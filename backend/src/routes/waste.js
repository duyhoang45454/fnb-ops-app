const express = require('express');
const { AppError, query, withTransaction, getCurrentShift, insertAuditLog, isValidUuid } = require('../db');
const { authenticate, requireRole, getClientIp } = require('../auth');

const router = express.Router();

const REASON_CODES = ['SPILL', 'EXPIRED', 'WRONG_DRINK', 'QUALITY_TEST', 'EQUIPMENT_FAULT'];

router.use(authenticate);

async function approveWasteRecordInTx(client, wasteId, approverUser, clientIp) {
  const { rows: wasteRows } = await client.query(
    `SELECT w.*, ii.name AS item_name, ii.base_unit
     FROM waste_records w
     JOIN inventory_items ii ON ii.id = w.item_id
     WHERE w.id = $1
     FOR UPDATE OF w`,
    [wasteId]
  );
  if (!wasteRows.length) {
    throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy phiếu báo hủy.');
  }
  const waste = wasteRows[0];
  if (waste.status !== 'PENDING') {
    throw new AppError(409, 'INVALID_STATE', `Phiếu báo hủy đang ở trạng thái ${waste.status}, không thể duyệt.`);
  }

  // Lock item row
  await client.query(
    `SELECT id FROM inventory_items WHERE id = $1 FOR UPDATE`,
    [waste.item_id]
  );

  let remaining = Number(waste.qty_base);

  if (waste.reason_code === 'EXPIRED') {
    const { rows: expiredBatches } = await client.query(
      `SELECT id, remaining_qty_base, unit_cost
       FROM inventory_batches
       WHERE item_id = $1 AND remaining_qty_base > 0 AND expires_at <= NOW()
       ORDER BY expires_at ASC, received_at ASC, id ASC
       FOR UPDATE`,
      [waste.item_id]
    );

    for (const batch of expiredBatches) {
      if (remaining <= 0) break;
      const deduct = Math.min(remaining, Number(batch.remaining_qty_base));
      if (deduct > 0) {
        await client.query(
          `UPDATE inventory_batches SET remaining_qty_base = remaining_qty_base - $1 WHERE id = $2`,
          [deduct, batch.id]
        );
        await client.query(
          `INSERT INTO stock_ledger (
             item_id, batch_id, txn_type, qty_change_base, unit_cost_snapshot,
             ref_table, ref_id, created_by
           ) VALUES ($1, $2, 'WASTE', $3, $4, 'waste_records', $5, $6)`,
          [waste.item_id, batch.id, -deduct, batch.unit_cost, waste.id, approverUser.id]
        );
        remaining = Math.round((remaining - deduct) * 1000) / 1000;
      }
    }
  }

  if (remaining > 0) {
    await client.query(
      `SELECT total_cogs, shortfall_qty
       FROM fn_deduct_stock_fefo($1, $2, 'WASTE', 'waste_records', $3, $4, TRUE)`,
      [waste.item_id, remaining, waste.id, approverUser.id]
    );
  }

  const { rows: updatedRows } = await client.query(
    `UPDATE waste_records
     SET status = 'APPROVED',
         approved_by = $1,
         approved_at = NOW()
     WHERE id = $2
     RETURNING id, item_id, qty_base, reason_code, notes, camera_photo_url, status, created_at, approved_at`,
    [approverUser.id, waste.id]
  );

  await insertAuditLog(client, {
    actorId: approverUser.id,
    approverId: approverUser.id,
    actionCode: 'WASTE_APPROVED',
    entityTable: 'waste_records',
    entityId: waste.id,
    oldValues: { status: 'PENDING' },
    newValues: { status: 'APPROVED', qty_base: waste.qty_base, reason_code: waste.reason_code },
    reason: `Duyệt báo hủy ${waste.qty_base} ${waste.base_unit} ${waste.item_name} (${waste.reason_code})`,
    deviceIp: clientIp,
  });

  const { rows: fullRows } = await client.query(
    `SELECT w.id, w.item_id, ii.name AS item_name, ii.base_unit, w.qty_base,
            w.reason_code, w.notes, w.camera_photo_url, w.status,
            rb.full_name AS reported_by_name, ab.full_name AS approved_by_name,
            w.created_at, w.approved_at
     FROM waste_records w
     JOIN inventory_items ii ON ii.id = w.item_id
     JOIN users rb ON rb.id = w.reported_by
     LEFT JOIN users ab ON ab.id = w.approved_by
     WHERE w.id = $1`,
    [updatedRows[0].id]
  );
  return fullRows[0];
}

router.get('/', requireRole('OWNER', 'MANAGER', 'BARISTA'), async (req, res, next) => {
  try {
    const { rows: shiftRows } = await query(
      `SELECT id FROM work_shifts ORDER BY opened_at DESC LIMIT 1`
    );
    if (!shiftRows.length) {
      return res.json([]);
    }
    const shiftId = shiftRows[0].id;

    const { rows } = await query(
      `SELECT w.id, w.item_id, ii.name AS item_name, ii.base_unit, w.qty_base,
              w.reason_code, w.notes, w.camera_photo_url, w.status,
              rb.full_name AS reported_by_name, ab.full_name AS approved_by_name,
              w.created_at, w.approved_at
       FROM waste_records w
       JOIN inventory_items ii ON ii.id = w.item_id
       JOIN users rb ON rb.id = w.reported_by
       LEFT JOIN users ab ON ab.id = w.approved_by
       WHERE w.shift_id = $1
       ORDER BY w.created_at DESC, w.id DESC`,
      [shiftId]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

router.post('/', requireRole('OWNER', 'MANAGER', 'BARISTA'), async (req, res, next) => {
  try {
    const itemId = req.body?.item_id;
    const qtyBase = req.body?.qty_base;
    const reasonCode = typeof req.body?.reason_code === 'string'
      ? req.body.reason_code.trim().toUpperCase()
      : '';
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : null;
    const cameraPhotoUrl = typeof req.body?.camera_photo_url === 'string'
      ? req.body.camera_photo_url.trim()
      : '';

    if (!isValidUuid(itemId)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'item_id không hợp lệ.');
    }
    if (typeof qtyBase !== 'number' || !Number.isFinite(qtyBase) || qtyBase <= 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Số lượng hủy (qty_base) phải > 0.');
    }
    if (!REASON_CODES.includes(reasonCode)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Mã lý do (reason_code) không hợp lệ.');
    }
    if (!cameraPhotoUrl || !cameraPhotoUrl.startsWith('camera://')) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Ảnh bằng chứng bắt buộc chụp trực tiếp từ camera (camera_photo_url phải có tiền tố "camera://").'
      );
    }

    const result = await withTransaction(async (client) => {
      const shift = await getCurrentShift(client, { forUpdate: false });
      const { rows: itemRows } = await client.query(
        `SELECT id, name, base_unit FROM inventory_items WHERE id = $1 AND deleted_at IS NULL`,
        [itemId]
      );
      if (!itemRows.length) {
        throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy nguyên liệu.');
      }

      const { rows: inserted } = await client.query(
        `INSERT INTO waste_records (
           shift_id, item_id, qty_base, reason_code, notes,
           camera_photo_url, reported_by, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
         RETURNING id`,
        [shift.id, itemId, qtyBase, reasonCode, notes, cameraPhotoUrl, req.user.id]
      );
      const wasteId = inserted[0].id;

      await insertAuditLog(client, {
        actorId: req.user.id,
        actionCode: 'WASTE_CREATED',
        entityTable: 'waste_records',
        entityId: wasteId,
        newValues: {
          item_id: itemId,
          qty_base: qtyBase,
          reason_code: reasonCode,
          camera_photo_url: cameraPhotoUrl,
          status: 'PENDING',
        },
        reason: `Tạo phiếu báo hủy ${qtyBase} ${itemRows[0].base_unit} ${itemRows[0].name} (${reasonCode})`,
        deviceIp: getClientIp(req),
      });

      if (req.user.role === 'OWNER' || req.user.role === 'MANAGER') {
        return approveWasteRecordInTx(client, wasteId, req.user, getClientIp(req));
      }

      const { rows: fullRows } = await client.query(
        `SELECT w.id, w.item_id, ii.name AS item_name, ii.base_unit, w.qty_base,
                w.reason_code, w.notes, w.camera_photo_url, w.status,
                rb.full_name AS reported_by_name, ab.full_name AS approved_by_name,
                w.created_at, w.approved_at
         FROM waste_records w
         JOIN inventory_items ii ON ii.id = w.item_id
         JOIN users rb ON rb.id = w.reported_by
         LEFT JOIN users ab ON ab.id = w.approved_by
         WHERE w.id = $1`,
        [wasteId]
      );
      return fullRows[0];
    });

    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/approve', requireRole('OWNER', 'MANAGER'), async (req, res, next) => {
  try {
    const wasteId = req.params.id;
    if (!isValidUuid(wasteId)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'ID phiếu báo hủy không hợp lệ.');
    }

    const result = await withTransaction(async (client) => {
      return approveWasteRecordInTx(client, wasteId, req.user, getClientIp(req));
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/reject', requireRole('OWNER', 'MANAGER'), async (req, res, next) => {
  try {
    const wasteId = req.params.id;
    if (!isValidUuid(wasteId)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'ID phiếu báo hủy không hợp lệ.');
    }
    const rejectReason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim()
      : 'Quản lý từ chối phiếu báo hủy';

    const result = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(
        `SELECT id, status, notes FROM waste_records WHERE id = $1 FOR UPDATE`,
        [wasteId]
      );
      if (!existing.length) {
        throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy phiếu báo hủy.');
      }
      if (existing[0].status !== 'PENDING') {
        throw new AppError(409, 'INVALID_STATE', `Phiếu báo hủy đang ở trạng thái ${existing[0].status}, không thể từ chối.`);
      }

      await client.query(
        `UPDATE waste_records
         SET status = 'REJECTED',
             approved_by = $1,
             approved_at = NOW()
         WHERE id = $2`,
        [req.user.id, wasteId]
      );

      await insertAuditLog(client, {
        actorId: req.user.id,
        approverId: req.user.id,
        actionCode: 'WASTE_REJECTED',
        entityTable: 'waste_records',
        entityId: wasteId,
        oldValues: { status: 'PENDING' },
        newValues: { status: 'REJECTED', reject_reason: rejectReason },
        reason: rejectReason,
        deviceIp: getClientIp(req),
      });

      const { rows: fullRows } = await client.query(
        `SELECT w.id, w.item_id, ii.name AS item_name, ii.base_unit, w.qty_base,
                w.reason_code, w.notes, w.camera_photo_url, w.status,
                rb.full_name AS reported_by_name, ab.full_name AS approved_by_name,
                w.created_at, w.approved_at
         FROM waste_records w
         JOIN inventory_items ii ON ii.id = w.item_id
         JOIN users rb ON rb.id = w.reported_by
         LEFT JOIN users ab ON ab.id = w.approved_by
         WHERE w.id = $1`,
        [wasteId]
      );
      return fullRows[0];
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
