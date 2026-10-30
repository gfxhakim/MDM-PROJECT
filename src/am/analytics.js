// Account-management analytics for the Head of AM workspaces (AM Part 10): coverage, platform
// trends and per-manager performance, all read from the record. Trends come from the nightly
// HealthHistory snapshots (their component inputs carry delivery, returns and cancellations), so
// a trend only exists for the weeks the recompute has actually run — nothing is back-filled.
// Measures with no data source yet (NRR and upgrades from finance/billing, CSAT from the survey)
// are returned as null and shown as not wired.
import { prisma } from '../db.js';
import { getLiveConfig } from '../config/service.js';
import { coverage } from './capacity.js';

const DAY = 86_400_000;
const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `W${String(Math.ceil(((t - y0) / DAY + 1) / 7)).padStart(2, '0')}`;
}
const inputsOf = (h) => {
  const comps = JSON.parse(h.components || '{}').components ?? [];
  return comps.find((c) => c.key === 'delivery')?.inputs ?? {};
};

export async function amAnalytics({ now = new Date(), db = prisma } = {}) {
  const { values: c } = await getLiveConfig(db);
  const since = new Date(now.getTime() - 12 * 7 * DAY);
  const quarterStart = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
  const [history, sellers, managers, qbrTasks] = await Promise.all([
    db.healthHistory.findMany({ where: { date: { gte: since < quarterStart ? since : quarterStart } }, orderBy: { date: 'asc' } }),
    db.seller.findMany({ where: { joinStatus: 'accepted' }, select: { id: true, contactId: true, assignedAccountManagerId: true, marketsServed: true } }),
    db.user.findMany({ where: { role: 'ACCOUNT_MANAGER', active: true }, select: { id: true } }),
    db.ticket.findMany({ where: { type: 'am_task', taskType: 'qbr', createdAt: { gte: quarterStart } }, select: { status: true, assigneeId: true } }),
  ]);

  // platform trend, one point per ISO week that has snapshots
  const weeks = new Map();
  for (const h of history.filter((x) => x.date >= since)) {
    const w = isoWeek(h.date);
    const i = inputsOf(h);
    const row = weeks.get(w) ?? { health: [], delivery: [], returns: [], cancel: [] };
    row.health.push(h.score);
    if (typeof i.deliveryRate === 'number') row.delivery.push(i.deliveryRate);
    if (typeof i.returnRate === 'number') row.returns.push(i.returnRate);
    if (typeof i.cancelRate === 'number') row.cancel.push(i.cancelRate);
    weeks.set(w, row);
  }
  const trend = { weeks: [...weeks.keys()] };
  for (const k of ['health', 'delivery', 'returns', 'cancel']) trend[k] = [...weeks.values()].map((r) => avg(r[k]));

  // first response time per manager: inbound → next outbound on the seller conversations
  const convs = await db.conversation.findMany({
    where: { contactId: { in: sellers.map((s) => s.contactId) } },
    include: { messages: { where: { createdAt: { gte: quarterStart }, kind: { in: ['text', 'template'] } }, orderBy: { createdAt: 'asc' }, select: { direction: true, createdAt: true } } },
  });
  const convBy = new Map(convs.map((x) => [x.contactId, x]));
  const responses = (s) => {
    const out = []; let waiting = null;
    for (const m of convBy.get(s.contactId)?.messages ?? []) {
      if (m.direction === 'in' && !waiting) waiting = m.createdAt;
      else if (m.direction === 'out' && waiting) { out.push((m.createdAt - waiting) / 3_600_000); waiting = null; }
    }
    return out;
  };

  const perf = {};
  for (const m of managers) {
    const book = sellers.filter((s) => s.assignedAccountManagerId === m.id);
    const ids = new Set(book.map((s) => s.id));
    const qStart = history.filter((h) => ids.has(h.sellerId) && h.date >= quarterStart);
    const firstPerSeller = new Map();
    for (const h of qStart) if (!firstPerSeller.has(h.sellerId)) firstPerSeller.set(h.sellerId, inputsOf(h));
    const base = [...firstPerSeller.values()];
    const qbr = qbrTasks.filter((t) => t.assigneeId === m.id);
    const resp = median(book.flatMap(responses));
    perf[m.id] = {
      dq0: avg(base.map((i) => i.deliveryRate).filter((x) => typeof x === 'number')),
      cq0: avg(base.map((i) => i.cancelRate).filter((x) => typeof x === 'number')),
      nrr: null, upgrades: null, csat: null,
      expansions: book.filter((s) => s.marketsServed > 1).length,
      respH: resp === null ? null : Math.round(resp * 10) / 10,
      qbrDone: qbr.filter((t) => t.status === 'done').length, qbrDue: qbr.length,
    };
  }
  // Audit & Quality checks (AM Part 11): counted from the record, not asserted.
  const quality = {
    unassigned: sellers.filter((s) => !s.assignedAccountManagerId).length,
    escalationsNoNote: await db.ticket.count({ where: { type: 'am_task', escalated: true, OR: [{ escalationReason: null }, { escalationReason: '' }] } }),
  };
  return { coverage: await coverage(c, db), trend, perf, quarterStart, quality };
}
