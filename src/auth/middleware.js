import { loadPrincipal, verifyToken } from './service.js';
import { grant } from './permissions.js';
import { forbidden, unauthorized } from '../http/errors.js';
import { denialReason } from './scope.js';

/** Resolve the Bearer token to req.user, or 401. */
export async function authenticate(req, _res, next) {
  try {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw unauthorized();
    const user = await loadPrincipal(verifyToken(token));
    if (!user) throw unauthorized('This account is not active.');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Require any grant other than false for a permission. Scope checks happen in the service. */
export const requirePermission = (permission) => (req, _res, next) => {
  if (!grant(req.user.role, permission)) return next(forbidden(denialReason(req.user, permission)));
  next();
};
