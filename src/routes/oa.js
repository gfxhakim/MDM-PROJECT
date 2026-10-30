// Onboarding Agent API. Every action re-checks scope and the ticket's state in the service.
import { Router } from 'express';
import { ah, forbidden } from '../http/errors.js';
import { prisma } from '../db.js';
import { getLiveConfig } from '../config/service.js';
import { grant } from '../auth/permissions.js';
import { requirePermission } from '../auth/middleware.js';
import { getTicket } from '../core/tickets.js';
import { emit } from '../core/events.js';
import * as oa from '../oa/service.js';
import { activationGate } from '../oa/stateMachine.js';
import { availability, onboardingAgents } from '../oa/capacity.js';
import { runOnboardingSweep } from '../oa/rules.js';
import { onboardingBudget } from '../core/templates.js';
import { onboardingReadWhere } from '../auth/scope.js';
import { redact } from '../auth/permissions.js';
import { pickAccountManager } from '../am/handover.js';

export const oaRouter = Router();

// Every lead the caller may read, with its conversation and timeline — what the console renders.
oaRouter.get('/leads', ah(async (req, res) => {
  const tickets = await prisma.ticket.findMany({
    where: onboardingReadWhere(req.user), include: { contact: true }, orderBy: { createdAt: 'desc' }, take: 1000,
  });
  const contactIds = [...new Set(tickets.map((t) => t.contactId))];
  const convs = await prisma.conversation.findMany({ where: { contactId: { in: contactIds } } });
  const messages = await prisma.message.findMany({ where: { conversationId: { in: convs.map((c) => c.id) } }, orderBy: { createdAt: 'asc' } });
  const events = await prisma.eventLog.findMany({
    where: { OR: [{ entityType: 'ticket', entityId: { in: tickets.map((t) => t.id) } }, { entityType: 'contact', entityId: { in: contactIds } }] },
    orderBy: { createdAt: 'desc' },
  });
  const byConv = new Map(convs.map((c) => [c.contactId, { ...c, messages: [] }]));
  const convById = new Map([...byConv.values()].map((c) => [c.id, c]));
  for (const m of messages) convById.get(m.conversationId)?.messages.push(m);
  const evBy = new Map();
  for (const e of events) evBy.set(e.entityId, [...(evBy.get(e.entityId) ?? []), e]);
  res.json(redact(tickets.map((t) => ({
    ...t, qualification: JSON.parse(t.qualification), handoffRecord: JSON.parse(t.handoffRecord), tags: JSON.parse(t.tags),
    conversation: byConv.get(t.contactId) ?? null,
    events: [...(evBy.get(t.id) ?? []), ...(evBy.get(t.contactId) ?? [])],
  })), req.user.role));
}));

// Which account manager activation would hand this lead to (AM 3.2) — shown, never chosen.
oaRouter.get('/tickets/:id/am-preview', ah(async (req, res) => {
  const t = await getTicket(req.user, req.params.id);
  const { values: c } = await getLiveConfig();
  const pick = await pickAccountManager(t.contact.country, c);
  res.json(pick.manager ? { managerId: pick.manager.id, name: pick.manager.name, bookSize: pick.bookSize } : { managerId: null, reason: pick.reason });
}));

// A lead with everything the workspace's left pane needs, including the activation gate.
oaRouter.get('/tickets/:id', ah(async (req, res) => {
  const t = await getTicket(req.user, req.params.id);
  if (t.type !== 'onboarding_task') return res.status(404).json({ error: { code: 'not_found', message: 'Ticket not found.' } });
  const { values: c } = await getLiveConfig();
  const conv = await prisma.conversation.findUnique({ where: { contactId: t.contactId } });
  const gate = activationGate(t);
  const stalledAt = new Date(new Date(t.createdAt).getTime() + c['oa.stalled_day'] * 86_400_000);
  res.json({
    ...t,
    conversationId: conv?.id ?? null,
    activation: gate,
    cadence: {
      noAnswer: { attemptNo: t.attemptNo, max: c['oa.no_answer_max'], nextAttemptAt: t.nextAttemptAt },
      wentQuiet: { followupNo: t.followupNo, max: c['oa.quiet_max'], nextFollowupAt: t.nextFollowupAt },
      cadenceReset: t.cadenceReset,
    },
    stalled: !['activated', 'cold_lead', 'junk_lead'].includes(t.status) && new Date() >= stalledAt,
    templateBudget: conv ? await onboardingBudget(conv.id, { config: c }) : null,
  });
}));

oaRouter.patch('/tickets/:id', ah(async (req, res) => res.json(await oa.updateTicket(req.user, req.params.id, req.body ?? {}))));
oaRouter.post('/tickets/:id/transition', ah(async (req, res) => res.json(await oa.transition(req.user, req.params.id, req.body?.to, req.body?.reason))));
oaRouter.post('/tickets/:id/log-call', ah(async (req, res) => res.json(await oa.logCall(req.user, req.params.id, req.body?.outcome, req.body?.note))));
oaRouter.post('/tickets/:id/book-walkthrough', ah(async (req, res) => res.json(await oa.bookWalkthrough(req.user, req.params.id, req.body ?? {}))));
oaRouter.post('/tickets/:id/send-hub', ah(async (req, res) => res.json(await oa.sendHub(req.user, req.params.id, req.body?.variables))));
oaRouter.post('/tickets/:id/activate', ah(async (req, res) => res.json(await oa.activate(req.user, req.params.id))));
oaRouter.post('/tickets/:id/request-transfer', ah(async (req, res) => res.json(await oa.requestTransfer(req.user, req.params.id, req.body?.reason))));
oaRouter.post('/tickets/:id/reassign', ah(async (req, res) => res.json(await oa.reassign(req.user, req.params.id, req.body?.toUserId, req.body?.reason))));
oaRouter.post('/tickets/:id/assign-over-capacity', ah(async (req, res) => res.json(await oa.assignOverCapacity(req.user, req.params.id, req.body?.reason))));
oaRouter.post('/tickets/:id/macros/:macroId', ah(async (req, res) => res.json(await oa.runMacro(req.user, req.params.macroId, req.params.id, req.body ?? {}))));

oaRouter.get('/macros', ah(async (req, res) => {
  res.json(await prisma.macro.findMany({
    where: { module: 'oa', OR: [{ scope: 'team' }, { scope: 'personal', ownerId: req.user.id }] },
    orderBy: { name: 'asc' },
  }));
}));

// Capacity: an agent sees only their own budget (no peers, no targets — OA 4.6); supervisors see the team.
oaRouter.get('/capacity', ah(async (req, res) => {
  const { values: c } = await getLiveConfig();
  const team = grant(req.user.role, 'reports.view') === 'own'
    ? await prisma.user.findMany({ where: { id: req.user.id } })
    : await onboardingAgents();
  if (!team.length) return res.json([]);
  res.json(await Promise.all(team.map(async (a) => ({ agentId: a.id, name: a.name, ...(await availability(a, c)) }))));
}));

// Presence until the PBX is wired: an agent marks themselves on / off a call.
oaRouter.post('/presence', ah(async (req, res) => {
  if (req.user.role !== 'OA_AGENT') throw forbidden('Presence is for onboarding agents.');
  await prisma.user.update({ where: { id: req.user.id }, data: { onCall: !!req.body?.onCall } });
  if (!req.body?.onCall) await runOnboardingSweep(); // agent.capacity_changed → r8
  res.json({ onCall: !!req.body?.onCall });
}));

oaRouter.post('/sweep', requirePermission('automation.manage'), ah(async (_req, res) => res.json(await runOnboardingSweep())));

// Platform events until the MDM connector exists (step 9): registration and first order.
oaRouter.post('/registrations', ah(async (req, res) => {
  if (req.user.role !== 'ADMIN') throw forbidden('Registrations arrive from the MDM platform; an Admin can simulate one.');
  const r = await oa.registerMerchant(req.body ?? {});
  res.status(201).json({ contactId: r.contact.id, ticketId: r.ticket?.id ?? null, outcome: r.outcome });
}));
oaRouter.post('/orders', ah(async (req, res) => {
  if (req.user.role !== 'ADMIN') throw forbidden('Orders arrive from the MDM platform; an Admin can simulate one.');
  const at = req.body?.at ? new Date(req.body.at) : new Date();
  res.status(201).json(await emit('order.created', { contactId: req.body?.contactId, at }));
}));

