// Server-side scope. Every list and lookup goes through these builders, so a role's scope is
// applied once, in one place (AM D-05), instead of per view.
//
//  - Onboarding: read is team-wide for agents, write is own-only (OA 9.4 — two separate grants).
//  - Account management: an AM sees ONLY their own book. A foreign seller is not-found, never
//    forbidden (AM 9.4, AC-20) — a 403 would confirm the seller exists.
import { prisma } from '../db.js';
import { grant } from './permissions.js';
import { notFound } from '../http/errors.js';

const ROLE_LABEL = {
  OA_AGENT: 'Onboarding Agent', SHIFT_LEAD: 'Shift lead', MANAGER: 'Manager', ADMIN: 'Admin',
  ACCOUNT_MANAGER: 'Account Manager', READ_ONLY: 'Read-only',
};

/** The sentence a disabled control shows (Principle 6: disabled controls state their reason). */
export function denialReason(user, permission, g = grant(user.role, permission)) {
  const role = ROLE_LABEL[user.role] ?? user.role;
  switch (g) {
    case false: return `Not available to the ${role} role.`;
    case 'request': return 'The platform assigns leads — request a transfer instead.';
    case 'escalate': return `The ${role} role escalates this; an Admin decides.`;
    case 'approval': return 'Needs approval from an Admin.';
    case 'take_over': return 'Take the conversation over first, with a reason.';
    case 'own': case 'own_gated': case 'own_reason': return 'Lead not assigned to you.';
    case 'own_book': return 'Not in your book.';
    case 'own_contacts': return 'Not one of your contacts.';
    default: return null;
  }
}

// ─────────────────────────── onboarding tickets ───────────────────────────

/** Prisma `where` for the onboarding tickets this user may read. */
export function onboardingReadWhere(user) {
  const base = { type: 'onboarding_task' };
  const all = grant(user.role, 'onboarding.view_all');
  if (all === true || all === 'team') return base;
  if (all === 'own_contacts') return { ...base, OR: [{ assigneeId: user.id }, { contact: { ownerAgentId: user.id } }] };
  return { ...base, assigneeId: user.id };
}

/**
 * May this user perform `permission` on this (already readable) onboarding ticket?
 * Returns { allowed, reason, needsReason, gated } — reason is the sentence for a disabled control.
 * `gated` means a service-layer precondition (e.g. the activation gate, OA 8.1) still applies.
 */
export function onboardingCan(user, ticket, permission) {
  const g = grant(user.role, permission);
  const own = ticket.assigneeId === user.id;
  const result = (allowed, extra = {}) => ({ allowed, reason: allowed ? null : denialReason(user, permission, g), ...extra });
  switch (g) {
    case true: return result(true);
    case 'team': return result(true);
    case 'with_reason': return result(true, { needsReason: true });
    case 'own': return result(own);
    case 'own_gated': return result(own, { gated: true });
    case 'own_reason': return result(own, { needsReason: true });
    case 'own_contacts': return result(own || ticket.contact?.ownerAgentId === user.id);
    default: return result(false);
  }
}

export async function findOnboardingTicket(user, id, db = prisma) {
  const t = await db.ticket.findFirst({ where: { id, ...onboardingReadWhere(user) }, include: { contact: true } });
  if (!t) throw notFound('Ticket not found.');
  return t;
}

// ─────────────────────────── sellers / am_task ───────────────────────────

/** Prisma `where` for the sellers this user may see; null = no access to the AM module at all. */
export function sellerWhere(user) {
  const g = grant(user.role, 'seller.view');
  if (g === true) return {};
  if (g === 'own_book') return { assignedAccountManagerId: user.id };
  return null;
}

/** Prisma `where` for the am_tasks this user may see (always via the seller's book). */
export function amTaskWhere(user) {
  const s = sellerWhere(user);
  if (s === null) return null;
  return Object.keys(s).length ? { type: 'am_task', seller: s } : { type: 'am_task' };
}

/** A seller in the caller's scope, or not-found — foreign and nonexistent look identical (AC-20). */
export async function findSellerInScope(user, id, db = prisma, args = {}) {
  const scope = sellerWhere(user);
  const s = scope === null ? null : await db.seller.findFirst({ ...args, where: { id, ...scope } });
  if (!s) throw notFound('Not in your book.');
  return s;
}

/** May this user perform an AM `permission` on a seller already found in scope? */
export function sellerCan(user, seller, permission) {
  const g = grant(user.role, permission);
  if (g === true || g === 'with_reason') return { allowed: true, reason: null, needsReason: g === 'with_reason' };
  if (g === 'own_book') {
    const ok = seller.assignedAccountManagerId === user.id;
    return { allowed: ok, reason: ok ? null : denialReason(user, permission, g) };
  }
  return { allowed: false, reason: denialReason(user, permission, g) };
}
