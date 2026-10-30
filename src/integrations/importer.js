// Zoho CRM import (CSV or Excel export). Two kinds:
//   • leads   — open onboarding leads. Each row goes through registerMerchant, so capture (r1),
//               capacity-based assignment and the holding queue apply exactly as for a live
//               registration. Rows closed in Zoho (junk, lost, converted) are not reopened.
//   • sellers — the existing seller book: contact + seller record + platform mirror. Ownership
//               is kept from Zoho only when the named account manager covers the seller's market
//               and has room; otherwise same market, smallest book (AM 3.2, no cross-market
//               fallback). Only a seller activated in the last 14 days with no welcome call goes
//               through the full handover (r1 welcome task). Health and stage are never imported.
//
// Every import runs as a dry run first (a plan, per row, nothing written) and is committed as a
// second call. A committed run is one IntegrationRun plus one audit entry with every row's result.
import ExcelJS from 'exceljs';
import { prisma } from '../db.js';
import { getLiveConfig } from '../config/service.js';
import { normalizePhone } from '../core/contacts.js';
import { badRequest } from '../http/errors.js';
import { logEvent } from '../services/audit.js';
import { registerMerchant } from '../oa/service.js';
import { handover, pickAccountManager } from '../am/handover.js';
import { countryFromPhone } from './phone.js';
import { applyMirror, mirrorData } from './mirror.js';

const MAX_ROWS = 5000;
const WELCOME_WINDOW_DAYS = 14; // an imported seller activated this recently with no welcome call still gets one

// Zoho column names (and common variants) → our field.
const ALIASES = {
  name: ['full name', 'lead name', 'contact name', 'name', 'account name', 'store name', 'business name', 'seller name'],
  firstName: ['first name'], lastName: ['last name'],
  phone: ['mobile', 'phone', 'phone number', 'mobile number', 'whatsapp', 'whatsapp number'],
  country: ['country', 'market', 'mailing country', 'billing country'],
  source: ['lead source', 'source', 'utm source', 'utm', 'campaign'],
  status: ['lead status', 'status', 'stage'],
  mdmRef: ['seller id', 'mdm id', 'mdm ref', 'seller ref', 'account number'],
  accountManager: ['account manager', 'account owner', 'owner', 'lead owner', 'am', 'am email'],
  activatedAt: ['activated', 'activation date', 'activated at', 'created time', 'join date'],
  welcomeCallAt: ['welcome call', 'welcome call date'],
  totalOrders: ['total orders', 'orders'], deliveryRate: ['delivery rate', 'delivery %'], returnRate: ['return rate', 'returns %'],
  cancelRate: ['cancel rate', 'cancellation rate'], wallet: ['wallet', 'wallet balance'], products: ['products', 'product count'],
  lastOrderAt: ['last order', 'last order date'], weeklyOrders: ['weekly orders', 'orders by week'],
};
const COUNTRY = { libya: 'LY', ly: 'LY', 'ليبيا': 'LY', iraq: 'IQ', iq: 'IQ', 'العراق': 'IQ', lebanon: 'LB', lb: 'LB', 'لبنان': 'LB' };
const CLOSED = /junk|lost|not qualified|disqualified|converted|do not contact|duplicate/i;

/** RFC 4180 CSV (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  const s = text.replace(/^\uFEFF/, '');
  const firstLine = s.slice(0, s.search(/\r?\n|$/));
  const sep = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ','; // Excel in some locales exports ';'
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = r.getCell(c).value;
      vals.push(v instanceof Date ? v.toISOString() : v && typeof v === 'object' ? (v.text ?? v.result ?? String(v)) : v == null ? '' : String(v));
    }
    rows.push(vals);
  });
  return rows;
}

/** Decode an uploaded file into objects keyed by our field names. */
export async function readRows({ filename = '', contentBase64 }) {
  if (!contentBase64) throw badRequest('contentBase64 is required (the file, base64-encoded).');
  const buf = Buffer.from(contentBase64, 'base64');
  const isXlsx = /\.xlsx$/i.test(filename) || buf.subarray(0, 2).toString() === 'PK';
  const table = isXlsx ? await parseXlsx(buf) : parseCsv(buf.toString('utf8'));
  if (table.length < 2) throw badRequest('The file has no data rows.');
  if (table.length - 1 > MAX_ROWS) throw badRequest(`At most ${MAX_ROWS} rows per import.`);
  const header = table[0].map((h) => String(h).trim().toLowerCase());
  const col = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const i = header.findIndex((h) => names.includes(h));
    if (i >= 0) col[field] = i;
  }
  const unmapped = table[0].filter((_, i) => !Object.values(col).includes(i));
  const rows = table.slice(1).map((r, i) => {
    const o = { _row: i + 2 };
    for (const [field, idx] of Object.entries(col)) o[field] = String(r[idx] ?? '').trim();
    if (!o.name && (o.firstName || o.lastName)) o.name = `${o.firstName ?? ''} ${o.lastName ?? ''}`.trim();
    return o;
  });
  return { rows, columns: Object.keys(col), unmapped };
}

const marketOf = (row, phone) => COUNTRY[String(row.country || '').toLowerCase()] ?? (/^(LY|IQ|LB)$/i.test(row.country) ? row.country.toUpperCase() : countryFromPhone(phone));
const dateOr = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

async function planLead(row, seen, db) {
  let phone;
  try { phone = normalizePhone(row.phone); } catch { return { row: row._row, action: 'skip', reason: 'No valid phone number.' }; }
  if (seen.has(phone)) return { row: row._row, action: 'skip', reason: 'Duplicate phone within the file.' };
  seen.add(phone);
  const market = marketOf(row, phone);
  if (!market) return { row: row._row, action: 'skip', reason: 'Market is not Libya, Iraq or Lebanon.' };
  if (CLOSED.test(row.status || '')) return { row: row._row, action: 'skip', reason: `Closed in Zoho (${row.status}) — not reopened as a lead.` };
  const existing = await db.contact.findUnique({ where: { phone } });
  if (existing) return { row: row._row, action: 'skip', reason: existing.contactType === 'merchant' ? 'Already a contact here.' : 'Already a seller here.' };
  return { row: row._row, action: 'create_lead', phone, market, name: row.name || phone, source: row.source || 'zoho_import' };
}

async function planSeller(row, seen, ctx, db) {
  let phone;
  try { phone = normalizePhone(row.phone); } catch { return { row: row._row, action: 'skip', reason: 'No valid phone number.' }; }
  if (seen.has(phone)) return { row: row._row, action: 'skip', reason: 'Duplicate phone within the file.' };
  seen.add(phone);
  const market = marketOf(row, phone);
  if (!market) return { row: row._row, action: 'skip', reason: 'Market is not Libya, Iraq or Lebanon.' };
  const mirror = mirrorData({
    totalOrders: row.totalOrders, deliveryRate: row.deliveryRate, returnRate: row.returnRate, cancelRate: row.cancelRate,
    wallet: row.wallet, products: row.products, lastOrderAt: row.lastOrderAt, weeklyOrders: row.weeklyOrders,
  });
  if (mirror.errors.length) return { row: row._row, action: 'skip', reason: mirror.errors.join(' ') };
  const existingContact = await db.contact.findUnique({ where: { phone }, include: { seller: true } });
  if (existingContact?.seller) return { row: row._row, action: 'update_mirror', sellerId: existingContact.seller.id, mirror: mirror.data, reason: 'Seller exists — platform figures updated, ownership unchanged.' };
  const mdmRef = row.mdmRef || `ZOHO-${phone.replace(/\D/g, '')}`;
  if (await db.seller.findUnique({ where: { mdmRef } })) return { row: row._row, action: 'skip', reason: `Seller ID ${mdmRef} already belongs to another contact.` };
  // ownership: keep the Zoho owner only when they cover this market and have room
  let managerId = null; let ownership;
  const named = row.accountManager && ctx.managers.find((m) => [m.email.toLowerCase(), m.name.toLowerCase()].includes(row.accountManager.toLowerCase()));
  if (named && JSON.parse(named.markets).includes(market) && ctx.books.get(named.id) < ctx.maxBook) {
    managerId = named.id; ctx.books.set(named.id, ctx.books.get(named.id) + 1); ownership = `Kept with ${named.name} (Zoho owner).`;
  } else {
    ownership = row.accountManager
      ? `${row.accountManager} ${named ? (JSON.parse(named.markets).includes(market) ? 'is at the book ceiling' : `does not cover ${market}`) : 'is not a user here'} — assigned by the handover rule.`
      : 'Assigned by the handover rule (same market, smallest book).';
  }
  return { row: row._row, action: 'create_seller', phone, market, name: row.name || phone, mdmRef, managerId, ownership,
    activatedAt: dateOr(row.activatedAt) ?? new Date(), welcomeCallAt: dateOr(row.welcomeCallAt), mirror: mirror.data };
}

export async function runImport(user, { kind, filename, contentBase64, dryRun = true }, db = prisma) {
  if (!['leads', 'sellers'].includes(kind)) throw badRequest('kind must be "leads" or "sellers".');
  const { rows, columns, unmapped } = await readRows({ filename, contentBase64 });
  if (!columns.includes('phone')) throw badRequest('No phone column found (expected "Mobile", "Phone" or "WhatsApp").');
  const { values: c } = await getLiveConfig(db);
  const managers = await db.user.findMany({ where: { role: 'ACCOUNT_MANAGER', active: true } });
  const books = new Map(await Promise.all(managers.map(async (m) => [m.id, await db.seller.count({ where: { assignedAccountManagerId: m.id } })])));
  const ctx = { managers, books, maxBook: c['am.maxBook'] };
  const seen = new Set();
  const plan = [];
  for (const row of rows) plan.push(kind === 'leads' ? await planLead(row, seen, db) : await planSeller(row, seen, ctx, db));
  const count = (a) => plan.filter((p) => p.action === a).length;
  const summary = { kind, filename, rows: rows.length, columns, unmapped, create: count('create_lead') + count('create_seller'), update: count('update_mirror'), skip: count('skip') };
  if (dryRun) return { dryRun: true, summary, plan };

  const run = await db.integrationRun.create({ data: { kind: 'zoho_import', status: 'running', actorId: user.id } });
  const results = [];
  for (const p of plan) {
    if (p.action === 'skip') { results.push({ row: p.row, ok: false, skipped: true, reason: p.reason }); continue; }
    try {
      if (p.action === 'create_lead') {
        const r = await registerMerchant({ phone: p.phone, name: p.name, country: p.market, sourceUtm: p.source }, {}, db);
        await db.contact.update({ where: { id: r.contact.id }, data: { legacy: true } });
        results.push({ row: p.row, ok: true, contactId: r.contact.id, ticketId: r.ticket?.id ?? null, assigned: !!r.ticket?.assigneeId });
      } else if (p.action === 'update_mirror') {
        await applyMirror(p.sellerId, p.mirror, db);
        results.push({ row: p.row, ok: true, sellerId: p.sellerId, updated: Object.keys(p.mirror) });
      } else {
        const contact = await db.contact.create({ data: { phone: p.phone, name: p.name, country: p.market, contactType: 'seller', sourceUtm: 'zoho_import', ownerAgentId: p.managerId, legacy: true } });
        await db.conversation.create({ data: { contactId: contact.id } });
        const seller = await db.seller.create({
          data: { mdmRef: p.mdmRef, contactId: contact.id, market: p.market, joinStatus: 'accepted', activatedAt: p.activatedAt, welcomeCallAt: p.welcomeCallAt,
            healthStale: true, lastSyncedAt: new Date(), ...p.mirror },
        });
        let ownership = p.ownership;
        const recent = !p.welcomeCallAt && Date.now() - p.activatedAt.getTime() < WELCOME_WINDOW_DAYS * 86_400_000;
        if (!p.managerId && recent) {
          // Activated recently and never welcomed: this is a real handover (r1 opens the welcome task).
          const h = await handover(seller.id, { config: c }, db);
          ownership = h.assigned ? `Assigned by the handover rule to ${h.managerName}; welcome call task opened.` : `Not assigned: ${h.reason}`;
        } else {
          // An established seller joining the book: same market, smallest book (AM 3.2), but no welcome task.
          const pick = p.managerId ? { manager: ctx.managers.find((m) => m.id === p.managerId) } : await pickAccountManager(p.market, c, db);
          if (pick.manager) {
            await db.seller.update({ where: { id: seller.id }, data: { assignedAccountManagerId: pick.manager.id } });
            await db.contact.update({ where: { id: contact.id }, data: { ownerAgentId: pick.manager.id } });
            if (pick.manager.businessNumber) await db.conversation.updateMany({ where: { contactId: contact.id }, data: { businessNumber: pick.manager.businessNumber } });
            await logEvent({ actorId: user.id, entityType: 'seller', entityId: seller.id, action: 'SELLER_ASSIGNED', after: { assignedAccountManagerId: pick.manager.id, via: 'zoho_import' }, reason: ownership }, db);
            if (!p.managerId) ownership = `Assigned to ${pick.manager.name} (same market, smallest book).`;
          } else ownership = `Not assigned: ${pick.reason}`;
        }
        results.push({ row: p.row, ok: true, sellerId: seller.id, ownership });
      }
    } catch (err) {
      results.push({ row: p.row, ok: false, reason: err.message });
    }
  }
  const done = { ...summary, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok && !r.skipped).length, results };
  await db.integrationRun.update({ where: { id: run.id }, data: { status: 'completed', finishedAt: new Date(), summary: JSON.stringify(done) } });
  await logEvent({ actorId: user.id, entityType: 'bulk', entityId: `import:${run.id}`, action: `import.zoho_${kind}`, after: done, reason: filename || null }, db);
  return { dryRun: false, runId: run.id, summary: done };
}

