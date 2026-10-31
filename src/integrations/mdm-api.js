// The client's MDM platform API (https://api.mdm.express; OpenAPI served at /api/docs/swagger).
// Only the endpoints this app needs, with the request and response shapes from that spec:
//   • POST /api/sellers/search                      → { list: Seller[], pagination }
//       Seller: trackingId, firstName, lastName, phones[], country {id, code}, joinStatus,
//       joinStatusDate, accountManager {trackingId}, utm {utmSource}, createdAt, updatedAt
//   • POST /api/v2/orders/search                     → { list: Order[], pagination }   filters.sellerId, createdAt, updatedAt
//   • GET  /api/v2/orders/statistics/statuses        → { list: [{ status, total }] }   query sellerId, createdAt
//   • POST /api/finance/seller-payments/wallets/search → { list: [{ seller, ready, notReady, paid }] }
//       needs filters.countryId and the x-payment-password header
//   • POST /api/omni-channel/account-managers/search  → { list: [{ trackingId, email, … }] }
//   • POST /api/omni-channel/account-managers/sellers/{sellerId}  { accountManagerId }
//   • PATCH /api/sellers/{id}/join/not-answer | followup | missing-documents  { notes }
// Every list call pages with pagination { page, perPage }. Auth: x-api-key.
// Health and lifecycle stage are never read from the platform: they are derived here (AC-03).
const WEEK = 7 * 86_400_000;

export const PATHS = {
  sellers: '/api/sellers/search',
  orders: '/api/v2/orders/search',
  statuses: '/api/v2/orders/statistics/statuses',
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

/** Order status totals → rates in %. */
export function ratesFromStatuses(body) {
  const pairs = (body?.list ?? []).map((r) => [String(r.status ?? ''), Number(r.total ?? 0)]);
  const sum = (re) => pairs.filter(([k]) => re.test(k)).reduce((a, [, n]) => a + n, 0);
  const all = pairs.reduce((a, [, n]) => a + n, 0);
  if (!all) return {};
  const pct = (n) => Math.round((n / all) * 1000) / 10;
  return { deliveryRate: pct(sum(/deliver|livr/i)), returnRate: pct(sum(/return|retour/i)), cancelRate: pct(sum(/cancel|annul/i)) };
}

/** The platform figures for one seller: 8 weeks of orders, rates, lifetime orders, last order, wallet. */
export async function sellerMetrics(api, sellerId, { now = new Date(), countryId = null } = {}) {
  const id = String(sellerId);
  const weeklyOrders = [];
  for (let w = 7; w >= 0; w--) {
    const end = new Date(now.getTime() - w * WEEK); const start = new Date(end.getTime() - WEEK);
    weeklyOrders.push(await api.count(PATHS.orders, { sellerId: [id], createdAt: { start: start.toISOString(), end: end.toISOString() } }));
  }
  const q = new URLSearchParams({ sellerId: id, 'createdAt[start]': new Date(now.getTime() - 8 * WEEK).toISOString(), 'createdAt[end]': now.toISOString() });
  const rates = ratesFromStatuses(await api.call('GET', PATHS.statuses, { query: q.toString() }));
  const totalOrders = await api.count(PATHS.orders, { sellerId: [id] });
  const last = totalOrders ? await api.first(PATHS.orders, { filters: { sellerId: [id] }, sortBy: { createdAt: 'DESC' } }) : null;
  const out = { weeklyOrders, ...rates, totalOrders, lastOrderAt: dateOf(last?.createdAt) };
  if (api.paymentPassword && countryId) {
    const w = await api.first(PATHS.wallets, { filters: { countryId, sellerId: [id] }, headers: { 'x-payment-password': api.paymentPassword } });
    if (w) out.wallet = Number(w.ready ?? 0);
  }
  return out;
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
