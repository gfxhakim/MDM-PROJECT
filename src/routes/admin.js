// Admin: temporary elevation and the audit trail.
import { Router } from 'express';
import { ah } from '../http/errors.js';
import { requirePermission } from '../auth/middleware.js';
import { grantElevation, listElevations, revokeElevation } from '../auth/elevation.js';
import { listUsers, setActive, setPassword } from '../auth/users.js';
import { prisma } from '../db.js';

export const adminRouter = Router();

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

// Read-only view of the single immutable log. No write or delete route exists.
adminRouter.get('/audit', requirePermission('audit.view'), ah(async (req, res) => {
  const { entityType, entityId, action, actorId } = req.query;
  const take = Math.min(Number(req.query.limit) || 100, 500);
  const where = Object.fromEntries(Object.entries({ entityType, entityId, action, actorId }).filter(([, v]) => v));
  const rows = await prisma.eventLog.findMany({ where, orderBy: { createdAt: 'desc' }, take });
  res.json(rows.map((r) => ({ ...r, before: r.before && JSON.parse(r.before), after: r.after && JSON.parse(r.after) })));
}));

// ───────── accounts ─────────
// Everyone who can sign in, including accounts switched off and those imported from MDM.
adminRouter.get('/users', requirePermission('roles.manage'), ah(async (_req, res) => {
  res.json(await listUsers());
}));

// A password typed by the Admin (at least 8 characters). The audit entry never carries it.
adminRouter.post('/users/:id/password', requirePermission('roles.manage'), ah(async (req, res) => {
  res.json(await setPassword(req.user, req.params.id, req.body?.password));
}));

// { active: false, reason } switches an account off — its open leads go to the holding queue and
// its sellers to the same-market, smallest-book manager; { active: true, reason } switches it on.
adminRouter.post('/users/:id/active', requirePermission('roles.manage'), ah(async (req, res) => {
  res.json(await setActive(req.user, req.params.id, req.body?.active === true, req.body?.reason));
}));
