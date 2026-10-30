import { PrismaClient } from '@prisma/client';

// One client per process. Services accept an optional client (or transaction) so tests and
// simulation can run them against a rolled-back transaction.
export const prisma = globalThis.__mdmPrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalThis.__mdmPrisma = prisma;
