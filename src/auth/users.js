// Accounts (Admin): the list of everyone who can sign in, a password set by the Admin, switching an
// account off or on, and removing an account (the demo accounts, or someone who left). Switching off
// or removing an onboarding agent sends their open leads to the holding queue (rule r8 assigns them
// again by capacity); an account manager's sellers go to the manager MDM names for them when that
// person is here, otherwise to the same-market, smallest-book manager (AM 3.2), or stay unassigned
// with the Admin alerted. A removed account is kept (hidden) so the audit history still names it.
// Every change is one audit entry per account; a password is never logged.
import { prisma } from '../db.js';
import { badRequest, notFound } from '../http/errors.js';
import { logEvent } from '../services/audit.js';
import { hashPassword } from './service.js';
import { getLiveConfig } from '../config/service.js';
import { pickAccountManager } from '../am/handover.js';
import { addSystemLine } from '../core/conversations.js';
import { notifyRole } from '../core/notifications.js';
import { TICKET_TYPES } from '../core/ticketTypes.js';
import { ROLES } from './permissions.js';
import { AM_ADMINS } from '../auth/scope.js';

const OPEN = TICKET_TYPES.onboarding_task.openStatuses;
const parse = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };
const written = (reason) => { if (typeof reason !== 'string' || !reason.trim()) throw badRequest('A written reason is required.'); return reason.trim(); };

/** The example team the seed created before the real people came from MDM (the two prototypes' names). */
export const DEMO_TEAM = ['salma@mdm.local', 'karim@mdm.local', 'noor@mdm.local', 'yassine@mdm.local', 'rania@mdm.local', 'omar@mdm.local'];

export async function listUsers({ includeRemoved = false } = {}, db = prisma) {
  const [users, leads, books, staff] = await Promise.all([
    db.user.findMany({ where: includeRemoved ? {} : { removedAt: null }, orderBy: [{ active: 'desc' }, { role: 'asc' }, { name: 'asc' }] }),
    db.ticket.groupBy({ by: ['assigneeId'], where: { type: 'onboarding_task', status: { in: OPEN }, assigneeId: { not: null } }, _count: { _all: true } }),
    db.seller.groupBy({ by: ['assignedAccountManagerId'], where: { assignedAccountManagerId: { not: null } }, _count: { _all: true } }),
    db.mdmStaff.findMany({ where: { userId: { not: null } }, select: { userId: true, role: true, scope: true, restricted: true, lastSeenAt: true } }),
  ]);
  const openLeads = new Map(leads.map((r) => [r.assigneeId, r._count._all]));
  const bookSize = new Map(books.map((r) => [r.assignedAccountManagerId, r._count._all]));
  const onMdm = new Map(staff.map((r) => [r.userId, r]));
  return users.map((u) => ({
    id: u.id, email: u.email, name: u.name, role: u.role, markets: parse(u.markets, []), active: u.active, onCall: u.onCall, extension: u.extension,
    businessNumber: u.businessNumber, shiftMinutes: u.shiftMinutes, createdAt: u.createdAt, hasPassword: !!u.passwordHash, removedAt: u.removedAt,
    demo: DEMO_TEAM.includes(u.email) || /@mdm\.local$/.test(u.email),
    source: u.mdmRef ? 'mdm' : 'local', mdmRef: u.mdmRef, mdmRole: u.mdmRole, mdmScope: u.mdmScope, mdmUsernames: parse(u.mdmUsernames, []), mdmSyncedAt: u.mdmSyncedAt,
    restrictedOnMdm: onMdm.get(u.id)?.restricted ?? null, openLeads: openLeads.get(u.id) ?? 0, bookSize: bookSize.get(u.id) ?? 0,
  }));
}

/** A password typed by an Admin for one account. Never logged; the audit entry says only that it was set. */
export async function setPassword(actor, userId, password, db = prisma) {
  if (typeof password !== 'string' || password.length < 8) throw badRequest('A password needs at least 8 characters.');
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.removedAt) throw notFound('No such account.');
  await db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password) } });
  await logEvent({ actorId: actor.id, entityType: 'user', entityId: userId, action: 'user.password_set', after: { hadPassword: !!user.passwordHash }, reason: 'Set by an Administrator' }, db);
  return { ok: true, userId, mdmSignIn: !!user.mdmRef };
}

/**
 * Hand an account's work on: open leads to the holding queue, sellers to the manager MDM names for
 * them (when that person is here and active), else AM 3.2, else unassigned with one alert to the
 * Admins for the whole run. The account must already be inactive, so it is never picked itself.
 */
async function releaseWork(actorId, user, why, db, { leads = true, sellers = true } = {}) {
  const now = new Date();
  const moved = { leadsHeld: 0, sellersMoved: 0, sellersUnassigned: 0 };
  const { values: config } = await getLiveConfig(db);
  for (const t of leads ? await db.ticket.findMany({ where: { type: 'onboarding_task', status: { in: OPEN }, assigneeId: user.id } }) : []) {
    await db.ticket.update({ where: { id: t.id }, data: { assigneeId: null, holdReason: 'agent deactivated', heldAt: now } });
    await logEvent({ actorId, entityType: 'ticket', entityId: t.id, action: 'ticket.held', before: { assigneeId: user.id }, after: { assigneeId: null, holdReason: 'agent deactivated' }, reason: why }, db);
    moved.leadsHeld++;
  }
  const unassigned = [];
  for (const s of sellers ? await db.seller.findMany({ where: { assignedAccountManagerId: user.id }, include: { contact: true } }) : []) {
    const named = s.mdmManagerRef
      ? await db.user.findFirst({ where: { mdmManagerRef: s.mdmManagerRef, role: 'ACCOUNT_MANAGER', active: true, removedAt: null, NOT: { id: user.id } } })
      : null;
    const pick = named ? { manager: named, fromPlatform: true } : await pickAccountManager(s.market, config, db);
    const conv = await db.conversation.findFirst({ where: { contactId: s.contactId } });
    if (pick.manager) {
      await db.seller.update({ where: { id: s.id }, data: { assignedAccountManagerId: pick.manager.id } });
      await db.contact.update({ where: { id: s.contactId }, data: { ownerAgentId: pick.manager.id } });
      await db.ticket.updateMany({ where: { sellerId: s.id, type: 'am_task', status: 'open' }, data: { assigneeId: pick.manager.id } });
      if (conv) await addSystemLine(conv.id, `Account manager changed to ${pick.manager.name}: ${user.name}'s account ${why.startsWith('Removed') ? 'was removed' : why.startsWith('Role changed') ? 'changed role' : 'was switched off'}.`, db);
      await logEvent({ actorId, entityType: 'seller', entityId: s.id, action: 'seller.reassigned', before: { assignedAccountManagerId: user.id },
        after: { assignedAccountManagerId: pick.manager.id, ...(pick.fromPlatform ? { fromPlatform: true } : {}) }, reason: `${user.name}: ${why}` }, db);
      moved.sellersMoved++;
    } else {
      await db.seller.update({ where: { id: s.id }, data: { assignedAccountManagerId: null } });
      await db.contact.update({ where: { id: s.contactId }, data: { ownerAgentId: null } });
      await logEvent({ actorId, entityType: 'seller', entityId: s.id, action: 'seller.unassigned_alert', before: { assignedAccountManagerId: user.id }, reason: pick.reason }, db);
      unassigned.push(pick.reason);
      moved.sellersUnassigned++;
    }
  }
  if (unassigned.length) {
    await notifyRole(AM_ADMINS, { kind: 'am.r1.no_manager', title: `${unassigned.length} seller${unassigned.length === 1 ? '' : 's'} without an account manager`,
      body: `${user.name}: ${why}. ${[...new Set(unassigned)].join(' ')}`, dedupeKey: `user.released:${user.id}:${now.toISOString()}` }, db);
  }
  return moved;
}

/** Switch an account off (with what happens to its leads and sellers) or on again. */
export async function setActive(actor, userId, active, reason, db = prisma) {
  const why = written(reason);
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('No such account.');
  if (user.removedAt) throw badRequest('This account was removed. Put it back first.');
  if (user.id === actor.id && !active) throw badRequest('You cannot switch off your own account.');
  if (user.active === !!active) throw badRequest(active ? 'The account is already active.' : 'The account is already off.');
  await db.user.update({ where: { id: userId }, data: { active: !!active } });
  const moved = active ? { leadsHeld: 0, sellersMoved: 0, sellersUnassigned: 0 } : await releaseWork(actor.id, user, why, db);
  await logEvent({ actorId: actor.id, entityType: 'user', entityId: userId, action: active ? 'user.activated' : 'user.deactivated', before: { active: user.active }, after: { active: !!active, ...moved }, reason: why }, db);
  return { ok: true, userId, active: !!active, ...moved };
}

/** The roles an account can hold here, as the Accounts page names them. */
export const ROLE_NAMES = {
  OA_AGENT: 'Onboarding agent', SHIFT_LEAD: 'Shift lead', MANAGER: 'Manager', ADMIN: 'Administrator',
  ACCOUNT_MANAGER: 'Account manager', HEAD_OF_AM: 'Head of AM', READ_ONLY: 'Read-only',
};
// Only these two roles are matched to work by market (OA 4.2 capacity, AM 3.2 handover).
const NEEDS_MARKET = ['OA_AGENT', 'ACCOUNT_MANAGER'];
const MARKET_CODES = ['LY', 'IQ', 'LB'];

/**
 * Give an account another role (OA Appendix A "Manage roles & permissions": Admin). Permissions
 * belong to roles, never to people (OA Part 9), so this is the only way to change what someone may
 * do. Work the old role held is handed on exactly as when the account is switched off: open leads to
 * the holding queue, sellers to the manager MDM names or the same-market, smallest-book manager.
 * The change takes effect on the person's next click (the role is re-read on every request).
 * `markets` (optional) replaces the account's markets in the same step.
 */
export async function changeRole(actor, userId, role, reason, markets, db = prisma) {
  const why = written(reason);
  if (!ROLES.includes(role) || !ROLE_NAMES[role]) throw badRequest(`Choose a role: ${Object.values(ROLE_NAMES).join(', ')}.`);
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('No such account.');
  if (user.removedAt) throw badRequest('This account was removed. Put it back first.');
  if (user.id === actor.id) throw badRequest('You cannot change your own role.');
  if (user.role === role) throw badRequest(`This account is already ${ROLE_NAMES[role]}.`);
  if (user.role === 'ADMIN' && user.active && !(await db.user.count({ where: { role: 'ADMIN', active: true, removedAt: null, NOT: { id: user.id } } }))) {
    throw badRequest('This is the last active Administrator — changing its role would lock everyone out.');
  }
  if (markets != null && (!Array.isArray(markets) || markets.some((m) => !MARKET_CODES.includes(m)))) throw badRequest('Markets are LY, IQ or LB.');
  const before = parse(user.markets, []);
  const after = markets != null ? [...new Set(markets)] : before;
  if (NEEDS_MARKET.includes(role) && !after.length) throw badRequest(`A ${ROLE_NAMES[role]} is matched to work by market — tick at least one market.`);
  await db.user.update({ where: { id: userId }, data: { role, ...(markets != null ? { markets: JSON.stringify(after) } : {}) } });
  // Leads stay with someone who is still an onboarding agent, sellers with someone still an account manager.
  const moved = await releaseWork(actor.id, user, `Role changed to ${ROLE_NAMES[role]}: ${why}`, db, { leads: role !== 'OA_AGENT', sellers: role !== 'ACCOUNT_MANAGER' });
  await logEvent({ actorId: actor.id, entityType: 'user', entityId: userId, action: 'user.role_changed',
    before: { role: user.role, markets: before }, after: { role, markets: after, ...moved }, reason: why }, db);
  return { ok: true, userId, role, markets: after, ...moved };
}

/**
 * Remove an account: it can no longer sign in, disappears from every list and pick, and its work is
 * handed on as when it is switched off. The row stays (hidden) so the audit history keeps its name;
 * an Admin can put it back. actor = null is the deploy step that retires the demo team.
 */
export async function removeUser(actor, userId, reason, db = prisma) {
  const why = written(reason);
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('No such account.');
  if (user.removedAt) throw badRequest('This account is already removed.');
  if (actor && user.id === actor.id) throw badRequest('You cannot remove your own account.');
  if (user.role === 'ADMIN' && user.active && !(await db.user.count({ where: { role: 'ADMIN', active: true, removedAt: null, NOT: { id: user.id } } }))) {
    throw badRequest('This is the last active Administrator — removing it would lock everyone out.');
  }
  await db.user.update({ where: { id: userId }, data: { active: false, removedAt: new Date() } });
  const moved = await releaseWork(actor?.id ?? null, user, `Removed: ${why}`, db);
  await logEvent({ actorId: actor?.id ?? null, entityType: 'user', entityId: userId, action: 'user.removed', before: { active: user.active }, after: { active: false, removed: true, ...moved }, reason: why }, db);
  return { ok: true, userId, removed: true, ...moved };
}

/** Put a removed account back. It comes back active unless MDM restricts the person. */
export async function restoreUser(actor, userId, reason, db = prisma) {
  const why = written(reason);
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('No such account.');
  if (!user.removedAt) throw badRequest('This account is not removed.');
  const staff = user.mdmRef ? await db.mdmStaff.findUnique({ where: { mdmRef: user.mdmRef } }) : null;
  const active = !staff?.restricted;
  await db.user.update({ where: { id: userId }, data: { removedAt: null, active } });
  await logEvent({ actorId: actor.id, entityType: 'user', entityId: userId, action: 'user.restored', before: { removed: true }, after: { removed: false, active }, reason: why }, db);
  return { ok: true, userId, active };
}

/**
 * Deploy step (production): the example agents and account managers the seed created at first are
 * removed — the real team is imported from MDM (People on MDM). Runs once per account: a removed
 * account is left alone, and an Admin can put one back.
 */
export async function retireDemoTeam(db = prisma) {
  const out = [];
  for (const email of DEMO_TEAM) {
    const u = await db.user.findUnique({ where: { email } });
    if (!u || u.removedAt) continue;
    out.push({ email, ...(await removeUser(null, u.id, 'Demo account — the real agents and account managers are imported from MDM (People on MDM).', db)) });
  }
  return out;
}
