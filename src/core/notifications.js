// In-app notifications — the rules' notify(...) action. With a dedupeKey, notifying twice is a
// no-op, which keeps every scheduled sweep idempotent.
import { prisma } from '../db.js';

export async function notify({ userId, kind, title, body = null, ticketId = null, dedupeKey = null }, db = prisma) {
  if (!userId) return null;
  if (dedupeKey) {
    const existing = await db.notification.findFirst({ where: { userId, dedupeKey } });
    if (existing) return null;
  }
  return db.notification.create({ data: { userId, kind, title, body, ticketId, dedupeKey } });
}

export async function notifyRole(role, payload, db = prisma) {
  const users = await db.user.findMany({ where: { role, active: true }, select: { id: true } });
  const out = [];
  for (const u of users) out.push(await notify({ ...payload, userId: u.id }, db));
  return out.filter(Boolean);
}

export function listNotifications(userId, { unreadOnly = false, take = 50 } = {}, db = prisma) {
  return db.notification.findMany({
    where: { userId, ...(unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(take, 200),
  });
}

export function markRead(userId, ids, db = prisma) {
  return db.notification.updateMany({ where: { userId, id: { in: ids }, readAt: null }, data: { readAt: new Date() } });
}
