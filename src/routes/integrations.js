// Integrations (build step 9). Two routers:
//   • integrationHooks — inbound webhooks, authenticated by their own shared secret or signature,
//     never by a user token (mounted before `authenticate`);
//   • integrationsRouter — the Admin's status page, manual MDM sync, Zoho import, click-to-call.
// Every connector is optional: unset credentials leave the app running on imported/seeded data
// and the status endpoint says what is and isn't connected.
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ah, forbidden, unauthorized } from '../http/errors.js';
import { requirePermission } from '../auth/middleware.js';
import { findContact } from '../core/contacts.js';
import { prisma } from '../db.js';
import { handleWebhook, verifySignature, whatsappConfig, whatsappStatus } from '../integrations/whatsapp.js';
import { handleMdmEvent, mdmConfig, mdmStatus, syncSellers } from '../integrations/mdm.js';
import { dial, handleYeastarEvent, yeastarConfig, yeastarStatus } from '../integrations/yeastar.js';
import { runImport } from '../integrations/importer.js';

const sameSecret = (given, expected) => {
  if (!expected || !given) return false;
  const a = Buffer.from(String(given)); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const integrationHooks = Router();

// Meta's subscription handshake.
integrationHooks.get('/whatsapp/webhook', (req, res) => {
  const { verifyToken } = whatsappConfig();
  if (req.query['hub.mode'] === 'subscribe' && verifyToken && req.query['hub.verify_token'] === verifyToken) {
    return res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  }
  res.sendStatus(403);
});

integrationHooks.post('/whatsapp/webhook', ah(async (req, res) => {
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

integrationHooks.post('/yeastar/events', ah(async (req, res) => {
  if (!sameSecret(req.get('x-yeastar-secret') ?? req.query.secret, yeastarConfig().webhookSecret)) throw unauthorized('Invalid or missing Yeastar secret.');
  res.json(await handleYeastarEvent(req.body ?? {}));
}));

export const integrationsRouter = Router();

integrationsRouter.get('/status', requirePermission('integrations.manage'), ah(async (_req, res) => {
  const runs = await prisma.integrationRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 });
  res.json({
    mdm: await mdmStatus(), whatsapp: whatsappStatus(), yeastar: yeastarStatus(),
    runs: runs.map((r) => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null })),
  });
}));

integrationsRouter.post('/mdm/sync', requirePermission('integrations.manage'), ah(async (req, res) => {
  res.json(await syncSellers({ actorId: req.user.id }));
}));

// Zoho CSV/XLSX import. dryRun defaults to true: the first call returns the per-row plan.
integrationsRouter.post('/import', requirePermission('integrations.manage'), ah(async (req, res) => {
  const { kind, filename, contentBase64, dryRun } = req.body ?? {};
  res.json(await runImport(req.user, { kind, filename, contentBase64, dryRun: dryRun !== false }));
}));

// Click-to-call: the caller must be able to see the contact (same scope as the conversation).
integrationsRouter.post('/yeastar/dial', ah(async (req, res) => {
  if (req.user.role === 'READ_ONLY') throw forbidden('Read-only users cannot place calls.');
  const contact = await findContact(req.user, req.body?.contactId);
  const me = await prisma.user.findUnique({ where: { id: req.user.id } });
  res.json(await dial(me, contact));
}));
