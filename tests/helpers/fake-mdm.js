// A stand-in for the MDM platform API (shapes from its OpenAPI spec), for the connector tests.
// sellers: platform seller records; orders: { sellerId: count }; managers: platform AMs.
export function fakeMdm({ sellers = [], orders = {}, managers = [], wallets = {}, fail = null } = {}) {
  const calls = [];
  const page = (list, body) => {
    const { page: p = 1, perPage = 100 } = body?.pagination ?? {};
    const slice = list.slice((p - 1) * perPage, p * perPage);
    return { list: slice, pagination: { page: p, perPage, total: list.length, hasMore: p * perPage < list.length } };
  };
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method: opts.method, path: u.pathname, query: u.search, key: opts.headers['x-api-key'], body, headers: opts.headers });
    const reply = (status, json) => ({ ok: status < 300, status, json: async () => json });
    const forced = fail?.(opts.method, u.pathname, body);
    if (forced) return reply(forced, { error: { code: 'x', message: `forced ${forced}` } });
    if (u.pathname === '/api/sellers/search') {
      const sorted = [...sellers].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      return reply(200, page(sorted, body));
    }
    if (u.pathname.startsWith('/api/sellers/') && opts.method === 'GET') {
      return reply(200, sellers.find((s) => s.trackingId === decodeURIComponent(u.pathname.split('/')[3])) ?? {});
    }
    if (u.pathname === '/api/v2/orders/search') {
      const f = body.filters ?? {};
      if (f.updatedAt) {
        const list = Object.entries(orders).filter(([, n]) => n).map(([id]) => ({ trackingId: `o-${id}`, seller: { trackingId: id }, createdAt: '2026-10-29T10:00:00Z' }));
        return reply(200, page(list, body));
      }
      const id = f.sellerId?.[0]; const n = orders[id] ?? 0;
      const total = f.createdAt ? (n ? 1 : 0) : n;
      return reply(200, { list: total ? [{ trackingId: 'o1', seller: { trackingId: id }, createdAt: '2026-10-29T10:00:00Z' }] : [], pagination: { page: 1, perPage: 1, total, hasMore: false } });
    }
    if (u.pathname === '/api/v2/orders/statistics/statuses') {
      return reply(200, { list: [{ status: 'delivered', total: 80 }, { status: 'returned', total: 15 }, { status: 'cancelled', total: 5 }], pagination: {} });
    }
    if (u.pathname === '/api/finance/seller-payments/wallets/search') {
      const id = body.filters.sellerId?.[0];
      return reply(200, page(id in wallets ? [{ seller: { trackingId: id }, ready: wallets[id], notReady: 0, paid: 0 }] : [], body));
    }
    if (u.pathname === '/api/omni-channel/account-managers/search') return reply(200, page(managers, body));
    if (u.pathname.startsWith('/api/omni-channel/account-managers/sellers/')) return reply(200, { sellerId: u.pathname.split('/').pop(), accountManagerId: body.accountManagerId });
    if (/^\/api\/sellers\/[^/]+\/join\//.test(u.pathname)) return reply(200, { trackingId: u.pathname.split('/')[3] });
    return reply(404, { error: { code: 'not_found', message: 'no route' } });
  };
  return { fetchImpl, calls };
}

export const mdmSeller = (id, phone, extra = {}) => ({
  trackingId: id, firstName: extra.firstName ?? id, lastName: '', phones: [phone],
  country: { id: 'c-ly', name: 'Libya', code: 'LY' }, joinStatus: 'pending', joinStatusDate: '2026-10-30T00:00:00Z',
  createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', utm: { utmSource: 'fb_ads' }, accountManager: null, ...extra,
});
