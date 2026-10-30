// Configuration surface (AM Part 11, OA 13.4). Reading the live values is open to every signed-in
// user (agents see "attempt 3 of 5"); every change goes through the service, which enforces the
// Appendix D owner column per key.
import { Router } from 'express';
import { ah, forbidden } from '../http/errors.js';
import * as cfg from '../config/service.js';
import { PARAMETERS } from '../config/parameters.js';

export const configRouter = Router();

const EDITORS = ['MANAGER', 'ADMIN'];
const editorsOnly = (req, _res, next) =>
  EDITORS.includes(req.user.role) ? next() : next(forbidden('Configuration is changed by a Manager or an Admin.'));

configRouter.get('/', ah(async (_req, res) => res.json(await cfg.getLiveConfig())));

configRouter.get('/parameters', (req, res) => {
  res.json(PARAMETERS.map((p) => ({ ...p, editable: cfg.canEdit(req.user.role, p.key) })));
});

configRouter.get('/draft', editorsOnly, ah(async (_req, res) => res.json(await cfg.getDraft())));
configRouter.patch('/draft', editorsOnly, ah(async (req, res) => res.json(await cfg.updateDraft(req.body?.changes, req.user))));
configRouter.delete('/draft', editorsOnly, ah(async (req, res) => res.json(await cfg.discardDraft(req.user))));
configRouter.post('/simulate', editorsOnly, ah(async (req, res) => res.json(await cfg.simulate({ changes: req.body?.changes }))));

configRouter.post('/publish', editorsOnly, ah(async (req, res) => {
  res.json(await cfg.publish({ actor: req.user, note: req.body?.note, expectedVersion: req.body?.expectedVersion }));
}));

configRouter.post('/rollback', editorsOnly, ah(async (req, res) => {
  res.json(await cfg.rollback({ actor: req.user, targetVersion: req.body?.targetVersion, note: req.body?.note }));
}));

configRouter.get('/versions', editorsOnly, ah(async (_req, res) => res.json(await cfg.listVersions())));
configRouter.get('/versions/:version', editorsOnly, ah(async (req, res) => res.json(await cfg.getVersion(req.params.version))));
