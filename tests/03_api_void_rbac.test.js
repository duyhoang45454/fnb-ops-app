import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  api,
  demoLogin,
  resetDemo,
  loginAllRoles,
  assertNoKeys,
  FORBIDDEN_COST_KEYS,
  IDS,
} from './helpers.js';

describe('03. Void Override PIN, RBAC, BOM Versioning & Audit Logs', () => {
  let tokens;
  let orderId;
  let orderCode;

  before(async () => {
    const ownerToken = await demoLogin('OWNER');
    await resetDemo(ownerToken);
    tokens = await loginAllRoles();

    // Create a PAID order to test void workflows
    const res = await api('/api/orders', {
      method: 'POST',
      token: tokens.cashier,
      body: {
        items: [{ menu_item_id: IDS.menu.MT_CLASSIC, quantity: 1, modifier_ids: [] }],
        payment_method: 'CASH',
        order_code: 'ORD-VOID-TEST-01',
      },
    });
    assert.equal(res.status, 201, `Seed order failed: ${res.text}`);
    orderId = res.data.order.id;
    orderCode = res.data.order.order_code;
  });

  it('rejects unauthenticated requests with 401 UNAUTHORIZED', async () => {
    const endpoints = [
      '/api/me',
      '/api/orders',
      '/api/inventory/items',
      '/api/eod/current',
      '/api/audit-logs',
      '/api/dashboard',
    ];
    for (const ep of endpoints) {
      const res = await api(ep);
      assert.equal(res.status, 401, `GET ${ep} without token expected 401, got ${res.status}`);
      assert.equal(res.data?.error?.code, 'UNAUTHORIZED');
    }
  });

  it('CASHIER void without PIN, with wrong PIN, or with CASHIER/BARISTA PIN returns 422 INVALID_PIN', async () => {
    // Missing PIN
    const noPin = await api(`/api/orders/${orderId}/void`, {
      method: 'POST',
      token: tokens.cashier,
      body: { reason: 'Khách đổi ý' },
    });
    assert.equal(noPin.status, 422);
    assert.equal(noPin.data?.error?.code, 'INVALID_PIN');

    // Wrong PIN
    const wrongPin = await api(`/api/orders/${orderId}/void`, {
      method: 'POST',
      token: tokens.cashier,
      body: { reason: 'Khách đổi ý', approver_pin: '0000' },
    });
    assert.equal(wrongPin.status, 422);
    assert.equal(wrongPin.data?.error?.code, 'INVALID_PIN');

    // CASHIER's own PIN (1111)
    const cashierPin = await api(`/api/orders/${orderId}/void`, {
      method: 'POST',
      token: tokens.cashier,
      body: { reason: 'Khách đổi ý', approver_pin: '1111' },
    });
    assert.equal(cashierPin.status, 422);
    assert.equal(cashierPin.data?.error?.code, 'INVALID_PIN');

    // BARISTA's PIN (2222)
    const baristaPin = await api(`/api/orders/${orderId}/void`, {
      method: 'POST',
      token: tokens.cashier,
      body: { reason: 'Khách đổi ý', approver_pin: '2222' },
    });
    assert.equal(baristaPin.status, 422);
    assert.equal(baristaPin.data?.error?.code, 'INVALID_PIN');
  });

  it('rejects void with missing/blank reason with 400 VALIDATION_ERROR', async () => {
    const res1 = await api(`/api/orders/${orderId}/void`, {
      method: 'POST',
      token: tokens.cashier,
      body: { approver_pin: '2468' },
    });
    assert.equal(res1.status, 400);
    assert.equal(res1.data?.error?.code, 'VALIDATION_ERROR');

    const res2 = await api(`/api/orders/${orderId}/void`, {
      method: 'POST',
      token: tokens.cashier,
      body: { reason: '   ', approver_pin: '2468' },
    });
    assert.equal(res2.status, 400);
    assert.equal(res2.data?.error?.code, 'VALIDATION_ERROR');
  });

  it('CASHIER void with MANAGER PIN 2468 succeeds -> VOIDED, records void_approved_by_name and POS_VOID_PAID audit log', async () => {
    const res = await api(`/api/orders/${orderId}/void`, {
      method: 'POST',
      token: tokens.cashier,
      body: { reason: 'Khách đổi sang món khác', approver_pin: '2468' },
    });
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${res.text}`);
    assert.equal(res.data.id, orderId);
    assert.equal(res.data.order_code, orderCode);
    assert.equal(res.data.status, 'VOIDED');
    assert.equal(res.data.void_reason, 'Khách đổi sang món khác');
    assert.ok(
      res.data.void_approved_by_name && res.data.void_approved_by_name.includes('Trần Lan'),
      `Expected manager name in void_approved_by_name, got ${res.data.void_approved_by_name}`
    );

    // Audit log check by OWNER
    const auditRes = await api('/api/audit-logs?limit=50', { token: tokens.owner });
    assert.equal(auditRes.status, 200);
    const voidLog = auditRes.data.find(
      (a) => a.action_code === 'POS_VOID_PAID' && a.entity_id === orderId
    );
    assert.ok(voidLog, 'Audit log should contain POS_VOID_PAID for voided order');
    assert.ok(voidLog.approver_name && voidLog.approver_name.includes('Trần Lan'));
    assert.equal(voidLog.reason, 'Khách đổi sang món khác');
  });

  it('rejects voiding an already VOIDED order with 409 INVALID_STATE', async () => {
    const res = await api(`/api/orders/${orderId}/void`, {
      method: 'POST',
      token: tokens.owner,
      body: { reason: 'Hủy lại' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.data?.error?.code, 'INVALID_STATE');
  });

  it('restricts GET /api/audit-logs and GET /api/dashboard to OWNER only (403 for others)', async () => {
    for (const role of ['manager', 'cashier', 'barista']) {
      const aRes = await api('/api/audit-logs', { token: tokens[role] });
      assert.equal(aRes.status, 403, `${role} GET /api/audit-logs expected 403`);
      const dRes = await api('/api/dashboard', { token: tokens[role] });
      assert.equal(dRes.status, 403, `${role} GET /api/dashboard expected 403`);
    }

    const dashOwner = await api('/api/dashboard', { token: tokens.owner });
    assert.equal(dashOwner.status, 200);
    assert.equal(typeof dashOwner.data.revenue, 'number');
    assert.equal(typeof dashOwner.data.paid_orders, 'number');
    assert.equal(typeof dashOwner.data.voided_orders, 'number');
    assert.ok(dashOwner.data.voided_orders >= 1);
  });

  it('RBAC on inventory & cost visibility: CASHIER gets 403, MANAGER/BARISTA see no cost keys, OWNER sees costs', async () => {
    const cItems = await api('/api/inventory/items', { token: tokens.cashier });
    assert.equal(cItems.status, 403);
    const cBatches = await api('/api/inventory/batches', { token: tokens.cashier });
    assert.equal(cBatches.status, 403);
    const cLedger = await api('/api/inventory/ledger', { token: tokens.cashier });
    assert.equal(cLedger.status, 403);

    for (const role of ['manager', 'barista']) {
      const iRes = await api('/api/inventory/items', { token: tokens[role] });
      assert.equal(iRes.status, 200);
      assertNoKeys(iRes.data, FORBIDDEN_COST_KEYS, `${role} GET /api/inventory/items`);

      const bRes = await api('/api/inventory/batches', { token: tokens[role] });
      assert.equal(bRes.status, 200);
      assertNoKeys(bRes.data, FORBIDDEN_COST_KEYS, `${role} GET /api/inventory/batches`);

      const lRes = await api('/api/inventory/ledger', { token: tokens[role] });
      assert.equal(lRes.status, 200);
      assertNoKeys(lRes.data, FORBIDDEN_COST_KEYS, `${role} GET /api/inventory/ledger`);

      const mRes = await api('/api/menu', { token: tokens[role] });
      assert.equal(mRes.status, 200);
      assertNoKeys(mRes.data, FORBIDDEN_COST_KEYS, `${role} GET /api/menu`);
    }

    const ownerItems = await api('/api/inventory/items', { token: tokens.owner });
    assert.equal(ownerItems.status, 200);
    assert.ok(ownerItems.data.every((i) => typeof i.avg_unit_cost === 'number'));

    const ownerBatches = await api('/api/inventory/batches', { token: tokens.owner });
    assert.equal(ownerBatches.status, 200);
    assert.ok(ownerBatches.data.every((b) => typeof b.unit_cost === 'number'));
  });

  it('blocks MANAGER from POST /api/inventory/purchases and POST /api/menu/:id/recipe-version with 403', async () => {
    const pRes = await api('/api/inventory/purchases', {
      method: 'POST',
      token: tokens.manager,
      body: {
        item_id: IDS.items.MILK_FRESH,
        qty_base: 1000,
        unit_cost: 34,
        expires_at: new Date(Date.now() + 5 * 86400_000).toISOString(),
      },
    });
    assert.equal(pRes.status, 403);

    const rRes = await api(`/api/menu/${IDS.menu.MT_CLASSIC}/recipe-version`, {
      method: 'POST',
      token: tokens.manager,
      body: {},
    });
    assert.equal(rRes.status, 403);
  });

  it('OWNER recipe-version bumps version_no while existing orders keep old recipe_version_id', async () => {
    // Create an order on v1 before bumping
    const preOrderRes = await api('/api/orders', {
      method: 'POST',
      token: tokens.cashier,
      body: {
        items: [{ menu_item_id: IDS.menu.TEA_BLACK, quantity: 1, modifier_ids: [] }],
        payment_method: 'CASH',
        order_code: 'ORD-PRE-BUMP',
      },
    });
    assert.equal(preOrderRes.status, 201);

    const bumpRes = await api(`/api/menu/${IDS.menu.TEA_BLACK}/recipe-version`, {
      method: 'POST',
      token: tokens.owner,
      body: {
        lines: [
          { item_id: IDS.items.PREP_TEA, qty_base: 220, ingredient_role: 'BASE_TEA' },
          { item_id: IDS.items.SUGAR_SYRUP, qty_base: 30, ingredient_role: 'SUGAR' },
          { item_id: IDS.items.CUP_500ML, qty_base: 1, ingredient_role: 'CUP' },
        ],
        sop_steps: ['1. Đong 220ml hồng trà', '2. Thêm 30ml đường', '3. Thêm đá'],
      },
    });
    assert.ok(
      [200, 201].includes(bumpRes.status),
      `Bump failed (${bumpRes.status}): ${bumpRes.text}`
    );
    assert.equal(bumpRes.data.version_no, 2);

    // Check menu now returns version 2
    const menuRes = await api('/api/menu', { token: tokens.owner });
    assert.equal(menuRes.status, 200);
    const teaBlack = menuRes.data.find((m) => m.id === IDS.menu.TEA_BLACK);
    assert.equal(teaBlack.recipe.version_no, 2);
    assert.notEqual(teaBlack.recipe.id, IDS.recipes.TEA_BLACK_V1);

    // Check audit log recorded BOM_VERSION_BUMP
    const auditRes = await api('/api/audit-logs?limit=20', { token: tokens.owner });
    assert.equal(auditRes.status, 200);
    const bomAudit = auditRes.data.find((a) => a.action_code === 'BOM_VERSION_BUMP');
    assert.ok(bomAudit, 'Expected BOM_VERSION_BUMP in audit_logs');

    // Old order (ORD-PRE-BUMP) should still have old COGS / recipe snapshot; new order uses v2
    const postOrderRes = await api('/api/orders', {
      method: 'POST',
      token: tokens.owner,
      body: {
        items: [{ menu_item_id: IDS.menu.TEA_BLACK, quantity: 1, modifier_ids: [] }],
        payment_method: 'CASH',
        order_code: 'ORD-POST-BUMP',
      },
    });
    assert.equal(postOrderRes.status, 201);
    // v1 used 200ml tea (50ml remaining in TEA-MORNING-01 @8 + 150ml TEA-NOON-02 @9 = 1750) + 35ml sugar @25 (875) + 1 cup @950 = 3575
    // v2 uses 220ml tea @9 (1980) + 30ml sugar @25 (750) + 1 cup @950 = 3680
    const ordersRes = await api('/api/orders', { token: tokens.owner });
    const preOrd = ordersRes.data.find((o) => o.order_code === 'ORD-PRE-BUMP');
    const postOrd = ordersRes.data.find((o) => o.order_code === 'ORD-POST-BUMP');
    assert.equal(preOrd.cogs, 3575);
    assert.equal(postOrd.cogs, 3680);

    // Also verify in DB that old order kept TEA_BLACK_V1 while new order uses bumped recipe id
    const pgMod = await import('pg');
    const { DB_CONFIG } = await import('./helpers.js');
    const client = new pgMod.default.Client(DB_CONFIG);
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT o.order_code, oi.recipe_version_id
         FROM pos_orders o JOIN pos_order_items oi ON oi.order_id = o.id
         WHERE o.order_code IN ('ORD-PRE-BUMP', 'ORD-POST-BUMP')`
      );
      const byCode = Object.fromEntries(rows.map((r) => [r.order_code, r.recipe_version_id]));
      assert.equal(byCode['ORD-PRE-BUMP'], IDS.recipes.TEA_BLACK_V1);
      assert.equal(byCode['ORD-POST-BUMP'], teaBlack.recipe.id);
    } finally {
      await client.end();
    }
  });
});
