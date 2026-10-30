// Onboarding Agent engine — capture (r1), reset-on-reply (r7), the agent's actions, the state
// machine, activation and handoff. Every write is scoped (src/auth/scope.js), audited in the one
// EventLog, and validated here in the service — the interface only mirrors these checks.
import { prisma, inTx } from '../db.js';
import { logEvent } from '../services/audit.js';
import { getLiveConfig } from '../config/service.js';
import { grant } from '../auth/permissions.js';
import { denialReason, findOnboardingTicket, onboardingCan } from '../auth/scope.js';
import { badRequest, forbidden, HttpError, notFound } from '../http/errors.js';
import { notify, notifyRole } from '../core/notifications.js';
import { addNote, addSystemLine, sendTemplate } from '../core/conversations.js';
import { emit } from '../core/events.js';
import { TICKET_TYPES } from '../core/ticketTypes.js';
import { handover } from '../am/handover.js';
import { addBusinessMinutes, hoursFromConfig, isBusinessTime } from './businessHours.js';
import { pickAgent } from './capacity.js';
import {
  activationGate, canTransition, CLOSED, filled, HANDOFF_KEYS, HANDOFF_SYSTEM_KEYS, QUALIFICATION_KEYS, STAGES,
} from './stateMachine.js';

const OPEN = TICKET_TYPES.onboarding_task.openStatuses;
const DAY = 86_400_000;
const WALKTHROUGH_MODES = ['phone', 'meet', 'whatsapp_video'];

const json = (s) => (typeof s === 'string' ? JSON.parse(s) : s);
const tagsOf = (t) => json(t.tags ?? '[]');
const withTag = (t, tag) => JSON.stringify([...new Set([...tagsOf(t), tag])]);

/** Update a ticket and audit exactly the fields that changed. */
export async function changeTicket(db, ticket, data, { actorId = null, action = 'ticket.updated', reason = null } = {}) {
  const before = {};
  const after = {};
  for (const [k, v] of Object.entries(data)) {
    const old = ticket[k] instanceof Date ? ticket[k].toISOString() : ticket[k];
    const nu = v instanceof Date ? v.toISOString() : v;
    if (old !== nu) { before[k] = old ?? null; after[k] = nu ?? null; }
  }
  const updated = await db.ticket.update({ where: { id: ticket.id }, data });
  if (Object.keys(after).length) {
    await logEvent({ actorId, entityType: 'ticket', entityId: ticket.id, action, before, after, reason }, db);
  }
  return updated;
}

async function conversationOf(contactId, db) {
  return db.conversation.findUnique({ where: { contactId } });
}

/** Load a readable ticket and check the user may perform `permission` on it. */
async function forAction(user, ticketId, permission, db, { open = true } = {}) {
  const t = await findOnboardingTicket(user, ticketId, db);
  const can = onboardingCan(user, t, permission);
  if (!can.allowed) throw forbidden(can.reason);
  if (open && !OPEN.includes(t.status)) throw new HttpError(409, 'ticket_closed', `This lead is ${t.status.replace('_', ' ')} — reopen it first.`);
  return t;
}

const config = async (db, c) => c ?? (await getLiveConfig(db)).values;

// ─────────────────────────── r1 — capture ───────────────────────────

/**
 * r1 (OA 3.2): a merchant with no open onboarding ticket gets one, assigned by pick_agent, or
 * held with a reason. Returns the ticket, or null when the rule does not apply.
 */
export async function capture(contactId, { now = new Date(), cfg, source } = {}, db = prisma) {
  const c = await config(db, cfg);
  if (!c['oa.rule.r1.enabled']) return null;
  return inTx(db, async (tx) => {
    const contact = await tx.contact.findUnique({ where: { id: contactId } });
    if (!contact || contact.contactType !== 'merchant' || contact.blocked) return null;
    const existing = await tx.ticket.findFirst({ where: { contactId, type: 'onboarding_task', status: { in: OPEN } } });
    if (existing) return null;

    const bh = hoursFromConfig(c);
    let assignee = null;
    let holdReason = null;
    if (!isBusinessTime(now, bh)) holdReason = 'outside business hours';
    else {
      const pick = await pickAgent(contact.country, c, now, tx);
      if (pick.agent) assignee = pick.agent;
      else holdReason = pick.holdReason;
    }
    const dueAt = addBusinessMinutes(now, c['oa.first_contact_sla'] * 60, bh);
    const ticket = await tx.ticket.create({
      data: {
        type: 'onboarding_task', contactId, status: 'new', stage: 'first_contact', dueAt, createdAt: now,
        assigneeId: assignee?.id ?? null, holdReason, heldAt: assignee ? null : now,
        handoffRecord: JSON.stringify({ source: contact.sourceUtm ?? source ?? 'whatsapp' }),
      },
    });
    await logEvent({
      entityType: 'ticket', entityId: ticket.id, action: 'ticket.created',
      after: { type: 'onboarding_task', assigneeId: ticket.assigneeId, holdReason, dueAt: dueAt.toISOString(), rule: 'r1' },
    }, tx);
    if (assignee) {
      await notify({ userId: assignee.id, kind: 'oa.r1.assigned', title: `New lead: ${contact.name}`, ticketId: ticket.id, dedupeKey: `oa.r1:${ticket.id}` }, tx);
    }
    return ticket;
  });
}

/** A registration on the platform (contact.registered). Same phone → same contact (OA 3.3). */
export async function registerMerchant({ phone, name, country, sourceUtm }, { now = new Date() } = {}, db = prisma) {
  const { normalizePhone } = await import('../core/contacts.js');
  const e164 = normalizePhone(phone);
  let contact = await db.contact.findUnique({ where: { phone: e164 } });
  if (!contact) {
    if (!country) throw badRequest('country is required for a new registration.');
    contact = await db.contact.create({ data: { phone: e164, name: name?.trim() || e164, country, sourceUtm: sourceUtm ?? null } });
    await db.conversation.create({ data: { contactId: contact.id, businessNumber: process.env.ONBOARDING_NUMBER ?? null } });
    await logEvent({ entityType: 'contact', entityId: contact.id, action: 'contact.created', after: { phone: e164, country, sourceUtm: sourceUtm ?? null, via: 'registration' } });
  }
  if (contact.contactType !== 'merchant') {
    // An existing seller registering again: escalate to their AM, never a second onboarding.
    const conv = await conversationOf(contact.id, db);
    if (conv) await addSystemLine(conv.id, 'Registered again — this contact is already a seller. Check with their account manager before anything is activated.', db);
    if (contact.ownerAgentId) await notify({ userId: contact.ownerAgentId, kind: 'oa.duplicate_registration', title: `${contact.name} registered again`, dedupeKey: `dupreg:${contact.id}:${now.toISOString().slice(0, 10)}` });
    return { contact, ticket: null, outcome: 'escalated_existing_seller' };
  }
  const open = await db.ticket.findFirst({ where: { contactId: contact.id, type: 'onboarding_task', status: { in: OPEN } } });
  if (open) {
    const conv = await conversationOf(contact.id, db);
    if (conv) await addSystemLine(conv.id, `Registered again${sourceUtm ? ` (source: ${sourceUtm})` : ''} — existing onboarding ticket kept.`, db);
    return { contact, ticket: open, outcome: 'annotated_existing' };
  }
  await emit('contact.registered', { contact, now });
  const ticket = await db.ticket.findFirst({ where: { contactId: contact.id, type: 'onboarding_task', status: { in: OPEN } } });
  return { contact, ticket, outcome: ticket ? 'created' : 'no_ticket' };
}

// ─────────────────────────── r7 — reset on reply, once ───────────────────────────

export async function resetOnReply(contactId, { now = new Date(), cfg } = {}, db = prisma) {
  const c = await config(db, cfg);
  if (!c['oa.rule.r7.enabled']) return null;
  const t = await db.ticket.findFirst({ where: { contactId, type: 'onboarding_task', status: { in: OPEN }, cadenceReset: false } });
  if (!t) return null;
  // A brand-new ticket's own first message is not a reply to a cadence.
  if (t.attemptNo === 0 && t.followupNo === 0 && t.status === 'new') return null;
  const updated = await changeTicket(db, t, {
    attemptNo: 0, followupNo: 0, cadenceReset: true, dueAt: now, nextAttemptAt: null, nextFollowupAt: null,
  }, { action: 'ticket.cadence_reset', reason: 'r7 — inbound reply resets the cadence (once per ticket)' });
  await notify({ userId: t.assigneeId, kind: 'oa.r7.replied', title: 'Lead replied', ticketId: t.id, dedupeKey: `oa.r7:${t.id}` }, db);
  return updated;
}

// ─────────────────────────── agent actions ───────────────────────────

/** Log a call outcome (OA 5.2, macros 6.5). The counter moves only here, never by a rule. */
export async function logCall(user, ticketId, outcome, note, { now = new Date(), permission = 'onboarding.edit' } = {}, db = prisma) {
  if (!['no_answer', 'answered_strong', 'answered_soft'].includes(outcome)) throw badRequest('outcome must be no_answer, answered_strong or answered_soft.');
  const c = await config(db);
  return inTx(db, async (tx) => {
    const t = await forAction(user, ticketId, permission, tx);
    const max = c['oa.no_answer_max'];
    const attemptNo = Math.min(t.attemptNo + 1, outcome === 'no_answer' ? max : t.attemptNo + 1);
    let data;
    let defaultNote;
    if (outcome === 'no_answer') {
      if (t.status !== 'failed_to_contact' && !canTransition(t.status, 'failed_to_contact')) {
        throw new HttpError(409, 'illegal_transition', `A ${t.status} lead cannot move to Failed to Contact.`);
      }
      if (attemptNo >= max) {
        data = { attemptNo, status: 'cold_lead', dueAt: null, nextAttemptAt: null, closedAt: now, tags: withTag(t, 'oa_cold_no_answer') };
        defaultNote = `${attemptNo} daily attempts, no answer — cadence cutoff`;
      } else {
        const next = new Date(now.getTime() + c['oa.no_answer_gap'] * DAY);
        data = { attemptNo, status: 'failed_to_contact', nextAttemptAt: next, dueAt: next };
        defaultNote = `Called, no answer (attempt ${attemptNo} of ${max}).`;
      }
    } else {
      const to = outcome === 'answered_strong' ? 'qualified' : 'prequalified';
      if (t.status !== to && !canTransition(t.status, to)) throw new HttpError(409, 'illegal_transition', `A ${t.status} lead cannot move to ${to}.`);
      data = { attemptNo, status: to, nextAttemptAt: null, ...(outcome === 'answered_strong' ? { stage: 'walkthrough' } : {}) };
      defaultNote = outcome === 'answered_strong' ? 'Answered — strong lead.' : 'Answered — soft lead.';
    }
    const updated = await changeTicket(tx, t, data, { actorId: user.id, action: 'ticket.call_logged', reason: outcome });
    const conv = await conversationOf(t.contactId, tx);
    if (conv) await tx.message.create({ data: { conversationId: conv.id, direction: 'internal', kind: 'note', body: note?.trim() || defaultNote, authorUserId: user.id } });
    return updated;
  });
}

/** Move status along the state machine (OA 2.5). Activation has its own action. */
export async function transition(user, ticketId, to, reason, { now = new Date() } = {}, db = prisma) {
  if (to === 'activated') throw badRequest('Use the activate action — it enforces the qualification gate and the handoff record.');
  const c = await config(db);
  return inTx(db, async (tx) => {
    const t0 = await findOnboardingTicket(user, ticketId, tx);
    const reopening = ['cold_lead', 'junk_lead'].includes(t0.status);
    const t = await forAction(user, ticketId, reopening ? 'onboarding.reopen' : 'onboarding.edit', tx, { open: !reopening });
    if (!canTransition(t.status, to)) throw new HttpError(409, 'illegal_transition', `${t.status} → ${to} is not a permitted transition.`);
    const needsReason = reopening || (to === 'cold_lead' && !(t.status === 'failed_to_contact' && t.attemptNo >= c['oa.no_answer_max']));
    if (needsReason && !filled(reason)) throw badRequest('A written reason is required for this change.');
    const data = { status: to };
    if (CLOSED.includes(to)) Object.assign(data, { closedAt: now, dueAt: null, nextAttemptAt: null, nextFollowupAt: null });
    if (reopening) Object.assign(data, { closedAt: null, dueAt: now, attemptNo: 0, followupNo: 0, cadenceReset: false });
    return changeTicket(tx, t, data, { actorId: user.id, action: reopening ? 'ticket.reopened' : 'ticket.status_changed', reason: reason ?? null });
  });
}

/** Edit agent-owned fields: stage, priority, qualification, handoff record, stalled reason. */
export async function updateTicket(user, ticketId, patch = {}, db = prisma) {
  const allowed = ['stage', 'priority', 'qualification', 'handoffRecord', 'stalledReason'];
  const unknown = Object.keys(patch).filter((k) => !allowed.includes(k));
  if (unknown.length) throw badRequest(`Not editable here: ${unknown.join(', ')}. Counters, due dates and assignment are written by the rules.`);
  return inTx(db, async (tx) => {
    const t = await forAction(user, ticketId, 'onboarding.edit', tx);
    const data = {};
    if (patch.stage !== undefined) {
      if (!STAGES.includes(patch.stage) || patch.stage === 'done') throw badRequest(`stage must be one of ${STAGES.filter((s) => s !== 'done').join(', ')}.`);
      data.stage = patch.stage;
    }
    if (patch.priority !== undefined) {
      if (!['urgent', 'high', 'normal', 'low'].includes(patch.priority)) throw badRequest('priority must be urgent, high, normal or low.');
      data.priority = patch.priority;
    }
    if (patch.qualification !== undefined) {
      const q = { ...json(t.qualification) };
      for (const [k, v] of Object.entries(patch.qualification ?? {})) {
        if (!QUALIFICATION_KEYS.includes(k) || typeof v !== 'boolean') throw badRequest(`qualification.${k} must be one of ${QUALIFICATION_KEYS.join(', ')} with a true/false value.`);
        q[k] = v;
      }
      data.qualification = JSON.stringify(q);
    }
    if (patch.handoffRecord !== undefined) {
      const h = { ...json(t.handoffRecord) };
      for (const [k, v] of Object.entries(patch.handoffRecord ?? {})) {
        if (!HANDOFF_KEYS.includes(k)) throw badRequest(`Unknown handoff field "${k}".`);
        if (HANDOFF_SYSTEM_KEYS.includes(k)) throw badRequest(`handoffRecord.${k} is written by the platform.`);
        if (typeof v !== 'string') throw badRequest(`handoffRecord.${k} must be text.`);
        h[k] = v;
      }
      data.handoffRecord = JSON.stringify(h);
    }
    if (patch.stalledReason !== undefined) {
      if (!filled(patch.stalledReason)) throw badRequest('stalledReason must be written text.');
      data.stalledReason = String(patch.stalledReason).trim();
    }
    return changeTicket(tx, t, data, { actorId: user.id });
  });
}

/** Book the walkthrough (OA 7.2). Consumes walkthrough minutes from the moment it is booked. */
export async function bookWalkthrough(user, ticketId, { at, mode }, { now = new Date() } = {}, db = prisma) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime()) || when <= now) throw badRequest('Walkthrough time must be in the future.');
  if (!WALKTHROUGH_MODES.includes(mode)) throw badRequest(`mode must be one of ${WALKTHROUGH_MODES.join(', ')}.`);
  return inTx(db, async (tx) => {
    const t = await forAction(user, ticketId, 'onboarding.book_walkthrough', tx);
    return changeTicket(tx, t, { stage: 'walkthrough', walkthroughAt: when, walkthroughMode: mode, dueAt: when },
      { actorId: user.id, action: 'ticket.walkthrough_booked' });
  });
}

/** The declined-call path (OA 7.3): send the Hub, start the went-quiet cadence. */
export async function sendHub(user, ticketId, variables, { now = new Date() } = {}, db = prisma) {
  const c = await config(db);
  const t = await forAction(user, ticketId, 'onboarding.template', db);
  const conv = await conversationOf(t.contactId, db);
  if (!conv) throw notFound('Conversation not found.');
  await sendTemplate(user, conv.id, 'oa_hub_share_v1', variables, { now }, db);
  const next = new Date(now.getTime() + c['oa.quiet_gap'] * DAY);
  return changeTicket(db, await db.ticket.findUnique({ where: { id: t.id } }),
    { stage: 'walkthrough', followupNo: 0, nextFollowupAt: next, dueAt: next },
    { actorId: user.id, action: 'ticket.hub_sent', reason: 'Declined a call — Resource Hub sent; went-quiet cadence starts' });
}

/** "Request transfer" — the agent's only assignment-adjacent action (OA 4.5). */
export async function requestTransfer(user, ticketId, reason, db = prisma) {
  if (!filled(reason)) throw badRequest('A written reason is required.');
  const t = await findOnboardingTicket(user, ticketId, db);
  if (grant(user.role, 'onboarding.reassign') !== 'request') throw forbidden('Your role reassigns directly.');
  await logEvent({ actorId: user.id, entityType: 'ticket', entityId: t.id, action: 'ticket.transfer_requested', reason }, db);
  await notifyRole('SHIFT_LEAD', { kind: 'oa.transfer_request', title: `${user.name} requests a transfer`, body: reason, ticketId: t.id }, db);
  return { requested: true };
}

/** Reassign (shift lead, manager, admin). The merchant sees nothing; audited before/after. */
export async function reassign(user, ticketId, toUserId, reason, db = prisma) {
  if (!filled(reason)) throw badRequest('A written reason is required.');
  return inTx(db, async (tx) => {
    const t = await findOnboardingTicket(user, ticketId, tx);
    if (grant(user.role, 'onboarding.reassign') !== true) throw forbidden(denialReason(user, 'onboarding.reassign'));
    if (!OPEN.includes(t.status)) throw new HttpError(409, 'ticket_closed', 'Only an open lead can be reassigned.');
    const target = await tx.user.findUnique({ where: { id: toUserId } });
    if (!target || !target.active || target.role !== 'OA_AGENT') throw badRequest('Reassign to an active Onboarding Agent.');
    if (target.id === t.assigneeId) throw badRequest('The lead is already assigned to that agent.');
    const updated = await changeTicket(tx, t, { assigneeId: target.id, holdReason: null, heldAt: null }, { actorId: user.id, action: 'ticket.reassigned', reason });
    const conv = await conversationOf(t.contactId, tx);
    if (conv) await addSystemLine(conv.id, `Reassigned to ${target.name} by ${user.name}.`, tx);
    await notify({ userId: target.id, kind: 'oa.reassigned', title: 'Lead reassigned to you', body: reason, ticketId: t.id }, tx);
    if (t.assigneeId) await notify({ userId: t.assigneeId, kind: 'oa.reassigned_away', title: 'Lead reassigned', body: reason, ticketId: t.id }, tx);
    return updated;
  });
}

/** Assign a held ticket over capacity (OA 4.5): most free minutes, ignoring can_take; never to an agent on a call. */
export async function assignOverCapacity(user, ticketId, reason, { now = new Date() } = {}, db = prisma) {
  if (grant(user.role, 'onboarding.assign_over_capacity') !== true) throw forbidden(denialReason(user, 'onboarding.assign_over_capacity'));
  if (!filled(reason)) throw badRequest('A written reason is required.');
  const c = await config(db);
  return inTx(db, async (tx) => {
    const t = await findOnboardingTicket(user, ticketId, tx);
    if (t.assigneeId || !OPEN.includes(t.status)) throw new HttpError(409, 'not_held', 'Only a held (unassigned, open) lead can be assigned over capacity.');
    const pick = await pickAgent(t.contact.country, c, now, tx, { ignoreCapacity: true });
    if (!pick.agent) throw new HttpError(409, 'no_agent', `No agent available: ${pick.holdReason}.`);
    const updated = await changeTicket(tx, t, { assigneeId: pick.agent.id, holdReason: null, heldAt: null }, { actorId: user.id, action: 'ticket.assigned_over_capacity', reason });
    await notify({ userId: pick.agent.id, kind: 'oa.r1.assigned', title: `New lead: ${t.contact.name}`, body: 'Assigned over capacity', ticketId: t.id }, tx);
    return updated;
  });
}

// ─────────────────────────── activation & handoff (OA 8) ───────────────────────────

/**
 * The accept action. Preconditions are enforced here (AC-OA-15): status Qualified, all five
 * qualification criteria, every agent-written handoff field. Then: the seller is accepted, the
 * contact becomes a seller owned by the AM (AM rule r1 picks them), the ticket is activated and
 * closed, the conversation stays open, and the AM's welcome task is opened.
 */
export async function activate(user, ticketId, { now = new Date() } = {}, db = prisma) {
  const c = await config(db);
  const result = await inTx(db, async (tx) => {
    const t = await forAction(user, ticketId, 'onboarding.activate', tx);
    const gate = activationGate(t);
    if (!gate.ok) throw new HttpError(422, 'activation_gate', gate.reason, gate);
    const contact = t.contact;

    // Platform accept operation (idempotent). The MDM connector (step 9) maps the real seller id.
    let seller = await tx.seller.findUnique({ where: { contactId: contact.id } });
    if (!seller) {
      seller = await tx.seller.create({ data: { mdmRef: `LOCAL-${contact.id}`, contactId: contact.id, market: contact.country, joinStatus: 'accepted', activatedAt: now } });
    } else if (seller.joinStatus !== 'accepted') {
      seller = await tx.seller.update({ where: { id: seller.id }, data: { joinStatus: 'accepted', activatedAt: now } });
    }
    await tx.contact.update({ where: { id: contact.id }, data: { contactType: 'seller', ownerAgentId: null } });
    await logEvent({ actorId: user.id, entityType: 'seller', entityId: seller.id, action: 'seller.accepted', after: { joinStatus: 'accepted', ticketId: t.id } }, tx);

    const ho = await handover(seller.id, { config: c, now, handoffRecord: json(t.handoffRecord) }, tx);
    const handoffRecord = {
      ...json(t.handoffRecord),
      source: json(t.handoffRecord).source || contact.sourceUtm || 'whatsapp',
      accountManager: ho.assigned ? ho.managerName : `Unassigned — ${ho.reason}`,
    };
    const updated = await changeTicket(tx, t, {
      status: 'activated', stage: 'done', dueAt: null, nextAttemptAt: null, nextFollowupAt: null, closedAt: now,
      handoffRecord: JSON.stringify(handoffRecord),
    }, { actorId: user.id, action: 'ticket.activated', reason: ho.assigned ? `Handed to ${ho.managerName}` : ho.reason });
    const conv = await conversationOf(contact.id, tx);
    if (conv) {
      await addSystemLine(conv.id, ho.assigned
        ? `Activated by ${user.name}. ${ho.managerName} is now the account manager on this conversation.`
        : `Activated by ${user.name}. No account manager assigned yet — ${ho.reason}`, tx);
    }
    return { ticket: updated, seller, handover: ho };
  });
  await emit('seller.accepted', { sellerId: result.seller.id, handover: result.handover, now });
  return result;
}

// ─────────────────────────── r10 — first order ───────────────────────────

/** order.created domain event: record first_order_at and solve the onboarding ticket. */
export async function recordFirstOrder(contactId, { at = new Date(), cfg } = {}, db = prisma) {
  const c = await config(db, cfg);
  if (!c['oa.rule.r10.enabled']) return null;
  const t = await db.ticket.findFirst({ where: { contactId, type: 'onboarding_task', status: 'activated', firstOrderAt: null } });
  if (!t) return null;
  const updated = await changeTicket(db, t, { firstOrderAt: at, closedAt: t.closedAt ?? at }, { action: 'ticket.first_order', reason: 'r10 — first order placed' });
  const contact = await db.contact.findUnique({ where: { id: contactId } });
  await notify({ userId: contact?.ownerAgentId, kind: 'oa.r10.first_order', title: `${contact?.name} placed their first order`, ticketId: t.id, dedupeKey: `oa.r10:${t.id}` }, db);
  return updated;
}

// ─────────────────────────── macros ───────────────────────────

/**
 * Run a macro (OA 6.5): applies ticket changes and returns text for the composer. Never sends —
 * except "Send Hub", whose send is itself the declined-call action and goes through the template path.
 */
export async function runMacro(user, macroId, ticketId, input = {}, { now = new Date() } = {}, db = prisma) {
  const macro = await db.macro.findUnique({ where: { id: macroId } });
  if (!macro || macro.module !== 'oa' || (macro.scope === 'personal' && macro.ownerId !== user.id)) throw notFound('Macro not found.');
  const t = await findOnboardingTicket(user, ticketId, db);
  const can = onboardingCan(user, t, 'onboarding.macro');
  if (!can.allowed) throw forbidden(`Run a macro — ${can.reason.replace(/\.$/, '').toLowerCase()}.`);
  const a = json(macro.actions);
  let ticket;
  switch (a.op) {
    case 'log_call': ticket = await logCall(user, ticketId, a.outcome, input.note ?? macro.insertText, { now, permission: 'onboarding.macro' }, db); break;
    case 'book_walkthrough': ticket = await bookWalkthrough(user, ticketId, input, { now }, db); break;
    case 'send_hub': ticket = await sendHub(user, ticketId, input.variables, { now }, db); break;
    case 'mark_junk': {
      ticket = await transition(user, ticketId, 'junk_lead', input.note ?? macro.insertText, { now }, db);
      const conv = await conversationOf(t.contactId, db);
      if (conv) await addNote(user, conv.id, input.note || macro.insertText || 'Marked junk.', db);
      break;
    }
    default: throw badRequest(`Macro action "${a.op}" is not supported.`);
  }
  await db.macro.update({ where: { id: macro.id }, data: { usageCount: { increment: 1 } } });
  return { ticket, insertText: a.op === 'book_walkthrough' ? macro.insertText : '' };
}

// ─────────────────────────── bulk (OA 13.3) ───────────────────────────

const BULK_OPS = {
  reassign: (user, id, p) => reassign(user, id, p.toUserId, p.reason),
  transition: (user, id, p) => transition(user, id, p.to, p.reason),
  assign_over_capacity: (user, id, p) => assignOverCapacity(user, id, p.reason),
};

/**
 * One bulk run: each ticket goes through the same service call (and permission check) as a single
 * action, results are reported per ticket — nothing is skipped silently — and the run itself is
 * one audit entry carrying the full affected list.
 */
export async function bulk(user, { op, ticketIds, ...params }, db = prisma) {
  if (!BULK_OPS[op]) throw badRequest(`op must be one of ${Object.keys(BULK_OPS).join(', ')}.`);
  if (!Array.isArray(ticketIds) || !ticketIds.length) throw badRequest('ticketIds must be a non-empty list.');
  if (ticketIds.length > 200) throw badRequest('At most 200 tickets per bulk run.');
  if (!params.reason || !String(params.reason).trim()) throw badRequest('A written reason is required for a bulk action.');
  const results = [];
  for (const id of ticketIds) {
    try {
      await BULK_OPS[op](user, id, params);
      results.push({ ticketId: id, ok: true });
    } catch (err) {
      results.push({ ticketId: id, ok: false, status: err.status ?? 500, error: err.message });
    }
  }
  await logEvent({ actorId: user.id, entityType: 'bulk', entityId: `oa:${op}:${Date.now()}`, action: `bulk.oa_${op}`,
    after: { params: { ...params, reason: undefined }, results }, reason: params.reason }, db);
  return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}
