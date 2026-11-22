const express = require('express');
const fs = require('fs');
const path = require('path');
const { AppError, query } = require('./db');
const { authRouter, meHandler } = require('./routes/auth');
const shiftRouter = require('./routes/shift');
const menuRouter = require('./routes/menu');
const ordersRouter = require('./routes/orders');
const inventoryRouter = require('./routes/inventory');
const wasteRouter = require('./routes/waste');
const eodRouter = require('./routes/eod');
const hrRouter = require('./routes/hr');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const FRONTEND_DIR = process.env.FRONTEND_DIR || path.resolve(__dirname, '../../frontend');

app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

// Health check (public)
app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1');
    return res.json({ ok: true, db: true });
  } catch (err) {
    return res.status(500).json({ ok: false, db: false, error: { code: 'INTERNAL', message: 'Lỗi kết nối cơ sở dữ liệu.' } });
  }
});

// Auth & current user
app.use('/api/auth', authRouter);
app.get('/api/me', ...meHandler);

// Shift & Blind Cash Close
app.use('/api/shift', shiftRouter);

// Menu / BOM / Modifiers
app.use('/api', menuRouter);

// POS Orders
app.use('/api/orders', ordersRouter);

// Inventory & Prep
app.use('/api/inventory', inventoryRouter);

// Waste Records
app.use('/api/waste', wasteRouter);

// EOD Blind Reconciliation
app.use('/api/eod', eodRouter);

// HR Attendance
app.use('/api/hr', hrRouter);

// Audit Logs, Dashboard & Demo Reset
app.use('/api', adminRouter);

// Unknown /api/* routes return 404 JSON
app.use('/api', (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Không tìm thấy đường dẫn API: ${req.method} ${req.originalUrl}`,
    },
  });
});

// Static frontend serving at '/'
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    const indexPath = path.join(FRONTEND_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    return res.status(404).send('Frontend index.html not found');
  });
}

// Global error handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Dữ liệu JSON không hợp lệ.',
      },
    });
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  // PostgreSQL error mapping
  if (err && typeof err.code === 'string') {
    if (err.code === 'P0001' || err.code === 'P0003' || err.code === 'P0004') {
      return res.status(409).json({
        error: {
          code: 'INVALID_STATE',
          message: err.message || 'Trạng thái nghiệp vụ không hợp lệ.',
        },
      });
    }
    if (err.code === 'P0002') {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: err.message || 'Không tìm thấy dữ liệu.',
        },
      });
    }
    if (err.code === '23505') {
      return res.status(409).json({
        error: {
          code: 'CONFLICT',
          message: 'Dữ liệu bị trùng lặp.',
        },
      });
    }
    if (err.code === '23503' || err.code === '23514' || err.code === '22P02' || err.code === '22023') {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.message || 'Dữ liệu đầu vào không hợp lệ.',
        },
      });
    }
    if (err.code === '42501') {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: err.message || 'Không đủ quyền truy cập dữ liệu.',
        },
      });
    }
  }

  console.error('Unhandled error:', err);
  return res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Lỗi hệ thống nội bộ.',
    },
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BrewGuard F&B Backend listening on http://0.0.0.0:${PORT}`);
  console.log(`Serving static frontend from: ${FRONTEND_DIR}`);
});
