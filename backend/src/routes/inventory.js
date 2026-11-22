const express = require('express');
const { AppError, query, withTransaction, insertAuditLog, isValidUuid } = require('../db');
const { authenticate, requireRole, getClientIp } = require('../auth');
const { sanitizeForRole } = require('../sanitize');

const router = express.Router();

router.use(authenticate);

function formatPrepTimestamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

router.get('/items', requireRole('OWNER', 'MANAGER', 'BARISTA'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ii.id, ii.sku, ii.name, ii.item_type, ii.abc_class, ii.base_unit,
              ii.tare_weight_g, ii.min_stock_base, ii.avg_unit_cost,
              COALESCE(b.valid_stock, 0) AS valid_stock,
              COALESCE(b.expired_stock, 0) AS expired_stock,
              (COALESCE(b.valid_stock, 0) <= ii.min_stock_base) AS is_low,
              uc.unit_name AS count_unit_name,
              uc.to_base_factor AS count_unit_factor
       FROM inventory_items ii
       LEFT JOIN (
         SELECT item_id,
                SUM(CASE WHEN remaining_qty_base > 0 AND expires_at > NOW() THEN remaining_qty_base ELSE 0 END) AS valid_stock,
                SUM(CASE WHEN remaining_qty_base > 0 AND expires_at <= NOW() THEN remaining_qty_base ELSE 0 END) AS expired_stock
         FROM inventory_batches
         GROUP BY item_id
       ) b ON b.item_id = ii.id
       LEFT JOIN LATERAL (
         SELECT unit_name, to_base_factor
         FROM item_unit_conversions
         WHERE item_id = ii.id AND is_count_unit = TRUE
         ORDER BY to_base_factor ASC
         LIMIT 1
       ) uc ON TRUE
       WHERE ii.deleted_at IS NULL AND ii.is_active = TRUE
       ORDER BY ii.sku ASC`
    );

    const result = rows.map((r) => {
      const out = {
        id: r.id,
        sku: r.sku,
        name: r.name,
        item_type: r.item_type,
        abc_class: r.abc_class,
        base_unit: r.base_unit,
        tare_weight_g: r.tare_weight_g,
        min_stock_base: r.min_stock_base,
        valid_stock: r.valid_stock,
        expired_stock: r.expired_stock,
        is_low: r.is_low,
        count_unit: r.count_unit_name
          ? { unit_name: r.count_unit_name, to_base_factor: r.count_unit_factor }
          : null,
      };
      if (req.user.role === 'OWNER') {
        out.avg_unit_cost = r.avg_unit_cost;
      }
      return out;
    });

    return res.json(sanitizeForRole(result, req.user.role));
  } catch (err) {
    return next(err);
  }
});

router.get('/batches', requireRole('OWNER', 'MANAGER', 'BARISTA'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ib.id, ib.batch_code, ib.item_id, ii.name AS item_name, ii.item_type,
              ii.abc_class, ii.base_unit, ib.received_at, ib.expires_at,
              ib.initial_qty_base, ib.remaining_qty_base,
              (ib.expires_at <= NOW()) AS is_expired,
              ib.unit_cost
       FROM inventory_batches ib
       JOIN inventory_items ii ON ii.id = ib.item_id
       WHERE ii.deleted_at IS NULL
       ORDER BY ii.sku ASC, ib.expires_at ASC, ib.received_at ASC, ib.id ASC`
    );

    const result = rows.map((r) => {
      const out = {
        id: r.id,
        batch_code: r.batch_code,
        item_id: r.item_id,
        item_name: r.item_name,
        item_type: r.item_type,
        abc_class: r.abc_class,
        base_unit: r.base_unit,
        received_at: r.received_at,
        expires_at: r.expires_at,
        initial_qty_base: r.initial_qty_base,
        remaining_qty_base: r.remaining_qty_base,
        is_expired: r.is_expired,
      };
      if (req.user.role === 'OWNER') {
        out.unit_cost = r.unit_cost;
      }
      return out;
    });

    return res.json(sanitizeForRole(result, req.user.role));
  } catch (err) {
    return next(err);
  }
});

router.get('/ledger', requireRole('OWNER', 'MANAGER', 'BARISTA'), async (req, res, next) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      limit = 200;
    }
    limit = Math.min(limit, 1000);

    const { rows } = await query(
      `SELECT sl.id, sl.created_at, sl.txn_type, sl.item_id, ii.name AS item_name,
              ii.base_unit, sl.batch_id, ib.batch_code, sl.qty_change_base,
              sl.ref_table, sl.ref_id, u.full_name AS created_by_name,
              sl.unit_cost_snapshot
       FROM stock_ledger sl
       JOIN inventory_items ii ON ii.id = sl.item_id
       LEFT JOIN inventory_batches ib ON ib.id = sl.batch_id
       JOIN users u ON u.id = sl.created_by
       ORDER BY sl.created_at DESC, sl.id DESC
       LIMIT $1`,
      [limit]
    );

    const result = rows.map((r) => {
      const out = {
        id: r.id,
        created_at: r.created_at,
        txn_type: r.txn_type,
        item_id: r.item_id,
        item_name: r.item_name,
        base_unit: r.base_unit,
        batch_id: r.batch_id,
        batch_code: r.batch_code || null,
        qty_change_base: r.qty_change_base,
        ref_table: r.ref_table,
        ref_id: r.ref_id,
        created_by_name: r.created_by_name,
      };
      if (req.user.role === 'OWNER') {
        out.unit_cost_snapshot = r.unit_cost_snapshot;
        out.value_vnd = Math.round(Math.abs(r.qty_change_base) * r.unit_cost_snapshot * 100) / 100;
      }
      return out;
    });

    return res.json(sanitizeForRole(result, req.user.role));
  } catch (err) {
    return next(err);
  }
});

router.post('/purchases', requireRole('OWNER'), async (req, res, next) => {
  try {
    const itemId = req.body?.item_id;
    const qtyBase = req.body?.qty_base;
    const unitCost = req.body?.unit_cost;
    const expiresAtRaw = req.body?.expires_at;
    const customBatchCode = typeof req.body?.batch_code === 'string' ? req.body.batch_code.trim() : '';

    if (!isValidUuid(itemId)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'item_id không hợp lệ.');
    }
    if (typeof qtyBase !== 'number' || !Number.isFinite(qtyBase) || qtyBase <= 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Số lượng nhập (qty_base) phải > 0.');
    }
    if (typeof unitCost !== 'number' || !Number.isFinite(unitCost) || unitCost < 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Đơn giá nhập (unit_cost) phải >= 0.');
    }
    const expiresAtDate = new Date(expiresAtRaw);
    if (!expiresAtRaw || Number.isNaN(expiresAtDate.getTime()) || expiresAtDate.getTime() <= Date.now()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Hạn sử dụng (expires_at) phải là ngày giờ hợp lệ trong tương lai.');
    }

    const result = await withTransaction(async (client) => {
      const { rows: itemRows } = await client.query(
        `SELECT id, sku, name, item_type, abc_class, base_unit, avg_unit_cost
         FROM inventory_items
         WHERE id = $1 AND deleted_at IS NULL
         FOR UPDATE`,
        [itemId]
      );
      if (!itemRows.length) {
        throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy nguyên liệu.');
      }
      const item = itemRows[0];

      const batchCode = customBatchCode || `${item.sku}-PO-${formatPrepTimestamp(new Date())}`;

      // Compute weighted average cost across valid remaining batches + new batch
      const { rows: stockRows } = await client.query(
        `SELECT COALESCE(SUM(remaining_qty_base), 0) AS total_qty,
                COALESCE(SUM(remaining_qty_base * unit_cost), 0) AS total_val
         FROM inventory_batches
         WHERE item_id = $1 AND remaining_qty_base > 0 AND expires_at > NOW()`,
        [itemId]
      );
      const existingQty = stockRows[0].total_qty || 0;
      const existingVal = stockRows[0].total_val || 0;
      const newAvgCost = Math.round(((existingVal + qtyBase * unitCost) / (existingQty + qtyBase)) * 10000) / 10000;

      const { rows: batchRows } = await client.query(
        `INSERT INTO inventory_batches (
           item_id, batch_code, received_at, expires_at,
           initial_qty_base, remaining_qty_base, unit_cost
         ) VALUES ($1, $2, NOW(), $3, $4, $4, $5)
         RETURNING id, batch_code, item_id, received_at, expires_at, initial_qty_base, remaining_qty_base, unit_cost`,
        [itemId, batchCode, expiresAtDate.toISOString(), qtyBase, unitCost]
      );
      const batch = batchRows[0];

      await client.query(
        `INSERT INTO stock_ledger (
           item_id, batch_id, txn_type, qty_change_base, unit_cost_snapshot,
           ref_table, ref_id, created_by
         ) VALUES ($1, $2, 'PURCHASE', $3, $4, 'inventory_batches', $2, $5)`,
        [itemId, batch.id, qtyBase, unitCost, req.user.id]
      );

      await client.query(
        `UPDATE inventory_items SET avg_unit_cost = $1 WHERE id = $2`,
        [newAvgCost, itemId]
      );

      await insertAuditLog(client, {
        actorId: req.user.id,
        actionCode: 'PURCHASE_RECEIVED',
        entityTable: 'inventory_batches',
        entityId: batch.id,
        oldValues: { avg_unit_cost: item.avg_unit_cost },
        newValues: {
          batch_code: batch.batch_code,
          item_id: itemId,
          qty_base: qtyBase,
          unit_cost: unitCost,
          avg_unit_cost: newAvgCost,
        },
        reason: `Nhập kho ${qtyBase} ${item.base_unit} ${item.name} (lô ${batch.batch_code})`,
        deviceIp: getClientIp(req),
      });

      return {
        ...batch,
        item_name: item.name,
        item_type: item.item_type,
        abc_class: item.abc_class,
        base_unit: item.base_unit,
        is_expired: false,
      };
    });

    return res.status(201).json(sanitizeForRole(result, req.user.role));
  } catch (err) {
    return next(err);
  }
});

router.post('/prep', requireRole('OWNER', 'MANAGER', 'BARISTA'), async (req, res, next) => {
  try {
    const semiItemId = req.body?.semi_item_id;
    const yieldQtyBase = req.body?.yield_qty_base;
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : null;

    if (!isValidUuid(semiItemId)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'semi_item_id không hợp lệ.');
    }
    if (typeof yieldQtyBase !== 'number' || !Number.isFinite(yieldQtyBase) || yieldQtyBase <= 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Sản lượng (yield_qty_base) phải > 0.');
    }

    const result = await withTransaction(async (client) => {
      const { rows: itemRows } = await client.query(
        `SELECT id, sku, name, item_type, abc_class, base_unit, avg_unit_cost
         FROM inventory_items
         WHERE id = $1 AND deleted_at IS NULL
         FOR UPDATE`,
        [semiItemId]
      );
      if (!itemRows.length) {
        throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy bán thành phẩm.');
      }
      const item = itemRows[0];
      if (item.item_type !== 'SEMI_FINISHED') {
        throw new AppError(400, 'VALIDATION_ERROR', `Mặt hàng "${item.name}" không phải SEMI_FINISHED.`);
      }

      let shelfHours = 8;
      if (item.sku === 'PREP-TEA') shelfHours = 6;
      else if (item.sku === 'PREP-PEARL') shelfHours = 4;

      const now = new Date();
      const expiresAt = new Date(now.getTime() + shelfHours * 3600 * 1000);
      const batchCode = `${item.sku}-PREP-${formatPrepTimestamp(now)}`;

      // Check if an active semi-finished recipe exists for this item
      const { rows: semiRecipeRows } = await client.query(
        `SELECT id, standard_yield_base
         FROM recipes
         WHERE semi_item_id = $1 AND is_active = TRUE
         LIMIT 1`,
        [semiItemId]
      );

      // Generate prep_id beforehand or insert prep_productions after batch creation?
      // Note prep_productions.output_batch_id REFERENCES inventory_batches(id) NOT NULL UNIQUE.
      // So we create the batch first (with placeholder unit_cost if recipe exists, or computed cost first).
      // Wait: if we compute raw material deductions using fn_deduct_stock_fefo with ref_id = prep_id,
      // we can generate a UUID for prep_id via gen_random_uuid() or node crypto.randomUUID(),
      // OR deduct after inserting prep_productions and update batch unit_cost?
      // Wait: stock_ledger references ref_table = 'prep_productions', ref_id = prep_id (no FK constraint on ref_id, just UUID).
      // Even better: use crypto.randomUUID() for prepId, deduct raw materials if recipe exists, get total cogs,
      // compute unit_cost = totalCogs / yieldQtyBase, then insert inventory_batches, prep_productions(id = prepId), and stock_ledger(PREP_IN).
      const { randomUUID } = require('crypto');
      const prepId = randomUUID();

      let batchUnitCost = item.avg_unit_cost;
      if (semiRecipeRows.length > 0) {
        const semiRecipe = semiRecipeRows[0];
        const { rows: lines } = await client.query(
          `SELECT item_id, qty_base FROM recipe_lines WHERE recipe_id = $1 ORDER BY item_id ASC`,
          [semiRecipe.id]
        );
        if (lines.length > 0) {
          let totalRawCogs = 0;
          const ratio = yieldQtyBase / semiRecipe.standard_yield_base;
          for (const line of lines) {
            const needed = Math.round(line.qty_base * ratio * 1000) / 1000;
            if (needed > 0) {
              const { rows: ded } = await client.query(
                `SELECT total_cogs, shortfall_qty
                 FROM fn_deduct_stock_fefo($1, $2, 'PREP_OUT', 'prep_productions', $3, $4, TRUE)`,
                [line.item_id, needed, prepId, req.user.id]
              );
              totalRawCogs += Number(ded[0].total_cogs || 0);
            }
          }
          batchUnitCost = Math.round((totalRawCogs / yieldQtyBase) * 10000) / 10000;
        }
      }

      const { rows: batchRows } = await client.query(
        `INSERT INTO inventory_batches (
           item_id, batch_code, received_at, expires_at,
           initial_qty_base, remaining_qty_base, unit_cost
         ) VALUES ($1, $2, $3, $4, $5, $5, $6)
         RETURNING id, batch_code, item_id, received_at, expires_at, initial_qty_base, remaining_qty_base, unit_cost`,
        [semiItemId, batchCode, now.toISOString(), expiresAt.toISOString(), yieldQtyBase, batchUnitCost]
      );
      const batch = batchRows[0];

      await client.query(
        `INSERT INTO prep_productions (
           id, semi_item_id, output_batch_id, prepared_by,
           yield_qty_base, prepared_at, expires_at, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [prepId, semiItemId, batch.id, req.user.id, yieldQtyBase, now.toISOString(), expiresAt.toISOString(), notes]
      );

      await client.query(
        `INSERT INTO stock_ledger (
           item_id, batch_id, txn_type, qty_change_base, unit_cost_snapshot,
           ref_table, ref_id, created_by
         ) VALUES ($1, $2, 'PREP_IN', $3, $4, 'prep_productions', $5, $6)`,
        [semiItemId, batch.id, yieldQtyBase, batchUnitCost, prepId, req.user.id]
      );

      await insertAuditLog(client, {
        actorId: req.user.id,
        actionCode: 'PREP_PRODUCTION',
        entityTable: 'prep_productions',
        entityId: prepId,
        newValues: {
          prep_id: prepId,
          semi_item_id: semiItemId,
          batch_id: batch.id,
          batch_code: batch.batch_code,
          yield_qty_base: yieldQtyBase,
          expires_at: batch.expires_at,
        },
        reason: `Nấu mẻ ${yieldQtyBase} ${item.base_unit} ${item.name} (${batch.batch_code})`,
        deviceIp: getClientIp(req),
      });

      return {
        prep_id: prepId,
        batch: {
          ...batch,
          item_name: item.name,
          item_type: item.item_type,
          abc_class: item.abc_class,
          base_unit: item.base_unit,
          is_expired: false,
        },
      };
    });

    return res.status(201).json(sanitizeForRole(result, req.user.role));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
