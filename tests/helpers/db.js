// Gives each test file its own throw-away SQLite database with the current schema.
// Must be imported (and awaited) BEFORE anything that imports src/db.js.
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function useTestDatabase(name) {
  const dir = join(root, 'tests/.tmp');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.db`);
  rmSync(file, { force: true });
  rmSync(`${file}-journal`, { force: true });
  process.env.DATABASE_URL = `file:${file}`;
  execSync('npx prisma db push --skip-generate', { cwd: root, env: process.env, stdio: 'ignore' });
  return file;
}
