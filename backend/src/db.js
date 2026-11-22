const { Pool, Client, types } = require('pg');

// Convert PostgreSQL NUMERIC (OID 1700) to JS Number
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));
// Also parse INT8 (OID 20) counts as Number when safe
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgres://fnb_app_user:CHANGE_THIS_STRONG_PASSWORD@localhost:5432/fnb_ops';

const ADMIN_DATABASE_URL =
  process.env.ADMIN_DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5432/fnb_ops';

let pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected PG pool error:', err.message);
});

async function recreatePool() {
  const oldPool = pool;
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (err) => {
    console.error('Unexpected PG pool error:', err.message);
  });
  try {
    await oldPool.end();
  } catch (e) {
    // ignore errors ending old pool
  }
}

async function query(text, params) {
  return pool.query(text, params);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      console.error('Rollback error:', rbErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

function createAdminClient() {
  return new Client({ connectionString: ADMIN_DATABASE_URL });
}

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function getCurrentShift(client, { forUpdate = false } = {}) {
  const sql = `
    SELECT ws.*, u.full_name AS manager_name
    FROM work_shifts ws
    JOIN users u ON u.id = ws.manager_id
    ORDER BY ws.opened_at DESC
    LIMIT 1
    ${forUpdate ? 'FOR UPDATE OF ws' : ''}
  `;
  const { rows } = await client.query(sql);
  if (!rows.length) {
    throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy ca làm việc nào.');
  }
  return rows[0];
}

async function insertAuditLog(client, {
  actorId,
  approverId = null,
  actionCode,
  entityTable,
  entityId,
  oldValues = null,
  newValues = null,
  reason = null,
  deviceIp = null,
}) {
  await client.query(
    `INSERT INTO audit_logs (
       actor_id, approver_id, action_code, entity_table, entity_id,
       old_values_json, new_values_json, reason, device_ip
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      actorId,
      approverId,
      actionCode,
      entityTable,
      entityId,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      reason,
      deviceIp,
    ]
  );
}

function isValidUuid(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

module.exports = {
  DATABASE_URL,
  ADMIN_DATABASE_URL,
  getPool: () => pool,
  recreatePool,
  query,
  withTransaction,
  createAdminClient,
  AppError,
  getCurrentShift,
  insertAuditLog,
  isValidUuid,
};
