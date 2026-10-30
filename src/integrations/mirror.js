// The seller mirror: the read-only copy of MDM platform data (orders, delivery, wallet,
// catalogue) that the health engine reads. Only these fields can be written by a connector or an
// import — health, band and lifecycle stage are derived and are never accepted from outside (AC-03).
import { prisma } from '../db.js';

export const MIRROR_FIELDS = {
  weeklyOrders: 'json8', weeklyReturnRates: 'json8', deliveryRate: 'pct', returnRate: 'pct', cancelRate: 'pct',
  wallet: 'number', walletNegativeDays: 'int', products: 'int', marketsServed: 'int', momGrowthPct: 'number',
  lastOrderAt: 'date', totalOrders: 'int', lastLoginAt: 'date', lastStoreUpdateAt: 'date', lastProductAddedAt: 'date',
};
export const DERIVED_FIELDS = ['healthScore', 'healthBand', 'healthComponents', 'stage', 'lifecycleStage', 'health'];

/** Validate and coerce mirror fields. Unknown fields are reported, derived fields refused. */
export function mirrorData(input) {
  const data = {}; const ignored = []; const errors = [];
  for (const [k, v] of Object.entries(input ?? {})) {
    if (DERIVED_FIELDS.includes(k)) { errors.push(`${k} is derived by the platform and cannot be written.`); continue; }
    const type = MIRROR_FIELDS[k];
    if (!type) { ignored.push(k); continue; }
    if (v === null || v === undefined || v === '') { if (type === 'date') data[k] = null; continue; }
    if (type === 'json8') {
      const arr = Array.isArray(v) ? v : String(v).split(/[;,|]/).map((x) => x.trim()).filter(Boolean);
      const nums = arr.map(Number);
      if (nums.some((x) => !Number.isFinite(x))) { errors.push(`${k} must be a list of numbers.`); continue; }
      data[k] = JSON.stringify(nums.slice(-8));
    } else if (type === 'date') {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) errors.push(`${k} is not a date.`); else data[k] = d;
    } else {
      let n = Number(String(v).replace('%', ''));
      if (!Number.isFinite(n)) { errors.push(`${k} is not a number.`); continue; }
      if (type === 'pct' && n > 0 && n <= 1 && String(v).includes('.') && !String(v).includes('%')) n *= 100; // 0.34 → 34
      data[k] = type === 'int' ? Math.round(n) : n;
    }
  }
  return { data, ignored, errors };
}

/** Write mirror fields onto a seller and mark health stale so the next recompute includes it. */
export async function applyMirror(sellerId, data, db = prisma) {
  if (!Object.keys(data).length) return null;
  return db.seller.update({ where: { id: sellerId }, data: { ...data, healthStale: true, lastSyncedAt: new Date() } });
}
