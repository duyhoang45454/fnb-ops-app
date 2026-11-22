const express = require('express');
const fs = require('fs');
const path = require('path');
const { AppError, query, createAdminClient, recreatePool } = require('../db');
const { authenticate, requireRole } = require('../auth');

const router = express.Router();

const DB_SQL_DIR = process.env.DB_SQL_DIR || path.resolve(__dirname, '../../../database');

router.get('/audit-logs', authenticate, requireRole('OWNER'), async (req, res, next) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      limit = 100;
    }
    limit = Math.min(limit, 500);

    const { rows } = await query(
      `SELECT al.id, al.created_at, al.action_code, al.entity_table, al.entity_id,
              act.full_name AS actor_name,
              app.full_name AS approver_name,
              al.reason, al.old_values_json, al.new_values_json
       FROM audit_logs al
       JOIN users act ON act.id = al.actor_id
       LEFT JOIN users app ON app.id = al.approver_id
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT $1`,
      [limit]
    );

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

router.get('/dashboard', authenticate, requireRole('OWNER'), async (req, res, next) => {
  try {
    const { rows: shiftRows } = await query(
      `SELECT id FROM work_shifts ORDER BY opened_at DESC LIMIT 1`
    );
    const shiftId = shiftRows.length ? shiftRows[0].id : null;

    let revenue = 0;
    let paidOrders = 0;
    let voidedOrders = 0;
    let cogs = 0;

    if (shiftId) {
      const { rows: orderAgg } = await query(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'PAID' THEN total_amount ELSE 0 END), 0) AS revenue,
           COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid_orders,
           COUNT(*) FILTER (WHERE status = 'VOIDED')::int AS voided_orders
         FROM pos_orders
         WHERE shift_id = $1`,
        [shiftId]
      );
      revenue = Number(orderAgg[0].revenue || 0);
      paidOrders = Number(orderAgg[0].paid_orders || 0);
      voidedOrders = Number(orderAgg[0].voided_orders || 0);

      const { rows: cogsRows } = await query(
        `SELECT COALESCE(SUM(ABS(sl.qty_change_base) * sl.unit_cost_snapshot), 0) AS total_cogs
         FROM pos_orders o
         JOIN pos_order_items oi ON oi.order_id = o.id
         JOIN stock_ledger sl ON sl.ref_table = 'pos_order_items' AND sl.ref_id = oi.id AND sl.txn_type = 'POS_SALE'
         WHERE o.shift_id = $1 AND o.status = 'PAID'`,
        [shiftId]
      );
      cogs = Math.round(Number(cogsRows[0].total_cogs || 0) * 100) / 100;
    }

    const foodCostPct = revenue > 0 ? Math.round((cogs / revenue) * 100 * 100) / 100 : 0;

    const { rows: lowStockRows } = await query(
      `SELECT ii.id AS item_id, ii.name, ii.base_unit,
              COALESCE(b.valid_stock, 0) AS valid_stock,
              ii.min_stock_base
       FROM inventory_items ii
       LEFT JOIN (
         SELECT item_id, SUM(remaining_qty_base) AS valid_stock
         FROM inventory_batches
         WHERE remaining_qty_base > 0 AND expires_at > NOW()
         GROUP BY item_id
       ) b ON b.item_id = ii.id
       WHERE ii.deleted_at IS NULL AND ii.is_active = TRUE
         AND COALESCE(b.valid_stock, 0) <= ii.min_stock_base
       ORDER BY ii.sku ASC`
    );

    const { rows: expiredRows } = await query(
      `SELECT ib.id AS batch_id, ib.batch_code, ii.name AS item_name,
              ii.base_unit, ib.remaining_qty_base
       FROM inventory_batches ib
       JOIN inventory_items ii ON ii.id = ib.item_id
       WHERE ib.remaining_qty_base > 0 AND ib.expires_at <= NOW()
       ORDER BY ib.expires_at ASC`
    );

    let eodSummary = null;
    if (shiftId) {
      const { rows: eodRows } = await query(
        `SELECT id, status
         FROM eod_reconciliations
         WHERE shift_id = $1 AND business_date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
         LIMIT 1`,
        [shiftId]
      );
      if (eodRows.length) {
        const { rows: alertCounts } = await query(
          `SELECT
             COUNT(*) FILTER (WHERE alert_level = 'RED')::int AS red,
             COUNT(*) FILTER (WHERE alert_level = 'YELLOW')::int AS yellow
           FROM eod_reconciliation_lines
           WHERE reconciliation_id = $1`,
          [eodRows[0].id]
        );
        eodSummary = {
          status: eodRows[0].status,
          red: Number(alertCounts[0].red || 0),
          yellow: Number(alertCounts[0].yellow || 0),
        };
      }
    }

    const { rows: recentAudit } = await query(
      `SELECT al.id, al.created_at, al.action_code, al.entity_table, al.entity_id,
              act.full_name AS actor_name,
              app.full_name AS approver_name,
              al.reason, al.old_values_json, al.new_values_json
       FROM audit_logs al
       JOIN users act ON act.id = al.actor_id
       LEFT JOIN users app ON app.id = al.approver_id
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT 6`
    );

    return res.json({
      revenue,
      paid_orders: paidOrders,
      cogs,
      food_cost_pct: foodCostPct,
      voided_orders: voidedOrders,
      low_stock: lowStockRows,
      expired_batches: expiredRows,
      eod: eodSummary,
      recent_audit: recentAudit,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/admin/reset-demo', authenticate, requireRole('OWNER'), async (req, res, next) => {
  const sqlFiles = [
    '01_schema.sql',
    '02_functions_fefo.sql',
    '03_seed_and_test.sql',
    '04_app_seed.sql',
  ];

  const client = createAdminClient();
  try {
    const fileContents = sqlFiles.map((fname) => {
      const fullPath = path.join(DB_SQL_DIR, fname);
      if (!fs.existsSync(fullPath)) {
        throw new AppError(500, 'INTERNAL', `Không tìm thấy file SQL seed: ${fullPath}`);
      }
      return { fname, sql: fs.readFileSync(fullPath, 'utf8') };
    });

    await client.connect();
    await client.query(
      `DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO postgres, public;`
    );
    for (const { sql } of fileContents) {
      await client.query(sql);
    }
    await client.end();

    await recreatePool();

    return res.json({ ok: true });
  } catch (err) {
    try {
      await client.end();
    } catch (e) {
      // ignore
    }
    return next(err);
  }
});

module.exports = router;
