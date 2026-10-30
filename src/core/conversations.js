// The one conversation per contact, docked by both consoles (OA 6.4, AM 7.2). There is no
// second composer and no module-specific send path: every message goes through this file.
//
// Who may write:
//   - reply / template: only the conversation's owner, and only with the reply grant.
//       owner = the user who took it over, else the assignee of the open onboarding ticket,
//       else the contact's owner (the AM after activation). Supervisors take over first
//       (OA 9.2, AC-OA-22): "monitoring is not replying".
//   - note: anyone who can read it and holds the note grant. Notes never reach the contact.
// Closing a ticket never closes the conversation — a conversation has no closed state.
import { prisma, inTx } from '../db.js';
import { logEvent } from '../services/audit.js';
import { getLiveConfig } from '../config/service.js';
import { grant } from '../auth/permissions.js';
import { denialReason } from '../auth/scope.js';
import { badRequest, forbidden, HttpError, notFound } from '../http/errors.js';
import { contactWhere } from './contacts.js';
import { TICKET_TYPES } from './ticketTypes.js';
import { moduleForContact, onboardingBudget, renderTemplate, usableTemplate } from './templates.js';
import { emit } from './events.js';

export const SESSION_WINDOW_MS = 24 * 3_600_000;

/** The 24-hour customer-service window, from the last inbound message. */
export function sessionWindow(conversation, now = new Date()) {
  const last = conversation.lastInboundAt ? new Date(conversation.lastInboundAt) : null;
  const closesAt = last ? new Date(last.getTime() + SESSION_WINDOW_MS) : null;
  const open = !!closesAt && closesAt > now;
  return { open, closesAt, remainingMs: open ? closesAt - now : 0 };
}

async function load(id, db) {
  const c = await db.conversation.findUnique({
    where: { id },
    include: {
      contact: { include: { seller: true } },
    },
  });
  if (!c) return null;
  const openOnboarding = await db.ticket.findFirst({
    where: { contactId: c.contactId, type: 'onboarding_task', status: { in: TICKET_TYPES.onboarding_task.openStatuses } },
  });
  return { ...c, openOnboarding };
}

/** Load a conversation the user may read, or not-found. */
export async function findConversation(user, id, db = prisma) {
  const where = contactWhere(user);
  const c = where && (await load(id, db));
  if (!c) throw notFound('Conversation not found.');
  const visible = await db.contact.count({ where: { AND: [{ id: c.contactId }, where] } });
  if (!visible) throw notFound('Conversation not found.');
  return c;
}

export function ownerOf(conv) {
  if (conv.takenOverById) return { userId: conv.takenOverById, via: 'take_over' };
  if (conv.openOnboarding) return { userId: conv.openOnboarding.assigneeId, via: 'onboarding_ticket' };
  return { userId: conv.contact.ownerAgentId ?? conv.contact.seller?.assignedAccountManagerId ?? null, via: 'contact_owner' };
}

/** What this user may do in this (already readable) conversation, each with its reason. */
export function conversationCan(user, conv) {
  const onboarding = !!conv.openOnboarding || conv.contact.contactType === 'merchant';
  const replyPerm = onboarding ? 'onboarding.reply' : 'am.reply';
  const notePerm = onboarding ? 'onboarding.note' : 'am.note';
  const takePerm = onboarding ? 'onboarding.take_over' : 'am.take_over';
  const owner = ownerOf(conv);
  const isOwner = !!owner.userId && owner.userId === user.id;

  let reply = { allowed: false, reason: null };
  const contact = conv.contact;
  if (!grant(user.role, replyPerm)) reply.reason = denialReason(user, replyPerm);
  else if (!isOwner) {
    reply.reason = grant(user.role, takePerm)
      ? 'Monitoring is not replying — take the conversation over first, with a reason.'
      : onboarding ? 'Lead not assigned to you — add an internal note instead.' : 'Not your seller.';
  } else if (contact.blocked) reply.reason = 'Contact is blocked.';
  else if (contact.optedOut) reply.reason = 'Contact has opted out of messages.';
  else reply = { allowed: true, reason: null };

  const noteGrant = grant(user.role, notePerm);
  const note = noteGrant ? { allowed: true, reason: null } : { allowed: false, reason: denialReason(user, notePerm) };
  const takeOver = grant(user.role, takePerm) && !isOwner
    ? { allowed: true, reason: null, needsReason: true }
    : { allowed: false, reason: isOwner ? 'You already own this conversation.' : denialReason(user, takePerm) };
  return { reply, template: reply, note, takeOver, owner };
}

function view(user, conv, messages, now) {
  return {
    id: conv.id,
    contactId: conv.contactId,
    channel: conv.channel,
    businessNumber: conv.businessNumber,
    window: sessionWindow(conv, now),
    owner: ownerOf(conv),
    takenOverById: conv.takenOverById,
    openOnboardingTicketId: conv.openOnboarding?.id ?? null,
    can: conversationCan(user, conv),
    messages,
  };
}

export async function getConversation(user, id, { now = new Date() } = {}, db = prisma) {
  const conv = await findConversation(user, id, db);
  const messages = await db.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: 'asc' } });
  return view(user, conv, messages, now);
}

export async function getConversationForContact(user, contactId, opts, db = prisma) {
  const c = await db.conversation.findUnique({ where: { contactId } });
  if (!c) throw notFound('Conversation not found.');
  return getConversation(user, c.id, opts, db);
}

async function writeOutbound(db, conv, data, actorId, auditAction, auditAfter) {
  return inTx(db, async (tx) => {
    const msg = await tx.message.create({ data: { conversationId: conv.id, direction: 'out', ...data, authorUserId: actorId } });
    await tx.conversation.update({ where: { id: conv.id }, data: { lastOutboundAt: msg.createdAt } });
    await logEvent({ actorId, entityType: 'conversation', entityId: conv.id, action: auditAction, after: { messageId: msg.id, ...auditAfter } }, tx);
    return msg;
  });
}

/** Free-text reply. Blocked server-side outside the 24-hour window. */
export async function sendText(user, conversationId, body, { now = new Date() } = {}, db = prisma) {
  if (!body || !String(body).trim()) throw badRequest('Message body is required.');
  const conv = await findConversation(user, conversationId, db);
  const can = conversationCan(user, conv);
  if (!can.reply.allowed) throw forbidden(can.reply.reason);
  if (!sessionWindow(conv, now).open) {
    throw new HttpError(409, 'window_closed', 'The 24-hour window is closed. Only an approved template can be sent (billable).');
  }
  const msg = await writeOutbound(db, conv, { kind: 'text', body: String(body), createdAt: now }, user.id, 'message.sent', { kind: 'text' });
  await emit('message.sent', { conversation: conv, message: msg, actorId: user.id });
  return msg;
}

/**
 * Send an approved template, inside or outside the window. Always billable.
 * `user` is null for an automated send by a rule (actor = system). Onboarding sends are checked
 * against the monthly ceiling and the per-contact cap; a rule never fabricates a send it cannot pay for.
 */
export async function sendTemplate(user, conversationId, templateKey, variables = [], { now = new Date(), automated = false, ruleId, config, silent = false } = {}, db = prisma) {
  let conv;
  if (automated) {
    conv = await load(conversationId, db);
    if (!conv) throw notFound('Conversation not found.');
    if (conv.contact.blocked || conv.contact.optedOut) {
      throw new HttpError(409, 'contact_unreachable', conv.contact.blocked ? 'Contact is blocked.' : 'Contact has opted out of messages.');
    }
  } else {
    conv = await findConversation(user, conversationId, db);
    const can = conversationCan(user, conv);
    if (!can.template.allowed) throw forbidden(can.template.reason);
  }
  // `config` lets a simulated sweep evaluate the budget against the draft; `silent` keeps a
  // simulation from emitting events that would run outside its rolled-back transaction.
  const values = config ?? (await getLiveConfig(db)).values;
  const t = await usableTemplate(templateKey, conv.contact, values, db);
  const body = renderTemplate(t.bodyEn, variables);
  if (moduleForContact(conv.contact) === 'oa') {
    const budget = await onboardingBudget(conv.id, { now, config: values }, db);
    if (!budget.allowed) throw new HttpError(409, 'template_budget', budget.reason, budget);
  }
  const actorId = automated ? null : user.id;
  const msg = await writeOutbound(db, conv, { kind: 'template', body, templateKey: t.key, billable: true, createdAt: now }, actorId,
    'message.template_sent', { templateKey: t.key, billable: true, automated, ruleId: ruleId ?? null });
  if (!silent) await emit('message.sent', { conversation: conv, message: msg, actorId, automated });
  return msg;
}

/** Internal note. Never shown to the contact; allowed on any readable conversation with the grant. */
export async function addNote(user, conversationId, body, db = prisma) {
  if (!body || !String(body).trim()) throw badRequest('Note text is required.');
  const conv = await findConversation(user, conversationId, db);
  const can = conversationCan(user, conv);
  if (!can.note.allowed) throw forbidden(can.note.reason);
  return db.message.create({ data: { conversationId: conv.id, direction: 'internal', kind: 'note', body: String(body), authorUserId: user.id } });
}

/** System line in the thread (assignment, take-over …). Internal, never sent. */
export function addSystemLine(conversationId, body, db = prisma) {
  return db.message.create({ data: { conversationId, direction: 'internal', kind: 'system', body } });
}

/**
 * Take over (OA 13.3 / AM Appendix A): reason required, system line posted, audited with the
 * previous owner. On an open onboarding ticket it reassigns the ticket; otherwise it marks the
 * conversation as taken over until released.
 */
export async function takeOver(user, conversationId, reason, db = prisma) {
  if (!reason || !String(reason).trim()) throw badRequest('A written reason is required to take over.');
  const conv = await findConversation(user, conversationId, db);
  const can = conversationCan(user, conv);
  if (!can.takeOver.allowed) throw forbidden(can.takeOver.reason);
  const previous = ownerOf(conv).userId ?? null;
  await inTx(db, async (tx) => {
    if (conv.openOnboarding && !conv.takenOverById) {
      await tx.ticket.update({ where: { id: conv.openOnboarding.id }, data: { assigneeId: user.id } });
      await logEvent({
        actorId: user.id, entityType: 'ticket', entityId: conv.openOnboarding.id, action: 'ticket.taken_over',
        before: { assigneeId: previous }, after: { assigneeId: user.id }, reason,
      }, tx);
    } else {
      await tx.conversation.update({ where: { id: conv.id }, data: { takenOverById: user.id, takenOverAt: new Date() } });
      await logEvent({
        actorId: user.id, entityType: 'conversation', entityId: conv.id, action: 'conversation.taken_over',
        before: { ownerId: previous }, after: { ownerId: user.id }, reason,
      }, tx);
    }
    await addSystemLine(conv.id, `${user.name} took over this conversation. Reason: ${reason}`, tx);
  });
  return getConversation(user, conv.id, {}, db);
}

/** Hand a taken-over conversation back to its normal owner. */
export async function release(user, conversationId, db = prisma) {
  const conv = await findConversation(user, conversationId, db);
  if (conv.takenOverById !== user.id && user.role !== 'ADMIN') throw forbidden('Only the user who took it over, or an Admin, can release it.');
  if (!conv.takenOverById) throw badRequest('This conversation is not taken over.');
  await inTx(db, async (tx) => {
    await tx.conversation.update({ where: { id: conv.id }, data: { takenOverById: null, takenOverAt: null } });
    await logEvent({ actorId: user.id, entityType: 'conversation', entityId: conv.id, action: 'conversation.released', before: { ownerId: conv.takenOverById } }, tx);
    await addSystemLine(conv.id, `${user.name} handed the conversation back.`, tx);
  });
  return getConversation(user, conv.id, {}, db);
}
