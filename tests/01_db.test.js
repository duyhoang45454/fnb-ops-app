import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DB_CONFIG, APP_DB_USER, APP_DB_PASSWORD, IDS } from './helpers.js';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_DB_NAME = 'fnb_test_db';

describe('01. Database Schema, FEFO, Dynamic BOM & Immutability', () => {
  let superClient;
  let appClient;
  let ordTestDeduction;

  before(async () => {
    const adminClient = new Client({ ...DB_CONFIG, database: 'postgres' });
    await adminClient.connect();
    try {
      await adminClient.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB_NAME]
      );
      await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
      await adminClient.query(`CREATE DATABASE ${TEST_DB_NAME}`);
    } finally {
      await adminClient.end();
    }

    superClient = new Client({ ...DB_CONFIG, database: TEST_DB_NAME });
    await superClient.connect();

    const sqlFiles = [
      path.join(ROOT_DIR, 'database/01_schema.sql'),
      path.join(ROOT_DIR, 'database/02_functions_fefo.sql'),
      path.join(ROOT_DIR, 'database/03_seed_and_test.sql'),
      path.join(ROOT_DIR, 'database/04_app_seed.sql'),
    ];

    for (const file of sqlFiles) {
      const sql = await fs.readFile(file, 'utf8');
      await superClient.query(sql);
    }

    const ordTestSql = await fs.readFile(
      path.join(ROOT_DIR, 'tests/sql/ord_test_001.sql'),
      'utf8'
    );
    const results = await superClient.query(ordTestSql);
    const resultList = Array.isArray(results) ? results : [results];
    const selectRes = resultList.find(
      (r) => r.command === 'SELECT' && r.rows?.length > 0 && r.rows[0].jsonb_pretty
    );
    assert.ok(selectRes, 'Expected jsonb_pretty output from ord_test_001.sql');
    ordTestDeduction = JSON.parse(selectRes.rows[0].jsonb_pretty);

    appClient = new Client({
      ...DB_CONFIG,
      database: TEST_DB_NAME,
      user: APP_DB_USER,
      password: APP_DB_PASSWORD,
    });
    await appClient.connect();
  });

  after(async () => {
    if (appClient) await appClient.end().catch(() => {});
    if (superClient) await superClient.end().catch(() => {});

    const adminClient = new Client({ ...DB_CONFIG, database: 'postgres' });
    await adminClient.connect();
    try {
      await adminClient.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB_NAME]
      );
      await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    } finally {
      await adminClient.end();
    }
  });

  it('fn_process_pos_order_deduction returns expected COGS and low-stock alert for ORD-TEST-001', () => {
    assert.equal(Number(ordTestDeduction.total_order_cogs_vnd), 18560);
    assert.deepEqual(ordTestDeduction.negative_stock_alerts, []);
    const milkAlert = ordTestDeduction.low_stock_alerts.find(
      (a) => a.sku === 'MILK-FRESH'
    );
    assert.ok(milkAlert, 'low_stock_alerts should contain MILK-FRESH');
    assert.equal(Number(milkAlert.remaining_valid_qty), 890);
  });

  it('updates batch remaining quantities strictly following FEFO and skipping expired batches', async () => {
    const { rows } = await superClient.query(
      `SELECT batch_code, remaining_qty_base FROM inventory_batches`
    );
    const byCode = Object.fromEntries(
      rows.map((r) => [r.batch_code, Number(r.remaining_qty_base)])
    );

    assert.equal(byCode['MILK-EXPIRED-00'], 500);
    assert.equal(byCode['MILK-FEFO-01'], 0);
    assert.equal(byCode['MILK-FEFO-02'], 890);
    assert.equal(byCode['TEA-MORNING-01'], 0);
    assert.equal(byCode['TEA-NOON-02'], 2810);
    assert.equal(byCode['PEARL-NOON-01'], 900);
    assert.equal(byCode['CUP700-LOT-01'], 198);
    assert.equal(byCode['SUGAR-LOT-01'], 2000);
  });

  it('snapshots per-unit COGS and ticket_printed_at on pos_order_items', async () => {
    const { rows } = await superClient.query(
      `SELECT cogs_snapshot, ticket_printed_at
       FROM pos_order_items
       WHERE id = '51000000-0000-0000-0000-000000000001'`
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].cogs_snapshot), 9280);
    assert.ok(rows[0].ticket_printed_at !== null, 'ticket_printed_at should be set');
  });

  it('prevents double deduction for the same order with SQLSTATE P0004', async () => {
    await assert.rejects(
      () =>
        superClient.query(
          `SELECT fn_process_pos_order_deduction('50000000-0000-0000-0000-000000000001', $1, TRUE)`,
          [IDS.users.CASHIER]
        ),
      (err) => err.code === 'P0004'
    );
  });

  it('blocks DELETE/UPDATE on stock_ledger and audit_logs for fnb_app_user (42501)', async () => {
    await assert.rejects(
      () => appClient.query(`DELETE FROM stock_ledger`),
      (err) => err.code === '42501'
    );
    await assert.rejects(
      () => appClient.query(`UPDATE audit_logs SET reason = 'x'`),
      (err) => err.code === '42501'
    );
  });

  it('blocks DELETE/TRUNCATE on stock_ledger even as superuser via trigger (42501)', async () => {
    await assert.rejects(
      () => superClient.query(`DELETE FROM stock_ledger`),
      (err) => err.code === '42501'
    );
    await assert.rejects(
      () => superClient.query(`TRUNCATE stock_ledger`),
      (err) => err.code === '42501'
    );
  });

  it('computes fn_calculate_dynamic_bom accurately across modifier combinations', async () => {
    await superClient.query('BEGIN');
    try {
      const { rows: [ord] } = await superClient.query(
        `INSERT INTO pos_orders (order_code, shift_id, cashier_id, status, subtotal, total_amount, payment_method, paid_at)
         VALUES ('ORD-BOM-TEST', $1, $2, 'PAID', 0, 0, 'CASH', NOW())
         RETURNING id`,
        [IDS.shift, IDS.users.CASHIER]
      );

      // Combo 1: 1x MT-CLASSIC + 50% Sugar only
      const { rows: [oi1] } = await superClient.query(
        `INSERT INTO pos_order_items (order_id, menu_item_id, recipe_version_id, quantity, unit_price, cogs_snapshot)
         VALUES ($1, $2, $3, 1, 35000, 0) RETURNING id`,
        [ord.id, IDS.menu.MT_CLASSIC, IDS.recipes.MT_CLASSIC_V1]
      );
      await superClient.query(
        `INSERT INTO pos_order_item_modifiers (order_item_id, modifier_id, price_delta_snapshot)
         VALUES ($1, $2, 0)`,
        [oi1.id, IDS.modifiers.SUGAR_50]
      );
      const bom1 = await superClient.query(
        `SELECT item_id, total_qty_base FROM fn_calculate_dynamic_bom($1)`,
        [oi1.id]
      );
      const map1 = Object.fromEntries(bom1.rows.map((r) => [r.item_id, Number(r.total_qty_base)]));
      assert.deepEqual(map1, {
        [IDS.items.PREP_TEA]: 150,
        [IDS.items.MILK_FRESH]: 100,
        [IDS.items.SUGAR_SYRUP]: 15,
        [IDS.items.CUP_500ML]: 1,
      });

      // Combo 2: 1x MT-CLASSIC + Size L only
      const { rows: [oi2] } = await superClient.query(
        `INSERT INTO pos_order_items (order_id, menu_item_id, recipe_version_id, quantity, unit_price, cogs_snapshot)
         VALUES ($1, $2, $3, 1, 42000, 0) RETURNING id`,
        [ord.id, IDS.menu.MT_CLASSIC, IDS.recipes.MT_CLASSIC_V1]
      );
      await superClient.query(
        `INSERT INTO pos_order_item_modifiers (order_item_id, modifier_id, price_delta_snapshot)
         VALUES ($1, $2, 7000)`,
        [oi2.id, IDS.modifiers.SIZE_L]
      );
      const bom2 = await superClient.query(
        `SELECT item_id, total_qty_base FROM fn_calculate_dynamic_bom($1)`,
        [oi2.id]
      );
      const map2 = Object.fromEntries(bom2.rows.map((r) => [r.item_id, Number(r.total_qty_base)]));
      assert.deepEqual(map2, {
        [IDS.items.PREP_TEA]: 195,
        [IDS.items.MILK_FRESH]: 130,
        [IDS.items.SUGAR_SYRUP]: 39,
        [IDS.items.CUP_700ML]: 1,
      });

      // Combo 3: 2x MT-CLASSIC + Size L + 50% Sugar + Pearl
      const { rows: [oi3] } = await superClient.query(
        `INSERT INTO pos_order_items (order_id, menu_item_id, recipe_version_id, quantity, unit_price, cogs_snapshot)
         VALUES ($1, $2, $3, 2, 50000, 0) RETURNING id`,
        [ord.id, IDS.menu.MT_CLASSIC, IDS.recipes.MT_CLASSIC_V1]
      );
      await superClient.query(
        `INSERT INTO pos_order_item_modifiers (order_item_id, modifier_id, price_delta_snapshot)
         VALUES ($1, $2, 7000), ($1, $3, 0), ($1, $4, 8000)`,
        [oi3.id, IDS.modifiers.SIZE_L, IDS.modifiers.SUGAR_50, IDS.modifiers.TOPPING_PEARL]
      );
      const bom3 = await superClient.query(
        `SELECT item_id, total_qty_base FROM fn_calculate_dynamic_bom($1)`,
        [oi3.id]
      );
      const map3 = Object.fromEntries(bom3.rows.map((r) => [r.item_id, Number(r.total_qty_base)]));
      assert.deepEqual(map3, {
        [IDS.items.PREP_TEA]: 390,
        [IDS.items.MILK_FRESH]: 260,
        [IDS.items.SUGAR_SYRUP]: 39,
        [IDS.items.PREP_PEARL]: 100,
        [IDS.items.CUP_700ML]: 2,
      });
    } finally {
      await superClient.query('ROLLBACK');
    }
  });
});
