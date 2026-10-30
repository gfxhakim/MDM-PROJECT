// Account Manager console ⇄ API adapter.
// The prototype renders from S.sellers, TEAM, CFG, RULES, AUDIT and VERSIONS and derives health,
// stage, playbook gates and capacity in the browser. Here every one of those comes from the server:
// health and stage are the recompute job's output (never computed or written by a client — AC-03),
// gates are read live from the seller record (AC-14), and capacity is the server's rate model.
// Each action is an API call followed by a reload, so the console shows what the server decided.
/* global API, I18N, S, CFG, TEAM, ME, RULES, AUDIT, VERSIONS, BANDS, PB, TASKTYPE, MACROS, M, canEdit, health,
   render, toast, openModal, closeModal, seller, esc, ic, fmt, fmtT, ago, days, daysInactive, openTasks, renderTpl, band, book */
(function () {
  const COUNTRY = { LY: 'Libya', IQ: 'Iraq', LB: 'Lebanon' };
  const COLORS = ['#DC2626', '#0E7490', '#7C3AED', '#2B8A3E', '#B45309', '#E64980', '#1D4ED8', '#475569'];
  const STAGE = { 'Pending Activation': 'pending', New: 'new', Onboarding: 'onboarding', Activated: 'activated', Active: 'active',
    Growth: 'growth', Mature: 'mature', Recovering: 'atrisk', Churned: 'churned' };

  const X = { me: null, grants: {}, users: [], userById: new Map(), capacity: new Map(), version: null, values: {}, busy: false, raw: new Map() };
  window.MDM = X;

  const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const nameOf = (id) => (id ? X.userById.get(id)?.name ?? 'Unknown user' : 'Rule (automation)');
  const errText = (e) => e?.message || 'Something went wrong.';
  const fail = (e) => { console.error(e); toast(errText(e), 'warn'); };
  const first = (s) => String(s.owner || s.biz).split(' ')[0];
  const readKey = () => `mdm.am.readAlerts.${X.me?.id}`;
  const readAlerts = () => { try { return JSON.parse(localStorage.getItem(readKey()) || '[]'); } catch { return []; } };

  async function act(fn, okMsg) {
    if (X.busy) return;
    X.busy = true;
    try {
      await fn();
      await reload();
      if (okMsg) toast(okMsg, 'ok');
    } catch (e) {
      fail(e);
      await reload().catch(() => {});
    } finally {
      X.busy = false;
    }
  }

  // ───────────── mapping server → prototype ─────────────
  function msgOf(m, s) {
    const at = m.createdAt;
    if (m.kind === 'note') return { dir: 'out', ch: 'note', kind: 'note', body: m.body, at, by: nameOf(m.authorUserId) };
    if (m.kind === 'system') return { dir: 'out', ch: 'note', kind: 'sys', body: m.body, at };
    if (m.kind === 'call_event') return { dir: 'out', ch: 'voice', kind: 'call', body: m.body, at };
    if (m.kind === 'template') return { dir: 'out', ch: 'whatsapp', kind: 'tpl', body: m.templateKey, text: m.body, at, state: 'sent' };
    return { dir: m.direction, ch: s.channel, kind: 'text', body: m.body, at, state: m.direction === 'out' ? 'sent' : undefined };
  }

  function timelineOf(raw) {
    const tl = [];
    const T = (e, type, title, body) => tl.push({ at: e.createdAt, type, title, body: body || '', by: nameOf(e.actorId) });
    for (const e of raw.events) {
      const a = e.after ? JSON.parse(e.after) : {};
      const b = e.before ? JSON.parse(e.before) : {};
      switch (e.action) {
        case 'SELLER_ASSIGNED': T(e, 'assign', `Assigned to ${nameOf(a.assignedAccountManagerId ?? a.managerId)}`, 'Handover from Onboarding — same market, smallest book.'); break;
        case 'seller.reassigned': T(e, 'assign', `Reassigned to ${nameOf(a.assignedAccountManagerId)}`, `Previously ${nameOf(b.assignedAccountManagerId)}. ${e.reason || ''}`); break;
        case 'seller.call_logged': T(e, 'call', a.outcome === 'no_answer' ? 'Call — no answer' : a.outcome === 'escalate' ? 'Call completed — escalated' : a.outcome === 'partial' ? 'Call completed — follow-up needed' : 'Call completed', e.reason || ''); break;
        case 'seller.stage_changed': T(e, 'stage', `Stage → ${b.stage ? `${b.stage} → ` : ''}${a.stage}`, 'Derived by the nightly recompute — never set by hand.'); break;
        case 'playbook.ticked': T(e, 'task', `Playbook step completed — day ${a.day}`, `Gate: ${a.gate}`); break;
        case 'seller.churned': T(e, 'churn', 'Marked Churned', e.reason || ''); break;
        case 'seller.transfer_requested': T(e, 'assign', 'Transfer requested', e.reason || ''); break;
        default: break;
      }
    }
    for (const t of raw.tasks) {
      tl.push({ at: t.createdAt, type: 'task', title: `Task opened by ${t.ruleId ? (t.ruleId.startsWith('r10') ? 'the onboarding playbook' : `rule ${t.ruleId}`) : nameOf(t.createdById)}`, body: t.title, by: t.ruleId ? 'Rule (automation)' : '' });
      if (t.closedAt) tl.push({ at: t.closedAt, type: 'task', title: `Task completed — ${t.title}`, body: t.outcome || '' });
      if (t.escalatedAt) tl.push({ at: t.escalatedAt, type: 'escalate', title: `Escalated — ${t.escalation?.escalatesTo ?? 'next owner'}`, body: t.escalationReason || '' });
    }
    return tl.sort((x, y) => new Date(y.at) - new Date(x.at));
  }

  function taskOf(t) {
    const pb = /^r10:d(\d+)$/.exec(t.ruleId || '');
    return {
      id: t.id, type: t.taskType, title: t.title, why: t.why, prio: t.priority, createdAt: t.createdAt, dueAt: t.dueAt || t.createdAt,
      done: t.status !== 'open', doneAt: t.closedAt, outcome: t.outcome, ruleId: pb ? `pb_d${pb[1]}` : t.ruleId, alertKey: t.alertKey,
      escalated: t.escalated, upgraded: !!t.upgradedAt, can: t.can, minutes: t.minutes,
    };
  }

  function sellerOf(r, i) {
    const m = r.metrics;
    const weeks = Array.from({ length: 8 }, (_, k) => m.weeklyOrders[k] ?? 0);
    const rr = r.weeklyReturnRates || [];
    let high = 0;
    for (let k = rr.length - 1; k >= 0 && rr[k] > CFG.returnAlertPct; k--) high++;
    const country = COUNTRY[r.market] || r.market;
    const s = {
      id: r.id, code: r.mdmRef, biz: r.name, owner: r.name, country, city: '—', cat: '—', phone: r.phone,
      color: COLORS[i % COLORS.length], amId: r.assignedAccountManagerId, stage: STAGE[r.stage] || 'active', serverStage: r.stage,
      activatedAt: r.activatedAt, assignedAt: r.activatedAt, weeks, totalOrders: m.totalOrders,
      deliveryRate: m.deliveryRate, returnRate: m.returnRate, cancelRate: m.cancelRate, returnWeeksHigh: high,
      wallet: m.wallet, walletNegDays: m.walletNegativeDays, products: m.products,
      markets: [country].concat(Array.from({ length: Math.max(0, (m.marketsServed || 1) - 1) }, () => 'another market')),
      lastOrderAt: m.lastOrderAt, lastLoginAt: r.lastLoginAt || r.activatedAt, openTickets: r.openTickets,
      lastContactAt: r.lastContactAt || r.activatedAt, lastQbrAt: r.lastReviewAt, welcomeCallAt: r.welcomeCallAt,
      channel: r.conversation?.channel === 'portal' ? 'portal' : 'whatsapp', lastInboundAt: r.conversation?.lastInboundAt ?? null,
      convId: r.conversation?.id ?? null, contactId: r.contactId, health: r.health, playbook: r.playbook,
      msgs: [], tl: [], tasks: r.tasks.map(taskOf), readAlerts: readAlerts(),
      pb: Object.fromEntries(r.playbook.filter((p) => p.tickedAt).map((p) => [`d${p.day}`, true])),
    };
    s.msgs = (r.conversation?.messages || []).map((x) => msgOf(x, s));
    s.tl = timelineOf(r);
    return s;
  }

  // ───────────── derived values come from the server ─────────────
  const bandByLabel = (label) => BANDS.find((b) => b.label === label) || BANDS[0];
  window.healthOf = function (s) {
    const h = s.health || {};
    const score = h.score ?? 0;
    const comps = (h.components || []).map((c) => ({ k: c.key, label: c.label, w: c.weight, score: c.score ?? 0, why: c.why, off: !!c.off }));
    return { score, comps, band: h.band ? bandByLabel(h.band) : band(score) };
  };
  health = (s) => (s.health?.score ?? 0); // eslint-disable-line no-global-assign
  window.runRules = function () { const o = []; o.upgrades = 0; return o; }; // rules run on the server only
  window.pbState = function (s) {
    const age = Math.max(0, ago(s.activatedAt));
    return PB.map((p) => {
      const srv = (s.playbook || []).find((x) => `d${x.day}` === p.k);
      const done = !!s.pb[p.k];
      return { ...p, done, gateOk: srv ? srv.gateOpen : false, late: !done && age > p.day, now: !done && age <= p.day && age >= p.day - 1 };
    });
  };
  window.capacity = function (amId) {
    const c = X.capacity.get(amId);
    const bookList = S.sellers.filter((s) => s.amId === amId);
    if (!c) {
      return { book: bookList, shift: 0, reserved: 0, assignable: 0, baseline: 0, cadence: 0, taskMins: 0, committed: 0, free: 0, util: 0,
        headroom: CFG.maxBook - bookList.length, mix: { onb: 0, steady: 0, risk: 0, crit: 0 }, state: 'free', binding: 'time', slots: 0, slotsByTime: 0, perSeller: 0, openTasks: 0 };
    }
    const util = c.assignable ? c.committed / c.assignable : 0;
    return {
      book: bookList, shift: c.shift, reserved: c.reserved, assignable: c.assignable, baseline: c.baseline, cadence: c.cadence, taskMins: c.taskMins,
      committed: c.committed, free: c.free, util, headroom: c.headroom,
      mix: { onb: c.mix.onboarding, steady: c.mix.steady, risk: c.mix.atRisk, crit: c.mix.critical },
      state: util >= 1 ? 'full' : util >= 0.85 ? 'tight' : 'free', binding: c.binding, slots: c.slots, slotsByTime: c.slotsByTime, perSeller: c.perSeller,
      openTasks: bookList.reduce((n, s) => n + s.tasks.filter((t) => !t.done).length, 0),
    };
  };

  // ───────────── performance & analytics (server aggregates) ─────────────
  const protoPerfOf = window.perfOf;
  window.perfOf = function (id) {
    const P = X.analytics?.perf?.[id] || {};
    const base = protoPerfOf(id); // book-derived parts (retention, activation, welcome SLA, delivery now)
    const dq0 = P.dq0 ?? base.delivery; const cq0 = P.cq0 ?? base.cancel;
    return {
      ...base, nrr: P.nrr ?? null, deliveryDelta: base.delivery - dq0, cancelDelta: base.cancel - cq0,
      upgrades: P.upgrades ?? null, upgradePct: P.upgrades == null ? null : (base.book ? Math.round(P.upgrades / base.book * 100) : 0),
      expansions: P.expansions ?? 0, csat: P.csat ?? null, respH: P.respH ?? null,
      qbr: P.qbrDue ? Math.round(P.qbrDone / P.qbrDue * 100) : 100,
    };
  };
  window.kpiVal = (P, k) => (P[k] === null || P[k] === undefined ? '—' : P[k]);
  // A measure with no data source earns nothing and is shown as not wired — never as zero.
  const protoKpiPct = window.kpiPct;
  window.kpiPct = (r, v) => (typeof v === 'number' ? protoKpiPct(r, v) : 0);
  X.pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
  X.quality = (k) => X.analytics?.quality?.[k] ?? 0;
  X.accepted = () => X.analytics?.coverage?.acceptedSellers ?? S.sellers.length;
  X.covered = () => X.analytics?.coverage?.withManager ?? S.sellers.filter((s) => s.amId).length;
  X.series = (k) => { const t = X.analytics?.trend; if (!t) return []; return t.weeks.map((w, i) => ({ k: w, v: t[k]?.[i] })).filter((p) => typeof p.v === 'number'); };
  const protoTrend = window.trendChart;
  window.trendChart = function (series, opts) {
    if (!series || series.length < 2) {
      return `<div class="banner bn-slate tiny">${ic('chart', 14)}<div>The trend starts once the nightly recompute has run in two different weeks — it is built from those snapshots and never back-filled.</div></div>`;
    }
    return protoTrend(series, opts);
  };
  X.cohorts = () => [];
  X.cohortNote = () => 'Retention by cohort needs month-by-month order history from the MDM platform connector. Until it is connected the table stays empty rather than estimated.';
  X.churnReasons = () => [];
  X.churnNote = () => 'Churn reasons come from the save-campaign task outcome. That outcome is not yet structured (open decision D-04), so reasons are not counted — churn is marked by hand with a written reason in the audit trail.';

  // ───────────── load ─────────────
  async function reload() {
    const [bundle, users, capacity, cfg] = await Promise.all([
      API.get('/api/am/console'), API.get('/api/users'), API.get('/api/am/capacity').catch(() => []), API.get('/api/config'),
    ]);
    X.users = users; X.userById = new Map(users.map((u) => [u.id, u]));
    X.capacity = new Map(capacity.map((c) => [c.managerId, c]));
    X.values = cfg.values; X.version = cfg.version;
    for (const k of Object.keys(CFG)) if (`am.${k}` in cfg.values) CFG[k] = cfg.values[`am.${k}`];
    for (const r of RULES) { const k = `am.rule.${r.id}.enabled`; if (k in cfg.values) r.live = cfg.values[k]; }
    TEAM = users.filter((u) => u.role === 'ACCOUNT_MANAGER').map((u, i) => ({ // eslint-disable-line no-global-assign
      id: u.id, name: u.name, init: initials(u.name), color: COLORS[i % COLORS.length],
      country: COUNTRY[JSON.parse(u.markets || '[]')[0]] || '—', number: u.businessNumber || '—',
    }));
    S.sellers = bundle.sellers.map(sellerOf);
    X.analytics = await API.get('/api/am/analytics').catch(() => null);
    if (S.role === 'admin') await loadAdmin();
    render();
  }

  async function loadAdmin() {
    const [audit, versions] = await Promise.all([
      API.get('/api/admin/audit?limit=100').catch(() => []),
      API.get('/api/config/versions').catch(() => []),
    ]);
    AUDIT.length = 0;
    for (const e of audit) {
      AUDIT.push({ at: e.createdAt, who: e.actorId ? nameOf(e.actorId) : 'system',
        what: `${esc(e.action)} <code>${esc(e.entityType)} ${esc(String(e.entityId).slice(-8))}</code>${e.reason ? ' — ' + esc(e.reason) : ''}` });
    }
    VERSIONS.length = 0;
    for (const v of versions) {
      VERSIONS.push({ v: v.version, at: v.createdAt, by: nameOf(v.authorId), live: v.live, note: v.note || '',
        diff: Object.entries(v.diff).map(([k, d]) => [k.replace(/^am\./, ''), d.before, d.after]), state: null });
    }
  }

  // ───────────── identity & role ─────────────
  window.save = function () {};
  window.resetDemo = function () { reload().then(() => toast('Reloaded from the server', 'ok')); };
  canEdit = (s) => s.amId === ME; // eslint-disable-line no-global-assign
  const isHead = () => X.me.role === 'ADMIN'; // the Head of AM workspace (AM Appendix A: Admin)
  window.setRole = function (r) {
    if (r === 'admin' && !isHead()) return toast('The Head of Account Management workspace is not part of your role.', 'warn');
    S.role = r; S.sel = []; location.hash = r === 'admin' ? '#/a/ops' : '#/';
    reload().catch(fail);
  };
  window.renderWho = function () {
    const adm = S.role === 'admin';
    return `${I18N.toggleHTML()}
      ${isHead() ? `<span class="roleswitch">
        <button class="${adm ? '' : 'on'}" onclick="setRole('am')">Account Manager</button>
        <button class="${adm ? 'on' : ''}" onclick="setRole('admin')">Head of AM</button></span>` : ''}
      <span class="me" style="${adm ? 'background:#4F46E5' : ''}">
        <span class="av" style="${adm ? 'color:#4F46E5' : ''}">${initials(X.me.name)}</span> <span data-i18n="off">${esc(X.me.name)}</span></span>
      <a class="btn btn-ghost btn-sm" href="/oa" style="${X.me.role === 'ACCOUNT_MANAGER' ? 'display:none' : ''}">Onboarding</a>
      ${X.me.role === 'ADMIN' && adm ? '<a class="btn btn-ghost btn-sm" href="/integrations">Integrations</a>' : ''}
      <button class="btn btn-ghost btn-sm" onclick="API.logout()">Sign out</button>`;
  };

  // ───────────── conversation ─────────────
  const protoMsgHTML = window.msgHTML;
  window.msgHTML = function (s, m) {
    if (m.kind === 'note') {
      return `<div class="msg note"><div><div class="bubble">${ic('file', 11)} <b>Internal note</b> — ${esc(m.body)}</div>
        <div class="meta">${new Date(m.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · ${esc(m.by || '')} · not visible to the seller</div></div></div>`;
    }
    if (m.kind === 'tpl' && m.text) return protoMsgHTML(s, { ...m, kind: 'text', body: m.text }).replace('<div class="bubble">', `<div class="bubble"><span class="tplmark">${ic('file', 9)} template · ${esc(m.body)}</span><br>`).replace(' · Sent<', ' · Sent · billable<');
    return protoMsgHTML(s, m);
  };
  const tplVars = (key, s) => ({
    am_welcome_v1: [first(s), X.userById.get(s.amId)?.name || X.me.name],
    am_inactive_v2: [first(s), String(daysInactive(s))],
    am_returns_v1: [first(s), String(s.returnRate)],
    am_qbr_invite_v1: [first(s), 'your store'],
    am_save_v1: [first(s), String(daysInactive(s))],
    am_expansion_v1: [first(s), ['Libya', 'Iraq', 'Lebanon'].filter((c) => !s.markets.includes(c))[0] || 'a second market'],
  }[key] || [first(s)]);
  window.renderTpl = (function (proto) {
    return function (key, s, extra) { return proto(key, { ...s, cat: s.cat === '—' ? 'store' : s.cat }, extra); };
  })(window.renderTpl);

  window.sendReply = function (id) {
    const s = seller(id); const body = (S.draft || '').trim();
    if (!body) return toast('Nothing to send');
    act(async () => { await API.post(`/api/conversations/${s.convId}/messages`, { kind: 'text', body }); S.draft = ''; }, 'Sent');
  };
  window.saveNote = function (id) {
    const s = seller(id); const v = ((document.getElementById('m-note') || {}).value || '').trim();
    closeModal();
    if (!v) return;
    act(() => API.post(`/api/conversations/${s.convId}/messages`, { kind: 'note', body: v }), 'Note saved');
  };
  window.sendTemplate = function (id) {
    const s = seller(id); const key = M.choice;
    closeModal();
    act(() => API.post(`/api/conversations/${s.convId}/messages`, { kind: 'template', templateKey: key, variables: tplVars(key, s) }), 'Template sent — billable');
  };

  // ───────────── calls & tasks ─────────────
  window.saveCall = function (id) {
    const s = seller(id); const note = ((document.getElementById('m-note') || {}).value || '').trim();
    const taskId = (document.getElementById('m-task') || {}).value || undefined; const outcome = M.choice;
    const t = taskId ? s.tasks.find((x) => x.id === taskId) : null;
    closeModal();
    act(() => API.post(`/api/am/sellers/${s.id}/calls`, { outcome, taskId, note, minutes: t ? TASKTYPE[t.type].mins : 20 }),
      outcome === 'no_answer' ? 'No answer logged — retry set for tomorrow' : outcome === 'escalate' ? 'Escalated — the next owner is notified' : 'Call logged');
  };
  window.doComplete = function (sid, tid) {
    const note = ((document.getElementById('m-note') || {}).value || '').trim();
    if (!note) return toast('Write one line on what happened — the next person reads it.', 'warn');
    closeModal();
    act(() => API.post(`/api/am/tasks/${tid}/close`, { outcome: note }), 'Task completed');
  };
  window.doEscalateUI = function (sid, tid) {
    const why = ((document.getElementById('m-note') || {}).value || '').trim();
    if (!why) return toast('A written reason is required to escalate.', 'warn');
    closeModal();
    act(() => API.post(`/api/am/tasks/${tid}/escalate`, { reason: why }), 'Escalated — the next owner is notified');
  };
  window.snoozeTask = function (sid, tid) { act(() => API.post(`/api/am/tasks/${tid}/snooze`, { days: 1 }), 'Pushed one day'); };
  window.saveTask = function (sid) {
    const s = seller(sid);
    const title = (document.getElementById('m-title') || {}).value || `${TASKTYPE[M.choice].label} — ${s.biz}`;
    const why = ((document.getElementById('m-why') || {}).value || '').trim();
    if (!why) return toast('Say why — a task without a reason is a task nobody can act on.', 'warn');
    const due = +(document.getElementById('m-due') || {}).value || 0;
    const dueAt = new Date(Date.now() + due * 86400000).toISOString();
    closeModal();
    act(() => API.post(`/api/am/sellers/${s.id}/tasks`, { taskType: M.choice, title, why, priority: M.prio || 'normal', dueAt }), 'Task opened');
  };
  window.togglePb = function (sid, k) {
    const s = seller(sid); const st = window.pbState(s).find((x) => x.k === k);
    if (s.pb[k]) return toast('A completed playbook step stays completed — it is part of the audit trail.', 'warn');
    if (!st.gateOk) return toast(`Cannot tick “${st.t}” — ${st.gateLbl || 'its gate'} is not met on this account`, 'warn');
    act(() => API.post(`/api/am/sellers/${s.id}/playbook/${st.day}/tick`), `${st.t} — completed`);
  };
  const protoTransfer = window.requestTransfer;
  window.requestTransfer = function (id) {
    protoTransfer(id);
    const btn = document.querySelector('#modal-root .modal-f .btn-red');
    if (btn) btn.setAttribute('onclick', `MDM.doTransfer('${id}')`);
  };
  X.doTransfer = function (id) {
    const reason = ((document.getElementById('m-note') || {}).value || '').trim();
    if (!reason) return toast('A reason is required.', 'warn');
    closeModal();
    act(() => API.post(`/api/am/sellers/${id}/request-transfer`, { reason }), 'Transfer request sent to the Head of Account Management');
  };

  // Macros are internal: a note plus the task changes they describe — each one a permission-checked call.
  window.applyMacro = function (id) {
    const s = seller(id); const m = MACROS.find((x) => x.key === M.choice);
    const open = openTasks(s);
    const byType = (type) => open.find((t) => t.type === type);
    closeModal();
    act(async () => {
      await API.post(`/api/conversations/${s.convId}/messages`, { kind: 'note', body: m.note });
      const close = (t, outcome) => t && API.post(`/api/am/tasks/${t.id}/close`, { outcome });
      if (m.key === 'x_welcome_done') await close(byType('welcome'), 'Welcome call completed');
      if (m.key === 'x_intervention') await close(byType('intervention'), 'Intervention call completed');
      if (m.key === 'x_coach_returns') await close(byType('coach'), 'Coaching delivered');
      if (m.key === 'x_save_offer') await close(byType('save'), 'Save offer extended');
      if (m.key === 'x_escalate' && open[0]) await API.post(`/api/am/tasks/${open[0].id}/escalate`, { reason: m.note });
      if (m.key === 'x_no_answer') await API.post(`/api/am/sellers/${s.id}/calls`, { outcome: 'no_answer', taskId: open[0]?.id });
    }, m.title);
  };
  window.openAlert = function (sid, tid) {
    const r = readAlerts(); if (!r.includes(tid)) r.push(tid);
    try { localStorage.setItem(readKey(), JSON.stringify(r)); } catch { /* private mode */ }
    seller(sid).readAlerts = r; location.hash = '#/seller/' + sid;
  };
  window.markAllRead = function () {
    const r = readAlerts();
    for (const s of book()) for (const t of s.tasks) if (t.alertKey && !r.includes(t.id)) r.push(t.id);
    try { localStorage.setItem(readKey(), JSON.stringify(r)); } catch { /* private mode */ }
    for (const s of S.sellers) s.readAlerts = r;
    render();
  };
  window.runSweep = function () {
    act(async () => { const r = await API.post('/api/am/sweep'); toast(`Sweep complete — ${r.tasksOpened} task(s) opened, ${r.tasksUpgraded} upgraded in place`, 'ok'); });
  };

  // ───────────── Head of AM ─────────────
  window.doReassign = function () {
    const to = M.choice; const reason = ((document.getElementById('m-note') || {}).value || '').trim(); const ids = S.sel.slice();
    if (!reason) return toast('A written reason is required for the audit trail.', 'warn');
    closeModal();
    act(async () => {
      const r = await API.post('/api/am/reassign', { sellerIds: ids, toManagerId: to, reason });
      S.sel = [];
      const bad = r.results.filter((x) => !x.ok);
      toast(`${r.succeeded} reassigned to ${nameOf(to)}${bad.length ? ` · ${bad.length} refused: ${bad[0].error}` : ''}`, bad.length ? 'warn' : 'ok');
    });
  };
  window.doBulkTask = function () {
    const type = M.choice; const ids = S.sel.slice();
    const title = (document.getElementById('m-title') || {}).value || TASKTYPE[type].label;
    const why = ((document.getElementById('m-why') || {}).value || '').trim() || 'Opened by the Head of Account Management.';
    const due = +(document.getElementById('m-due') || {}).value || 7;
    closeModal();
    act(async () => {
      const r = await API.post('/api/am/bulk-tasks', { sellerIds: ids, taskType: type, title, why, dueAt: new Date(Date.now() + due * 86400000).toISOString() });
      S.sel = [];
      const bad = r.results.filter((x) => !x.ok);
      toast(`${r.succeeded} task(s) opened${bad.length ? ` · ${bad.length} refused: ${bad[0].error}` : ''}`, bad.length ? 'warn' : 'ok');
    });
  };
  window.doTakeOver = function (id) {
    const s = seller(id); const reason = ((document.getElementById('m-note') || {}).value || '').trim();
    if (!reason) return toast('A written reason is required.', 'warn');
    closeModal();
    act(() => API.post(`/api/conversations/${s.convId}/take-over`, { reason }), 'Taken over — the account manager has been notified');
  };
  const protoBlock = window.blockContact;
  window.blockContact = function (id) {
    protoBlock(id);
    const btn = document.querySelector('#modal-root .modal-f .btn-red');
    if (btn) { btn.textContent = 'Block'; btn.setAttribute('onclick', `MDM.doBlock('${id}')`); }
  };
  X.doBlock = function (id) {
    const reason = ((document.getElementById('m-note') || {}).value || '').trim();
    if (!reason) return toast('A written reason is required.', 'warn');
    closeModal();
    act(() => API.post(`/api/contacts/${seller(id).contactId}/block`, { reason }), 'Contact blocked — reversible, audited');
  };

  // Configuration: the server simulates against a copy, publishes a full snapshot, rolls back exactly.
  const draftChanges = () => Object.fromEntries(Object.entries(S.cfgDraft).map(([k, v]) => [`am.${k}`, v]));
  window.simulate = async function () {
    let sim;
    try { sim = await API.post('/api/config/simulate', { changes: draftChanges() }); } catch (e) { return fail(e); }
    const a = sim.impacts?.accountManagement || { tasksOpened: 0, tasksUpgraded: 0, hoursAdded: 0, bandMoves: [], bands: { before: {}, after: {} } };
    openModal(`<div class="modal-h">${ic('play', 18)}<h3>Simulate — ${Object.keys(S.cfgDraft).length} pending change(s)</h3><span style="flex:1"></span>
        <button class="tb-btn" onclick="closeModal()">${ic('x', 16)}</button></div>
      <div class="modal-b">
        ${sim.errors.length ? `<div class="banner bn-red" style="margin-bottom:14px">${ic('warn', 15)}<div>${sim.errors.map((e) => esc(e.message)).join('<br>')}</div></div>` : ''}
        <div class="eyebrow" style="margin-bottom:8px">Band movement across all sellers</div>
        ${BANDS.slice().reverse().map((b) => {
          const from = a.bands.before[b.label] || 0; const to = a.bands.after[b.label] || 0; const delta = to - from;
          return `<div class="simrow"><i class="hb-dot" style="background:${b.color}"></i><span class="nm">${b.label}</span>
            <span class="from">${from}</span>${ic('chev', 11)}<span class="to">${to}</span>
            ${delta ? `<span class="mv ${delta > 0 ? 'mv-up' : 'mv-dn'}">${delta > 0 ? '+' : ''}${delta}</span>` : '<span class="tiny muted">no change</span>'}</div>`;
        }).join('')}
        <div class="banner ${a.tasksOpened || a.tasksUpgraded ? 'bn-amber' : 'bn-green'}" style="margin:16px 0">${ic(a.tasksOpened || a.tasksUpgraded ? 'warn' : 'check', 15)}
          <div><b>${a.tasksOpened} new task(s)</b> would be opened on the next sweep, adding roughly <b>${a.hoursAdded} hours</b> across ${TEAM.length} account managers.
          ${a.tasksUpgraded ? `A further <b>${a.tasksUpgraded}</b> routine check-in(s) would be upgraded to an urgent intervention in place.` : ''}</div></div>
        <div class="banner bn-slate tiny">${ic('shield', 14)}<div>Run by the real rule engine against a copy that is thrown away. Nothing has changed.</div></div>
      </div>
      <div class="modal-f"><button class="btn btn-ghost" onclick="closeModal()">Keep editing</button>
        <button class="btn btn-red" ${sim.publishable ? '' : 'disabled'} onclick="publishCfg()">${ic('check', 13)} Publish</button></div>`, true);
  };
  window.publishCfg = function () {
    const changes = draftChanges();
    if (!Object.keys(changes).length) return toast('Nothing to publish');
    closeModal();
    act(async () => {
      await API.del('/api/config/draft');
      await API.patch('/api/config/draft', { changes });
      const r = await API.post('/api/config/publish', { expectedVersion: X.version, note: Object.keys(changes).join(', ') });
      S.cfgDraft = {};
      toast(`Version ${r.version} published — the rule sweep ran immediately`, 'ok');
    });
  };
  window.rollback = function (v) {
    openModal(`<div class="modal-h">${ic('refresh', 18)}<h3>Roll back to version ${v}</h3><span style="flex:1"></span>
        <button class="tb-btn" onclick="closeModal()">${ic('x', 16)}</button></div>
      <div class="modal-b"><div class="banner bn-amber">${ic('warn', 15)}
        <div>This restores the complete configuration snapshot of version ${v} — every value, not only the ones that version changed — as a new version.
        Tasks already opened stay open.</div></div></div>
      <div class="modal-f"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-red" onclick="doRollback(${v})">Roll back</button></div>`, true);
  };
  window.doRollback = function (v) {
    closeModal();
    act(async () => { const r = await API.post('/api/config/rollback', { targetVersion: v }); toast(`Rolled back to version ${v} (now v${r.version})`, 'ok'); });
  };
  window.toggleRule = function (id) {
    const r = RULES.find((x) => x.id === id); const key = `am.rule.${id}.enabled`;
    act(async () => {
      await API.del('/api/config/draft');
      await API.patch('/api/config/draft', { changes: { [key]: !r.live } });
      await API.post('/api/config/publish', { expectedVersion: X.version, note: `${r.live ? 'Disable' : 'Enable'} ${id}` });
    }, `Rule ${id} ${r.live ? 'disabled' : 'enabled'}`);
  };

  // ───────────── boot ─────────────
  const protoRender = window.render;
  window.render = function () {
    if (!X.me) return;
    if ((location.hash || '').startsWith('#/a/') && !isHead()) { location.hash = '#/'; return; }
    protoRender();
  };
  async function boot() {
    const me = await API.me();
    X.me = me.user; X.grants = me.grants;
    if (!['ACCOUNT_MANAGER', 'ADMIN'].includes(me.user.role)) { location.href = '/oa'; return; }
    ME = me.user.id; // eslint-disable-line no-global-assign
    S.role = me.user.role === 'ACCOUNT_MANAGER' ? 'am' : 'admin';
    if (S.role === 'admin' && !(location.hash || '').startsWith('#/a/') && !(location.hash || '').startsWith('#/seller/')) location.hash = '#/a/ops';
    await reload();
    setInterval(() => {
      const busy = document.querySelector('#modal-root .ovl') || document.activeElement?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (!busy && !X.busy) reload().catch(() => {});
    }, 30000);
  }
  boot().catch(fail);
})();
