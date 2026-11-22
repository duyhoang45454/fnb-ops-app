const jwt = require('jsonwebtoken');
const { AppError, query } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const JWT_EXPIRES_IN = '12h';

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRES_IN,
  });
}

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Thiếu hoặc sai định dạng token xác thực.'));
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Token xác thực không hợp lệ.'));
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ.'));
    }

    const { rows } = await query(
      `SELECT u.id, u.full_name, u.phone, u.is_active, u.deleted_at, r.code AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [payload.sub]
    );

    if (!rows.length || !rows[0].is_active || rows[0].deleted_at !== null) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Tài khoản không tồn tại hoặc đã bị khóa.'));
    }

    req.user = {
      id: rows[0].id,
      full_name: rows[0].full_name,
      phone: rows[0].phone,
      role: rows[0].role,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Chưa đăng nhập.'));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new AppError(
          403,
          'FORBIDDEN',
          `Vai trò ${req.user.role} không có quyền thực hiện thao tác này.`
        )
      );
    }
    return next();
  };
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  let ip = typeof xff === 'string' && xff.length > 0 ? xff.split(',')[0].trim() : req.ip || null;
  if (ip && ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  return ip || null;
}

module.exports = {
  JWT_SECRET,
  signToken,
  authenticate,
  requireRole,
  getClientIp,
};
