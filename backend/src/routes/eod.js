const express = require('express');
const { AppError, withTransaction, getCurrentShift, insertAuditLog, isValidUuid } = require('../db');
const { authenticate, requireRole, getClientIp } = require('../auth');
const { sanitizeForRole } = require('../sanitize');

const router = express.Router();

const BLIND_THEORETICAL_KEYS = [
  'opening_qty_base',
  'purchased_qty_base',
  'pos_usage_qty_base',
  'waste_qty_base',
  'theoretical_qty_base',
  'variance_qty_base',
  'variance_pct_usage',
  'variance_vnd',
  'alert_level',
  'total_variance_vnd',
];

router.use(authenticate);

async function ensureCurrentEod(client, userId) {
  const shift = await getCurrentShift(client, { forUpdate: false });
  const { rows: dateRows } = await client.query(
    `SELECT (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS biz_date`
  );
  const businessDate = dateRows[0].biz_date;

  const { rows: existing } = await client.query(
    `SELECT * FROM eod_reconciliations
     WHERE business_date = $1 AND shift_id = $2
     FOR UPDATE`,
    [businessDate, shift.id]
  );

  if (existing.length) {
    return existing[0];
  }

  const { rows: created } = await client.query(
    `INSERT INTO eod_reconciliations (
       business_date, shift_id, abc_scope, status, counted_by, total_variance_vnd
     ) VALUES ($1, $2, 'A', 'DRAFT_COUNTING', $3, 0)
     RETURNING *`,
    [businessDate, shift.id, userId]
  );
  const eod = created[0];

  const { rows: classAItems } = await client.query(
    `SELECT id FROM inventory_items
     WHERE abc_class = 'A' AND deleted_at IS NULL AND is_active = TRUE
     ORDER BY sku ASC`
  );

  for (const item of classAItems) {
    await client.query(
      `INSERT INTO eod_reconciliation_lines (
         reconciliation_id, item_id, counted_sealed_units, weighed_gross_g, counted_qty_base
       ) VALUES ($1, $2, 0, 0, 0)
       ON CONFLICT (reconciliation_id, item_id) DO NOTHING`,
      [eod.id, item.id]
    );
  }

  return eod;
}

async function fetchEodResponse(client, eodId, role) {
  const { rows: hdrRows } = await client.query(
    `SELECT e.*, u.full_name AS counted_by_name
     FROM eod_reconciliations e
     JOIN users u ON u.id = e.counted_by
     WHERE e.id = $1`,
    [eodId]
  );
  const hdr = hdrRows[0];

  const { rows: lineRows } = await client.query(
    `SELECT l.*, ii.sku, ii.name AS item_name, ii.base_unit, ii.tare_weight_g,
            uc.unit_name AS count_unit_name, uc.to_base_factor AS count_unit_factor
     FROM eod_reconciliation_lines l
     JOIN inventory_items ii ON ii.id = l.item_id
     LEFT JOIN LATERAL (
       SELECT unit_name, to_base_factor
       FROM item_unit_conversions
       WHERE item_id = ii.id AND is_count_unit = TRUE
       ORDER BY to_base_factor ASC
       LIMIT 1
     ) uc ON TRUE
     WHERE l.reconciliation_id = $1
     ORDER BY ii.sku ASC`,
    [eodId]
  );

  const isDraft = hdr.status === 'DRAFT_COUNTING';
  const showTheoretical = !isDraft && role === 'OWNER';

  const lines = lineRows.map((l) => {
    const baseLine = {
      item_id: l.item_id,
      sku: l.sku,
      item_name: l.item_name,
      base_unit: l.base_unit,
      tare_weight_g: l.tare_weight_g,
      count_unit: l.count_unit_name
        ? { unit_name: l.count_unit_name, to_base_factor: l.count_unit_factor }
        : null,
      counted_sealed_units: l.counted_sealed_units,
      weighed_gross_g: l.weighed_gross_g,
      counted_qty_base: l.counted_qty_base,
    };

    if (showTheoretical) {
      baseLine.opening_qty_base = l.opening_qty_base;
      baseLine.purchased_qty_base = l.purchased_qty_base;
      baseLine.pos_usage_qty_base = l.pos_usage_qty_base;
      baseLine.waste_qty_base = l.waste_qty_base;
      baseLine.theoretical_qty_base = l.theoretical_qty_base;
      baseLine.variance_qty_base = l.variance_qty_base;
      baseLine.variance_pct_usage = l.variance_pct_usage;
      baseLine.variance_vnd = l.variance_vnd;
      baseLine.alert_level = l.alert_level;
      if (l.explanation_note !== null) {
        baseLine.explanation_note = l.explanation_note;
      }
    }

    return baseLine;
  });

  const resp = {
    id: hdr.id,
    business_date: hdr.business_date instanceof Date
      ? hdr.business_date.toISOString().slice(0, 10)
      : String(hdr.business_date).slice(0, 10),
    status: hdr.status,
    abc_scope: hdr.abc_scope,
    counted_by_name: hdr.counted_by_name,
    submitted_at: hdr.submitted_at,
    lines,
  };

  if (showTheoretical) {
    let red = 0;
    let yellow = 0;
    let green = 0;
    for (const l of lineRows) {
      if (l.alert_level === 'RED') red += 1;
      else if (l.alert_level === 'YELLOW') yellow += 1;
      else if (l.alert_level === 'GREEN') green += 1;
    }
    resp.total_variance_vnd = hdr.total_variance_vnd;
    resp.summary = {
      red,
      yellow,
      green,
      total_variance_vnd: hdr.total_variance_vnd,
    };
  }

  // Extra safety: guarantee none of the blind theoretical keys exist when DRAFT or non-OWNER
  if (!showTheoretical) {
    for (const key of BLIND_THEORETICAL_KEYS) {
      delete resp[key];
      for (const ln of resp.lines) {
        delete ln[key];
      }
    }
  }

  return sanitizeForRole(resp, role);
}

router.get('/current', requireRole('OWNER', 'MANAGER', 'BARISTA'), async (req, res, next) => {
  try {
    const data = await withTransaction(async (client) => {
      const eod = await ensureCurrentEod(client, req.user.id);
      return fetchEodResponse(client, eod.id, req.user.role);
    });
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

router.put('/current/lines', requireRole('OWNER', 'MANAGER', 'BARISTA'), async (req, res, next) => {
  try {
    const linesInput = req.body?.lines;
    if (!Array.isArray(linesInput) || linesInput.length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Danh sách lines không được rỗng.');
    }

    for (const ln of linesInput) {
      if (!isValidUuid(ln?.item_id)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'item_id trong lines không hợp lệ.');
      }
      if (
        typeof ln.counted_sealed_units !== 'number' ||
        !Number.isFinite(ln.counted_sealed_units) ||
        ln.counted_sealed_units < 0
      ) {
        throw new AppError(400, 'VALIDATION_ERROR', 'counted_sealed_units phải >= 0.');
      }
      if (
        typeof ln.weighed_gross_g !== 'number' ||
        !Number.isFinite(ln.weighed_gross_g) ||
        ln.weighed_gross_g < 0
      ) {
        throw new AppError(400, 'VALIDATION_ERROR', 'weighed_gross_g phải >= 0.');
      }
    }

    const data = await withTransaction(async (client) => {
      const eod = await ensureCurrentEod(client, req.user.id);
      if (eod.status !== 'DRAFT_COUNTING') {
        throw new AppError(409, 'INVALID_STATE', `Phiếu EOD đang ở trạng thái ${eod.status}, không thể sửa số đếm.`);
      }

      const itemIds = linesInput.map((l) => l.item_id);
      const { rows: existingLines } = await client.query(
        `SELECT l.item_id, ii.base_unit, ii.tare_weight_g,
                COALESCE(uc.to_base_factor, 1) AS to_base_factor
         FROM eod_reconciliation_lines l
         JOIN inventory_items ii ON ii.id = l.item_id
         LEFT JOIN LATERAL (
           SELECT to_base_factor
           FROM item_unit_conversions
           WHERE item_id = ii.id AND is_count_unit = TRUE
           ORDER BY to_base_factor ASC
           LIMIT 1
         ) uc ON TRUE
         WHERE l.reconciliation_id = $1 AND l.item_id = ANY($2::uuid[])`,
        [eod.id, itemIds]
      );

      const lineMetaMap = new Map(existingLines.map((r) => [r.item_id, r]));

      for (const ln of linesInput) {
        const meta = lineMetaMap.get(ln.item_id);
        if (!meta) {
          throw new AppError(404, 'NOT_FOUND', `Nguyên liệu ${ln.item_id} không nằm trong phiếu EOD hiện tại.`);
        }
        const factor = Number(meta.to_base_factor || 1);
        const tare = Number(meta.tare_weight_g || 0);
        const openNet = meta.base_unit === 'pcs'
          ? ln.weighed_gross_g
          : Math.max(0, ln.weighed_gross_g - tare);
        const countedQtyBase = Math.round((ln.counted_sealed_units * factor + openNet) * 1000) / 1000;

        await client.query(
          `UPDATE eod_reconciliation_lines
           SET counted_sealed_units = $1,
               weighed_gross_g = $2,
               counted_qty_base = $3
           WHERE reconciliation_id = $4 AND item_id = $5`,
          [ln.counted_sealed_units, ln.weighed_gross_g, countedQtyBase, eod.id, ln.item_id]
        );
      }

      await client.query(
        `UPDATE eod_reconciliations SET counted_by = $1 WHERE id = $2`,
        [req.user.id, eod.id]
      );

      return fetchEodResponse(client, eod.id, req.user.role);
    });

    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

router.post('/current/submit', requireRole('OWNER', 'MANAGER', 'BARISTA'), async (req, res, next) => {
  try {
    const data = await withTransaction(async (client) => {
      const eod = await ensureCurrentEod(client, req.user.id);
      if (eod.status !== 'DRAFT_COUNTING') {
        throw new AppError(409, 'INVALID_STATE', `Phiếu EOD đang ở trạng thái ${eod.status}, không thể nộp lại.`);
      }

      const bizDate = eod.business_date instanceof Date
        ? eod.business_date.toISOString().slice(0, 10)
        : String(eod.business_date).slice(0, 10);

      const { rows: lineRows } = await client.query(
        `SELECT l.id, l.item_id, l.counted_qty_base, ii.base_unit, ii.avg_unit_cost
         FROM eod_reconciliation_lines l
         JOIN inventory_items ii ON ii.id = l.item_id
         WHERE l.reconciliation_id = $1
         ORDER BY ii.sku ASC`,
        [eod.id]
      );

      let totalVarianceVnd = 0;
      let redCount = 0;

      for (const ln of lineRows) {
        const { rows: ledgerAgg } = await client.query(
          `SELECT
             COALESCE(SUM(CASE WHEN (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date < $2::date THEN qty_change_base ELSE 0 END), 0) AS opening_qty,
             COALESCE(SUM(CASE WHEN (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $2::date AND txn_type IN ('PURCHASE', 'PREP_IN') AND qty_change_base > 0 THEN qty_change_base ELSE 0 END), 0) AS purchased_qty,
             COALESCE(SUM(CASE WHEN (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $2::date AND txn_type = 'POS_SALE' THEN ABS(qty_change_base) ELSE 0 END), 0) AS pos_usage_qty,
             COALESCE(SUM(CASE WHEN (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $2::date AND txn_type = 'WASTE' THEN ABS(qty_change_base) ELSE 0 END), 0) AS waste_qty,
             COALESCE(SUM(qty_change_base), 0) AS total_ledger_qty
           FROM stock_ledger
           WHERE item_id = $1`,
          [ln.item_id, bizDate]
        );

        const { rows: expRows } = await client.query(
          `SELECT COALESCE(SUM(remaining_qty_base), 0) AS expired_remaining
           FROM inventory_batches
           WHERE item_id = $1 AND remaining_qty_base > 0 AND expires_at <= NOW()`,
          [ln.item_id]
        );

        const agg = ledgerAgg[0];
        const opening = Math.round(Number(agg.opening_qty) * 1000) / 1000;
        const purchased = Math.round(Number(agg.purchased_qty) * 1000) / 1000;
        const posUsage = Math.round(Number(agg.pos_usage_qty) * 1000) / 1000;
        const waste = Math.round(Number(agg.waste_qty) * 1000) / 1000;
        const expiredRem = Number(expRows[0].expired_remaining || 0);

        const theoretical = Math.round((Number(agg.total_ledger_qty) - expiredRem) * 1000) / 1000;
        const counted = Number(ln.counted_qty_base);
        const variance = Math.round((counted - theoretical) * 1000) / 1000;
        const variancePctUsage = posUsage > 0
          ? Math.round((Math.abs(variance) / posUsage) * 100 * 100) / 100
          : (variance !== 0 ? 100 : 0);

        let alertLevel = 'GREEN';
        if (ln.base_unit === 'pcs' && variance <= -3) {
          alertLevel = 'RED';
        } else if (variancePctUsage > 5) {
          alertLevel = 'RED';
        } else if (variancePctUsage >= 2) {
          alertLevel = 'YELLOW';
        }

        if (alertLevel === 'RED') {
          redCount += 1;
        }

        const varianceVnd = Math.round(variance * Number(ln.avg_unit_cost) * 100) / 100;
        totalVarianceVnd = Math.round((totalVarianceVnd + varianceVnd) * 100) / 100;

        await client.query(
          `UPDATE eod_reconciliation_lines
           SET opening_qty_base = $1,
               purchased_qty_base = $2,
               pos_usage_qty_base = $3,
               waste_qty_base = $4,
               theoretical_qty_base = $5,
               variance_qty_base = $6,
               variance_pct_usage = $7,
               variance_vnd = $8,
               alert_level = $9
           WHERE id = $10`,
          [
            opening,
            purchased,
            posUsage,
            waste,
            theoretical,
            variance,
            variancePctUsage,
            varianceVnd,
            alertLevel,
            ln.id,
          ]
        );
      }

      await client.query(
        `UPDATE eod_reconciliations
         SET status = 'SUBMITTED',
             counted_by = $1,
             total_variance_vnd = $2,
             submitted_at = NOW(),
             alert_sent_at = CASE WHEN $3 > 0 THEN NOW() ELSE NULL END
         WHERE id = $4`,
        [req.user.id, totalVarianceVnd, redCount, eod.id]
      );

      await insertAuditLog(client, {
        actorId: req.user.id,
        actionCode: 'EOD_BLIND_SUBMIT',
        entityTable: 'eod_reconciliations',
        entityId: eod.id,
        oldValues: { status: 'DRAFT_COUNTING' },
        newValues: { status: 'SUBMITTED', red_alerts: redCount, total_variance_vnd: totalVarianceVnd },
        reason: `Nộp kiểm kho mù cuối ngày (${redCount} cảnh báo đỏ)`,
        deviceIp: getClientIp(req),
      });

      return fetchEodResponse(client, eod.id, req.user.role);
    });

    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

router.post('/current/lock', requireRole('OWNER'), async (req, res, next) => {
  try {
    const data = await withTransaction(async (client) => {
      const eod = await ensureCurrentEod(client, req.user.id);
      if (eod.status !== 'SUBMITTED') {
        throw new AppError(409, 'INVALID_STATE', `Chỉ khóa phiếu EOD ở trạng thái SUBMITTED (hiện tại: ${eod.status}).`);
      }

      await client.query(
        `UPDATE eod_reconciliations
         SET status = 'LOCKED',
             locked_by = $1
         WHERE id = $2`,
        [req.user.id, eod.id]
      );

      await insertAuditLog(client, {
        actorId: req.user.id,
        actionCode: 'EOD_LOCK',
        entityTable: 'eod_reconciliations',
        entityId: eod.id,
        oldValues: { status: 'SUBMITTED' },
        newValues: { status: 'LOCKED', locked_by: req.user.id },
        reason: 'Chủ quán khóa sổ đối soát EOD',
        deviceIp: getClientIp(req),
      });

      return fetchEodResponse(client, eod.id, req.user.role);
    });

    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

router.post('/current/reopen', requireRole('OWNER'), async (req, res, next) => {
  try {
    const data = await withTransaction(async (client) => {
      const eod = await ensureCurrentEod(client, req.user.id);
      const oldStatus = eod.status;

      await client.query(
        `UPDATE eod_reconciliation_lines
         SET opening_qty_base = NULL,
             purchased_qty_base = NULL,
             pos_usage_qty_base = NULL,
             waste_qty_base = NULL,
             theoretical_qty_base = NULL,
             variance_qty_base = NULL,
             variance_pct_usage = NULL,
             variance_vnd = NULL,
             alert_level = NULL
         WHERE reconciliation_id = $1`,
        [eod.id]
      );

      await client.query(
        `UPDATE eod_reconciliations
         SET status = 'DRAFT_COUNTING',
             locked_by = NULL,
             total_variance_vnd = 0,
             submitted_at = NULL,
             alert_sent_at = NULL
         WHERE id = $1`,
        [eod.id]
      );

      await insertAuditLog(client, {
        actorId: req.user.id,
        actionCode: 'EOD_REOPEN',
        entityTable: 'eod_reconciliations',
        entityId: eod.id,
        oldValues: { status: oldStatus },
        newValues: { status: 'DRAFT_COUNTING' },
        reason: 'Chủ quán mở kiểm lại phiếu EOD',
        deviceIp: getClientIp(req),
      });

      return fetchEodResponse(client, eod.id, req.user.role);
    });

    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
