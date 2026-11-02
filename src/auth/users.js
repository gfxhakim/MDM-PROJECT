// Accounts (Admin): the list of everyone who can sign in, a password set by the Admin, and
// switching an account off or on. Switching off an onboarding agent sends their open leads to the
// holding queue (rule r8 assigns them again by capacity); switching off an account manager hands
// each seller to the same-market, smallest-book manager (AM 3.2) or leaves them unassigned with
// the Admin alerted. Every change is one audit entry per account; a password is never logged.
import { prisma } from '../db.js';
import { badRequest, notFound } from '../http/errors.js';
import { logEvent } from '../services/audit.js';
import { hashPassword } from './service.js';
import { getLiveConfig } from '../config/service.js';
import { pickAccountManager } from '../am/handover.js';
import { addSystemLine } from '../core/conversations.js';
import { notifyRole } from '../core/notifications.js';
import { TICKET_TYPES } from '../core/ticketTypes.js';

const OPEN = TICKET_TYPES.onboarding_task.openStatuses;
const parse = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };

export async function listUsers(db = prisma) {
  const [users, leads, books, staff] = await Promise.all([
    db.user.findMany({ orderBy: [{ active: 'desc' }, { role: 'asc' }, { name: 'asc' }] }),
    db.ticket.groupBy({ by: ['assigneeId'], where: { type: 'onboarding_task', status: { in: OPEN }, assigneeId: { not: null } }, _count: { _all: true } }),
    db.seller.groupBy({ by: ['assignedAccountManagerId'], where: { assignedAccountManagerId: { not: null } }, _count: { _all: true } }),
    db.mdmStaff.findMany({ where: { userId: { not: null } }, select: { userId: true, role: true, scope: true, restricted: true, lastSeenAt: true } }),
  ]);
  const openLeads = new Map(leads.map((r) => [r.assigneeId, r._count._all]));
  const bookSize = new Map(books.map((r) => [r.assignedAccountManagerId, r._count._all]));
  const onMdm = new Map(staff.map((r) => [r.userId, r]));
  return users.map((u) => ({
    id: u.id, email: u.email, name: u.name, role: u.role, markets: parse(u.markets, []), active: u.active, onCall: u.onCall, extension: u.extension,
    businessNumber: u.businessNumber, shiftMinutes: u.shiftMinutes, createdAt: u.createdAt, hasPassword: !!u.passwordHash,
    source: u.mdmRef ? 'mdm' : 'local', mdmRef: u.mdmRef, mdmRole: u.mdmRole, mdmScope: u.mdmScope, mdmUsernames: parse(u.mdmUsernames, []), mdmSyncedAt: u.mdmSyncedAt,
    restrictedOnMdm: onMdm.get(u.id)?.restricted ?? null, openLeads: openLeads.get(u.id) ?? 0, bookSize: bookSize.get(u.id) ?? 0,
  }));
}

/** A password typed by an Admin for one account. Never logged; the audit entry says only that it was set. */
export async function setPassword(actor, userId, password, db = prisma) {
  if (typeof password !== 'string' || password.length < 8) throw badRequest('A password needs at least 8 characters.');
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('No such account.');
  await db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password) } });
  await logEvent({ actorId: actor.id, entityType: 'user', entityId: userId, action: 'user.password_set', after: { hadPassword: !!user.passwordHash }, reason: 'Set by an Administrator' }, db);
  return { ok: true, userId, mdmSignIn: !!user.mdmRef };
}

/** Switch an account off (with what happens to its leads and sellers) or on again. */
export async function setActive(actor, userId, active, reason, db = prisma) {
  if (typeof reason !== 'string' || !reason.trim()) throw badRequest('A written reason is required.');
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('No such account.');
  if (user.id === actor.id && !active) throw badRequest('You cannot switch off your own account.');
  if (user.active === !!active) throw badRequest(active ? 'The account is already active.' : 'The account is already off.');
  const now = new Date();
  const moved = { leadsHeld: 0, sellersMoved: 0, sellersUnassigned: 0 };
  if (!active) {
    const { values: config } = await getLiveConfig(db);
    for (const t of await db.ticket.findMany({ where: { type: 'onboarding_task', status: { in: OPEN }, assigneeId: userId }, include: { contact: true } })) {
      await db.ticket.update({ where: { id: t.id }, data: { assigneeId: null, holdReason: 'agent deactivated', heldAt: now } });
      await logEvent({ actorId: actor.id, entityType: 'ticket', entityId: t.id, action: 'ticket.held', before: { assigneeId: userId }, after: { assigneeId: null, holdReason: 'agent deactivated' }, reason: reason.trim() }, db);
      moved.leadsHeld++;
    }
    for (const s of await db.seller.findMany({ where: { assignedAccountManagerId: userId }, include: { contact: true } })) {
      const pick = await pickAccountManager(s.market, config, db);
      const conv = await db.conversation.findFirst({ where: { contactId: s.contactId } });
      if (pick.manager) {
        await db.seller.update({ where: { id: s.id }, data: { assignedAccountManagerId: pick.manager.id } });
        await db.contact.update({ where: { id: s.contactId }, data: { ownerAgentId: pick.manager.id } });
        await db.ticket.updateMany({ where: { sellerId: s.id, type: 'am_task', status: 'open' }, data: { assigneeId: pick.manager.id } });
        if (conv) await addSystemLine(conv.id, `Account manager changed to ${pick.manager.name}: ${user.name}'s account was switched off.`, db);
        await logEvent({ actorId: actor.id, entityType: 'seller', entityId: s.id, action: 'seller.reassigned', before: { assignedAccountManagerId: userId }, after: { assignedAccountManagerId: pick.manager.id }, reason: `${user.name} switched off: ${reason.trim()}` }, db);
        moved.sellersMoved++;
      } else {
        await db.seller.update({ where: { id: s.id }, data: { assignedAccountManagerId: null } });
        await db.contact.update({ where: { id: s.contactId }, data: { ownerAgentId: null } });
        await logEvent({ actorId: actor.id, entityType: 'seller', entityId: s.id, action: 'seller.unassigned_alert', before: { assignedAccountManagerId: userId }, reason: pick.reason }, db);
        await notifyRole('ADMIN', { kind: 'am.r1.no_manager', title: `No account manager for ${s.contact.name}`, body: pick.reason, dedupeKey: `am.r1.no_manager:${s.id}` }, db);
        moved.sellersUnassigned++;
      }
    }
  }
  await db.user.update({ where: { id: userId }, data: { active: !!active } });
  await logEvent({ actorId: actor.id, entityType: 'user', entityId: userId, action: active ? 'user.activated' : 'user.deactivated', before: { active: user.active }, after: { active: !!active, ...moved }, reason: reason.trim() }, db);
  return { ok: true, userId, active: !!active, ...moved };
}
