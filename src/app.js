import express from 'express';
import { authenticate } from './auth/middleware.js';
import { authRouter } from './routes/auth.js';
import { configRouter } from './routes/config.js';
import { adminRouter } from './routes/admin.js';
import { coreRouter } from './routes/core.js';
import { oaRouter } from './routes/oa.js';
import { registerOnboarding } from './oa/index.js';
import { amRouter } from './routes/am.js';
import { registerAccountManagement } from './am/index.js';
import { webRouter } from './web/routes.js';
import { integrationHooks, integrationsRouter } from './routes/integrations.js';
import { registerWhatsapp } from './integrations/whatsapp.js';

export function createApp() {
  registerOnboarding();
  registerAccountManagement();
  registerWhatsapp();
  const app = express();
  app.disable('x-powered-by');
  // Webhook signatures are computed over the exact bytes received, so keep them for those routes.
  const keepRaw = (req, _res, buf) => { if (req.originalUrl.startsWith('/api/integrations/')) req.rawBody = buf; };
  app.use('/api/integrations/import', express.json({ limit: '20mb' })); // base64 spreadsheet upload
  app.use(express.json({ limit: '1mb', verify: keepRaw }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/integrations', integrationHooks);
  app.use('/api/integrations', authenticate, integrationsRouter);
  app.use('/api/config', authenticate, configRouter);
  app.use('/api/admin', authenticate, adminRouter);
  app.use('/api/oa', authenticate, oaRouter);
  app.use('/api/am', authenticate, amRouter);
  app.use('/api', authenticate, coreRouter);

  app.use(webRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } }));

  // Errors with a status/code are expected refusals; anything else is a 500 without internals.
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON.' } });
    }
    if (err?.status && err?.code) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong.' } });
  });
  return app;
}
