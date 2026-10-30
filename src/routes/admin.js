// Admin: temporary elevation and the audit trail.
import { Router } from 'express';
import { ah } from '../http/errors.js';
import { requirePermission } from '../auth/middleware.js';
import { grantElevation, listElevations, revokeElevation } from '../auth/elevation.js';
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
