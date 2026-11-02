// Integrations (build step 9). Two routers:
//   • integrationHooks — inbound webhooks, authenticated by their own shared secret or signature,
//     never by a user token (mounted before `authenticate`);
//   • integrationsRouter — the Admin's status page, manual MDM sync, Zoho import, click-to-call.
// Every connector is optional: unset credentials leave the app running on imported/seeded data
// and the status endpoint says what is and isn't connected.
import { dateRange } from '../http/range.js';
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ah, forbidden, unauthorized } from '../http/errors.js';
import { requirePermission } from '../auth/middleware.js';
import { findContact } from '../core/contacts.js';
import { prisma } from '../db.js';
import { handleWebhook, verifySignature, whatsappConfig, whatsappStatus } from '../integrations/whatsapp.js';
import { handleMdmEvent, mdmConfig, mdmStatus, startSync } from '../integrations/mdm.js';
import { decideSkipped, listSkipped } from '../integrations/mdm-skipped.js';
import { decideStaff, listStaff } from '../integrations/mdm-staff.js';
import { dial, handleYeastarEvent, yeastarConfig, yeastarStatus } from '../integrations/yeastar.js';
import { runImport } from '../integrations/importer.js';
import { OPTIONAL, optionalOn } from '../integrations/optional.js';
import { pushPending, writebackStatus } from '../integrations/mdm-writeback.js';

// A connector that is switched off answers like a route that does not exist.
const ifOn = (name) => (_req, res, next) => (optionalOn(name) ? next() : res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } }));

const sameSecret = (given, expected) => {
  if (!expected || !given) return false;
  const a = Buffer.from(String(given)); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const integrationHooks = Router();

// Meta's subscription handshake.
integrationHooks.get('/whatsapp/webhook', ifOn('whatsapp'), (req, res) => {
  const { verifyToken } = whatsappConfig();
  if (req.query['hub.mode'] === 'subscribe' && verifyToken && req.query['hub.verify_token'] === verifyToken) {
    return res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  }
  res.sendStatus(403);
});

integrationHooks.post('/whatsapp/webhook', ifOn('whatsapp'), ah(async (req, res) => {
  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'))) throw unauthorized('Invalid or missing X-Hub-Signature-256.');
  res.json(await handleWebhook(req.body));
}));

integrationHooks.post('/mdm/events', ah(async (req, res) => {
  if (!sameSecret(req.get('x-mdm-key'), mdmConfig().webhookKey)) throw unauthorized('Invalid or missing X-MDM-Key.');
  const events = Array.isArray(req.body?.events) ? req.body.events : [req.body];
  const results = [];
  for (const e of events.slice(0, 500)) {
    try { results.push(await handleMdmEvent(e)); } catch (err) { results.push({ ok: false, reason: err.message }); }
  }
  res.json({ results });
}));

integrationHooks.post('/yeastar/events', ifOn('yeastar'), ah(async (req, res) => {
  if (!sameSecret(req.get('x-yeastar-secret') ?? req.query.secret, yeastarConfig().webhookSecret)) throw unauthorized('Invalid or missing Yeastar secret.');
  res.json(await handleYeastarEvent(req.body ?? {}));
}));

export const integrationsRouter = Router();

integrationsRouter.get('/status', requirePermission('integrations.manage'), ah(async (_req, res) => {
  const runs = await prisma.integrationRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 });
  res.json({
    mdm: await mdmStatus(), writeback: await writebackStatus(),
    optional: Object.fromEntries(OPTIONAL.map((k) => [k, optionalOn(k)])),
    ...(optionalOn('whatsapp') ? { whatsapp: whatsappStatus() } : {}),
    ...(optionalOn('yeastar') ? { yeastar: yeastarStatus() } : {}),
    runs: runs.map((r) => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null })),
  });
}));

// { full: true } re-reads every record from the beginning (the first sync always does).
// Answers as soon as the run is recorded; the page follows its progress under Recent runs.
integrationsRouter.post('/mdm/sync', requirePermission('integrations.manage'), ah(async (req, res) => {
  res.status(202).json(await startSync({ actorId: req.user.id, full: req.body?.full === true }));
}));

integrationsRouter.post('/mdm/push', requirePermission('integrations.manage'), ah(async (_req, res) => {
  res.json(await pushPending());
}));

// Sellers the pull could not place, kept aside for a decision. ?decision=waiting|placed|lead|left_out|imported|all
integrationsRouter.get('/mdm/skipped', requirePermission('integrations.manage'), ah(async (req, res) => {
  res.json(await listSkipped({ decision: req.query.decision, reason: req.query.reason, q: req.query.q, ...dateRange(req.query) }));
}));

// { ids, action: place|lead|leave_out|reopen, market?, managerId?, note?, phone? } — each row reported on
// its own, one audit entry for the run. A placed seller's figures come with the next sync, which is
// started at once when the platform is connected and no sync is running.
integrationsRouter.post('/mdm/skipped/decide', requirePermission('integrations.manage'), ah(async (req, res) => {
  const result = await decideSkipped(req.user, req.body ?? {});
  if (result.action === 'place' && result.done && mdmConfig().apiKey) {
    // answers as soon as the run is recorded; a sync already running (409) reads the placed sellers itself
    result.sync = await startSync({ actorId: req.user.id }).then((s) => ({ started: true, runId: s.runId }), (e) => ({ started: false, reason: e.message }));
  }
  res.json(result);
}));

// People on MDM: every platform user the pull read, waiting for the Admin's decision.
// ?decision=waiting|imported|left_out|all  &scope=  &q=
integrationsRouter.get('/mdm/staff', requirePermission('integrations.manage'), ah(async (req, res) => {
  res.json(await listStaff({ decision: req.query.decision, scope: req.query.scope || null, q: req.query.q || null, ...dateRange(req.query) }));
}));

// { ids, action: import|leave_out|reopen, role?, markets?, note? } — each person reported on their
// own, one audit entry for the run; an import then gives them the leads and sellers MDM ties to them.
integrationsRouter.post('/mdm/staff/decide', requirePermission('integrations.manage'), ah(async (req, res) => {
  res.json(await decideStaff(req.user, req.body ?? {}));
}));

// Zoho CSV/XLSX import. dryRun defaults to true: the first call returns the per-row plan.
integrationsRouter.post('/import', ifOn('zoho'), requirePermission('integrations.manage'), ah(async (req, res) => {
  const { kind, filename, contentBase64, dryRun } = req.body ?? {};
  res.json(await runImport(req.user, { kind, filename, contentBase64, dryRun: dryRun !== false }));
}));

// Click-to-call: the caller must be able to see the contact (same scope as the conversation).
integrationsRouter.post('/yeastar/dial', ifOn('yeastar'), ah(async (req, res) => {
  if (req.user.role === 'READ_ONLY') throw forbidden('Read-only users cannot place calls.');
  const contact = await findContact(req.user, req.body?.contactId);
  const me = await prisma.user.findUnique({ where: { id: req.user.id } });
  res.json(await dial(me, contact));
}));
