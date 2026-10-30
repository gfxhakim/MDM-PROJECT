// Platform core API: contacts, the conversation, messages, tickets, templates.
import { Router } from 'express';
import { ah, forbidden } from '../http/errors.js';
import { prisma } from '../db.js';
import { heartbeat } from '../core/presence.js';
import { findContact, listContacts, receiveInbound, setBlocked, setOptedOut } from '../core/contacts.js';
import * as conv from '../core/conversations.js';
import { getTicket, listTickets } from '../core/tickets.js';
import { onboardingBudget, renderTemplate } from '../core/templates.js';
import { amTaskWhere, onboardingReadWhere } from '../auth/scope.js';
import { listNotifications, markRead } from '../core/notifications.js';
import { grant } from '../auth/permissions.js';
import { logEvent } from '../services/audit.js';

export const coreRouter = Router();

// ───────── contacts ─────────
coreRouter.get('/contacts', ah(async (req, res) => {
  res.json(await listContacts(req.user, { q: req.query.q, take: Number(req.query.take) || 50 }));
}));

coreRouter.get('/contacts/:id', ah(async (req, res) => {
  const contact = await findContact(req.user, req.params.id);
  const [conversation, onboarding, amTasks] = await Promise.all([
    prisma.conversation.findUnique({ where: { contactId: contact.id }, select: { id: true } }),
    prisma.ticket.findMany({ where: { AND: [{ contactId: contact.id }, onboardingReadWhere(req.user)] }, select: { id: true, type: true, status: true, stage: true, assigneeId: true } }),
    amTaskWhere(req.user)
      ? prisma.ticket.findMany({ where: { AND: [{ contactId: contact.id }, amTaskWhere(req.user)] }, select: { id: true, type: true, status: true, taskType: true, assigneeId: true } })
      : [],
  ]);
  res.json({ ...contact, conversationId: conversation?.id ?? null, tickets: [...onboarding, ...amTasks] });
}));

coreRouter.post('/contacts/:id/block', ah(async (req, res) => {
  res.json(await setBlocked(req.user, req.params.id, true, req.body?.reason));
}));
coreRouter.post('/contacts/:id/unblock', ah(async (req, res) => {
  res.json(await setBlocked(req.user, req.params.id, false, req.body?.reason));
}));
coreRouter.post('/contacts/:id/opt-out', ah(async (req, res) => {
  res.json(await setOptedOut(req.user, req.params.id, req.body?.optedOut !== false, req.body?.reason));
}));

// ───────── conversation ─────────
coreRouter.get('/contacts/:id/conversation', ah(async (req, res) => {
  res.json(await conv.getConversationForContact(req.user, req.params.id));
}));
coreRouter.get('/conversations/:id', ah(async (req, res) => {
  res.json(await conv.getConversation(req.user, req.params.id));
}));

// Collision detection: heartbeat while the conversation is open; returns the others on it.
coreRouter.post('/conversations/:id/presence', ah(async (req, res) => {
  const c = await conv.findConversation(req.user, req.params.id); // read scope: foreign → not-found
  res.json({ others: heartbeat(c.id, req.user, req.body?.state) });
}));

// One send path for every console: kind = text | template | note.
coreRouter.post('/conversations/:id/messages', ah(async (req, res) => {
  const { kind = 'text', body, templateKey, variables } = req.body ?? {};
  let msg;
  if (kind === 'note') msg = await conv.addNote(req.user, req.params.id, body);
  else if (kind === 'template') msg = await conv.sendTemplate(req.user, req.params.id, templateKey, variables);
  else if (kind === 'text') msg = await conv.sendText(req.user, req.params.id, body);
  else return res.status(400).json({ error: { code: 'bad_request', message: `Unknown message kind "${kind}".` } });
  res.status(201).json(msg);
}));

coreRouter.post('/conversations/:id/take-over', ah(async (req, res) => {
  res.json(await conv.takeOver(req.user, req.params.id, req.body?.reason));
}));
coreRouter.post('/conversations/:id/release', ah(async (req, res) => {
  res.json(await conv.release(req.user, req.params.id));
}));

coreRouter.get('/conversations/:id/template-budget', ah(async (req, res) => {
  const c = await conv.findConversation(req.user, req.params.id);
  res.json(await onboardingBudget(c.id));
}));

// ───────── templates ─────────
coreRouter.get('/templates', ah(async (req, res) => {
  const where = req.query.module ? { module: req.query.module } : {};
  res.json(await prisma.template.findMany({ where, orderBy: { key: 'asc' } }));
}));

// Sends per template over a window — the spend view (OA 13.2). Counts only, no message content.
coreRouter.get('/templates/usage', ah(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
  const rows = await prisma.message.groupBy({
    by: ['templateKey'], where: { kind: 'template', direction: 'out', createdAt: { gte: new Date(Date.now() - days * 86_400_000) } }, _count: true,
  });
  res.json({ days, sends: Object.fromEntries(rows.filter((r) => r.templateKey).map((r) => [r.templateKey, r._count])) });
}));

// Enable / disable an approved template (agents cannot — OA 13.2). Content is changed only through
// Meta approval, so there is no edit route. Audited with the reason.
coreRouter.post('/templates/:key/:state(enable|disable)', ah(async (req, res) => {
  if (!grant(req.user.role, 'template.author')) throw forbidden('Templates are enabled or disabled by a Manager or an Admin.');
  const t = await prisma.template.findUnique({ where: { key: req.params.key } });
  if (!t) return res.status(404).json({ error: { code: 'not_found', message: 'Template not found.' } });
  const enabled = req.params.state === 'enable';
  if (enabled && t.status !== 'approved') throw forbidden('Only a Meta-approved template can be enabled.');
  const updated = await prisma.template.update({ where: { key: t.key }, data: { enabled } });
  await logEvent({ actorId: req.user.id, entityType: 'template', entityId: t.key, action: enabled ? 'template.enabled' : 'template.disabled',
    before: { enabled: t.enabled }, after: { enabled }, reason: req.body?.reason ?? null });
  res.json(updated);
}));

// Resolved preview — shown before a billable send (OA 6.6).
coreRouter.post('/templates/:key/preview', ah(async (req, res) => {
  const t = await prisma.template.findUnique({ where: { key: req.params.key } });
  if (!t) return res.status(404).json({ error: { code: 'not_found', message: 'Template not found.' } });
  res.json({ key: t.key, billable: true, body: renderTemplate(t.bodyEn, req.body?.variables ?? []) });
}));

// ───────── tickets ─────────
coreRouter.get('/tickets', ah(async (req, res) => {
  res.json(await listTickets(req.user, { type: req.query.type ?? 'onboarding_task', ...req.query }));
}));
coreRouter.get('/tickets/:id', ah(async (req, res) => {
  res.json(await getTicket(req.user, req.params.id));
}));

// ───────── people ─────────
// Names and markets only — what a console needs to label owners and pick a reassignment target.
coreRouter.get('/users', ah(async (req, res) => {
  const where = { active: true, ...(req.query.role ? { role: String(req.query.role) } : {}) };
  res.json(await prisma.user.findMany({ where, select: { id: true, name: true, role: true, markets: true, onCall: true, businessNumber: true }, orderBy: { name: 'asc' } }));
}));

// ───────── notifications ─────────
coreRouter.get('/notifications', ah(async (req, res) => {
  res.json(await listNotifications(req.user.id, { unreadOnly: req.query.unread === 'true' }));
}));
coreRouter.post('/notifications/read', ah(async (req, res) => {
  res.json(await markRead(req.user.id, Array.isArray(req.body?.ids) ? req.body.ids : []));
}));

// ───────── inbound (dev) ─────────
// Until the WhatsApp Business API webhook lands (step 9), an Admin can inject an inbound message.
coreRouter.post('/dev/inbound', ah(async (req, res) => {
  if (req.user.role !== 'ADMIN') throw forbidden('Only an Admin can simulate inbound messages.');
  const r = await receiveInbound(req.body ?? {});
  res.status(201).json({ contactId: r.contact.id, conversationId: r.conversation.id, messageId: r.message.id, createdContact: r.created });
}));
