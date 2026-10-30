import { Router } from 'express';
import { ah } from '../http/errors.js';
import { login } from '../auth/service.js';
import { authenticate } from '../auth/middleware.js';
import { grantsFor } from '../auth/permissions.js';

export const authRouter = Router();

authRouter.post('/login', ah(async (req, res) => {
  res.json(await login(req.body?.email, req.body?.password));
}));

// The caller and every grant they hold, so the UI can render disabled controls with their reason.
authRouter.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user, grants: grantsFor(req.user.role) });
});
