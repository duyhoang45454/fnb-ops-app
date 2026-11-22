const express = require('express');
const { AppError, query, withTransaction, getCurrentShift, insertAuditLog } = require('../db');
const { authenticate, requireRole, getClientIp } = require('../auth');

const router = express.Router();

router.use(authenticate);

router.get('/current', async (req, res, next) => {
  try {
    const { rows: shiftRows } = await query(
      `SELECT ws.id, ws.shift_date, ws.shift_slot, ws.status, ws.opened_at, ws.closed_at,
              ws.opening_cash, ws.blind_cash_counted, ws.expected_cash_pos, ws.cash_variance,
              u.full_name AS manager_name
       FROM work_shifts ws
       JOIN users u ON u.id = ws.manager_id
       ORDER BY ws.opened_at DESC
       LIMIT 1`
    );

    if (!shiftRows.length) {
      throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy ca làm việc.');
    }
    const shift = shiftRows[0];

    const payload = {
      id: shift.id,
      shift_date: shift.shift_date instanceof Date
        ? shift.shift_date.toISOString().slice(0, 10)
        : String(shift.shift_date).slice(0, 10),
      shift_slot: shift.shift_slot,
      status: shift.status,
      opened_at: shift.opened_at,
      closed_at: shift.closed_at,
      opening_cash: shift.opening_cash,
      blind_cash_counted: shift.blind_cash_counted,
      manager_name: shift.manager_name,
    };

    if (req.user.role === 'OWNER') {
      const { rows: cashRows } = await query(
        `SELECT COALESCE(SUM(total_amount), 0) AS cash_sales
         FROM pos_orders
         WHERE shift_id = $1 AND status = 'PAID' AND payment_method = 'CASH'`,
        [shift.id]
      );
      const expectedLive = Math.round((shift.opening_cash + (cashRows[0].cash_sales || 0)) * 100) / 100;
      const expectedCash = shift.status === 'OPEN'
        ? expectedLive
        : (shift.expected_cash_pos !== null ? shift.expected_cash_pos : expectedLive);
      const cashVariance = shift.blind_cash_counted !== null
        ? Math.round((shift.blind_cash_counted - expectedCash) * 100) / 100
        : (shift.cash_variance !== null ? shift.cash_variance : null);

      payload.expected_cash_pos = expectedCash;
      payload.cash_variance = cashVariance;
    }

    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

router.post('/blind-close', requireRole('OWNER', 'MANAGER', 'CASHIER'), async (req, res, next) => {
  try {
    const countedRaw = req.body?.counted_cash;
    if (typeof countedRaw !== 'number' || !Number.isFinite(countedRaw) || countedRaw < 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Số tiền mặt thực đếm (counted_cash) phải là số >= 0.');
    }
    const countedCash = Math.round(countedRaw * 100) / 100;

    const result = await withTransaction(async (client) => {
      const shift = await getCurrentShift(client, { forUpdate: true });
      if (shift.status !== 'OPEN') {
        throw new AppError(409, 'SHIFT_CLOSED', 'Ca làm việc hiện tại đã đóng, không thể chốt két.');
      }

      const { rows: cashRows } = await client.query(
        `SELECT COALESCE(SUM(total_amount), 0) AS cash_sales
         FROM pos_orders
         WHERE shift_id = $1 AND status = 'PAID' AND payment_method = 'CASH'`,
        [shift.id]
      );
      const expectedCash = Math.round((shift.opening_cash + (cashRows[0].cash_sales || 0)) * 100) / 100;
      const cashVariance = Math.round((countedCash - expectedCash) * 100) / 100;

      const { rows: updated } = await client.query(
        `UPDATE work_shifts
         SET blind_cash_counted = $1,
             expected_cash_pos = $2,
             cash_variance = $3,
             closed_at = NOW(),
             status = 'CLOSED'
         WHERE id = $4
         RETURNING status, blind_cash_counted, expected_cash_pos, cash_variance, closed_at`,
        [countedCash, expectedCash, cashVariance, shift.id]
      );

      await insertAuditLog(client, {
        actorId: req.user.id,
        actionCode: 'SHIFT_BLIND_CASH_CLOSE',
        entityTable: 'work_shifts',
        entityId: shift.id,
        oldValues: { status: shift.status },
        newValues: {
          status: 'CLOSED',
          blind_cash_counted: countedCash,
          expected_cash_pos: expectedCash,
          cash_variance: cashVariance,
        },
        reason: `Chốt két mù cuối ca, thực đếm ${countedCash}đ`,
        deviceIp: getClientIp(req),
      });

      return updated[0];
    });

    const resp = {
      status: result.status,
      blind_cash_counted: result.blind_cash_counted,
    };
    if (req.user.role === 'OWNER') {
      resp.expected_cash_pos = result.expected_cash_pos;
      resp.cash_variance = result.cash_variance;
    }

    return res.json(resp);
  } catch (err) {
    return next(err);
  }
});

router.post('/reopen', requireRole('OWNER'), async (req, res, next) => {
  try {
    const result = await withTransaction(async (client) => {
      const shift = await getCurrentShift(client, { forUpdate: true });
      const oldValues = {
        status: shift.status,
        closed_at: shift.closed_at,
        blind_cash_counted: shift.blind_cash_counted,
        expected_cash_pos: shift.expected_cash_pos,
        cash_variance: shift.cash_variance,
      };

      const { rows: updated } = await client.query(
        `UPDATE work_shifts
         SET status = 'OPEN',
             closed_at = NULL,
             blind_cash_counted = NULL,
             expected_cash_pos = NULL,
             cash_variance = NULL
         WHERE id = $1
         RETURNING id, shift_date, shift_slot, status, opened_at, closed_at, opening_cash, blind_cash_counted`,
        [shift.id]
      );

      await insertAuditLog(client, {
        actorId: req.user.id,
        actionCode: 'SHIFT_REOPEN',
        entityTable: 'work_shifts',
        entityId: shift.id,
        oldValues,
        newValues: { status: 'OPEN' },
        reason: 'Chủ quán mở lại ca làm việc',
        deviceIp: getClientIp(req),
      });

      return updated[0];
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
