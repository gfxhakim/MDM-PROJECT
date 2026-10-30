import express from 'express';
import { authenticate } from './auth/middleware.js';
import { authRouter } from './routes/auth.js';
import { configRouter } from './routes/config.js';
import { adminRouter } from './routes/admin.js';
import { coreRouter } from './routes/core.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/config', authenticate, configRouter);
  app.use('/api/admin', authenticate, adminRouter);
  app.use('/api', authenticate, coreRouter);

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
