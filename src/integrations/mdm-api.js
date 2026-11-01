// The client's MDM platform API (https://api.mdm.express; OpenAPI served at /api/docs/swagger).
// Only the endpoints this app needs, with the request and response shapes from that spec:
//   • POST /api/sellers/search                      → { list: Seller[], pagination }
//       Seller: trackingId, firstName, lastName, phones[], country {id, code}, joinStatus,
//       joinStatusDate, accountManager {trackingId}, utm {utmSource}, createdAt, updatedAt
//   • POST /api/v2/orders/search                     → { list: Order[], pagination }   filters.sellerId, createdAt, updatedAt
//   • POST /api/analytics/orders/sellers-status/search → { list: [{ seller {trackingId}, countryId, delivered, returned,
//       cancelled, totalLeads, totalParcels, totalParcelsWithoutLead, … }] }   filters.sellerId, date
//       MDM's own reporting row per seller and market. The delivery, return and cancel rates are read from
//       it (AM spec 1.2, OA spec 11.4: the platform computes these figures; this module only reads them).
//   • POST /api/finance/seller-payments/wallets/search → { list: [{ seller, ready, notReady, paid }] }
//       needs filters.countryId and the x-payment-password header
//   • POST /api/omni-channel/account-managers/search  → { list: [{ trackingId, email, … }] }
//   • POST /api/omni-channel/account-managers/sellers/{sellerId}  { accountManagerId }
//   • PATCH /api/sellers/{id}/join/not-answer | followup | missing-documents  { notes }
// Every list call pages with pagination { page, perPage }. Auth: x-api-key.
// Health and lifecycle stage are never read from the platform: they are derived here (AC-03).
const WEEK = 7 * 86_400_000;
const RATE_WINDOW_WEEKS = 8; // the AM prototype's "The numbers · last 8 weeks" card: delivery, returns, cancelled

export const PATHS = {
  sellers: '/api/sellers/search',
  orders: '/api/v2/orders/search',
  sellerReporting: '/api/analytics/orders/sellers-status/search',
  wallets: '/api/finance/seller-payments/wallets/search',
  managers: '/api/omni-channel/account-managers/search',
  assignManager: (sellerId) => `/api/omni-channel/account-managers/sellers/${encodeURIComponent(sellerId)}`,
  join: (sellerId, kind) => `/api/sellers/${encodeURIComponent(sellerId)}/join/${kind}`,
};

const dateOf = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

export class MdmApiError extends Error {
  constructor(status, method, path, body) {
    super(`MDM API ${method} ${path} responded ${status}${body?.error?.message ? `: ${body.error.message}` : ''}`);
    this.status = status;
  }
}

export function client({ url, apiKey, paymentPassword = null, fetchImpl = fetch }) {
  const call = async (method, path, { body, query, headers = {} } = {}) => {
    const qs = query ? `?${query}` : '';
    const res = await fetchImpl(`${url}${path}${qs}`, {
      method,
      headers: { 'x-api-key': apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new MdmApiError(res.status, method, path, json);
    return json;
  };
  const page = (path, { filters, sortBy, headers } = {}, p = 1, perPage = 100) =>
    call('POST', path, { body: { ...(filters ? { filters } : {}), ...(sortBy ? { sortBy } : {}), pagination: { page: p, perPage } }, headers });
  return {
    call,
    /** Every item of a search endpoint, page by page. */
    async *search(path, opts = {}, perPage = 100, maxPages = 1000) {
      for (let p = 1; p <= maxPages; p++) {
        const body = await page(path, opts, p, perPage);
        for (const item of body?.list ?? []) yield item;
        if (!body?.pagination?.hasMore) return;
      }
    },
    /** How many records a search matches, without reading them. */
    async count(path, filters) {
      return Number((await page(path, { filters }, 1, 1))?.pagination?.total) || 0;
    },
    async first(path, opts) {
      return (await page(path, opts, 1, 1))?.list?.[0] ?? null;
    },
    paymentPassword,
  };
}

/** A platform seller → the row upsertFromMdm expects. */
export function sellerToRow(s) {
  return {
    mdmRef: s.trackingId,
    phone: s.phones?.[0] ?? null,
    name: [s.firstName, s.lastName].filter(Boolean).join(' ').trim() || null,
    country: s.country?.code ?? null,
    countryId: s.country?.id ?? null,
    joinStatus: s.joinStatus ?? null,
    joinStatusDate: dateOf(s.joinStatusDate),
    createdAt: dateOf(s.createdAt),
    updatedAt: dateOf(s.updatedAt),
    utm: s.utm?.utmSource ?? null,
    accountManagerRef: s.accountManager?.trackingId ?? null,
  };
}

// joinStatus values are not enumerated in the spec (GET /api/sellers/metadata lists them at run
// time), so they are read by meaning.
export const isAccepted = (status) => /accept|approv|activ/i.test(status ?? '');
export const isRejected = (status) => /reject|refus|declin/i.test(status ?? '');

/**
 * MDM's reporting rows for one seller (one row per market) → delivery, return and cancel rates in %,
 * markets served, and the counts behind them.
 * The platform publishes no rate fields, only its counts per seller — delivered, returned, cancelled
 * and the orders they came out of (totalLeads + totalParcelsWithoutLead) — so each rate is that count
 * over the orders of the window. The spec does not state the denominator; the counts are kept in
 * `inputs` (AM 4.6: a score is stored with the inputs that produced it) so the basis can be changed
 * without re-reading the platform. No orders in the window → no rates ("no parcels yet").
 */
export function ratesFromReporting(rows, { window = null } = {}) {
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const sum = (k) => rows.reduce((a, r) => a + n(r?.[k]), 0);
  const inputs = {
    window, delivered: sum('delivered'), returned: sum('returned'), cancelled: sum('cancelled'),
    totalLeads: sum('totalLeads'), totalParcels: sum('totalParcels'), totalParcelsWithoutLead: sum('totalParcelsWithoutLead'),
    markets: [...new Set(rows.filter((r) => n(r?.totalLeads) + n(r?.totalParcels) > 0).map((r) => String(r.countryId ?? '')).filter(Boolean))],
  };
  inputs.orders = inputs.totalLeads + inputs.totalParcelsWithoutLead;
  const marketsServed = Math.max(1, inputs.markets.length);
  if (!inputs.orders) return { rates: null, inputs, marketsServed };
  const pct = (x) => Math.round((x / inputs.orders) * 1000) / 10;
  const rates = { deliveryRate: pct(inputs.delivered), returnRate: pct(inputs.returned), cancelRate: pct(inputs.cancelled) };
  if (Object.values(rates).some((v) => v > 100)) {
    return { rates: null, inputs, marketsServed, problem: `the platform's counts do not add up (${inputs.delivered} delivered, ${inputs.returned} returned, ${inputs.cancelled} cancelled out of ${inputs.orders} orders)` };
  }
  return { rates, inputs, marketsServed };
}

/**
 * The platform figures for one seller: 8 weeks of orders, the reporting rates, lifetime orders,
 * last order, wallet.
 * Best effort: each figure is fetched on its own, so one refused call (a permission the key lacks,
 * a filter the platform rejects) leaves that figure out instead of losing the seller. The reasons
 * come back in `warnings`.
 */
export async function sellerMetrics(api, sellerId, { now = new Date(), countryId = null } = {}) {
  const id = String(sellerId);
  const out = {}; const warnings = [];
  const attempt = async (what, fn) => { try { await fn(); } catch (err) { warnings.push(`${what}: ${err.message}`); } };
  await attempt('weekly orders', async () => {
    const weeklyOrders = [];
    for (let w = 7; w >= 0; w--) {
      const end = new Date(now.getTime() - w * WEEK); const start = new Date(end.getTime() - WEEK);
      weeklyOrders.push(await api.count(PATHS.orders, { sellerId: [id], createdAt: { start: start.toISOString(), end: end.toISOString() } }));
    }
    out.weeklyOrders = weeklyOrders;
  });
  // Delivery, return and cancel rates are read from MDM's reporting row for the seller, never
  // counted here. (The platform's GET /api/v2/orders/statistics/statuses answers 500 "syntax error
  // at or near $1" when filtered by seller, so it is not used.)
  await attempt('delivery, return and cancel rates', async () => {
    const window = { start: new Date(now.getTime() - RATE_WINDOW_WEEKS * WEEK).toISOString(), end: now.toISOString() };
    const rows = [];
    for await (const r of api.search(PATHS.sellerReporting, { filters: { sellerId: [id], date: window } })) {
      if (!r?.seller?.trackingId || String(r.seller.trackingId) === id) rows.push(r);
    }
    const { rates, inputs, marketsServed, problem } = ratesFromReporting(rows, { window });
    out.mirrorInputs = { rates: { ...inputs, readAt: now.toISOString() } };
    out.marketsServed = marketsServed;
    if (rates) Object.assign(out, rates);
    else if (problem) warnings.push(`delivery, return and cancel rates: left out — ${problem}`);
    else if ((out.weeklyOrders ?? []).some(Boolean)) warnings.push(`delivery, return and cancel rates: MDM reporting has no figures for this seller although it has orders in the last ${RATE_WINDOW_WEEKS} weeks — left unchanged`);
  });
  await attempt('total orders', async () => {
    out.totalOrders = await api.count(PATHS.orders, { sellerId: [id] });
    const last = out.totalOrders ? await api.first(PATHS.orders, { filters: { sellerId: [id] }, sortBy: { createdAt: 'DESC' } }) : null;
    out.lastOrderAt = dateOf(last?.createdAt);
  });
  if (api.paymentPassword && countryId) {
    await attempt('wallet', async () => {
      const w = await api.first(PATHS.wallets, { filters: { countryId, sellerId: [id] }, headers: { 'x-payment-password': api.paymentPassword } });
      if (w) out.wallet = Number(w.ready ?? 0);
    });
  }
  return { metrics: out, warnings };
}

/** sellerIds whose orders were created or changed since `since`. */
export async function sellersWithOrderChanges(api, since, now = new Date()) {
  const ids = new Set();
  for await (const o of api.search(PATHS.orders, { filters: { updatedAt: { start: since.toISOString(), end: now.toISOString() } } })) {
    if (o.seller?.trackingId) ids.add(String(o.seller.trackingId));
  }
  return ids;
}

/** Platform account managers, keyed by lower-case email. */
export async function managersByEmail(api) {
  const map = new Map();
  for await (const m of api.search(PATHS.managers, {})) if (m.email) map.set(m.email.toLowerCase(), m);
  return map;
}
