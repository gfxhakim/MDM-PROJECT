// Ticket reads for both module types, scoped by role. Writes (state machine, macros, cadence,
// activation; am_task open/close/escalate) belong to the module engines in steps 5 and 6 and go
// through the same scope checks.
import { prisma } from '../db.js';
import { redact } from '../auth/permissions.js';
import { amTaskWhere, onboardingCan, onboardingReadWhere, sellerCan } from '../auth/scope.js';
import { badRequest, notFound } from '../http/errors.js';
import { TICKET_TYPES } from './ticketTypes.js';

const ONBOARDING_ACTIONS = [
  'onboarding.reply', 'onboarding.note', 'onboarding.edit', 'onboarding.macro', 'onboarding.template',
  'onboarding.reassign', 'onboarding.book_walkthrough', 'onboarding.activate', 'onboarding.reopen', 'onboarding.take_over',
];
const AM_ACTIONS = ['am_task.close', 'am_task.escalate', 'am.reply', 'am.note', 'am.template', 'playbook.tick'];

function whereFor(user, type) {
  if (type === 'onboarding_task') return onboardingReadWhere(user);
  if (type === 'am_task') return amTaskWhere(user);
  throw badRequest(`Unknown ticket type "${type}".`);
}

function parse(t) {
  const out = { ...t, countsToward: TICKET_TYPES[t.type].countsToward };
  if (t.type === 'onboarding_task') {
    out.qualification = JSON.parse(t.qualification);
    out.handoffRecord = JSON.parse(t.handoffRecord);
  } else {
    delete out.qualification; delete out.handoffRecord;
  }
  return out;
}

function canMap(user, t) {
  if (t.type === 'onboarding_task') {
    return Object.fromEntries(ONBOARDING_ACTIONS.map((p) => [p, onboardingCan(user, t, p)]));
  }
  return Object.fromEntries(AM_ACTIONS.map((p) => [p, sellerCan(user, t.seller, p)]));
}

const LIST_FILTERS = ['status', 'stage', 'priority', 'taskType'];

export async function listTickets(user, { type, assignee, take = 100, ...query } = {}, db = prisma) {
  const scope = whereFor(user, type);
  if (!scope) return [];
  const filters = Object.fromEntries(LIST_FILTERS.filter((k) => query[k]).map((k) => [k, query[k]]));
  if (assignee === 'me') filters.assigneeId = user.id;
  else if (assignee === 'none') filters.assigneeId = null;
  const rows = await db.ticket.findMany({
    where: { AND: [scope, filters] },
    include: { contact: true, assignee: { select: { id: true, name: true } } },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
    take: Math.min(Number(take) || 100, 500),
  });
  return redact(rows.map(parse), user.role);
}

export async function getTicket(user, id, db = prisma) {
  const head = await db.ticket.findUnique({ where: { id }, select: { type: true } });
  const scope = head && whereFor(user, head.type);
  const t = scope && (await db.ticket.findFirst({
    where: { AND: [{ id }, scope] },
    include: { contact: true, seller: true, assignee: { select: { id: true, name: true } } },
  }));
  if (!t) throw notFound('Ticket not found.');
  return redact({ ...parse(t), can: canMap(user, t) }, user.role);
}
