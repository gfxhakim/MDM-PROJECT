// Script and style addresses carry a fingerprint of the file's content (/assets/x.js?v=1a2b3c4d).
// Browsers keep /assets for an hour in production; without the fingerprint a browser that had the
// previous version would run an old script against a new page after a deploy.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const assetsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/assets');
const seen = new Map();

function fingerprint(name) {
  if (process.env.NODE_ENV === 'production' && seen.has(name)) return seen.get(name);
  let v = '';
  try { v = createHash('sha1').update(readFileSync(join(assetsDir, name))).digest('hex').slice(0, 10); } catch { /* missing file: leave the address as it is */ }
  seen.set(name, v);
  return v;
}

/** Adds ?v=<content hash> to every /assets/… script or stylesheet address in a page. */
export function versioned(html) {
  return html.replace(/(\s(?:src|href)=")\/assets\/([^"?#]+)"/g, (m, attr, name) => {
    const v = fingerprint(name);
    return v ? `${attr}/assets/${name}?v=${v}"` : m;
  });
}
