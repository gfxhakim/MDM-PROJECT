// Production entrypoint (Railway or any container host). `npm start` runs this.
//
// 1. Fills the two required settings when the host has not set them:
//    • DATABASE_URL → SQLite in the persistent volume at /data if one is mounted, else ./prisma/prod.db
//      (the latter is wiped on every redeploy — attach a volume or data is lost).
//    • JWT_SECRET   → generated once and stored next to the database, so sign-ins survive restarts.
// 2. Brings the database schema up to date (prisma db push) and runs the idempotent seed.
// 3. Starts the server.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.NODE_ENV ||= 'production';

const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH || (existsSync('/data') ? '/data' : null);
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = volume ? `file:${join(volume, 'mdm.db')}` : `file:${join(root, 'prisma', 'prod.db')}`;
  console.log(`DATABASE_URL not set — using ${process.env.DATABASE_URL}`);
  if (!volume) console.warn('WARNING: no persistent volume is mounted; the database is lost on every redeploy. Attach a volume at /data.');
}
if (!process.env.JWT_SECRET) {
  const dir = volume ?? join(root, 'prisma');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '.jwt-secret');
  if (!existsSync(file)) writeFileSync(file, randomBytes(48).toString('hex'), { mode: 0o600 });
  process.env.JWT_SECRET = readFileSync(file, 'utf8').trim();
  console.log('JWT_SECRET not set — using the secret stored beside the database.');
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(' ')} failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
}
run(process.execPath, [join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate']);
run(process.execPath, [join(root, 'prisma', 'seed.js')]);

await import('../src/server.js');
