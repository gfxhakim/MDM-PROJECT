// The single immutable audit trail. Append-only: this module exposes no update or delete.
import { prisma } from '../db.js';

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

/**
 * @param {object} e
 * @param {string|null} e.actorId   null = system / rule
 * @param {string} e.entityType      ticket | contact | seller | config | conversation | user
 * @param {string} e.entityId
 * @param {string} e.action
 * @param {any} [e.before]
 * @param {any} [e.after]
 * @param {string} [e.reason]
 * @param {import('@prisma/client').Prisma.TransactionClient} [db]
 */
export function logEvent({ actorId = null, entityType, entityId, action, before, after, reason }, db = prisma) {
  return db.eventLog.create({
    data: { actorId, entityType, entityId: String(entityId), action, before: json(before), after: json(after), reason: reason ?? null },
  });
}
