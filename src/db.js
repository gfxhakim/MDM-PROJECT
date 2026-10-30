import { PrismaClient } from '@prisma/client';

// One client per process. Services accept an optional client (or transaction) so tests and
// simulation can run them against a rolled-back transaction.
export const prisma = globalThis.__mdmPrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalThis.__mdmPrisma = prisma;

/**
 * Run `fn` in a transaction on `db`, or directly when `db` is already a transaction client
 * (Prisma's interactive transaction client has no $transaction). Lets every service be called
 * either standalone or inside a caller's transaction — including simulate's rolled-back one.
 */
export function inTx(db, fn, opts) {
  return typeof db.$transaction === 'function' ? db.$transaction(fn, opts) : fn(db);
}
