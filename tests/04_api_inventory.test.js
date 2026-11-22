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

describe('04. Inventory Prep, Waste Approval/FEFO & Purchases', () => {
  let tokens;

  before(async () => {
    const ownerToken = await demoLogin('OWNER');
    await resetDemo(ownerToken);
    tokens = await loginAllRoles();
  });

  it('BARISTA prep creates SEMI_FINISHED batch with PREP_IN ledger and exact expiry hours (6h tea, 4h pearl)', async () => {
    const beforeTea = Date.now();
    const teaRes = await api('/api/inventory/prep', {
      method: 'POST',
      token: tokens.barista,
      body: {
        semi_item_id: IDS.items.PREP_TEA,
        yield_qty_base: 2000,
        notes: 'Nấu mẻ trà chiều',
      },
    });
    assert.equal(teaRes.status, 201, `Prep tea failed: ${teaRes.text}`);
    assertNoKeys(teaRes.data, FORBIDDEN_COST_KEYS, 'BARISTA POST /api/inventory/prep');
    assert.ok(teaRes.data.prep_id);
    assert.ok(teaRes.data.batch);
    assert.match(teaRes.data.batch.batch_code, /^PREP-TEA-PREP-\d{14}$/);
    assert.equal(teaRes.data.batch.initial_qty_base, 2000);
    assert.equal(teaRes.data.batch.remaining_qty_base, 2000);

    const teaExpHours =
      (new Date(teaRes.data.batch.expires_at).getTime() -
        new Date(teaRes.data.batch.received_at || beforeTea).getTime()) /
      3600_000;
    assert.ok(
      teaExpHours >= 5.9 && teaExpHours <= 6.1,
      `PREP-TEA expiry should be ~6h, got ${teaExpHours}h`
    );

    const beforePearl = Date.now();
    const pearlRes = await api('/api/inventory/prep', {
      method: 'POST',
      token: tokens.barista,
      body: {
        semi_item_id: IDS.items.PREP_PEARL,
        yield_qty_base: 500,
      },
    });
    assert.equal(pearlRes.status, 201, `Prep pearl failed: ${pearlRes.text}`);
    assertNoKeys(pearlRes.data, FORBIDDEN_COST_KEYS, 'BARISTA prep pearl');
    assert.match(pearlRes.data.batch.batch_code, /^PREP-PEARL-PREP-\d{14}$/);

    const pearlExpHours =
      (new Date(pearlRes.data.batch.expires_at).getTime() -
        new Date(pearlRes.data.batch.received_at || beforePearl).getTime()) /
      3600_000;
    assert.ok(
      pearlExpHours >= 3.9 && pearlExpHours <= 4.1,
      `PREP-PEARL expiry should be ~4h, got ${pearlExpHours}h`
    );

    // Verify PREP_IN rows exist in ledger
    const ledgerRes = await api('/api/inventory/ledger?limit=50', { token: tokens.owner });
    assert.equal(ledgerRes.status, 200);
    const teaLedger = ledgerRes.data.find(
      (l) => l.txn_type === 'PREP_IN' && l.ref_id === teaRes.data.prep_id
    );
    assert.ok(teaLedger, 'Ledger should contain PREP_IN for tea prep');
    assert.equal(teaLedger.ref_table, 'prep_productions');
    assert.equal(teaLedger.qty_change_base, 2000);
  });

  it('rejects prep on non-SEMI_FINISHED item (e.g. RAW MILK-FRESH) with 400', async () => {
    const res = await api('/api/inventory/prep', {
      method: 'POST',
      token: tokens.barista,
      body: {
        semi_item_id: IDS.items.MILK_FRESH,
        yield_qty_base: 500,
      },
    });
    assert.equal(res.status, 400);
    assert.equal(res.data?.error?.code, 'VALIDATION_ERROR');
  });

  it('rejects waste when camera_photo_url does not start with camera:// (400)', async () => {
    const res = await api('/api/waste', {
      method: 'POST',
      token: tokens.barista,
      body: {
        item_id: IDS.items.MILK_FRESH,
        qty_base: 100,
        reason_code: 'SPILL',
        camera_photo_url: 'https://example.com/gallery.jpg',
      },
    });
    assert.equal(res.status, 400);
    assert.equal(res.data?.error?.code, 'VALIDATION_ERROR');

    const emptyRes = await api('/api/waste', {
      method: 'POST',
      token: tokens.barista,
      body: {
        item_id: IDS.items.MILK_FRESH,
        qty_base: 100,
        reason_code: 'SPILL',
        camera_photo_url: '',
      },
    });
    assert.equal(emptyRes.status, 400);
  });

  it('waste workflow: BARISTA creates PENDING, BARISTA cannot approve (403), MANAGER approves -> APPROVED & WASTE ledger', async () => {
    const createRes = await api('/api/waste', {
      method: 'POST',
      token: tokens.barista,
      body: {
        item_id: IDS.items.MILK_FRESH,
        qty_base: 50,
        reason_code: 'SPILL',
        notes: 'Đổ ca đong sữa',
        camera_photo_url: 'camera://waste/spill_001.jpg',
      },
    });
    assert.equal(createRes.status, 201, `Create waste failed: ${createRes.text}`);
    assertNoKeys(createRes.data, FORBIDDEN_COST_KEYS, 'BARISTA POST /api/waste');
    assert.equal(createRes.data.status, 'PENDING');

    const wasteId = createRes.data.id;

    // BARISTA cannot approve
    const baristaApprove = await api(`/api/waste/${wasteId}/approve`, {
      method: 'POST',
      token: tokens.barista,
    });
    assert.equal(baristaApprove.status, 403);

    // MANAGER approves
    const mgrApprove = await api(`/api/waste/${wasteId}/approve`, {
      method: 'POST',
      token: tokens.manager,
    });
    assert.equal(mgrApprove.status, 200, `Manager approve failed: ${mgrApprove.text}`);
    assertNoKeys(mgrApprove.data, FORBIDDEN_COST_KEYS, 'MANAGER approve waste');
    assert.equal(mgrApprove.data.status, 'APPROVED');

    // Re-approving APPROVED waste -> 409
    const reApprove = await api(`/api/waste/${wasteId}/approve`, {
      method: 'POST',
      token: tokens.manager,
    });
    assert.equal(reApprove.status, 409);

    // Verify WASTE ledger row exists and FEFO deducted from MILK-FEFO-01 (150 -> 100)
    const ledgerRes = await api('/api/inventory/ledger?limit=50', { token: tokens.owner });
    const wasteLedger = ledgerRes.data.find(
      (l) => l.txn_type === 'WASTE' && l.ref_id === wasteId
    );
    assert.ok(wasteLedger, 'Ledger should contain WASTE row for approved waste');
    assert.equal(wasteLedger.ref_table, 'waste_records');
    assert.equal(wasteLedger.qty_change_base, -50);

    const batchesRes = await api('/api/inventory/batches', { token: tokens.owner });
    const fefo1 = batchesRes.data.find((b) => b.batch_code === 'MILK-FEFO-01');
    assert.equal(fefo1.remaining_qty_base, 100);
  });

  it('waste with EXPIRED reason for MILK-FRESH 500 consumes expired MILK-EXPIRED-00 batch first', async () => {
    const createRes = await api('/api/waste', {
      method: 'POST',
      token: tokens.barista,
      body: {
        item_id: IDS.items.MILK_FRESH,
        qty_base: 500,
        reason_code: 'EXPIRED',
        notes: 'Hủy lô sữa quá hạn',
        camera_photo_url: 'camera://waste/expired_milk.jpg',
      },
    });
    assert.equal(createRes.status, 201);
    const wasteId = createRes.data.id;

    const approveRes = await api(`/api/waste/${wasteId}/approve`, {
      method: 'POST',
      token: tokens.manager,
    });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.data.status, 'APPROVED');

    const batchesRes = await api('/api/inventory/batches', { token: tokens.owner });
    const byCode = Object.fromEntries(batchesRes.data.map((b) => [b.batch_code, b]));
    assert.equal(byCode['MILK-EXPIRED-00'].remaining_qty_base, 0);
    assert.equal(byCode['MILK-FEFO-01'].remaining_qty_base, 100);
    assert.equal(byCode['MILK-FEFO-02'].remaining_qty_base, 1000);

    // Ledger row should point to MILK-EXPIRED-00
    const ledgerRes = await api('/api/inventory/ledger?limit=50', { token: tokens.owner });
    const wasteLedger = ledgerRes.data.find(
      (l) => l.txn_type === 'WASTE' && l.ref_id === wasteId
    );
    assert.ok(wasteLedger);
    assert.equal(wasteLedger.batch_code, 'MILK-EXPIRED-00');
    assert.equal(wasteLedger.qty_change_base, -500);
  });

  it('OWNER purchase creates inventory batch, PURCHASE ledger, and updates weighted avg_unit_cost', async () => {
    const expDate = new Date(Date.now() + 7 * 86400_000).toISOString();
    const res = await api('/api/inventory/purchases', {
      method: 'POST',
      token: tokens.owner,
      body: {
        item_id: IDS.items.MILK_FRESH,
        qty_base: 1000,
        unit_cost: 40,
        expires_at: expDate,
        batch_code: 'MILK-PURCH-TEST',
      },
    });
    assert.equal(res.status, 201, `Purchase failed: ${res.text}`);
    assert.equal(res.data.batch_code, 'MILK-PURCH-TEST');
    assert.equal(res.data.initial_qty_base, 1000);
    assert.equal(res.data.remaining_qty_base, 1000);
    assert.equal(res.data.unit_cost, 40);

    const ledgerRes = await api('/api/inventory/ledger?limit=50', { token: tokens.owner });
    const purchLedger = ledgerRes.data.find(
      (l) => l.txn_type === 'PURCHASE' && l.ref_id === res.data.id
    );
    assert.ok(purchLedger, 'Ledger should contain PURCHASE row');
    assert.equal(purchLedger.ref_table, 'inventory_batches');
    assert.equal(purchLedger.qty_change_base, 1000);

    // Valid stock now: 100*30 + 1000*35 + 1000*40 = 78000 / 2100 = 37.1429
    const itemsRes = await api('/api/inventory/items', { token: tokens.owner });
    const milk = itemsRes.data.find((i) => i.id === IDS.items.MILK_FRESH);
    assert.ok(milk);
    assert.equal(milk.valid_stock, 2100);
    assert.ok(
      Math.abs(milk.avg_unit_cost - 78000 / 2100) < 0.01,
      `Expected avg_unit_cost ~37.1429, got ${milk.avg_unit_cost}`
    );
  });
});
