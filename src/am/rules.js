// The AM rule engine (AM Part 5, Appendix B). Nightly, after the health recompute; also on
// demand and right after every config publish.
//
// What a rule may do: open a task, emit an alert, upgrade a task in place, write to the timeline.
// What it may NOT do (AC-12): close a task, send a message, spend template budget, reassign, or
// write the operational record. Nothing in this file calls the conversation or assignment code.
//
// Dedup (AM 2.5): no second OPEN task with the same rule_id on the same seller — checked at insert.
// One call, one task (AM 5.3): r5 save > r2 critical > r3 decline > r4 inactivity, each guarded by
// hasCall(); a seller crossing Critical with an open r13 check-in has that task upgraded in place.
import { prisma } from '../db.js';
import { getLiveConfig } from '../config/service.js';
import { logEvent } from '../services/audit.js';
import { notifyRole } from '../core/notifications.js';
import { daysInactive, orderWindows } from './health.js';
import { recomputeAll } from './recompute.js';
import { cadenceDays, taskMinutes } from './capacity.js';
import { STEPS } from './playbook.js';

const DAY = 86_400_000;
const CALL_TYPES = ['intervention', 'save', 'checkin'];
const startOfUtcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const daysSince = (d, now) => (d ? Math.floor((now - new Date(d)) / DAY) : null);

/** Escalation ladder per alert (AM 5.4) — displayed on the task. */
export const ALERTS = {
  SELLER_ASSIGNED: { escalatesTo: 'Admin', afterHours: 24 },
  SELLER_HEALTH_CRITICAL: { escalatesTo: 'Commercial Director', afterHours: 72 },
  SELLER_ORDER_DECLINE: { escalatesTo: 'Commercial Director', afterHours: 72 },
  SELLER_INACTIVE: { escalatesTo: 'Save campaign at saveDays; Admin notified', afterHours: null },
  SELLER_HIGH_RETURNS: { escalatesTo: 'Operations if market-wide', afterHours: null },
  SELLER_SUPPORT_ESCALATION: { escalatesTo: 'Head of Support on SLA breach', afterHours: null },
  SELLER_PAYMENT_ISSUE: { escalatesTo: 'Finance owns the fix', afterHours: 0 },
};

/**
 * Run the sweep. Returns counts, every task opened/upgraded (with minutes), and band movement.
 * @param {{ db?, config?, now?: Date, simulate?: boolean, recompute?: boolean }} opts
 */
export async function runAmSweep({ db = prisma, config, now = new Date(), recompute = true } = {}) {
  const c = config ?? (await getLiveConfig(db)).values;
  const on = (r) => c[`am.rule.${r}.enabled`];
  const today = startOfUtcDay(now);
  const due = (days) => new Date(today.getTime() + days * DAY);

  // Health first — most rules read it (AM 4.6). Band movement is reported for simulate.
  const before = new Map((await db.seller.findMany({ where: { joinStatus: 'accepted' }, select: { id: true, healthBand: true } })).map((s) => [s.id, s.healthBand]));
  const computed = recompute ? await recomputeAll({ db, config: c, now, history: false }) : null;
  const bandMoves = [];
  if (computed) {
    for (const [id, { health }] of computed) {
      if (before.get(id) && before.get(id) !== health.band) bandMoves.push({ sellerId: id, from: before.get(id), to: health.band });
    }
  }

  const sellers = await db.seller.findMany({ where: { joinStatus: 'accepted' }, include: { contact: true } });
  const openTasks = await db.ticket.findMany({ where: { type: 'am_task', status: 'open' } });
  const tasksBySeller = new Map();
  for (const t of openTasks) tasksBySeller.set(t.sellerId, [...(tasksBySeller.get(t.sellerId) ?? []), t]);

  const opened = [];
  const upgraded = [];
  const byRule = {};

  for (const s of sellers) {
    const tasks = tasksBySeller.get(s.id) ?? [];
    const hasCall = () => tasks.some((t) => CALL_TYPES.includes(t.taskType));
    const hasRule = (ruleId) => tasks.some((t) => t.ruleId === ruleId);
    const stage = s.stage;
    const di = daysInactive(s, now);
    const health = s.healthScore;

    const open = async (ruleId, { taskType, priority, dueIn, title, why, alertKey }) => {
      if (hasRule(ruleId)) return null; // AM 2.5 — dedup at insert
      const t = await db.ticket.create({
        data: {
          type: 'am_task', contactId: s.contactId, sellerId: s.id, assigneeId: s.assignedAccountManagerId, status: 'open',
          taskType, priority, dueAt: due(dueIn), title, why, ruleId, alertKey: alertKey ?? null,
        },
      });
      tasks.push(t);
      if (alertKey) await logEvent({ entityType: 'seller', entityId: s.id, action: alertKey, after: { taskId: t.id, ruleId }, reason: why }, db);
      await logEvent({ entityType: 'ticket', entityId: t.id, action: 'am_task.opened', after: { ruleId, taskType, priority }, reason: why }, db);
      opened.push({ taskId: t.id, sellerId: s.id, ruleId, taskType, minutes: taskMinutes(taskType, c) });
      byRule[ruleId.split(':')[0]] = (byRule[ruleId.split(':')[0]] ?? 0) + 1;
      return t;
    };

    const upgrade = async (task, { ruleId, taskType, priority, why, alertKey }) => {
      const data = { ruleId, taskType, priority, dueAt: due(0), alertKey, why: `${task.why}\nUpgraded ${today.toISOString().slice(0, 10)}: ${why}` };
      const t = await db.ticket.update({ where: { id: task.id }, data });
      Object.assign(task, t);
      await logEvent({ entityType: 'ticket', entityId: task.id, action: 'am_task.upgraded', before: { ruleId: task.ruleId, taskType: 'checkin' }, after: { ruleId, taskType, priority }, reason: why }, db);
      if (alertKey) await logEvent({ entityType: 'seller', entityId: s.id, action: alertKey, after: { taskId: task.id, ruleId, upgraded: true }, reason: why }, db);
      upgraded.push({ taskId: task.id, sellerId: s.id, ruleId, from: 'checkin', to: taskType, minutesDelta: taskMinutes(taskType, c) - taskMinutes('checkin', c) });
      byRule[`${ruleId}_upgrade`] = (byRule[`${ruleId}_upgrade`] ?? 0) + 1;
    };

    // ── precedence group: one call, one task ──
    // r5 — save campaign (replaces an inactivity / cadence check-in rather than stacking on it)
    if (on('r5') && di >= c['am.saveDays'] && !['New', 'Churned'].includes(stage)) {
      const why = `No orders for ${di} days (save campaign at ${c['am.saveDays']}).`;
      const checkin = tasks.find((t) => t.taskType === 'checkin' && ['r4', 'r13'].includes(t.ruleId));
      if (checkin && !hasRule('r5')) await upgrade(checkin, { ruleId: 'r5', taskType: 'save', priority: 'urgent', why, alertKey: 'SELLER_INACTIVE' });
      else if (!hasCall() && await open('r5', { taskType: 'save', priority: 'urgent', dueIn: 0, title: 'Save campaign', why, alertKey: 'SELLER_INACTIVE' })) {
        await notifyRole('ADMIN', { kind: 'am.r5.save', title: `Save campaign opened: ${s.contact.name}`, body: why, dedupeKey: `am.r5:${s.id}:${today.toISOString()}` }, db);
      }
    }
    // r2 — health critical (upgrade an open r13 check-in in place)
    if (on('r2') && health !== null && health < c['am.healthCritical'] && stage !== 'Churned') {
      const why = `Health ${health}, below the critical threshold of ${c['am.healthCritical']}.`;
      const cadence = tasks.find((t) => t.ruleId === 'r13' && t.taskType === 'checkin');
      if (cadence) await upgrade(cadence, { ruleId: 'r2', taskType: 'intervention', priority: 'urgent', why, alertKey: 'SELLER_HEALTH_CRITICAL' });
      else if (!hasCall()) await open('r2', { taskType: 'intervention', priority: 'urgent', dueIn: 0, title: 'Intervention — health critical', why, alertKey: 'SELLER_HEALTH_CRITICAL' });
    }
    // r3 — week-on-week order decline, with the five-order volume gate
    if (on('r3')) {
      const { thisWeek, lastWeek } = orderWindows(s);
      if (lastWeek >= 5 && thisWeek < lastWeek * (1 - c['am.orderDropPct'] / 100) && !hasCall()) {
        await open('r3', { taskType: 'intervention', priority: 'high', dueIn: 0, title: 'Intervention — order decline', alertKey: 'SELLER_ORDER_DECLINE',
          why: `${thisWeek} orders this week against ${lastWeek} last week — down ${Math.round((1 - thisWeek / lastWeek) * 100)}% (threshold ${c['am.orderDropPct']}%).` });
      }
    }
    // r4 — inactivity check-in
    if (on('r4') && di >= c['am.inactiveDays'] && di < c['am.saveDays'] && !['New', 'Churned'].includes(stage) && !hasCall()) {
      await open('r4', { taskType: 'checkin', priority: 'high', dueIn: 0, title: 'Check-in · no orders', alertKey: 'SELLER_INACTIVE',
        why: `No orders for ${di} days (inactivity trigger at ${c['am.inactiveDays']}).` });
    }

    // ── outside the call guard: genuinely different work ──
    // r6 — high returns, sustained
    if (on('r6')) {
      const rates = JSON.parse(s.weeklyReturnRates ?? '[]');
      const n = c['am.returnAlertWeeks'];
      const recent = rates.slice(-n);
      if (recent.length >= n && recent.every((r) => r > c['am.returnAlertPct'])) {
        await open('r6', { taskType: 'coach', priority: 'high', dueIn: 2, title: 'Coaching — high returns', alertKey: 'SELLER_HIGH_RETURNS',
          why: `Returns above ${c['am.returnAlertPct']}% for ${n} consecutive weeks (${recent.map((r) => `${r}%`).join(', ')}).` });
      }
    }
    // r7 — support escalation (also runs on the support-ticket event)
    if (on('r7')) await supportEscalation(s, c, { db, now, open });
    // r8 — payment issue
    if (on('r8') && s.wallet < 0 && s.walletNegativeDays >= c['am.walletDays']) {
      await open('r8', { taskType: 'coord', priority: 'normal', dueIn: 1, title: 'Coordinate with Finance — payment issue', alertKey: 'SELLER_PAYMENT_ISSUE',
        why: `Wallet −$${Math.abs(Math.round(s.wallet))}, negative for ${s.walletNegativeDays} days (threshold ${c['am.walletDays']}).` });
    }
    // r9 — business review clock
    if (on('r9') && stage === 'Mature') {
      const since = daysSince(s.lastReviewAt ?? s.activatedAt, now);
      if (since !== null && since >= c['am.qbrDays']) {
        await open('r9', { taskType: 'qbr', priority: 'normal', dueIn: 7, title: 'Business review',
          why: `${since} days since the last business review (clock ${c['am.qbrDays']} days).` });
      }
    }
    // r10 — onboarding playbook clock
    if (on('r10') && ['New', 'Onboarding', 'Activated'].includes(stage) && s.activatedAt) {
      const age = Math.floor((now - s.activatedAt) / DAY);
      // Only inside the thirty-day window: an imported account months old has no playbook to catch up on.
      const window = Math.max(...STEPS.map((x) => x.day)) + 2;
      for (const step of STEPS.filter((x) => x.taskType && x.day <= age && age <= window)) {
        const late = age - step.day >= 2;
        await open(`r10:d${step.day}`, { taskType: step.taskType, priority: late ? 'high' : 'normal', dueIn: 0,
          title: `Day ${step.day} — ${step.title}`, why: `Thirty-day playbook: day ${step.day} step is due (account age ${age} days). Gate: ${step.gate}.` });
      }
    }
    // r11 (churn marking) and r12 (rebalance proposal) ship disabled; neither is implemented as an
    // automatic action — r11 needs the structured save outcome (D-04), r12 only ever proposes.
    // r13 — proactive contact cadence
    if (on('r13') && !['New', 'Onboarding', 'Activated', 'Churned'].includes(stage) && !hasCall()) {
      const cad = cadenceDays(s.healthBand, c);
      const since = daysSince(s.lastContactAt ?? s.activatedAt, now);
      if (since !== null && since >= cad) {
        await open('r13', { taskType: 'checkin', priority: s.healthBand === 'At Risk' || s.healthBand === 'Critical' ? 'high' : 'normal', dueIn: 0,
          title: 'Check-in · cadence', why: `${since} days since the last contact; the ${s.healthBand} cadence is ${cad} days.` });
      }
    }
  }

  const minutes = opened.reduce((m, x) => m + x.minutes, 0) + upgraded.reduce((m, x) => m + x.minutesDelta, 0);
  const bands = { before: {}, after: {} };
  for (const b of before.values()) if (b) bands.before[b] = (bands.before[b] ?? 0) + 1;
  for (const s of sellers) if (s.healthBand) bands.after[s.healthBand] = (bands.after[s.healthBand] ?? 0) + 1;
  return {
    tasksOpened: opened.length, tasksUpgraded: upgraded.length, byRule, opened, upgraded,
    hoursAdded: Math.round((minutes * (1 + c['am.wrapPct'] / 100) / 60) * 10) / 10,
    bandMoves, bands,
  };
}

/** r7 — unresolved support tickets on the seller reach ticketAlert. */
async function supportEscalation(seller, c, { db, open }) {
  const unresolved = await db.ticket.count({
    where: { contactId: seller.contactId, type: { notIn: ['onboarding_task', 'am_task'] }, closedAt: null },
  });
  if (unresolved >= c['am.ticketAlert']) {
    await open('r7', { taskType: 'coord', priority: 'urgent', dueIn: 0, title: 'Support escalation — take ownership', alertKey: 'SELLER_SUPPORT_ESCALATION',
      why: `${unresolved} unresolved support tickets (threshold ${c['am.ticketAlert']}).` });
  }
}
