const COST_KEYS = new Set([
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
]);

function stripCostKeys(data) {
  if (data === null || data === undefined || typeof data !== 'object') {
    return data;
  }
  if (data instanceof Date) {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((item) => stripCostKeys(item));
  }
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (COST_KEYS.has(k)) {
      continue;
    }
    out[k] = stripCostKeys(v);
  }
  return out;
}

function sanitizeForRole(data, role) {
  if (role === 'OWNER') {
    return data;
  }
  return stripCostKeys(data);
}

module.exports = {
  COST_KEYS,
  stripCostKeys,
  sanitizeForRole,
};
