// Account manager capacity — AM Part 8, with cadence modelled as a weekly RATE (8.2, D-13).
//
//   assignable = shiftMin × workDays − round(shift × reservedPct / 100)
//   committed  = round( (Σ stageBaseline + Σ cadenceRate + taskMins) × (1 + wrapPct/100) )
//   cadenceRate = 0 for New/Onboarding/Activated/Churned, else round(mCheckin × 7 / cadDays(band))
//   taskMins   = minutes of open exception tasks due within 7 days, excluding r13
//   binding / slots per 8.4 — always named, never one without the other
import { prisma } from '../db.js';
import { stageBaseline } from './lifecycle.js';

const DAY = 86_400_000;

export function taskMinutes(taskType, c) {
  return {
    welcome: c['am.mWelcome'], checkin: c['am.mCheckin'], intervention: c['am.mIntervention'], save: c['am.mSave'],
    qbr: c['am.mQbr'], coach: c['am.mCoach'], expansion: c['am.mExpansion'], coord: c['am.mCoord'],
  }[taskType] ?? 0;
}

export function cadenceDays(band, c) {
  if (band === 'Thriving') return c['am.cadThriving'];
  if (band === 'Healthy') return c['am.cadHealthy'];
  return c['am.cadRisk']; // Critical and At Risk
}

export function cadenceRate(stage, band, c) {
  if (['New', 'Onboarding', 'Activated', 'Churned'].includes(stage)) return 0;
  return Math.round(c['am.mCheckin'] * 7 / cadenceDays(band, c));
}

/** Pure: the Part 8 arithmetic over a book. sellers = [{stage, band}], tasks = [{taskType, ruleId, dueAt}]. */
export function capacityFor(sellers, tasks, c, now = new Date()) {
  const shift = c['am.shiftMin'] * c['am.workDays'];
  const reserved = Math.round(shift * c['am.reservedPct'] / 100);
  const assignable = shift - reserved;
  const baseline = sellers.reduce((s, x) => s + stageBaseline(x.stage, c), 0);
  const cadence = sellers.reduce((s, x) => s + cadenceRate(x.stage, x.band, c), 0);
  const horizon = now.getTime() + 7 * DAY;
  const taskMins = tasks
    .filter((t) => t.ruleId !== 'r13' && (!t.dueAt || new Date(t.dueAt).getTime() <= horizon))
    .reduce((s, t) => s + taskMinutes(t.taskType, c), 0);
  const committed = Math.round((baseline + cadence + taskMins) * (1 + c['am.wrapPct'] / 100));
  const free = assignable - committed;
  const bookSize = sellers.length;
  const headroom = c['am.maxBook'] - bookSize;
  const perSeller = bookSize ? Math.round(committed / bookSize) : 0;
  const slotsByTime = perSeller > 0 ? Math.floor(free / perSeller) : headroom;
  let binding;
  if (free <= 0) binding = 'time';
  else if (headroom <= 0) binding = 'book ceiling';
  else if (slotsByTime < headroom) binding = 'time';
  else binding = 'book ceiling';
  const mix = { onboarding: 0, critical: 0, atRisk: 0, steady: 0 };
  for (const x of sellers) {
    const w = stageBaseline(x.stage, c) + cadenceRate(x.stage, x.band, c);
    if (['New', 'Onboarding', 'Activated'].includes(x.stage)) mix.onboarding += w;
    else if (x.band === 'Critical') mix.critical += w;
    else if (x.band === 'At Risk' || x.stage === 'Recovering') mix.atRisk += w;
    else mix.steady += w;
  }
  return {
    shift, reserved, assignable, baseline, cadence, taskMins, committed, free,
    utilisation: assignable ? Math.round((committed / assignable) * 100) : 0,
    bookSize, maxBook: c['am.maxBook'], headroom, perSeller, slotsByTime,
    slots: Math.max(0, Math.min(slotsByTime, headroom)), binding, mix,
  };
}

export async function managerCapacity(manager, c, now = new Date(), db = prisma) {
  const sellers = await db.seller.findMany({ where: { assignedAccountManagerId: manager.id, joinStatus: 'accepted' }, select: { stage: true, healthBand: true } });
  const tasks = await db.ticket.findMany({ where: { type: 'am_task', status: 'open', assigneeId: manager.id }, select: { taskType: true, ruleId: true, dueAt: true } });
  return capacityFor(sellers.map((s) => ({ stage: s.stage, band: s.healthBand })), tasks, c, now);
}

/** The coverage arithmetic (AM 8.6) — stated in full on the Operations screen. */
export async function coverage(c, db = prisma) {
  const [accepted, assigned, managers] = await Promise.all([
    db.seller.count({ where: { joinStatus: 'accepted' } }),
    db.seller.count({ where: { joinStatus: 'accepted', assignedAccountManagerId: { not: null } } }),
    db.user.count({ where: { role: 'ACCOUNT_MANAGER', active: true } }),
  ]);
  const capacitySeats = managers * c['am.maxBook'];
  return {
    acceptedSellers: accepted, withManager: assigned, withoutManager: accepted - assigned,
    accountManagers: managers, maxBook: c['am.maxBook'], seatsAtCeiling: capacitySeats,
    managersNeeded: Math.ceil(accepted / c['am.maxBook']),
    statement: `${accepted} accepted sellers; ${assigned} have a named account manager and ${accepted - assigned} do not. `
      + `At a ceiling of ${c['am.maxBook']}, full coverage needs ${Math.ceil(accepted / c['am.maxBook'])} account managers; there are ${managers}.`,
  };
}
