// Pages: the login screen and the two consoles. Each console checks the session itself (the API
// is the control — a page without a token can render nothing but the redirect to sign in).
import express, { Router } from 'express';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoles } from './consoles.js';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public');
const html = (res, body) => res.set('cache-control', 'no-store').type('html').send(body);

export const webRouter = Router();
webRouter.use('/assets', express.static(join(publicDir, 'assets'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
webRouter.get('/', (_req, res) => res.set('cache-control', 'no-store').sendFile(join(publicDir, 'login.html')));
webRouter.get('/oa', (_req, res) => html(res, consoles().oa));
webRouter.get('/am', (_req, res) => {
  const am = consoles().am;
  return am ? html(res, am) : res.status(503).send('Account Manager console is not built yet.');
});
