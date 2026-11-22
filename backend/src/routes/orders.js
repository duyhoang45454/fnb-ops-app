const express = require('express');
const { AppError, query, withTransaction, getCurrentShift, insertAuditLog, isValidUuid } = require('../db');
const { authenticate, requireRole, getClientIp } = require('../auth');
const { sanitizeForRole } = require('../sanitize');

const router = express.Router();

const PAYMENT_METHODS = ['CASH', 'QR_TRANSFER', 'CARD', 'EWALLET'];

router.use(authenticate);

router.post('/', requireRole('OWNER', 'MANAGER', 'CASHIER'), async (req, res, next) => {
  try {
    const itemsInput = req.body?.items;
    const paymentMethod = typeof req.body?.payment_method === 'string'
      ? req.body.payment_method.trim().toUpperCase()
      : 'CASH';
    const customOrderCode = typeof req.body?.order_code === 'string' ? req.body.order_code.trim() : '';

    if (!Array.isArray(itemsInput) || itemsInput.length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Danh sách món (items) không được rỗng.');
    }
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Phương thức thanh toán không hợp lệ.');
    }

    for (const item of itemsInput) {
      if (!isValidUuid(item?.menu_item_id)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'menu_item_id không hợp lệ.');
      }
      if (!Number.isInteger(item?.quantity) || item.quantity < 1) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Số lượng món (quantity) phải là số nguyên >= 1.');
      }
      if (item.modifier_ids !== undefined) {
        if (!Array.isArray(item.modifier_ids) || item.modifier_ids.some((mid) => !isValidUuid(mid))) {
          throw new AppError(400, 'VALIDATION_ERROR', 'modifier_ids phải là mảng UUID hợp lệ.');
        }
      }
    }

    const result = await withTransaction(async (client) => {
      const shift = await getCurrentShift(client, { forUpdate: true });
      if (shift.status !== 'OPEN') {
        throw new AppError(409, 'SHIFT_CLOSED', 'Ca làm việc đã đóng, không thể tạo đơn mới.');
      }

      // Check duplicate custom order_code
      let orderCode = customOrderCode;
      if (orderCode) {
        const { rows: dup } = await client.query(
          `SELECT id FROM pos_orders WHERE order_code = $1`,
          [orderCode]
        );
        if (dup.length) {
          throw new AppError(409, 'CONFLICT', `Mã đơn "${orderCode}" đã tồn tại.`);
        }
      } else {
        const { rows: dateRow } = await client.query(
          `SELECT TO_CHAR(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYYMMDD') AS ymd,
                  COUNT(*)::int AS cnt
           FROM pos_orders
           WHERE (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`
        );
        const ymd = dateRow[0].ymd;
        let seq = Number(dateRow[0].cnt) + 1;
        while (true) {
          const candidate = `ORD-${ymd}-${String(seq).padStart(3, '0')}`;
          const { rows: exists } = await client.query(
            `SELECT 1 FROM pos_orders WHERE order_code = $1`,
            [candidate]
          );
          if (!exists.length) {
            orderCode = candidate;
            break;
          }
          seq += 1;
        }
      }

      // Validate all menu items & active recipes
      const menuIds = [...new Set(itemsInput.map((i) => i.menu_item_id))];
      const { rows: menuRows } = await client.query(
        `SELECT m.id, m.name, m.base_price, m.is_available, r.id AS recipe_id
         FROM menu_items m
         LEFT JOIN recipes r ON r.menu_item_id = m.id AND r.is_active = TRUE
         WHERE m.id = ANY($1::uuid[]) AND m.deleted_at IS NULL`,
        [menuIds]
      );
      const menuMap = new Map(menuRows.map((m) => [m.id, m]));

      for (const item of itemsInput) {
        const m = menuMap.get(item.menu_item_id);
        if (!m) {
          throw new AppError(404, 'NOT_FOUND', `Không tìm thấy món id: ${item.menu_item_id}`);
        }
        if (!m.is_available) {
          throw new AppError(409, 'INVALID_STATE', `Món "${m.name}" hiện đang tạm hết (is_available=false).`);
        }
        if (!m.recipe_id) {
          throw new AppError(409, 'INVALID_STATE', `Món "${m.name}" chưa có công thức (BOM) đang áp dụng.`);
        }
      }

      // Validate all modifiers
      const allModIds = [...new Set(itemsInput.flatMap((i) => i.modifier_ids || []))];
      const modMap = new Map();
      if (allModIds.length > 0) {
        const { rows: modRows } = await client.query(
          `SELECT id, name, price_delta FROM modifiers WHERE id = ANY($1::uuid[]) AND is_active = TRUE`,
          [allModIds]
        );
        for (const mod of modRows) {
          modMap.set(mod.id, mod);
        }
        for (const mid of allModIds) {
          if (!modMap.has(mid)) {
            throw new AppError(404, 'NOT_FOUND', `Không tìm thấy modifier id: ${mid}`);
          }
        }
      }

      let subtotal = 0;
      const preparedItems = itemsInput.map((item) => {
        const m = menuMap.get(item.menu_item_id);
        const modIds = item.modifier_ids || [];
        const mods = modIds.map((mid) => modMap.get(mid));
        const unitPrice = Math.round(
          (m.base_price + mods.reduce((s, mod) => s + mod.price_delta, 0)) * 100
        ) / 100;
        subtotal += unitPrice * item.quantity;
        return {
          menu_item_id: m.id,
          menu_name: m.name,
          recipe_version_id: m.recipe_id,
          quantity: item.quantity,
          unit_price: unitPrice,
          mods,
        };
      });
      subtotal = Math.round(subtotal * 100) / 100;

      const { rows: orderRows } = await client.query(
        `INSERT INTO pos_orders (
           order_code, shift_id, cashier_id, status, subtotal, discount_amount,
           total_amount, payment_method, paid_at
         ) VALUES ($1, $2, $3, 'PAID', $4, 0, $4, $5, NOW())
         RETURNING id, order_code, status, payment_method, subtotal, total_amount, created_at`,
        [orderCode, shift.id, req.user.id, subtotal, paymentMethod]
      );
      const order = orderRows[0];

      const insertedItems = [];
      for (const pi of preparedItems) {
        const { rows: oiRows } = await client.query(
          `INSERT INTO pos_order_items (
             order_id, menu_item_id, recipe_version_id, quantity, unit_price, cogs_snapshot
           ) VALUES ($1, $2, $3, $4, $5, 0)
           RETURNING id`,
          [order.id, pi.menu_item_id, pi.recipe_version_id, pi.quantity, pi.unit_price]
        );
        const orderItemId = oiRows[0].id;

        for (const mod of pi.mods) {
          await client.query(
            `INSERT INTO pos_order_item_modifiers (order_item_id, modifier_id, price_delta_snapshot)
             VALUES ($1, $2, $3)`,
            [orderItemId, mod.id, mod.price_delta]
          );
        }

        insertedItems.push({
          id: orderItemId,
          menu_item_id: pi.menu_item_id,
          menu_name: pi.menu_name,
          quantity: pi.quantity,
          unit_price: pi.unit_price,
          modifiers: pi.mods.map((mod) => mod.name),
        });
      }

      // Run FEFO deduction inside the exact same transaction
      const { rows: dedRows } = await client.query(
        `SELECT fn_process_pos_order_deduction($1, $2, TRUE) AS deduction`,
        [order.id, req.user.id]
      );
      const deduction = dedRows[0].deduction;

      // Read updated cogs_snapshot per item
      const { rows: cogsRows } = await client.query(
        `SELECT id, cogs_snapshot FROM pos_order_items WHERE order_id = $1`,
        [order.id]
      );
      const cogsMap = new Map(cogsRows.map((r) => [r.id, r.cogs_snapshot]));
      for (const it of insertedItems) {
        it.cogs_snapshot = cogsMap.get(it.id) ?? 0;
      }

      const totalOrderCogs = Number(deduction.total_order_cogs_vnd || 0);

      await insertAuditLog(client, {
        actorId: req.user.id,
        actionCode: 'POS_ORDER_PAID',
        entityTable: 'pos_orders',
        entityId: order.id,
        newValues: {
          order_code: order.order_code,
          total_amount: order.total_amount,
          payment_method: order.payment_method,
          cogs: totalOrderCogs,
        },
        reason: `Thanh toán đơn ${order.order_code} (${order.payment_method})`,
        deviceIp: getClientIp(req),
      });

      return {
        order: {
          id: order.id,
          order_code: order.order_code,
          status: order.status,
          payment_method: order.payment_method,
          subtotal: order.subtotal,
          total_amount: order.total_amount,
          created_at: order.created_at,
          items: insertedItems,
          cogs: totalOrderCogs,
        },
        deduction: {
          low_stock_alerts: deduction.low_stock_alerts || [],
          negative_stock_alerts: deduction.negative_stock_alerts || [],
          total_order_cogs_vnd: totalOrderCogs,
        },
      };
    });

    return res.status(201).json(sanitizeForRole(result, req.user.role));
  } catch (err) {
    if (err.code === '23505') {
      return next(new AppError(409, 'CONFLICT', 'Mã đơn hàng đã tồn tại.'));
    }
    return next(err);
  }
});

router.get('/', requireRole('OWNER', 'MANAGER', 'CASHIER'), async (req, res, next) => {
  try {
    const { rows: shiftRows } = await query(
      `SELECT id FROM work_shifts ORDER BY opened_at DESC LIMIT 1`
    );
    if (!shiftRows.length) {
      return res.json([]);
    }
    const shiftId = shiftRows[0].id;

    const { rows: orders } = await query(
      `SELECT o.id, o.order_code, o.status, o.payment_method, o.total_amount,
              o.created_at, o.paid_at, o.void_reason,
              c.full_name AS cashier_name,
              va.full_name AS void_approved_by_name
       FROM pos_orders o
       JOIN users c ON c.id = o.cashier_id
       LEFT JOIN users va ON va.id = o.void_approved_by
       WHERE o.shift_id = $1
       ORDER BY o.created_at DESC, o.id DESC`,
      [shiftId]
    );

    if (!orders.length) {
      return res.json([]);
    }

    const orderIds = orders.map((o) => o.id);
    const { rows: itemRows } = await query(
      `SELECT oi.id, oi.order_id, oi.quantity, oi.cogs_snapshot, mi.name AS menu_name,
              COALESCE(
                (SELECT array_agg(m.name ORDER BY oim.id ASC)
                 FROM pos_order_item_modifiers oim
                 JOIN modifiers m ON m.id = oim.modifier_id
                 WHERE oim.order_item_id = oi.id),
                ARRAY[]::varchar[]
              ) AS mod_names
       FROM pos_order_items oi
       JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE oi.order_id = ANY($1::uuid[])
       ORDER BY oi.id ASC`,
      [orderIds]
    );

    const itemsByOrder = new Map();
    for (const r of itemRows) {
      if (!itemsByOrder.has(r.order_id)) {
        itemsByOrder.set(r.order_id, []);
      }
      itemsByOrder.get(r.order_id).push(r);
    }

    // Also get exact COGS sum from stock_ledger or cogs_snapshot * quantity
    const { rows: ledgerCogsRows } = await query(
      `SELECT oi.order_id,
              ROUND(SUM(ABS(sl.qty_change_base) * sl.unit_cost_snapshot), 2) AS total_cogs
       FROM pos_order_items oi
       JOIN stock_ledger sl ON sl.ref_table = 'pos_order_items' AND sl.ref_id = oi.id AND sl.txn_type = 'POS_SALE'
       WHERE oi.order_id = ANY($1::uuid[])
       GROUP BY oi.order_id`,
      [orderIds]
    );
    const ledgerCogsMap = new Map(ledgerCogsRows.map((r) => [r.order_id, r.total_cogs]));

    const result = orders.map((o) => {
      const oItems = itemsByOrder.get(o.id) || [];
      const summary = oItems
        .map((it) => {
          const mods = Array.isArray(it.mod_names) && it.mod_names.length
            ? ` (${it.mod_names.join(', ')})`
            : '';
          return `${it.quantity}x ${it.menu_name}${mods}`;
        })
        .join('; ');

      const itemCogsFallback = Math.round(
        oItems.reduce((s, it) => s + it.cogs_snapshot * it.quantity, 0) * 100
      ) / 100;
      const cogs = ledgerCogsMap.has(o.id) ? ledgerCogsMap.get(o.id) : itemCogsFallback;

      const out = {
        id: o.id,
        order_code: o.order_code,
        status: o.status,
        payment_method: o.payment_method,
        total_amount: o.total_amount,
        created_at: o.created_at,
        paid_at: o.paid_at,
        cashier_name: o.cashier_name,
        void_reason: o.void_reason,
        void_approved_by_name: o.void_approved_by_name,
        summary,
      };
      if (req.user.role === 'OWNER') {
        out.cogs = cogs;
      }
      return out;
    });

    return res.json(sanitizeForRole(result, req.user.role));
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/void', requireRole('OWNER', 'MANAGER', 'CASHIER'), async (req, res, next) => {
  try {
    const orderId = req.params.id;
    if (!isValidUuid(orderId)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'ID đơn hàng không hợp lệ.');
    }

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Bắt buộc nhập lý do hủy đơn (reason).');
    }
    const approverPin = typeof req.body?.approver_pin === 'string' ? req.body.approver_pin.trim() : '';

    const result = await withTransaction(async (client) => {
      const { rows: orderRows } = await client.query(
        `SELECT id, order_code, status, total_amount
         FROM pos_orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId]
      );
      if (!orderRows.length) {
        throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng.');
      }
      const order = orderRows[0];

      if (order.status !== 'PAID') {
        throw new AppError(409, 'INVALID_STATE', `Chỉ được hủy đơn ở trạng thái PAID (hiện tại: ${order.status}).`);
      }

      let approverId = req.user.id;
      let approverName = req.user.full_name;

      if (req.user.role === 'CASHIER') {
        if (!approverPin) {
          throw new AppError(422, 'INVALID_PIN', 'Thu ngân hủy đơn đã thanh toán bắt buộc phải có mã PIN Quản lý hoặc Chủ quán.');
        }
        const { rows: approverRows } = await client.query(
          `SELECT u.id, u.full_name, r.code AS role
           FROM users u
           JOIN roles r ON r.id = u.role_id
           WHERE u.is_active = TRUE
             AND u.deleted_at IS NULL
             AND r.code IN ('MANAGER', 'OWNER')
             AND u.pos_pin_hash IS NOT NULL
             AND crypt($1, u.pos_pin_hash) = u.pos_pin_hash
           ORDER BY CASE WHEN r.code = 'MANAGER' THEN 1 ELSE 2 END
           LIMIT 1`,
          [approverPin]
        );
        if (!approverRows.length) {
          throw new AppError(422, 'INVALID_PIN', 'Mã PIN phê duyệt không hợp lệ hoặc không thuộc quyền Quản lý/Chủ quán.');
        }
        approverId = approverRows[0].id;
        approverName = approverRows[0].full_name;
      }

      await client.query(
        `UPDATE pos_orders
         SET status = 'VOIDED',
             void_reason = $1,
             void_approved_by = $2
         WHERE id = $3`,
        [reason, approverId, order.id]
      );

      await insertAuditLog(client, {
        actorId: req.user.id,
        approverId,
        actionCode: 'POS_VOID_PAID',
        entityTable: 'pos_orders',
        entityId: order.id,
        oldValues: { status: 'PAID', total_amount: order.total_amount },
        newValues: { status: 'VOIDED', void_reason: reason, void_approved_by: approverId },
        reason,
        deviceIp: getClientIp(req),
      });

      return {
        id: order.id,
        order_code: order.order_code,
        status: 'VOIDED',
        void_reason: reason,
        void_approved_by_name: approverName,
      };
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
