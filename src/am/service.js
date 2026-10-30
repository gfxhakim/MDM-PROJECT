// Account Manager actions. An AM writes exactly three things (AM 9.2): owned seller fields,
// am_task create/update/close in their own book, and support tickets on behalf of a seller.
// Health and stage are derived — no function here (or anywhere) accepts them as input (AC-03).
import { prisma, inTx } from '../db.js';
import { logEvent } from '../services/audit.js';
import { getLiveConfig } from '../config/service.js';
import { grant } from '../auth/permissions.js';
import { denialReason, findSellerInScope, sellerCan, sellerWhere } from '../auth/scope.js';
import { badRequest, forbidden, HttpError, notFound } from '../http/errors.js';
import { notify } from '../core/notifications.js';
import { addSystemLine } from '../core/conversations.js';
import { computeHealth } from './health.js';
import { capacityFor, managerCapacity, taskMinutes } from './capacity.js';
import { gateOpen, STEPS, stepFor } from './playbook.js';
import { ALERTS } from './rules.js';

const TASK_TYPES = ['welcome', 'checkin', 'intervention', 'save', 'qbr', 'coach', 'expansion', 'coord'];
const CONTACT_TYPES = ['welcome', 'checkin', 'intervention', 'save', 'qbr', 'coach', 'expansion'];
const PRIORITY_UP = { low: 'normal', normal: 'high', high: 'urgent', urgent: 'urgent' };
const filled = (v) => typeof v === 'string' && v.trim().length > 0;

const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

function sellerView(s) {
  return {
    id: s.id, mdmRef: s.mdmRef, contactId: s.contactId, name: s.contact?.name, nameAr: s.contact?.nameAr, phone: s.contact?.phone,
    market: s.market, joinStatus: s.joinStatus, activatedAt: s.activatedAt, assignedAccountManagerId: s.assignedAccountManagerId,
    stage: s.stage, healthScore: s.healthScore, healthBand: s.healthBand, healthStale: s.healthStale, healthComputedAt: s.healthComputedAt,
    metrics: {
      weeklyOrders: json(s.weeklyOrders, []), totalOrders: s.totalOrders, deliveryRate: s.deliveryRate, returnRate: s.returnRate,
      cancelRate: s.cancelRate, wallet: s.wallet, walletNegativeDays: s.walletNegativeDays, products: s.products,
      marketsServed: s.marketsServed, momGrowthPct: s.momGrowthPct, lastOrderAt: s.lastOrderAt,
    },
    lastContactAt: s.lastContactAt, lastReviewAt: s.lastReviewAt, welcomeCallAt: s.welcomeCallAt, churnedAt: s.churnedAt,
  };
}

/** The caller's book (AC-19): every list is scoped; there is no "all sellers" for an AM. */
export async function listBook(user, { band, stage, q } = {}, db = prisma) {
  const scope = sellerWhere(user);
  if (!scope) throw forbidden(denialReason(user, 'seller.view'));
  const where = { AND: [scope, { joinStatus: 'accepted' }, band ? { healthBand: band } : {}, stage ? { stage } : {},
    q ? { OR: [{ mdmRef: { contains: q } }, { contact: { name: { contains: q } } }] } : {}] };
  const rows = await db.seller.findMany({ where, include: { contact: true }, orderBy: [{ healthScore: 'asc' }] });
  return rows.map(sellerView);
}

/** One seller: record, explained health, open tasks with their escalation ladder, playbook with live gates. */
export async function getSeller(user, id, { now = new Date() } = {}, db = prisma) {
  const s = await findSellerInScope(user, id, db, { include: { contact: true } });
  const { values: c } = await getLiveConfig(db);
  const [tasks, ticks, conv] = await Promise.all([
    db.ticket.findMany({ where: { type: 'am_task', sellerId: s.id }, orderBy: [{ status: 'desc' }, { dueAt: 'asc' }] }),
    db.playbookProgress.findMany({ where: { sellerId: s.id } }),
    db.conversation.findUnique({ where: { contactId: s.contactId }, select: { id: true } }),
  ]);
  const health = json(s.healthComponents, {});
  return {
    ...sellerView(s),
    conversationId: conv?.id ?? null,
    health: {
      score: s.healthScore, band: s.healthBand, stale: s.healthStale, computedAt: s.healthComputedAt,
      fallback: health.fallback ?? !c['am.engagementLive'],
      weighting: health.fallback ?? !c['am.engagementLive']
        ? `Engagement has no data source yet (F5): its ${c['am.wEngagement']}% is split between Order Activity and Delivery.`
        : 'All five components are weighted as configured.',
      components: health.components ?? [],
    },
    tasks: tasks.map((t) => taskView(user, t, s, c)),
    playbook: STEPS.map((step) => {
      const tick = ticks.find((x) => x.stepDay === step.day);
      const open = gateOpen(step, s);
      return { ...step, gateOpen: open, tickedAt: tick?.tickedAt ?? null, tickedById: tick?.tickedById ?? null,
        canTick: !tick?.tickedAt && open && sellerCan(user, s, 'playbook.tick').allowed,
        reason: tick?.tickedAt ? 'Already complete.' : open ? sellerCan(user, s, 'playbook.tick').reason : `Gate not met: ${step.gate}.` };
    }),
  };
}

function taskView(user, t, seller, c) {
  const close = sellerCan(user, seller, 'am_task.close');
  return {
    ...t, countsToward: 'none', minutes: taskMinutes(t.taskType, c),
    chip: t.taskType === 'checkin' ? (t.ruleId === 'r13' ? 'Check-in · cadence' : t.ruleId === 'r4' ? 'Check-in · no orders' : 'Check-in') : null,
    escalation: t.alertKey ? ALERTS[t.alertKey] ?? null : null,
    can: {
      close: t.status !== 'open' ? { allowed: false, reason: 'Already closed.' } : close,
      escalate: t.status !== 'open' ? { allowed: false, reason: 'Already closed.' } : t.escalated ? { allowed: false, reason: 'Already escalated.' } : sellerCan(user, seller, 'am_task.escalate'),
    },
  };
}

async function taskInScope(user, taskId, db) {
  const t = await db.ticket.findUnique({ where: { id: taskId } });
  if (!t || t.type !== 'am_task') throw notFound('Task not found.');
  const seller = await findSellerInScope(user, t.sellerId, db); // foreign → not-found
  return { t, seller };
}

/** Open a task by hand. `why` is required — a task without one is a task nobody can act on. */
export async function createTask(user, sellerId, { taskType, title, why, priority = 'normal', dueAt }, db = prisma) {
  if (!TASK_TYPES.includes(taskType)) throw badRequest(`taskType must be one of ${TASK_TYPES.join(', ')}.`);
  if (!filled(why)) throw badRequest('why is required: the numbers or reason that produced this task.');
  if (!['urgent', 'high', 'normal', 'low'].includes(priority)) throw badRequest('priority must be urgent, high, normal or low.');
  const seller = await findSellerInScope(user, sellerId, db);
  const can = sellerCan(user, seller, 'am_task.create');
  if (!can.allowed) throw forbidden(can.reason);
  const due = dueAt ? new Date(dueAt) : new Date();
  if (Number.isNaN(due.getTime())) throw badRequest('dueAt is not a date.');
  return inTx(db, async (tx) => {
    const t = await tx.ticket.create({
      data: { type: 'am_task', contactId: seller.contactId, sellerId: seller.id, assigneeId: seller.assignedAccountManagerId,
        status: 'open', taskType, title: title?.trim() || taskType, why: why.trim(), priority, dueAt: due, ruleId: null },
    });
    await logEvent({ actorId: user.id, entityType: 'ticket', entityId: t.id, action: 'am_task.opened', after: { taskType, priority, manual: true }, reason: why }, tx);
    return t;
  });
}

/** Close a task: a human act, outcome required. Contact tasks record the contact on the seller. */
export async function closeTask(user, taskId, outcome, { now = new Date() } = {}, db = prisma) {
  if (!filled(outcome)) throw badRequest('An outcome is required to close a task.');
  return inTx(db, async (tx) => {
    const { t, seller } = await taskInScope(user, taskId, tx);
    const can = sellerCan(user, seller, 'am_task.close');
    if (!can.allowed) throw forbidden(can.reason);
    if (t.status !== 'open') throw new HttpError(409, 'task_closed', 'This task is already closed.');
    const updated = await tx.ticket.update({ where: { id: t.id }, data: { status: 'done', outcome: outcome.trim(), closedAt: now } });
    const sellerData = {};
    if (CONTACT_TYPES.includes(t.taskType)) sellerData.lastContactAt = now;
    if (t.taskType === 'welcome' && !seller.welcomeCallAt) sellerData.welcomeCallAt = now;
    if (t.taskType === 'qbr') sellerData.lastReviewAt = now;
    if (Object.keys(sellerData).length) await tx.seller.update({ where: { id: seller.id }, data: sellerData });
    await logEvent({ actorId: user.id, entityType: 'ticket', entityId: t.id, action: 'am_task.closed', before: { status: 'open' }, after: { status: 'done', outcome: outcome.trim() } }, tx);
    return updated;
  });
}

/** Escalate (AM 5.5): moves the problem, never the seller. Reason required; audited. */
export async function escalateTask(user, taskId, reason, db = prisma) {
  if (!filled(reason)) throw badRequest('A written reason is required to escalate.');
  return inTx(db, async (tx) => {
    const { t, seller } = await taskInScope(user, taskId, tx);
    const can = sellerCan(user, seller, 'am_task.escalate');
    if (!can.allowed) throw forbidden(can.reason);
    if (t.status !== 'open') throw new HttpError(409, 'task_closed', 'This task is already closed.');
    if (t.escalated) throw new HttpError(409, 'already_escalated', 'This task is already escalated.');
    const updated = await tx.ticket.update({
      where: { id: t.id }, data: { escalated: true, escalatedAt: new Date(), escalationReason: reason.trim(), priority: PRIORITY_UP[t.priority] },
    });
    await logEvent({ actorId: user.id, entityType: 'ticket', entityId: t.id, action: 'am_task.escalated',
      before: { priority: t.priority }, after: { priority: updated.priority, escalatesTo: ALERTS[t.alertKey]?.escalatesTo ?? null }, reason }, tx);
    return updated;
  });
}

/** Tick a playbook step — refused when its gate is false, for every role (AC-14). */
export async function tickStep(user, sellerId, day, { now = new Date() } = {}, db = prisma) {
  const step = stepFor(day);
  if (!step) throw badRequest('Unknown playbook step.');
  return inTx(db, async (tx) => {
    const seller = await findSellerInScope(user, sellerId, tx);
    const can = sellerCan(user, seller, 'playbook.tick');
    if (!can.allowed) throw forbidden(can.reason);
    if (!gateOpen(step, seller)) throw new HttpError(422, 'gate_closed', `Day ${step.day} — ${step.title}: gate not met (${step.gate}).`);
    const existing = await tx.playbookProgress.findUnique({ where: { sellerId_stepDay: { sellerId: seller.id, stepDay: step.day } } });
    if (existing?.tickedAt) throw new HttpError(409, 'already_ticked', 'This step is already complete.');
    const row = await tx.playbookProgress.upsert({
      where: { sellerId_stepDay: { sellerId: seller.id, stepDay: step.day } },
      create: { sellerId: seller.id, stepDay: step.day, tickedAt: now, tickedById: user.id },
      update: { tickedAt: now, tickedById: user.id },
    });
    await logEvent({ actorId: user.id, entityType: 'seller', entityId: seller.id, action: 'playbook.ticked', after: { day: step.day, gate: step.gate } }, tx);
    return row;
  });
}

// ─────────────────────────── Admin ───────────────────────────

/**
 * Reassign sellers (AM 3.4): Admin only, written reason, audited per seller, bulk allowed.
 * Per-seller results are reported honestly. The conversation continues under the new manager's
 * number, with a system line the seller never sees (AM 3.5).
 */
export async function reassignSellers(user, sellerIds, toManagerId, reason, db = prisma) {
  if (grant(user.role, 'seller.assign_am') !== 'with_reason') throw forbidden(denialReason(user, 'seller.assign_am'));
  if (!filled(reason)) throw badRequest('A written reason is required.');
  if (!Array.isArray(sellerIds) || !sellerIds.length) throw badRequest('sellerIds must be a non-empty list.');
  const target = await db.user.findUnique({ where: { id: toManagerId } });
  if (!target || target.role !== 'ACCOUNT_MANAGER' || !target.active) throw badRequest('Reassign to an active Account Manager.');
  const { values: c } = await getLiveConfig(db);
  const results = [];
  for (const id of sellerIds) {
    try {
      await inTx(db, async (tx) => {
        const s = await tx.seller.findUnique({ where: { id }, include: { contact: true } });
        if (!s) throw notFound('Seller not found.');
        if (s.assignedAccountManagerId === target.id) throw badRequest('Already in that book.');
        const book = await tx.seller.count({ where: { assignedAccountManagerId: target.id } });
        if (book >= c['am.maxBook']) throw new HttpError(409, 'book_full', `${target.name}'s book is at the ceiling (${c['am.maxBook']}).`);
        await tx.seller.update({ where: { id }, data: { assignedAccountManagerId: target.id } });
        await tx.contact.update({ where: { id: s.contactId }, data: { ownerAgentId: target.id } });
        await tx.ticket.updateMany({ where: { sellerId: id, type: 'am_task', status: 'open' }, data: { assigneeId: target.id } });
        const conv = await tx.conversation.findUnique({ where: { contactId: s.contactId } });
        if (conv) {
          await tx.conversation.update({ where: { id: conv.id }, data: { businessNumber: target.businessNumber ?? conv.businessNumber } });
          await addSystemLine(conv.id, `Account manager changed to ${target.name}. Reason: ${reason}`, tx);
        }
        await logEvent({ actorId: user.id, entityType: 'seller', entityId: id, action: 'seller.reassigned',
          before: { assignedAccountManagerId: s.assignedAccountManagerId }, after: { assignedAccountManagerId: target.id }, reason }, tx);
        await notify({ userId: target.id, kind: 'am.reassigned', title: `${s.contact.name} moved to your book`, body: reason }, tx);
      });
      results.push({ sellerId: id, ok: true });
    } catch (err) {
      results.push({ sellerId: id, ok: false, error: err.message });
    }
  }
  await logEvent({ actorId: user.id, entityType: 'bulk', entityId: `reassign:${Date.now()}`, action: 'bulk.seller_reassign',
    after: { toManagerId: target.id, results }, reason });
  return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

/** Churn is set by hand until D-04 gives the save task a structured outcome (AM 5.7). Admin only. */
export async function markChurned(user, sellerId, reason, db = prisma) {
  if (user.role !== 'ADMIN') throw forbidden('Churn is marked by an Admin until the save outcome is structured (D-04).');
  if (!filled(reason)) throw badRequest('A churn reason is required.');
  const s = await findSellerInScope(user, sellerId, db);
  if (s.churnedAt) throw new HttpError(409, 'already_churned', 'Already marked churned.');
  await db.seller.update({ where: { id: s.id }, data: { churnedAt: new Date() } });
  await logEvent({ actorId: user.id, entityType: 'seller', entityId: s.id, action: 'seller.churned', reason }, db);
  return { churned: true };
}

export async function capacityView(user, db = prisma) {
  const { values: c } = await getLiveConfig(db);
  const managers = user.role === 'ADMIN'
    ? await db.user.findMany({ where: { role: 'ACCOUNT_MANAGER', active: true }, orderBy: { name: 'asc' } })
    : [await db.user.findUnique({ where: { id: user.id } })];
  return Promise.all(managers.map(async (m) => ({ managerId: m.id, name: m.name, markets: json(m.markets, []), ...(await managerCapacity(m, c, new Date(), db)) })));
}

export { computeHealth, capacityFor };

// ─────────────────────────── calls, snooze, transfer ───────────────────────────

const CALL_OUTCOMES = ['done', 'partial', 'no_answer', 'escalate'];

/**
 * Log a call on a seller (AM 5.3). The call line goes into the one conversation; an answered call
 * counts as contact. Against a task: done closes it, partial / no answer move it to tomorrow,
 * escalate escalates it (reason = the note). Never sends anything to the seller.
 */
export async function logCall(user, sellerId, { outcome, taskId, note, minutes }, { now = new Date() } = {}, db = prisma) {
  if (!CALL_OUTCOMES.includes(outcome)) throw badRequest(`outcome must be one of ${CALL_OUTCOMES.join(', ')}.`);
  if (outcome === 'escalate' && !filled(note)) throw badRequest('Say why this is beyond the account manager — the next owner reads only this.');
  const seller = await findSellerInScope(user, sellerId, db);
  const can = sellerCan(user, seller, 'seller.update');
  if (!can.allowed) throw forbidden(can.reason);
  const conv = await db.conversation.findUnique({ where: { contactId: seller.contactId } });
  const task = taskId ? (await taskInScope(user, taskId, db)).t : null;
  if (task && task.sellerId !== seller.id) throw badRequest('That task belongs to another seller.');
  if (task && task.status !== 'open') throw new HttpError(409, 'task_closed', 'This task is already closed.');
  const answered = outcome !== 'no_answer';
  const mins = Number.isFinite(Number(minutes)) && Number(minutes) > 0 ? Math.round(Number(minutes)) : 20;
  await inTx(db, async (tx) => {
    if (conv) {
      await tx.message.create({ data: { conversationId: conv.id, direction: 'out', kind: 'call_event', authorUserId: user.id, createdAt: now,
        body: answered ? `Outbound call · ${mins}:00 · answered` : 'Outbound call · 0:00 · no answer' } });
      if (filled(note)) await tx.message.create({ data: { conversationId: conv.id, direction: 'internal', kind: 'note', body: note.trim(), authorUserId: user.id, createdAt: now } });
    }
    if (answered) await tx.seller.update({ where: { id: seller.id }, data: { lastContactAt: now } });
    await logEvent({ actorId: user.id, entityType: 'seller', entityId: seller.id, action: 'seller.call_logged', after: { outcome, taskId: task?.id ?? null }, reason: note?.trim() || null }, tx);
  });
  if (task && outcome === 'done') await closeTask(user, task.id, note?.trim() || 'Resolved on the call', { now }, db);
  else if (task && (outcome === 'partial' || outcome === 'no_answer')) await snoozeTask(user, task.id, 1, { now, reason: outcome === 'no_answer' ? 'No answer — retry tomorrow.' : 'Follow-up needed.' }, db);
  else if (task && outcome === 'escalate') await escalateTask(user, task.id, note, db);
  return { logged: true };
}

/** Move a task's due date forward by whole days (the AM updates their own task; audited). */
export async function snoozeTask(user, taskId, days = 1, { now = new Date(), reason = null } = {}, db = prisma) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 30) throw badRequest('days must be a whole number from 1 to 30.');
  const { t, seller } = await taskInScope(user, taskId, db);
  const can = sellerCan(user, seller, 'am_task.close');
  if (!can.allowed) throw forbidden(can.reason);
  if (t.status !== 'open') throw new HttpError(409, 'task_closed', 'This task is already closed.');
  const base = t.dueAt && t.dueAt > now ? t.dueAt : now;
  const dueAt = new Date(base.getTime() + n * 86_400_000);
  const updated = await db.ticket.update({ where: { id: t.id }, data: { dueAt } });
  await logEvent({ actorId: user.id, entityType: 'ticket', entityId: t.id, action: 'am_task.rescheduled', before: { dueAt: t.dueAt }, after: { dueAt }, reason }, db);
  return updated;
}

/** An AM asks for a seller to move (AM 3.4): the Admin decides; nothing is reassigned here. */
export async function requestTransfer(user, sellerId, reason, db = prisma) {
  if (!filled(reason)) throw badRequest('A reason is required.');
  const seller = await findSellerInScope(user, sellerId, db, { include: { contact: true } });
  await logEvent({ actorId: user.id, entityType: 'seller', entityId: seller.id, action: 'seller.transfer_requested', reason }, db);
  await notifyAdmins(`${user.name} asks to transfer ${seller.contact.name}`, reason, `am-transfer:${seller.id}:${new Date().toISOString().slice(0, 10)}`, db);
  return { requested: true };
}

async function notifyAdmins(title, body, dedupeKey, db) {
  const admins = await db.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } });
  for (const a of admins) await notify({ userId: a.id, kind: 'am.transfer_request', title, body, dedupeKey }, db);
}

// ─────────────────────────── console bundle ───────────────────────────

/**
 * Everything the AM console renders for the caller's scope in one read: sellers with explained
 * health, tasks, playbook ticks, the conversation and the seller's timeline. Scoped exactly like
 * listBook — an AM receives their own book and nothing else.
 */
export async function consoleBundle(user, { now = new Date() } = {}, db = prisma) {
  const scope = sellerWhere(user);
  if (!scope) throw forbidden(denialReason(user, 'seller.view'));
  const { values: c } = await getLiveConfig(db);
  const sellers = await db.seller.findMany({ where: { AND: [scope, { joinStatus: 'accepted' }] }, include: { contact: true }, orderBy: { healthScore: 'asc' } });
  const ids = sellers.map((s) => s.id);
  const contactIds = sellers.map((s) => s.contactId);
  const [tasks, ticks, convs, events, tickets] = await Promise.all([
    db.ticket.findMany({ where: { type: 'am_task', sellerId: { in: ids } }, orderBy: { createdAt: 'desc' } }),
    db.playbookProgress.findMany({ where: { sellerId: { in: ids } } }),
    db.conversation.findMany({ where: { contactId: { in: contactIds } }, include: { messages: { orderBy: { createdAt: 'asc' }, take: 200 } } }),
    db.eventLog.findMany({ where: { entityType: 'seller', entityId: { in: ids } }, orderBy: { createdAt: 'desc' }, take: 2000 }),
    db.ticket.groupBy({ by: ['contactId'], where: { contactId: { in: contactIds }, type: { notIn: ['am_task', 'onboarding_task'] }, closedAt: null }, _count: true }),
  ]);
  const by = (rows, key) => rows.reduce((m, r) => m.set(r[key], [...(m.get(r[key]) ?? []), r]), new Map());
  const tasksBy = by(tasks, 'sellerId'); const ticksBy = by(ticks, 'sellerId'); const evBy = by(events, 'entityId');
  const convBy = new Map(convs.map((x) => [x.contactId, x]));
  const openTickets = new Map(tickets.map((x) => [x.contactId, x._count]));
  return {
    sellers: sellers.map((s) => {
      const health = json(s.healthComponents, {});
      const conv = convBy.get(s.contactId);
      return {
        ...sellerView(s),
        lastLoginAt: s.lastLoginAt, weeklyReturnRates: json(s.weeklyReturnRates, []), openTickets: openTickets.get(s.contactId) ?? 0,
        health: { score: s.healthScore, band: s.healthBand, stale: s.healthStale, fallback: health.fallback ?? !c['am.engagementLive'], components: health.components ?? [] },
        tasks: (tasksBy.get(s.id) ?? []).map((t) => taskView(user, t, s, c)),
        playbook: STEPS.map((step) => {
          const tick = (ticksBy.get(s.id) ?? []).find((x) => x.stepDay === step.day);
          return { day: step.day, title: step.title, gate: step.gate, gateOpen: gateOpen(step, s), tickedAt: tick?.tickedAt ?? null };
        }),
        conversation: conv ? { id: conv.id, channel: conv.channel, lastInboundAt: conv.lastInboundAt, takenOverById: conv.takenOverById, messages: conv.messages } : null,
        events: evBy.get(s.id) ?? [],
      };
    }),
  };
}
