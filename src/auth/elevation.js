// Temporary elevation (OA 9.3): a covering role for leave, time-bound, audited at grant,
// early revoke and automatic expiry. There is no permanent widening and no personal exception:
// the user simply acts as another existing role until endsAt.
import { prisma } from '../db.js';
import { logEvent } from '../services/audit.js';
import { ROLES } from './permissions.js';
import { badRequest, notFound } from '../http/errors.js';

const MAX_DAYS = 31;

export async function grantElevation({ actor, userId, role, endsAt, reason }, db = prisma) {
  if (!ROLES.includes(role)) throw badRequest(`Unknown role "${role}".`);
  if (!reason || !String(reason).trim()) throw badRequest('A written reason is required.');
  const end = new Date(endsAt);
  const now = new Date();
  if (Number.isNaN(end.getTime()) || end <= now) throw badRequest('endsAt must be a future date.');
  if (end - now > MAX_DAYS * 86_400_000) throw badRequest(`Elevation is time-bound: at most ${MAX_DAYS} days.`);

  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound('User not found.');
    if (user.role === role) throw badRequest('The user already holds that role.');
    const e = await tx.roleElevation.create({
      data: { userId, role, reason: String(reason).trim(), grantedById: actor.id, endsAt: end },
    });
    await logEvent({
      actorId: actor.id, entityType: 'user', entityId: userId, action: 'user.elevation_granted',
      before: { role: user.role }, after: { role, endsAt: end, elevationId: e.id }, reason: e.reason,
    }, tx);
    return e;
  });
}

export async function revokeElevation({ actor, elevationId, reason }, db = prisma) {
  return db.$transaction(async (tx) => {
    const e = await tx.roleElevation.findUnique({ where: { id: elevationId } });
    if (!e || e.revokedAt) throw notFound('No active elevation with that id.');
    const updated = await tx.roleElevation.update({ where: { id: e.id }, data: { revokedAt: new Date() } });
    await logEvent({
      actorId: actor.id, entityType: 'user', entityId: e.userId, action: 'user.elevation_revoked',
      before: { role: e.role }, after: { elevationId: e.id }, reason: reason ?? null,
    }, tx);
    return updated;
  });
}

/** Sweep: close elevations whose window has passed and audit each reversion. Idempotent. */
export async function expireElevations(now = new Date(), db = prisma) {
  const due = await db.roleElevation.findMany({ where: { revokedAt: null, endsAt: { lte: now } } });
  for (const e of due) {
    await db.$transaction(async (tx) => {
      const { count } = await tx.roleElevation.updateMany({ where: { id: e.id, revokedAt: null }, data: { revokedAt: e.endsAt } });
      if (!count) return;
      const user = await tx.user.findUnique({ where: { id: e.userId } });
      await logEvent({
        entityType: 'user', entityId: e.userId, action: 'user.elevation_expired',
        before: { role: e.role }, after: { role: user?.role ?? null, elevationId: e.id }, reason: 'Elevation window ended',
      }, tx);
    });
  }
  return due.length;
}

export function listElevations({ activeOnly = true } = {}, db = prisma) {
  const now = new Date();
  return db.roleElevation.findMany({
    where: activeOnly ? { revokedAt: null, endsAt: { gt: now } } : {},
    orderBy: { endsAt: 'asc' },
    include: { user: { select: { id: true, name: true, role: true } } },
  });
}
