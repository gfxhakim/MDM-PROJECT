// The "From MDM" card (HAKIM, 2 Nov: "each one has his own data in mdm … grab it with every piece
// of data"). Read-only: every field MDM sent for the merchant — the seller record, its stores, its
// own team members and, for roles that see cost, what MDM charges it per country — or for a person
// on MDM. Shown exactly as MDM sent it; changes are made on MDM. The server checks the scope (a
// foreign merchant is not-found) and leaves the fees out for roles without "See cost / fee / margin".
/* global API */
(function () {
  const cache = new Map(); // key → { state: 'loading' | 'ok' | 'error', data, error }
  const open = new Set(); // sections the person opened, kept across re-renders

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const label = (k) => {
    let t = String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
    t = t.replace(/\bid\b/g, 'ID').replace(/\butm\b/g, 'UTM').replace(/\bcod\b/g, 'COD');
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  const when = (v) => new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length);

  function value(v) {
    if (empty(v)) return '<span class="muted">—</span>';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'string' && ISO.test(v)) return `<span data-i18n="off" dir="ltr" class="num">${esc(when(v))}</span>`;
    // dir="auto": a phone number or an e-mail reads left to right inside the Arabic page
    if (Array.isArray(v)) return `<span data-i18n="off" dir="auto">${esc(v.join(', '))}</span>`;
    return `<span data-i18n="off" dir="auto">${esc(v)}</span>`;
  }

  // one object, every field: plain values as rows, objects and lists of objects as nested blocks
  function rows(obj, depth = 0) {
    const out = [];
    for (const [k, v] of Object.entries(obj || {})) {
      if (k.startsWith('_')) continue;
      if (isObj(v)) out.push(`<div class="mdmrec-sub" style="margin:6px 0 6px ${depth ? 10 : 0}px;padding-inline-start:10px;border-inline-start:2px solid var(--line)">
        <div class="eyebrow" style="margin:6px 0 2px">${esc(label(k))}</div>${rows(v, depth + 1)}</div>`);
      else if (Array.isArray(v) && v.some(isObj)) {
        out.push(`<div class="eyebrow" style="margin:8px 0 2px">${esc(label(k))}</div>`);
        v.forEach((item, i) => out.push(`<div class="mdmrec-sub" style="margin:4px 0;padding-inline-start:10px;border-inline-start:2px solid var(--line)">
          <div class="tiny muted" style="margin:4px 0">${esc(label(k))} ${i + 1}</div>${isObj(item) ? rows(item, depth + 1) : value(item)}</div>`));
      } else out.push(`<div class="kv"><span class="k">${esc(label(k))}</span><span class="v" style="max-width:62%;text-align:end;word-break:break-word">${value(v)}</span></div>`);
    }
    return out.join('');
  }

  function section(key, title, n, body) {
    const id = `${key}:${title}`;
    return `<details class="mdmrec-sec" ${open.has(id) ? 'open' : ''} ontoggle="MDMREC.toggled('${esc(id)}', this.open)" style="border-top:1px solid var(--line);padding:8px 0">
      <summary style="cursor:pointer;font-weight:700;font-size:13px">${n == null ? title : `${title} (${n})`}</summary>
      <div style="margin-top:6px">${body}</div></details>`;
  }

  function merchantBody(key, d) {
    if (!d.mdmRef) return '<div class="tiny muted">Not from MDM — this merchant has no MDM id.</div>';
    const head = `<div class="kv"><span class="k">MDM seller ID</span><span class="v num" data-i18n="off" dir="ltr">${esc(d.mdmRef)}</span></div>`;
    if (!d.seller && !d.stores.length && !d.teamMembers.length) return `${head}<div class="tiny muted" style="margin-top:6px">MDM has not sent this merchant's record yet — it comes with the next sync.</div>`;
    const list = (items, one) => (items.length ? items.map((x, i) => `<div class="eyebrow" style="margin:8px 0 2px">${one} ${i + 1}</div>${rows(x)}`).join('') : '<div class="tiny muted">None on MDM.</div>');
    return `${head}
      ${d.fetchedAt ? `<div class="kv"><span class="k">Updated at</span><span class="v">${value(d.fetchedAt)}</span></div>` : ''}
      ${section(key, 'The merchant on MDM', null, d.seller ? rows(d.seller) : '<div class="tiny muted">None on MDM.</div>')}
      ${section(key, 'Stores', d.stores.length, list(d.stores, 'Store'))}
      ${section(key, 'Team members', d.teamMembers.length, list(d.teamMembers, 'Team member'))}
      ${d.fees ? section(key, 'Fees by country', d.fees.length, d.fees.length ? d.fees.map((f) => rows(f)).join('<hr style="border:0;border-top:1px dashed var(--line)">') : '<div class="tiny muted">None on MDM.</div>')
        : '<div class="tiny muted" style="margin-top:8px">Cost, margin and settlement withheld</div>'}
      <div class="tiny muted" style="margin-top:8px">Everything MDM holds for this merchant, as MDM sent it. Changes are made on MDM.</div>`;
  }

  function personBody(key, d) {
    return `<div class="kv"><span class="k">Updated at</span><span class="v">${value(d.fetchedAt)}</span></div>
      ${section(key, 'The person on MDM', null, rows(d.user))}`;
  }

  function shell(key, body) {
    return `<div class="card" id="mdmrec-${esc(key)}">
      <div class="card-h"><h3>From MDM</h3><span class="sp"></span><span class="chip">read-only</span></div>${body}</div>`;
  }

  function draw(key, render) {
    const c = cache.get(key);
    if (!c || c.state === 'loading') return shell(key, '<div class="tiny muted">Loading what MDM holds…</div>');
    if (c.state === 'error') return shell(key, `<div class="tiny muted">${esc(c.error)}</div>`);
    return shell(key, render(key, c.data));
  }

  function load(key, url, render) {
    if (cache.has(key)) return;
    cache.set(key, { state: 'loading' });
    API.get(url).then((data) => cache.set(key, { state: 'ok', data }), (e) => cache.set(key, { state: 'error', error: e?.message || 'Could not read the MDM record.' }))
      .then(() => { const el = document.getElementById(`mdmrec-${key}`); if (el) el.outerHTML = draw(key, render); });
  }

  window.MDMREC = {
    /** The card for a lead (ticketId), a seller (sellerId) or a contact (contactId). */
    merchant(kind, id) {
      const key = `${kind}-${id}`;
      load(key, `/api/mdm/record?${kind}=${encodeURIComponent(id)}`, merchantBody);
      return draw(key, merchantBody);
    },
    /** The card for a person on MDM (People on MDM, Admin). */
    person(mdmRef) {
      const key = `user-${mdmRef}`;
      load(key, `/api/integrations/mdm/staff/${encodeURIComponent(mdmRef)}/record`, personBody);
      return draw(key, personBody);
    },
    toggled(id, isOpen) { if (isOpen) open.add(id); else open.delete(id); },
    /** Read again after a sync or an action (the next draw fetches). */
    forget() { cache.clear(); },
  };
})();
