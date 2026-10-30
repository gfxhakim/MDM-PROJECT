// The nightly recompute (AM 4.6): every accepted seller, all or nothing. Scores, bands, component
// breakdowns with their inputs, and the derived stage are computed in memory first and written in
// one transaction. On failure the previous values are kept, flagged stale, and the Admin alerted —
// never a book that is half yesterday and half today.
import { prisma, inTx } from '../db.js';
import { logEvent } from '../services/audit.js';
import { notifyRole } from '../core/notifications.js';
import { computeHealth } from './health.js';
import { deriveStage } from './lifecycle.js';

const startOfUtcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Compute without writing: Map sellerId → { stage, health }. */
export async function computeAll(c, now, db = prisma) {
  const sellers = await db.seller.findMany({ where: { joinStatus: 'accepted' } });
  const open = await db.ticket.findMany({ where: { type: 'am_task', status: 'open' }, select: { sellerId: true, taskType: true } });
  const bySeller = new Map();
  for (const t of open) bySeller.set(t.sellerId, [...(bySeller.get(t.sellerId) ?? []), t]);
  const out = new Map();
  for (const s of sellers) {
    const stage = deriveStage(s, bySeller.get(s.id) ?? [], now);
    out.set(s.id, { seller: s, stage, health: computeHealth(s, stage, c, now) });
  }
  return out;
}

export async function recomputeAll({ db = prisma, config: c, now = new Date(), history = true } = {}) {
  let computed;
  try {
    computed = await computeAll(c, now, db);
  } catch (err) {
    await inTx(db, async (tx) => {
      await tx.seller.updateMany({ where: { joinStatus: 'accepted' }, data: { healthStale: true } });
      await logEvent({ entityType: 'system', entityId: 'am.recompute', action: 'health.recompute_failed', reason: err.message }, tx);
      await notifyRole('ADMIN', { kind: 'am.recompute_failed', title: 'Health recompute failed — scores are stale', body: err.message, dedupeKey: `am.recompute_failed:${startOfUtcDay(now).toISOString()}` }, tx);
    });
    throw err;
  }
  const day = startOfUtcDay(now);
  await inTx(db, async (tx) => {
    for (const [id, { stage, health }] of computed) {
      await tx.seller.update({
        where: { id },
        data: {
          stage, healthScore: health.score, healthBand: health.band, healthComputedAt: now, healthStale: false,
          healthComponents: JSON.stringify({ fallback: health.fallback, weights: health.weights, components: health.components }),
        },
      });
      if (history) {
        await tx.healthHistory.deleteMany({ where: { sellerId: id, date: day } });
        await tx.healthHistory.create({ data: { sellerId: id, date: day, score: health.score, band: health.band, components: JSON.stringify(health.components) } });
      }
    }
  }, { timeout: 120_000 });
  return computed;
}
