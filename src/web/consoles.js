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

// The OA prototype's admin views carry sample figures and named examples. Each is replaced with a
// call into the adapter (window.MDM), which renders the server's numbers — or says plainly that a
// module has no data yet — so nothing on screen is invented.
const OA_REPLACEMENTS = [
  ["${[['r3','No-answer reminders created',12],['r5','Follow-up templates sent',4],\n           ['r4','Moved to Cold Lead',2],['r1','New leads captured and assigned',5],['r8','Held leads assigned when capacity freed',1]]",
    "${[['r3','No-answer reminders created'],['r5','Follow-up templates sent'],\n           ['r4','Moved to Cold Lead'],['r1','New leads captured and assigned'],['r8','Held leads assigned when capacity freed']].map(([id,t])=>[id,t,(A.ruleRuns||{})[id]||0])"],
  ["<div><b>Read this before acting on it.</b> Karim's activation rate is 62% against Salma's 70%, but his average time to first contact is 11.2 hours against her 6.4.\n      Speed to first contact is the strongest predictor in this table — the coaching target is the cadence discipline, not the closing skill.</div>",
    "<div><b>Read this before acting on it.</b> ${MDM.perfInsight()}</div>"],
  ["Karim has sent 118 of those; Noor 49. Spend follows the quiet cadence, not the workload.", "${MDM.tplSpendLine()}"],
  ["<div class=\"lrow\">${oaAvatar('oa1','')}<div class=\"grow\"><div class=\"t\">Salma → Shift lead</div>\n          <div class=\"s\">Covering Karim · expires ${fmt(d(4))} 16:30</div></div>\n          <button class=\"btn btn-ghost btn-sm\" onclick=\"toast('Elevation ended early — audited')\">End now</button></div>\n        <button class=\"btn btn-ghost btn-sm\" style=\"margin-top:10px\" onclick=\"toast('Grant time-bound elevation')\">${ic('plus',12)} Grant cover</button>",
    "${MDM.elevationsHTML()}"],
  ["${[['Karim Haddad','First contact — Rami Khoury','flagged: 2 attempts, no wrap-up note','#B45309'],\n           ['Noor Al-Saadi','Walkthrough — Layla Al-Jubouri','random sample','#475569'],\n           ['Salma Ben Ali','Activation — Khaled Bouzid','flagged: fast-track activation','#B45309']]",
    "${MDM.qaEmpty()}${[]"],
  ["${A.agents.map(a=>`<div style=\"margin-bottom:11px\">\n          <div style=\"display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px\">\n            <span style=\"font-weight:600\">${oa(a.id).name}</span><span class=\"num muted\">${a.qa} / 5</span></div>",
    "${MDM.qaEmpty()}${[].map(a=>`<div style=\"margin-bottom:11px\">\n          <div style=\"display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px\">\n            <span style=\"font-weight:600\">${oa(a.id).name}</span><span class=\"num muted\">${a.qa} / 5</span></div>"],
  ["['Walkthroughs delivered',6],['Average time to first contact','6.4h'],['Template sends used','38 of 120']]",
    "['Walkthroughs delivered',MDM.mine('walk')],['Average time to first contact',MDM.mine('avgH')+'h'],['Template sends used',MDM.mine('tpl')]]"],
  ["${[['Walkthrough — Khaled Bouzid',4.6,'Excellent pricing walkthrough. Commitments captured verbatim in the handoff.'],\n         ['First contact — Rami Khoury',3.8,'Two attempts logged without a wrap-up note. Write the note at the time, not at 16:30.']]",
    "${MDM.qaEmpty()}${[]"],
  ["<div><b>oa_nudge_v2 is 18% of spend and sits in the quiet cadence.</b> The cohort table says activations after day 14 are close to zero —\n      cutting the third follow-up would save roughly 40 sends a month and, on the evidence, cost almost no activations.\n      That is a two-field change on the Automation page.</div>",
    "<div>${MDM.tplInsight(total)}</div>"],
  ["${[212,88,61,74,33,19][i]} uses", "${MDM.macroUses(m)} uses"],
  ['rate:Math.round(w.act/w.reg*100)', 'rate:w.reg?Math.round(w.act/w.reg*100):0'],
  ['const perAct=Math.round(totMin/A.activated);', 'const perAct=A.activated?Math.round(totMin/A.activated):0;'],
  ['const msgPerAct=Math.round(msgMin/A.activated);', 'const msgPerAct=A.activated?Math.round(msgMin/A.activated):0;'],
  ["<div>Both configuration changes are dated on the chart, which is the only way to tell whether a rule change caused the movement.\n      The step from W28 tracks the fifth attempt; the W33 nudge template moved the quiet cohort, not the no-answer one — the cohort table below separates them.</div>",
    "<div>${MDM.marksNote()}</div>"],
  ["const total=Object.values(TPL_STATE).reduce((a,b)=>a+b.used,0);", "const total=Object.values(TPL_STATE).reduce((a,b)=>a+b.used,0)||1;"],
];

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
  for (const [from, to] of OA_REPLACEMENTS) h = replaceOnce(h, from, to, file);
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
  // sample figures → the server's numbers (or an honest "no data yet")
  ['const seriesOf = k => WEEKS12.map((w,i)=>({k:w, v:TREND[k][i]}));', 'const seriesOf = k => MDM.series(k);'],
  ['const ACCEPTED=1051, needed=Math.ceil(ACCEPTED/CFG.maxBook), covered=S.sellers.length;',
    'const ACCEPTED=MDM.accepted(), needed=Math.ceil(ACCEPTED/CFG.maxBook), covered=MDM.covered();'],
  ['const c=capacity(ME), ACCEPTED=1051;', 'const c=capacity(ME), ACCEPTED=MDM.accepted();'],
  ["const cohorts=[['Mar','May',96,88,79,71],['Apr','Jun',94,85,77,0],['May','Jul',97,90,0,0],['Jun','Aug',95,0,0,0]];", 'const cohorts=MDM.cohorts();'],
  ["const loss=[['Capacity on the seller side — went back to a physical shop only',9],\n    ['Return rate never came down',7],['Cash flow — could not fund stock',5],\n    ['Moved to a competitor on price',4],['Unresolved support experience',3],['Unreachable — no response to the save campaign',6]];",
    'const loss=MDM.churnReasons();'],
  ["<div>Captured on the save-campaign task when it closes. Two of the six reasons — returns and support experience — are\n        things the platform controls, and together they are ${Math.round((loss.find(l=>l[0].includes('Return'))[1]+loss.find(l=>l[0].includes('support'))[1])/sum(loss.map(l=>l[1]))*100)}% of the churn.</div>",
    '<div>${MDM.churnNote()}</div>'],
  ["<div>The drop happens between month two and month three, not at the start — which is exactly when the 30-day playbook stops\n        and nothing structured replaces it. A day-60 review is the obvious next step and does not exist yet.</div>",
    '<div>${MDM.cohortNote()}</div>'],
  ['${p.nrr}%</span>', '${MDM.pct(p.nrr)}</span>'],
  ['${p.respH} h</span>', "${p.respH===null?'—':p.respH+' h'}</span>"],
  ['<div class="val num">${P.nrr}%</div>', '<div class="val num">${MDM.pct(P.nrr)}</div>'],
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
