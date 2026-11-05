// Admin: temporary elevation and the audit trail.
import { Router } from 'express';
import { ah, badRequest } from '../http/errors.js';
import { requirePermission } from '../auth/middleware.js';
import { grantElevation, listElevations, revokeElevation } from '../auth/elevation.js';
import { changeRole, listUsers, removeUser, restoreUser, setActive, setPassword } from '../auth/users.js';
import { deleteAllData, deleteAllPreview, deleteRecords, listDeleted, restoreDeleted } from '../core/deletion.js';
import { isSyncRunning } from '../integrations/mdm.js';
import { dateRange } from '../http/range.js';
import { prisma } from '../db.js';
import { OA_APPENDIX_A, ROLES, grant } from '../auth/permissions.js';

export const adminRouter = Router();

// A role's onboarding grants, row by row as OA Appendix A lists them (read-only).
adminRouter.get('/roles/:role/grants', requirePermission('roles.manage'), ah(async (req, res) => {
  if (!ROLES.includes(req.params.role)) throw badRequest(`role must be one of ${ROLES.join(', ')}.`);
  res.json(OA_APPENDIX_A.map((r) => ({ ...r, value: grant(req.params.role, r.key) })));
}));

adminRouter.get('/elevations', requirePermission('roles.manage'), ah(async (req, res) => {
  res.json(await listElevations({ activeOnly: req.query.all !== 'true' }));
}));

adminRouter.post('/elevations', requirePermission('roles.manage'), ah(async (req, res) => {
  const { userId, role, endsAt, reason } = req.body ?? {};
  res.status(201).json(await grantElevation({ actor: req.user, userId, role, endsAt, reason }));
}));

adminRouter.delete('/elevations/:id', requirePermission('roles.manage'), ah(async (req, res) => {
  res.json(await revokeElevation({ actor: req.user, elevationId: req.params.id, reason: req.body?.reason }));
}));

// The Head of AM reads the account-management part of the trail (AM 9.5: configuration publish and
// rollback, reassignment, escalation, conversation take-over, block requests, bulk task creation),
// plus everything else written about sellers, their tasks, playbooks and health.
async function amTrail() {
  const sellerContacts = (await prisma.seller.findMany({ select: { contactId: true } })).map((s) => s.contactId);
  return { OR: [
    { entityType: 'seller' }, { action: { startsWith: 'am' } }, { action: { startsWith: 'seller.' } }, { action: { startsWith: 'playbook.' } },
    { action: { startsWith: 'health.' } }, { action: { in: ['bulk.am_task_create', 'bulk.seller_reassign'] } }, { action: { startsWith: 'config.' } },
    { action: { startsWith: 'conversation.' } },
    // block requests: on sellers' contacts only (a lead's block is the onboarding team's)
    { entityType: 'contact', entityId: { in: sellerContacts }, action: { contains: 'block' } },
  ] };
}

// Read-only view of the single immutable log. No write or delete route exists.
adminRouter.get('/audit', requirePermission('audit.view'), ah(async (req, res) => {
  const { entityType, entityId, action, actorId } = req.query;
  const take = Math.min(Number(req.query.limit) || 100, 500);
  const where = Object.fromEntries(Object.entries({ entityType, entityId, action, actorId }).filter(([, v]) => v));
  if (req.query.actor === 'system') where.actorId = null; // rules and the sync
  const { from, to } = dateRange(req.query);
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  if (req.user.role === 'HEAD_OF_AM') where.AND = [await amTrail()];
  const rows = await prisma.eventLog.findMany({ where, orderBy: { createdAt: 'desc' }, take });
  res.json(rows.map((r) => ({ ...r, before: r.before && JSON.parse(r.before), after: r.after && JSON.parse(r.after) })));
}));

// ───────── accounts ─────────
// Everyone who can sign in, including accounts switched off and those imported from MDM.
adminRouter.get('/users', requirePermission('roles.manage'), ah(async (req, res) => {
  res.json(await listUsers({ includeRemoved: req.query.removed === 'true' }));
}));

// { reason } — the account can no longer sign in and leaves every list; its leads go to the holding
// queue and its sellers on (as when it is switched off). Kept hidden for the audit history.
adminRouter.post('/users/:id/remove', requirePermission('roles.manage'), ah(async (req, res) => {
  res.json(await removeUser(req.user, req.params.id, req.body?.reason));
}));
adminRouter.post('/users/:id/restore', requirePermission('roles.manage'), ah(async (req, res) => {
  res.json(await restoreUser(req.user, req.params.id, req.body?.reason));
}));

// A password typed by the Admin (at least 8 characters). The audit entry never carries it.
adminRouter.post('/users/:id/password', requirePermission('roles.manage'), ah(async (req, res) => {
  res.json(await setPassword(req.user, req.params.id, req.body?.password));
}));

// { active: false, reason } switches an account off — its open leads go to the holding queue and
// its sellers to the same-market, smallest-book manager; { active: true, reason } switches it on.
// { role, reason, markets? } — another role for an account; its old work is handed on as when switched off.
adminRouter.post('/users/:id/role', requirePermission('roles.manage'), ah(async (req, res) => {
  res.json(await changeRole(req.user, req.params.id, req.body?.role, req.body?.reason, req.body?.markets));
}));

adminRouter.post('/users/:id/active', requirePermission('roles.manage'), ah(async (req, res) => {
  res.json(await setActive(req.user, req.params.id, req.body?.active === true, req.body?.reason));
}));

// ───────── deleting merchants ─────────
// { kind: leads|sellers|skipped, ids (≤ 200), reason } — deleted here only (MDM is never touched) and
// kept out of the sync; each row reported on its own, one audit entry with the full list.
adminRouter.post('/delete', requirePermission('records.delete'), ah(async (req, res) => {
  res.json(await deleteRecords(req.user, { kind: req.body?.kind, ids: req.body?.ids, reason: req.body?.reason }));
}));
// The deleted merchants (?kind=&q=&from=&to= on the deletion date; ?restored=true shows the restored too).
adminRouter.get('/deleted', requirePermission('records.delete'), ah(async (req, res) => {
  res.json(await listDeleted({ kind: req.query.kind || null, q: req.query.q || null, restored: req.query.restored === 'true', ...dateRange(req.query) }));
}));
// { ids, reason } — the sync may bring them back; their history here is not restored.
adminRouter.post('/deleted/restore', requirePermission('records.delete'), ah(async (req, res) => {
  res.json(await restoreDeleted(req.user, { ids: req.body?.ids, reason: req.body?.reason }));
}));

// ───────── delete all data ─────────
// What would be deleted (counts) and the number to type to confirm.
adminRouter.get('/delete-all', requirePermission('records.delete'), ah(async (_req, res) => {
  res.json({ ...(await deleteAllPreview()), syncRunning: isSyncRunning() });
}));
// { reason, confirm (the number of merchants here now), emptyDeletedList? } — every lead, seller,
// conversation and task, the Skipped sellers and People on MDM lists and the MDM records are deleted
// here (MDM is never touched); accounts, settings and the audit log stay. The automatic sync is paused.
adminRouter.post('/delete-all', requirePermission('records.delete'), ah(async (req, res) => {
  const b = req.body ?? {};
  res.json(await deleteAllData(req.user, { reason: b.reason, confirm: b.confirm, emptyDeletedList: b.emptyDeletedList === true }, { syncRunning: isSyncRunning() }));
}));
