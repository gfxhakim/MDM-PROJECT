// Serves the two prototype consoles (reference/*.html — normative for layout and wording) wired
// to the real API. The reference files are never edited: at startup each is transformed in
// memory — seeded demo state is emptied, a few constants become reassignable, the demo boot is
// removed — and the API adapter, i18n and session scripts are appended. The adapter replaces the
// in-browser actions with API calls; every rule still runs on the server.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function replaceOnce(html, from, to, file) {
  if (!html.includes(from)) throw new Error(`${file}: expected snippet not found — the reference changed: ${from.slice(0, 60)}`);
  return html.replace(from, to);
}

// The reference files are fragments (no <html>/<body>): wrap them, then append our scripts.
const HEAD = '<!doctype html>\n<html lang="en" dir="ltr">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>\n';
const TAIL = (adapter) => `
<script src="/assets/api.js"></script>
<script src="/assets/i18n.js"></script>
<script src="/assets/i18n-ar.js"></script>
<script src="/assets/${adapter}"></script>
</html>`;

function buildOa() {
  const file = 'reference/mdm-oa-console.html';
  let h = readFileSync(join(root, file), 'utf8');
  h = replaceOnce(h, "const ME = 'oa1';", "let ME = 'oa1';", file);
  h = replaceOnce(h, 'const TEAM = [', 'let TEAM = [', file);
  h = replaceOnce(h, 'const AMS = [', 'let AMS = [', file);
  h = replaceOnce(h, 'const canEdit = l =>', 'let canEdit = l =>', file);
  h = replaceOnce(h, "let S={leads:SEED.map(build),", "let S={leads:[],", file);
  h = replaceOnce(h, "try{const raw=localStorage.getItem(KEY); if(raw){const p=JSON.parse(raw); if(p&&p.leads&&p.leads.length) S.leads=p.leads;}}catch(e){}", '', file);
  h = replaceOnce(h, '/* =============== boot =============== */\nrender();', '/* boot: /assets/oa-adapter.js */', file);
  return HEAD + h + TAIL('oa-adapter.js');
}

// The AM console derives health, stage, playbook gates and capacity in the browser; the adapter
// replaces each with the server's values (AM 4.2: derived, never computed or written client-side).
const AM_REPLACEMENTS = [
  ["const ME = 'am1';", "let ME = 'am1';"],
  ['const TEAM = [', 'let TEAM = ['],
  ['const canEdit = s =>', 'let canEdit = s =>'],
  ['const health = s => healthOf(s).score;', 'let health = s => healthOf(s).score;'],
  ["let S={sellers:build(), role:'am',", "let S={sellers:[], role:'am',"],
  ['try{const raw=localStorage.getItem(KEY); if(raw){const p=JSON.parse(raw);\n  if(p&&p.sellers&&p.sellers.length) S.sellers=p.sellers;\n  if(p&&p.cfg) Object.assign(CFG,p.cfg);}}catch(e){}', ''],
  ["S.sel=[]; S.tab=S.tab||'health';\nrender();", "S.sel=[]; S.tab=S.tab||'health';\n/* boot: /assets/am-adapter.js */"],
];

function buildAm() {
  const file = 'reference/mdm-am-console_6.html';
  let h = readFileSync(join(root, file), 'utf8');
  for (const [from, to] of AM_REPLACEMENTS) h = replaceOnce(h, from, to, file);
  return HEAD + h + TAIL('am-adapter.js');
}

let cache = null;
export function consoles() {
  if (!cache || process.env.NODE_ENV !== 'production') cache = { oa: buildOa(), am: buildAm() };
  return cache;
}
