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

describe('02. POS Orders, FEFO API & Cost Visibility', () => {
  let tokens;

  before(async () => {
    const ownerToken = await demoLogin('OWNER');
    await resetDemo(ownerToken);
    tokens = await loginAllRoles();
  });

  it('GET /api/health returns {ok:true, db:true} without auth', async () => {
    const res = await api('/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { ok: true, db: true });
  });

  it('CASHIER executes canonical ORD-TEST-001 order; OWNER sees exact COGS & FEFO batches; CASHIER sees no cost keys', async () => {
    const createRes = await api('/api/orders', {
      method: 'POST',
      token: tokens.cashier,
      body: {
        items: [
          {
            menu_item_id: IDS.menu.MT_CLASSIC,
            quantity: 2,
            modifier_ids: [
              IDS.modifiers.SIZE_L,
              IDS.modifiers.SUGAR_0,
              IDS.modifiers.TOPPING_PEARL,
            ],
          },
        ],
        payment_method: 'QR_TRANSFER',
        order_code: 'ORD-TEST-001',
      },
    });

    assert.equal(createRes.status, 201, `Expected 201, got ${createRes.status}: ${createRes.text}`);
    assertNoKeys(createRes.data, FORBIDDEN_COST_KEYS, 'CASHIER POST /api/orders');

    const { order, deduction } = createRes.data;
    assert.equal(order.order_code, 'ORD-TEST-001');
    assert.equal(order.status, 'PAID');
    assert.equal(order.payment_method, 'QR_TRANSFER');
    assert.equal(typeof order.total_amount, 'number');
    assert.equal(order.total_amount, 100000);
    assert.equal(order.subtotal, 100000);
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].quantity, 2);
    assert.equal(order.items[0].unit_price, 50000);

    const milkAlert = deduction.low_stock_alerts.find((a) => a.sku === 'MILK-FRESH');
    assert.ok(milkAlert, 'low_stock_alerts should include MILK-FRESH');
    assert.equal(typeof milkAlert.remaining_valid_qty, 'number');
    assert.equal(milkAlert.remaining_valid_qty, 890);

    // CASHIER GET /api/orders must also hide cost keys
    const cashierOrdersRes = await api('/api/orders', { token: tokens.cashier });
    assert.equal(cashierOrdersRes.status, 200);
    assertNoKeys(cashierOrdersRes.data, FORBIDDEN_COST_KEYS, 'CASHIER GET /api/orders');

    // OWNER GET /api/orders sees cogs = 18560
    const ownerOrdersRes = await api('/api/orders', { token: tokens.owner });
    assert.equal(ownerOrdersRes.status, 200);
    const ord = ownerOrdersRes.data.find((o) => o.order_code === 'ORD-TEST-001');
    assert.ok(ord, 'OWNER should see ORD-TEST-001');
    assert.equal(typeof ord.cogs, 'number');
    assert.equal(ord.cogs, 18560);

    // OWNER GET /api/inventory/batches verifies FEFO & expired skip
    const batchesRes = await api('/api/inventory/batches', { token: tokens.owner });
    assert.equal(batchesRes.status, 200);
    const byCode = Object.fromEntries(batchesRes.data.map((b) => [b.batch_code, b]));

    assert.equal(byCode['MILK-EXPIRED-00'].remaining_qty_base, 500);
    assert.equal(byCode['MILK-EXPIRED-00'].is_expired, true);
    assert.equal(byCode['MILK-FEFO-01'].remaining_qty_base, 0);
    assert.equal(byCode['MILK-FEFO-02'].remaining_qty_base, 890);
    assert.equal(byCode['TEA-MORNING-01'].remaining_qty_base, 0);
    assert.equal(byCode['TEA-NOON-02'].remaining_qty_base, 2810);
    assert.equal(byCode['PEARL-NOON-01'].remaining_qty_base, 900);
    assert.equal(byCode['CUP700-LOT-01'].remaining_qty_base, 198);
    assert.equal(byCode['SUGAR-LOT-01'].remaining_qty_base, 2000);
  });

  it('rejects duplicate order_code with 409 CONFLICT', async () => {
    const res = await api('/api/orders', {
      method: 'POST',
      token: tokens.cashier,
      body: {
        items: [{ menu_item_id: IDS.menu.TEA_BLACK, quantity: 1, modifier_ids: [] }],
        payment_method: 'CASH',
        order_code: 'ORD-TEST-001',
      },
    });
    assert.equal(res.status, 409);
    assert.equal(res.data?.error?.code, 'CONFLICT');
  });

  it('blocks BARISTA from POST /api/orders with 403 FORBIDDEN', async () => {
    const res = await api('/api/orders', {
      method: 'POST',
      token: tokens.barista,
      body: {
        items: [{ menu_item_id: IDS.menu.TEA_BLACK, quantity: 1, modifier_ids: [] }],
        payment_method: 'CASH',
      },
    });
    assert.equal(res.status, 403);
    assert.equal(res.data?.error?.code, 'FORBIDDEN');
  });

  it('returns 409 when ordering an unavailable menu item, and 201 after restoring availability', async () => {
    const offRes = await api(`/api/menu/${IDS.menu.TEA_BLACK}/availability`, {
      method: 'PATCH',
      token: tokens.manager,
      body: { is_available: false },
    });
    assert.equal(offRes.status, 200);

    const orderRes = await api('/api/orders', {
      method: 'POST',
      token: tokens.cashier,
      body: {
        items: [{ menu_item_id: IDS.menu.TEA_BLACK, quantity: 1, modifier_ids: [] }],
        payment_method: 'CASH',
      },
    });
    assert.equal(orderRes.status, 409);

    const onRes = await api(`/api/menu/${IDS.menu.TEA_BLACK}/availability`, {
      method: 'PATCH',
      token: tokens.manager,
      body: { is_available: true },
    });
    assert.equal(onRes.status, 200);
  });

  it('rejects empty items array with 400 VALIDATION_ERROR', async () => {
    const res = await api('/api/orders', {
      method: 'POST',
      token: tokens.cashier,
      body: {
        items: [],
        payment_method: 'CASH',
      },
    });
    assert.equal(res.status, 400);
    assert.equal(res.data?.error?.code, 'VALIDATION_ERROR');
  });

  it('generates default order_code in ORD-YYYYMMDD-NNN format when omitted', async () => {
    const res = await api('/api/orders', {
      method: 'POST',
      token: tokens.cashier,
      body: {
        items: [{ menu_item_id: IDS.menu.TEA_BLACK, quantity: 1, modifier_ids: [] }],
        payment_method: 'CASH',
      },
    });
    assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${res.text}`);
    assertNoKeys(res.data, FORBIDDEN_COST_KEYS, 'CASHIER default order_code POST /api/orders');
    assert.match(res.data.order.order_code, /^ORD-\d{8}-\d{3}$/);
  });

  it('CASHIER GET /api/menu hides lines, sop_steps, and all cost keys; OWNER sees est_cogs', async () => {
    const cashierMenu = await api('/api/menu', { token: tokens.cashier });
    assert.equal(cashierMenu.status, 200);
    assertNoKeys(cashierMenu.data, FORBIDDEN_COST_KEYS, 'CASHIER GET /api/menu');
    for (const item of cashierMenu.data) {
      assert.ok(item.recipe, 'menu item should include recipe summary');
      assert.equal(typeof item.recipe.id, 'string');
      assert.equal(typeof item.recipe.version_no, 'number');
      assert.equal(item.recipe.lines, undefined, 'CASHIER should not see recipe.lines');
      assert.equal(item.recipe.sop_steps, undefined, 'CASHIER should not see recipe.sop_steps');
    }

    const ownerMenu = await api('/api/menu', { token: tokens.owner });
    assert.equal(ownerMenu.status, 200);
    for (const item of ownerMenu.data) {
      assert.equal(typeof item.recipe.est_cogs, 'number');
      assert.ok(Array.isArray(item.recipe.lines));
      assert.ok(Array.isArray(item.recipe.sop_steps));
    }
  });
});
