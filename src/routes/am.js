// Account Manager API. Scope is the book: a foreign seller is not-found (AC-20).
import { Router } from 'express';
import { ah, badRequest, forbidden } from '../http/errors.js';
import { prisma } from '../db.js';
import { getLiveConfig } from '../config/service.js';
import { requirePermission } from '../auth/middleware.js';
import { findSellerInScope } from '../auth/scope.js';
import * as am from '../am/service.js';
import { coverage } from '../am/capacity.js';
import { runAmSweep } from '../am/rules.js';
import { logEvent } from '../services/audit.js';
import { amAnalytics } from '../am/analytics.js';
import { grant } from '../auth/permissions.js';

export const amRouter = Router();

amRouter.get('/console', ah(async (req, res) => res.json(await am.consoleBundle(req.user))));
amRouter.post('/sellers/:id/calls', ah(async (req, res) => res.status(201).json(await am.logCall(req.user, req.params.id, req.body ?? {}))));
amRouter.post('/sellers/:id/request-transfer', ah(async (req, res) => res.json(await am.requestTransfer(req.user, req.params.id, req.body?.reason))));
amRouter.post('/tasks/:id/snooze', ah(async (req, res) => res.json(await am.snoozeTask(req.user, req.params.id, req.body?.days ?? 1, { reason: req.body?.reason ?? null }))));
amRouter.get('/book', ah(async (req, res) => res.json(await am.listBook(req.user, req.query))));
amRouter.get('/sellers/:id', ah(async (req, res) => res.json(await am.getSeller(req.user, req.params.id))));
amRouter.get('/sellers/:id/health-history', ah(async (req, res) => {
  const s = await findSellerInScope(req.user, req.params.id);
  res.json(await prisma.healthHistory.findMany({ where: { sellerId: s.id }, orderBy: { date: 'asc' }, take: 180 }));
}));
amRouter.post('/sellers/:id/tasks', ah(async (req, res) => res.status(201).json(await am.createTask(req.user, req.params.id, req.body ?? {}))));
amRouter.post('/tasks/:id/close', ah(async (req, res) => res.json(await am.closeTask(req.user, req.params.id, req.body?.outcome))));
amRouter.post('/tasks/:id/escalate', ah(async (req, res) => res.json(await am.escalateTask(req.user, req.params.id, req.body?.reason))));
amRouter.post('/sellers/:id/playbook/:day/tick', ah(async (req, res) => res.json(await am.tickStep(req.user, req.params.id, req.params.day))));
amRouter.get('/capacity', ah(async (req, res) => res.json(await am.capacityView(req.user))));

// ───────── Admin ─────────
amRouter.get('/coverage', requirePermission('am.performance_team'), ah(async (_req, res) => {
  res.json(await coverage((await getLiveConfig()).values));
}));
// Head of AM sees every manager; an AM sees their own performance row only (AM Appendix A).
amRouter.get('/analytics', requirePermission('am.performance_own'), ah(async (req, res) => {
  const a = await amAnalytics();
  if (!grant(req.user.role, 'am.performance_team')) { a.perf = { [req.user.id]: a.perf[req.user.id] ?? null }; delete a.quality; }
  res.json(a);
}));
amRouter.post('/sweep', requirePermission('am.rule_sweep'), ah(async (req, res) => {
  const r = await runAmSweep();
  await logEvent({ actorId: req.user.id, entityType: 'system', entityId: 'am.sweep', action: 'am.sweep_manual', after: { tasksOpened: r.tasksOpened, tasksUpgraded: r.tasksUpgraded } });
  res.json(r);
}));
amRouter.post('/bulk-tasks', ah(async (req, res) => res.json(await am.bulkCreateTasks(req.user, req.body ?? {}))));
amRouter.post('/reassign', ah(async (req, res) => {
  res.json(await am.reassignSellers(req.user, req.body?.sellerIds, req.body?.toManagerId, req.body?.reason));
}));
amRouter.post('/sellers/:id/churn', ah(async (req, res) => res.json(await am.markChurned(req.user, req.params.id, req.body?.reason))));

// The operational record is a read-only mirror of the MDM platform. Until the connector (step 9)
// writes it, an Admin can load metrics. Derived fields (health, band, stage) are never accepted.
const MIRROR = ['weeklyOrders', 'weeklyReturnRates', 'totalOrders', 'deliveryRate', 'returnRate', 'cancelRate', 'wallet',
  'walletNegativeDays', 'products', 'marketsServed', 'momGrowthPct', 'lastOrderAt', 'lastLoginAt', 'lastStoreUpdateAt', 'lastProductAddedAt'];
amRouter.post('/dev/sellers/:id/metrics', ah(async (req, res) => {
  if (req.user.role !== 'ADMIN') throw forbidden('The operational record comes from the MDM platform; an Admin can load test metrics.');
  const body = req.body ?? {};
  const bad = Object.keys(body).filter((k) => !MIRROR.includes(k));
  if (bad.length) throw badRequest(`Not part of the operational record: ${bad.join(', ')}. Health score and lifecycle stage are derived, never written.`);
  const data = { ...body };
  for (const k of ['weeklyOrders', 'weeklyReturnRates']) if (data[k] !== undefined) data[k] = JSON.stringify(data[k]);
  for (const k of ['lastOrderAt', 'lastLoginAt', 'lastStoreUpdateAt', 'lastProductAddedAt']) if (data[k]) data[k] = new Date(data[k]);
  const s = await findSellerInScope(req.user, req.params.id);
  res.json(await prisma.seller.update({ where: { id: s.id }, data }));
}));
