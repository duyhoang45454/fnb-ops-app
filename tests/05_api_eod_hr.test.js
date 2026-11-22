import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  api,
  demoLogin,
  resetDemo,
  loginAllRoles,
  assertNoKeys,
  FORBIDDEN_COST_KEYS,
  EOD_THEORETICAL_KEYS,
  IDS,
} from './helpers.js';

describe('05. EOD Blind Count, Lock/Reopen, HR Attendance & Blind Cash Close', () => {
  let tokens;

  before(async () => {
    const ownerToken = await demoLogin('OWNER');
    await resetDemo(ownerToken);
    tokens = await loginAllRoles();
  });

  describe('EOD Blind Reconciliation', () => {
    it('GET /api/eod/current creates DRAFT_COUNTING with ABC class A items and hides theoretical keys even from OWNER while DRAFT', async () => {
      // Sell ORD-TEST-001 first (2x MT-CLASSIC Size L, 0% Sugar, Pearl) so pos_usage & cups have activity
      const orderRes = await api('/api/orders', {
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
          payment_method: 'CASH',
          order_code: 'ORD-EOD-001',
        },
      });
      assert.equal(orderRes.status, 201);

      // MANAGER fetches current EOD -> auto-creates DRAFT_COUNTING
      const mgrEod = await api('/api/eod/current', { token: tokens.manager });
      assert.equal(mgrEod.status, 200, `MANAGER GET /api/eod/current failed: ${mgrEod.text}`);
      assert.equal(mgrEod.data.status, 'DRAFT_COUNTING');
      assertNoKeys(mgrEod.data, FORBIDDEN_COST_KEYS, 'MANAGER DRAFT EOD');
      assertNoKeys(mgrEod.data, EOD_THEORETICAL_KEYS, 'MANAGER DRAFT EOD');

      // ABC class A items: MILK-FRESH, PREP-TEA, PREP-PEARL, CUP-500ML, CUP-700ML (5 items)
      assert.equal(mgrEod.data.lines.length, 5);

      // Even OWNER must NOT see theoretical keys while DRAFT_COUNTING
      const ownerEod = await api('/api/eod/current', { token: tokens.owner });
      assert.equal(ownerEod.status, 200);
      assert.equal(ownerEod.data.status, 'DRAFT_COUNTING');
      assertNoKeys(ownerEod.data, EOD_THEORETICAL_KEYS, 'OWNER DRAFT EOD');
    });

    it('PUT /api/eod/current/lines computes counted_qty_base with tare weight & count_unit factor', async () => {
      // Expected valid remaining after ORD-EOD-001:
      // MILK-FRESH: 890 (MILK-EXPIRED-00 500 is expired so excluded from theoretical)
      // PREP-TEA: 2810
      // PREP-PEARL: 900
      // CUP-500ML: 200
      // CUP-700ML: 198 -> count 3 sealed (150) + 45 loose = 195 -> variance = -3 -> RED!
      const putRes = await api('/api/eod/current/lines', {
        method: 'PUT',
        token: tokens.manager,
        body: {
          lines: [
            { item_id: IDS.items.MILK_FRESH, counted_sealed_units: 0, weighed_gross_g: 935 }, // 935 - 45 tare = 890 (exact GREEN)
            { item_id: IDS.items.PREP_TEA, counted_sealed_units: 2, weighed_gross_g: 990 }, // 2*1000 + (990 - 180) = 2810 (exact GREEN)
            { item_id: IDS.items.PREP_PEARL, counted_sealed_units: 0, weighed_gross_g: 1120 }, // 1120 - 220 = 900 (exact GREEN)
            { item_id: IDS.items.CUP_500ML, counted_sealed_units: 4, weighed_gross_g: 0 }, // 4*50 = 200 (exact GREEN)
            { item_id: IDS.items.CUP_700ML, counted_sealed_units: 3, weighed_gross_g: 45 }, // 3*50 + 45 = 195 (missing 3 cups -> RED)
          ],
        },
      });
      assert.equal(putRes.status, 200, `PUT lines failed: ${putRes.text}`);
      assertNoKeys(putRes.data, FORBIDDEN_COST_KEYS, 'MANAGER PUT EOD lines');
      assertNoKeys(putRes.data, EOD_THEORETICAL_KEYS, 'MANAGER PUT EOD lines');

      const byItem = Object.fromEntries(putRes.data.lines.map((l) => [l.item_id, l]));
      assert.equal(byItem[IDS.items.MILK_FRESH].counted_qty_base, 890);
      assert.equal(byItem[IDS.items.PREP_TEA].counted_qty_base, 2810);
      assert.equal(byItem[IDS.items.PREP_PEARL].counted_qty_base, 900);
      assert.equal(byItem[IDS.items.CUP_500ML].counted_qty_base, 200);
      assert.equal(byItem[IDS.items.CUP_700ML].counted_qty_base, 195);
    });

    it('POST /api/eod/current/submit hides variance from MANAGER, reveals RED/GREEN & summary to OWNER, blocks PUT after submit', async () => {
      const submitRes = await api('/api/eod/current/submit', {
        method: 'POST',
        token: tokens.manager,
      });
      assert.equal(submitRes.status, 200, `Submit failed: ${submitRes.text}`);
      assert.equal(submitRes.data.status, 'SUBMITTED');
      assertNoKeys(submitRes.data, FORBIDDEN_COST_KEYS, 'MANAGER submit EOD');
      assertNoKeys(submitRes.data, EOD_THEORETICAL_KEYS, 'MANAGER submit EOD');

      // MANAGER GET still hides theoretical keys after submit
      const mgrGet = await api('/api/eod/current', { token: tokens.manager });
      assert.equal(mgrGet.status, 200);
      assert.equal(mgrGet.data.status, 'SUBMITTED');
      assertNoKeys(mgrGet.data, FORBIDDEN_COST_KEYS, 'MANAGER GET SUBMITTED EOD');
      assertNoKeys(mgrGet.data, EOD_THEORETICAL_KEYS, 'MANAGER GET SUBMITTED EOD');

      // OWNER GET reveals theoretical, variance, alert_level, summary
      const ownerGet = await api('/api/eod/current', { token: tokens.owner });
      assert.equal(ownerGet.status, 200);
      assert.equal(ownerGet.data.status, 'SUBMITTED');
      assert.ok(ownerGet.data.summary, 'OWNER should see EOD summary');
      assert.equal(ownerGet.data.summary.red, 1);
      assert.equal(ownerGet.data.summary.green, 4);
      assert.equal(ownerGet.data.summary.yellow, 0);

      const byItem = Object.fromEntries(ownerGet.data.lines.map((l) => [l.item_id, l]));
      const milk = byItem[IDS.items.MILK_FRESH];
      assert.equal(milk.theoretical_qty_base, 890);
      assert.equal(milk.variance_qty_base, 0);
      assert.equal(milk.alert_level, 'GREEN');

      const cup700 = byItem[IDS.items.CUP_700ML];
      assert.equal(cup700.theoretical_qty_base, 198);
      assert.equal(cup700.variance_qty_base, -3);
      assert.equal(cup700.alert_level, 'RED');
      assert.equal(cup700.variance_vnd, -3600);
      assert.equal(ownerGet.data.summary.total_variance_vnd, -3600);

      // PUT lines after submit -> 409 INVALID_STATE
      const putAfter = await api('/api/eod/current/lines', {
        method: 'PUT',
        token: tokens.manager,
        body: {
          lines: [{ item_id: IDS.items.CUP_700ML, counted_sealed_units: 3, weighed_gross_g: 48 }],
        },
      });
      assert.equal(putAfter.status, 409);
      assert.equal(putAfter.data?.error?.code, 'INVALID_STATE');
    });

    it('OWNER can lock and reopen EOD; non-OWNER gets 403 on lock/reopen', async () => {
      const mgrLock = await api('/api/eod/current/lock', {
        method: 'POST',
        token: tokens.manager,
      });
      assert.equal(mgrLock.status, 403);

      const lockRes = await api('/api/eod/current/lock', {
        method: 'POST',
        token: tokens.owner,
      });
      assert.equal(lockRes.status, 200);
      assert.equal(lockRes.data.status, 'LOCKED');

      const mgrReopen = await api('/api/eod/current/reopen', {
        method: 'POST',
        token: tokens.manager,
      });
      assert.equal(mgrReopen.status, 403);

      const reopenRes = await api('/api/eod/current/reopen', {
        method: 'POST',
        token: tokens.owner,
      });
      assert.equal(reopenRes.status, 200);
      assert.equal(reopenRes.data.status, 'DRAFT_COUNTING');
      assertNoKeys(reopenRes.data, EOD_THEORETICAL_KEYS, 'OWNER REOPENED DRAFT EOD');
    });
  });

  describe('HR Attendance & Blind Cash Close', () => {
    it('rejects clock-in with wrong BSSID or far GPS with 422 ATTENDANCE_REJECTED; rejects duplicate open clock-in with 409', async () => {
      // Wrong BSSID
      const badBssid = await api('/api/hr/clock-in', {
        method: 'POST',
        token: tokens.owner,
        body: {
          wifi_bssid: '00:11:22:33:44:55',
          gps_lat: 10.9032,
          gps_lng: 106.7681,
          face_photo_url: 'camera://face/owner.jpg',
        },
      });
      assert.equal(badBssid.status, 422);
      assert.equal(badBssid.data?.error?.code, 'ATTENDANCE_REJECTED');

      // Far GPS (10.80, 106.70 is >13km away)
      const farGps = await api('/api/hr/clock-in', {
        method: 'POST',
        token: tokens.owner,
        body: {
          wifi_bssid: '8C:3B:AD:12:9F',
          gps_lat: 10.8,
          gps_lng: 106.7,
          face_photo_url: 'camera://face/owner.jpg',
        },
      });
      assert.equal(farGps.status, 422);
      assert.equal(farGps.data?.error?.code, 'ATTENDANCE_REJECTED');

      // CASHIER already has an open clock-in in seed -> 409
      const dupClockIn = await api('/api/hr/clock-in', {
        method: 'POST',
        token: tokens.cashier,
        body: {
          wifi_bssid: '8C:3B:AD:12:9F',
          gps_lat: 10.9032,
          gps_lng: 106.7681,
          face_photo_url: 'camera://face/cashier.jpg',
        },
      });
      assert.equal(dupClockIn.status, 409);

      // OWNER has no open attendance in seed -> valid clock-in -> 201
      const okClockIn = await api('/api/hr/clock-in', {
        method: 'POST',
        token: tokens.owner,
        body: {
          wifi_bssid: '8C:3B:AD:12:9F',
          gps_lat: 10.9032,
          gps_lng: 106.7681,
          face_photo_url: 'camera://face/owner.jpg',
        },
      });
      assert.equal(okClockIn.status, 201, `OWNER clock-in failed: ${okClockIn.text}`);

      const attRes = await api('/api/hr/attendance', { token: tokens.owner });
      assert.equal(attRes.status, 200);
      assert.ok(attRes.data.some((a) => a.user_id === IDS.users.OWNER && a.clock_out_at === null));

      // Clock out OWNER, then second clock-out -> 404
      const out1 = await api('/api/hr/clock-out', { method: 'POST', token: tokens.owner });
      assert.equal(out1.status, 200);
      const out2 = await api('/api/hr/clock-out', { method: 'POST', token: tokens.owner });
      assert.equal(out2.status, 404);
    });

    it('blind cash close by CASHIER hides expected_cash_pos & cash_variance; OWNER sees live expected (2,100,000); closed shift blocks POS; reopen restores', async () => {
      // ORD-EOD-001 was CASH 100,000 + opening_cash 2,000,000 => expected_cash_pos = 2,100,000
      const shiftOwnerBefore = await api('/api/shift/current', { token: tokens.owner });
      assert.equal(shiftOwnerBefore.status, 200);
      assert.equal(shiftOwnerBefore.data.opening_cash, 2000000);
      assert.equal(shiftOwnerBefore.data.expected_cash_pos, 2100000);

      const shiftCashierBefore = await api('/api/shift/current', { token: tokens.cashier });
      assert.equal(shiftCashierBefore.status, 200);
      assert.equal(shiftCashierBefore.data.expected_cash_pos, undefined);
      assert.equal(shiftCashierBefore.data.cash_variance, undefined);

      // CASHIER blind closes with 2,095,000 (-5,000 variance)
      const closeRes = await api('/api/shift/blind-close', {
        method: 'POST',
        token: tokens.cashier,
        body: { counted_cash: 2095000 },
      });
      assert.equal(closeRes.status, 200, `Blind close failed: ${closeRes.text}`);
      assert.equal(closeRes.data.status, 'CLOSED');
      assert.equal(closeRes.data.blind_cash_counted, 2095000);
      assert.equal(closeRes.data.expected_cash_pos, undefined, 'CASHIER must not see expected_cash_pos');
      assert.equal(closeRes.data.cash_variance, undefined, 'CASHIER must not see cash_variance');

      // OWNER sees expected_cash_pos = 2100000 and cash_variance = -5000
      const shiftOwnerAfter = await api('/api/shift/current', { token: tokens.owner });
      assert.equal(shiftOwnerAfter.status, 200);
      assert.equal(shiftOwnerAfter.data.status, 'CLOSED');
      assert.equal(shiftOwnerAfter.data.expected_cash_pos, 2100000);
      assert.equal(shiftOwnerAfter.data.cash_variance, -5000);

      // Selling on CLOSED shift -> 409 SHIFT_CLOSED
      const closedOrder = await api('/api/orders', {
        method: 'POST',
        token: tokens.cashier,
        body: {
          items: [{ menu_item_id: IDS.menu.TEA_BLACK, quantity: 1, modifier_ids: [] }],
          payment_method: 'CASH',
        },
      });
      assert.equal(closedOrder.status, 409);
      assert.equal(closedOrder.data?.error?.code, 'SHIFT_CLOSED');

      // Non-OWNER cannot reopen shift -> 403
      const mgrReopen = await api('/api/shift/reopen', {
        method: 'POST',
        token: tokens.manager,
      });
      assert.equal(mgrReopen.status, 403);

      // OWNER reopens shift -> selling works again
      const ownerReopen = await api('/api/shift/reopen', {
        method: 'POST',
        token: tokens.owner,
      });
      assert.equal(ownerReopen.status, 200);

      const sellAgain = await api('/api/orders', {
        method: 'POST',
        token: tokens.cashier,
        body: {
          items: [{ menu_item_id: IDS.menu.TEA_BLACK, quantity: 1, modifier_ids: [] }],
          payment_method: 'CASH',
        },
      });
      assert.equal(sellAgain.status, 201);
    });
  });
});
