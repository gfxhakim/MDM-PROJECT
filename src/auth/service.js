// Authentication: passwords (bcrypt), JWT sessions, and the principal every request acts as.
// The token carries only the user id; role, active flag and elevation are re-read on every
// request, so a role change or deactivation takes effect immediately.
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { HttpError, unauthorized } from '../http/errors.js';

const TOKEN_TTL = process.env.JWT_TTL ?? '12h';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set.');
  return s;
}

export const hashPassword = (plain) => bcrypt.hash(plain, 10);

export function signToken(userId) {
  return jwt.sign({}, secret(), { subject: userId, expiresIn: TOKEN_TTL });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, secret()).sub;
  } catch {
    throw unauthorized('Your session has expired or is invalid. Sign in again.');
  }
}

/**
 * The principal a request acts as. `role` is the effective role: an active, unexpired elevation
 * replaces the base role for its window (OA 9.3). Expiry is read from endsAt, so it is exact even
 * before the expiry sweep writes its audit entry.
 */
export async function loadPrincipal(userId, now = new Date(), db = prisma) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || !user.active) return null;
  const elevation = await db.roleElevation.findFirst({
    where: { userId, revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { endsAt: 'desc' },
  });
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    baseRole: user.role,
    role: elevation?.role ?? user.role,
    elevation: elevation ? { id: elevation.id, role: elevation.role, endsAt: elevation.endsAt, reason: elevation.reason } : null,
    markets: JSON.parse(user.markets),
    businessNumber: user.businessNumber,
  };
}

export async function login(email, password, db = prisma) {
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new HttpError(400, 'bad_request', 'Email and password are required.');
  }
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  // Same message for unknown email, wrong password and inactive account.
  const ok = user && user.active && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) throw unauthorized('Invalid email or password.');
  return { token: signToken(user.id), user: await loadPrincipal(user.id, new Date(), db) };
}
