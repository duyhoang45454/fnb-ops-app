import assert from 'node:assert/strict';

export const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

export const DB_CONFIG = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'fnb_ops',
};

export const APP_DB_USER = 'fnb_app_user';
export const APP_DB_PASSWORD = 'CHANGE_THIS_STRONG_PASSWORD';

export const IDS = {
  roles: {
    OWNER: '10000000-0000-0000-0000-000000000001',
    MANAGER: '10000000-0000-0000-0000-000000000002',
    CASHIER: '10000000-0000-0000-0000-000000000003',
    BARISTA: '10000000-0000-0000-0000-000000000004',
  },
  users: {
    OWNER: '20000000-0000-0000-0000-000000000001',
    MANAGER: '20000000-0000-0000-0000-000000000002',
    CASHIER: '20000000-0000-0000-0000-000000000003',
    BARISTA: '20000000-0000-0000-0000-000000000004',
  },
  shift: '21000000-0000-0000-0000-000000000001',
  items: {
    MILK_FRESH: '30000000-0000-0000-0000-000000000001',
    SUGAR_SYRUP: '30000000-0000-0000-0000-000000000002',
    PREP_TEA: '30000000-0000-0000-0000-000000000003',
    PREP_PEARL: '30000000-0000-0000-0000-000000000004',
    CUP_500ML: '30000000-0000-0000-0000-000000000005',
    CUP_700ML: '30000000-0000-0000-0000-000000000006',
  },
  menu: {
    MT_CLASSIC: '40000000-0000-0000-0000-000000000001',
    TEA_BLACK: '40000000-0000-0000-0000-000000000002',
    MILK_PEARL: '40000000-0000-0000-0000-000000000003',
  },
  recipes: {
    MT_CLASSIC_V1: '41000000-0000-0000-0000-000000000001',
    TEA_BLACK_V1: '41000000-0000-0000-0000-000000000002',
    MILK_PEARL_V1: '41000000-0000-0000-0000-000000000003',
  },
  modifiers: {
    SIZE_L: '42000000-0000-0000-0000-000000000001',
    SUGAR_0: '42000000-0000-0000-0000-000000000002',
    TOPPING_PEARL: '42000000-0000-0000-0000-000000000003',
    SUGAR_50: '42000000-0000-0000-0000-000000000004',
  },
};

export const FORBIDDEN_COST_KEYS = [
  'unit_cost',
  'avg_unit_cost',
  'unit_cost_snapshot',
  'cogs',
  'cogs_snapshot',
  'total_order_cogs_vnd',
  'calculated_cogs',
  'est_cogs',
  'food_cost_pct',
  'variance_vnd',
  'total_variance_vnd',
  'value_vnd',
];

export const EOD_THEORETICAL_KEYS = [
  'opening_qty_base',
  'purchased_qty_base',
  'pos_usage_qty_base',
  'waste_qty_base',
  'theoretical_qty_base',
  'variance_qty_base',
  'variance_pct_usage',
  'variance_vnd',
  'alert_level',
  'total_variance_vnd',
];

export function assertNoKeys(value, forbiddenKeys, label = 'response') {
  const keySet = new Set(forbiddenKeys);
  const found = [];

  function walk(node, path) {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        walk(node[i], `${path}[${i}]`);
      }
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const nextPath = path ? `${path}.${k}` : k;
      if (keySet.has(k)) {
        found.push(nextPath);
      }
      walk(v, nextPath);
    }
  }

  walk(value, '');
  assert.equal(
    found.length,
    0,
    `${label} must NOT contain forbidden keys [${forbiddenKeys.join(', ')}], found: ${found.join(', ')}`
  );
}

export async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const reqHeaders = { ...headers };
  if (token) {
    reqHeaders.Authorization = `Bearer ${token}`;
  }
  let payload;
  if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: reqHeaders,
    body: payload,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: res.status, data, text, headers: res.headers };
}

export async function demoLogin(role) {
  const res = await api('/api/auth/demo-login', {
    method: 'POST',
    body: { role },
  });
  assert.equal(
    res.status,
    200,
    `demo-login(${role}) expected 200, got ${res.status}: ${res.text}`
  );
  assert.ok(res.data?.token, `demo-login(${role}) missing token`);
  assert.equal(res.data?.user?.role, role);
  return res.data.token;
}

export async function resetDemo(ownerToken) {
  const token = ownerToken || (await demoLogin('OWNER'));
  const res = await api('/api/admin/reset-demo', {
    method: 'POST',
    token,
  });
  assert.equal(
    res.status,
    200,
    `POST /api/admin/reset-demo expected 200, got ${res.status}: ${res.text}`
  );
  assert.equal(res.data?.ok, true);
  return token;
}

export async function loginAllRoles() {
  const [owner, manager, cashier, barista] = await Promise.all([
    demoLogin('OWNER'),
    demoLogin('MANAGER'),
    demoLogin('CASHIER'),
    demoLogin('BARISTA'),
  ]);
  return { owner, manager, cashier, barista };
}
