const express = require('express');
const { AppError, query } = require('../db');
const { signToken, authenticate } = require('../auth');

const router = express.Router();

const VALID_ROLES = ['OWNER', 'MANAGER', 'CASHIER', 'BARISTA'];

router.post('/login', async (req, res, next) => {
  try {
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!phone || !password) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Vui lòng nhập số điện thoại và mật khẩu.');
    }

    const { rows } = await query(
      `SELECT u.id, u.full_name, u.phone, r.code AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.phone = $1
         AND u.is_active = TRUE
         AND u.deleted_at IS NULL
         AND crypt($2, u.password_hash) = u.password_hash
       LIMIT 1`,
      [phone, password]
    );

    if (!rows.length) {
      throw new AppError(401, 'UNAUTHORIZED', 'Số điện thoại hoặc mật khẩu không chính xác.');
    }

    const user = {
      id: rows[0].id,
      full_name: rows[0].full_name,
      role: rows[0].role,
    };
    const token = signToken(user);

    return res.json({ token, user });
  } catch (err) {
    return next(err);
  }
});

router.post('/demo-login', async (req, res, next) => {
  try {
    const role = typeof req.body?.role === 'string' ? req.body.role.trim().toUpperCase() : '';
    if (!VALID_ROLES.includes(role)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Vai trò không hợp lệ. Chỉ chấp nhận OWNER, MANAGER, CASHIER, BARISTA.');
    }

    const { rows } = await query(
      `SELECT u.id, u.full_name, u.phone, r.code AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE r.code = $1
         AND u.is_active = TRUE
         AND u.deleted_at IS NULL
       ORDER BY u.created_at ASC, u.id ASC
       LIMIT 1`,
      [role]
    );

    if (!rows.length) {
      throw new AppError(404, 'NOT_FOUND', `Không tìm thấy tài khoản demo cho vai trò ${role}.`);
    }

    const user = {
      id: rows[0].id,
      full_name: rows[0].full_name,
      role: rows[0].role,
    };
    const token = signToken(user);

    return res.json({ token, user });
  } catch (err) {
    return next(err);
  }
});

module.exports = {
  authRouter: router,
  meHandler: [
    authenticate,
    (req, res) => {
      res.json({
        id: req.user.id,
        full_name: req.user.full_name,
        role: req.user.role,
        phone: req.user.phone,
      });
    },
  ],
};
