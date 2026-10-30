// Onboarding console ⇄ API adapter.
// The prototype's views render from S.leads, TEAM, CFG, RULES, AUDIT and VERSIONS. This file fills
// those from the API and replaces every action that changed in-browser state with an API call.
// After each call the data is reloaded and the view re-rendered, so what the console shows is
// always what the server decided — including refusals, which are shown with their reason.
/* global API, I18N, S, CFG, TEAM, AMS, ME, RULES, AUDIT, VERSIONS, CFG_FIELDS, TEMPLATES, MACROS, CHECKS, M,
   render, toast, openModal, closeModal, lead, esc, ic, opt, fmtT, fmtHM, days, iso, oa, winState, winText, chDot, renderTpl,
   NO_ANSWER_MAX, QUIET_MAX, QUIET_GAP */
(function () {
  const COUNTRY = { LY: 'Libya', IQ: 'Iraq', LB: 'Lebanon' };
  const COLORS = ['#DC2626', '#0E7490', '#7C3AED', '#2B8A3E', '#B45309', '#2563EB'];
  const STATUS_MAP = { new: 'new', failed_to_contact: 'failed', prequalified: 'prequalified', qualified: 'qualified', activated: 'qualified', cold_lead: 'cold', junk_lead: 'junk' };
  const STATUS_BACK = { new: 'new', failed: 'failed_to_contact', prequalified: 'prequalified', qualified: 'qualified', cold: 'cold_lead', junk: 'junk_lead' };
  const CHECK_KEYS = { real: 'reachable', intent: 'intent', walk: 'walkthrough', docs: 'documents', expect: 'expectations' };
  const MODE_TO_API = { 'Phone call': 'phone', 'Google Meet': 'meet', 'WhatsApp video': 'whatsapp_video' };
  const MODE_FROM_API = { phone: 'Phone call', meet: 'Google Meet', whatsapp_video: 'WhatsApp video' };
  // prototype CFG key ⇄ configuration key (OA Appendix D)
  const CFG_KEYS = {
    firstContactH: 'oa.first_contact_sla', noAnswerMax: 'oa.no_answer_max', noAnswerGapD: 'oa.no_answer_gap',
    quietMax: 'oa.quiet_max', quietGapD: 'oa.quiet_gap', winbackDay: 'oa.winback_day', stalledDay: 'oa.stalled_day',
    tplBudgetMonth: 'oa.template_budget_month', tplPerContact: 'oa.template_per_contact_cap', unclaimedReofferMin: 'oa.holding_sweep_interval',
    shiftMin: 'oa.shift_minutes', reservedMin: 'oa.reserved_minutes', maxOpenLeads: 'oa.max_open_leads',
    walkthroughMin: 'oa.walkthrough_minutes', wtBufferMin: 'oa.walkthrough_buffer', firstContactMin: 'oa.first_contact_minutes',
    wrapMin: 'oa.wrap_minutes', followupMin: 'oa.followup_minutes', composeMin: 'oa.compose_minutes', readMin: 'oa.read_minutes',
    templateMin: 'oa.template_minutes', noteMin: 'oa.note_minutes', noAnswerMin: 'oa.no_answer_minutes', activationMin: 'oa.activation_minutes',
  };

  const X = { me: null, grants: {}, users: [], userById: new Map(), capacity: new Map(), macros: [], config: {}, version: null, raw: new Map(), busy: false };
  window.MDM = X;

  const initials = (n) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const nameOf = (id) => (id ? X.userById.get(id)?.name ?? 'Unknown user' : 'Rule (automation)');
  const first = (l) => l.name.split(' ')[0];
  const errText = (e) => e?.message || 'Something went wrong.';
  const fail = (e) => { console.error(e); toast(errText(e), 'warn'); };

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
  function stageOf(t) {
    if (t.status === 'activated') return 'activated';
    if (t.stage === 'walkthrough') return t.walkthroughAt ? 'booked' : 'hub';
    if (t.stage === 'documents') return 'documents';
    return t.status === 'new' ? 'registered' : 'contacted';
  }

  function msgOf(m, l) {
    const at = m.createdAt;
    if (m.kind === 'note') return { dir: 'out', ch: 'note', kind: 'note', body: m.body, at, by: nameOf(m.authorUserId) };
    if (m.kind === 'system') return { dir: 'out', ch: 'note', kind: 'sys', body: m.body, at };
    if (m.kind === 'call_event') return { dir: m.direction, ch: 'voice', kind: 'call', body: m.body, at };
    if (m.kind === 'template') return { dir: 'out', ch: 'whatsapp', kind: 'tpl', body: m.templateKey, text: m.body, at, state: 'sent', by: nameOf(m.authorUserId) };
    return { dir: m.direction, ch: l.channel, kind: 'text', body: m.body, at, state: m.direction === 'out' ? 'sent' : null };
  }

  function timelineOf(t, l) {
    const tl = [];
    const T = (e, type, title, body) => tl.push({ at: e.createdAt, type, title, body: body || '', by: nameOf(e.actorId) });
    for (const e of t.events) {
      const a = e.after ? JSON.parse(e.after) : {};
      const b = e.before ? JSON.parse(e.before) : {};
      switch (e.action) {
        case 'contact.created': T(e, 'reg', `Registered — ${l.source}`, `Contact ${l.contactCode} created · conversation ${l.conv} opened`); break;
        case 'ticket.created':
          if (a.assigneeId) T(e, 'assign', `Assigned to ${nameOf(a.assigneeId)}`, `Rule r1 · most free minutes on the ${l.country} queue`);
          else T(e, 'assign', `Held — ${a.holdReason}`, 'Assigned automatically as soon as an agent has capacity. Nobody picks leads by hand.');
          break;
        case 'ticket.assigned': case 'ticket.assigned_over_capacity':
          T(e, 'assign', `Assigned to ${nameOf(a.assigneeId)}`, e.reason || 'Capacity freed — assigned by the platform'); break;
        case 'ticket.reassigned': T(e, 'assign', 'Reassigned', `${nameOf(b.assigneeId)} → ${nameOf(a.assigneeId)} · ${e.reason || ''}`); break;
        case 'ticket.taken_over': T(e, 'assign', 'Taken over', `${nameOf(b.assigneeId)} → ${nameOf(a.assigneeId)} · ${e.reason || ''}`); break;
        case 'ticket.call_logged':
          if (e.reason === 'no_answer') T(e, 'noanswer', `Attempt ${a.attemptNo ?? ''} of ${NO_ANSWER_MAX} — no answer`, a.status === 'cold_lead' ? 'Cadence cutoff — moved to Cold Lead.' : 'Called, no answer.');
          else T(e, 'call', `Attempt ${a.attemptNo ?? ''} — answered`, a.status ? `Status set to ${STATUS[STATUS_MAP[a.status]]?.label ?? a.status}.` : '');
          break;
        case 'ticket.status_changed':
          if (a.status === 'cold_lead') T(e, 'cold', 'Moved to Cold Lead', e.reason || '');
          else if (a.status === 'junk_lead') T(e, 'junk', 'Marked Junk Lead', e.reason || '');
          else T(e, 'status', `Status → ${STATUS[STATUS_MAP[a.status]]?.label ?? a.status}`, e.reason || '');
          break;
        case 'ticket.reopened': T(e, 'status', 'Queue item reopened', e.reason || ''); break;
        case 'ticket.walkthrough_booked': T(e, 'book', `Walkthrough booked — ${MODE_FROM_API[a.walkthroughMode] ?? ''}`, a.walkthroughAt ? fmtT(a.walkthroughAt) : ''); break;
        case 'ticket.hub_sent': T(e, 'hub', 'Resource Hub sent — walkthrough declined', 'Went-quiet cadence started.'); break;
        case 'ticket.followup_sent': T(e, 'quiet', `Follow-up ${a.followupNo} of ${QUIET_MAX} — no reply`, 'Template oa_nudge_v2 sent.'); break;
        case 'ticket.cadence_reset': T(e, 'msg', 'Merchant replied — cadence reset', 'Counters back to zero, once per ticket.'); break;
        case 'ticket.activated': T(e, 'activate', 'Activated — handed off', e.reason || 'Handoff record complete.'); break;
        case 'ticket.first_order': T(e, 'order', 'First order placed', 'Counts toward the shared first-order-in-7-days KPI.'); break;
        case 'ticket.transfer_requested': T(e, 'status', 'Transfer requested', e.reason || ''); break;
        default: break;
      }
    }
    return tl.sort((x, y) => new Date(y.at) - new Date(x.at));
  }

  function leadOf(t, i) {
    const c = t.contact;
    const conv = t.conversation;
    const h = t.handoffRecord || {};
    const q = t.qualification || {};
    const l = {
      id: t.id, ticket: '#' + t.id.slice(-6).toUpperCase(), contactCode: 'CT-' + c.id.slice(-5).toUpperCase(), conv: conv ? 'C-' + conv.id.slice(-5).toUpperCase() : '—',
      name: c.name, ar: c.nameAr || '', country: COUNTRY[c.country] || c.country, city: '—', store: '—', phone: c.phone, email: '',
      source: h.source || c.sourceUtm || 'whatsapp', channel: conv?.channel === 'portal' ? 'portal' : 'whatsapp', utm: c.sourceUtm || '—',
      registeredAt: t.createdAt, ownerId: t.assigneeId, status: STATUS_MAP[t.status] || t.status, stage: stageOf(t),
      // The prototype's counter is the no-answer cadence; answered calls are not cadence attempts.
      attempts: t.status === 'failed_to_contact' || (t.status === 'cold_lead' && (t.tags || []).includes('oa_cold_no_answer')) ? t.attemptNo : 0,
      quiet: t.followupNo, nextAt: t.dueAt,
      walkthrough: t.walkthroughAt ? { at: t.walkthroughAt, mode: MODE_FROM_API[t.walkthroughMode] || t.walkthroughMode } : null,
      activatedAt: t.status === 'activated' ? t.closedAt : null, firstOrderAt: t.firstOrderAt,
      intent: h.intent || '', volume: '', notes: h.objections || '',
      handoff: t.status === 'activated' ? { am: h.accountManager, profile: h.sellerProfile, intent: h.intent, services: h.servicesDiscussed, objections: h.objections, commitments: h.commitments, risk: h.riskNotes } : null,
      checks: Object.fromEntries(Object.entries(CHECK_KEYS).map(([k, v]) => [k, q[v] === true])),
      waitingCapacity: !t.assigneeId && ['new', 'failed_to_contact', 'prequalified', 'qualified'].includes(t.status), waitReason: t.holdReason,
      assignedAt: t.assigneeId ? t.createdAt : null, color: COLORS[i % COLORS.length],
      lastInboundAt: conv?.lastInboundAt ?? null, convId: conv?.id ?? null, contactId: c.id, blocked: c.blocked, optedOut: c.optedOut,
      msgs: [], tl: [],
    };
    l.msgs = (conv?.messages || []).map((m) => msgOf(m, l));
    l.tl = timelineOf(t, l);
    return l;
  }

  function capacityOf(id) {
    const a = X.capacity.get(id);
    if (!a) return null;
    const assignable = a.assignable;
    const cWt = a.counts.walkthroughsToday * (CFG.walkthroughMin + CFG.wtBufferMin);
    const cFc = a.counts.firstContactsDue * (CFG.firstContactMin + CFG.wrapMin);
    const cCd = a.counts.followupsDue * CFG.followupMin;
    const pct = Math.round((a.free / assignable) * 100);
    return {
      open: a.openLeads, assignable, committed: a.committed, free: a.free, pct, cWt, cFc, cCd, onCall: a.onCall, canTake: a.canTake,
      cost: a.leadCost, slots: a.slots, byMinutes: a.slotsByMinutes, byCeiling: a.slotsByCeiling,
      binding: a.binding === 'open_lead_ceiling' ? 'ceiling' : 'minutes',
      state: a.onCall ? 'call' : !a.canTake ? 'full' : (pct < 25 || a.slots <= 2) ? 'tight' : 'free',
      wtToday: a.counts.walkthroughsToday, fcDue: a.counts.firstContactsDue, cadDue: a.counts.followupsDue,
    };
  }

  // ───────────── load ─────────────
  async function reload() {
    const isAdminView = API.canSeeAdmin(X.me.role);
    const [leads, users, capacity, cfg] = await Promise.all([
      API.get('/api/oa/leads'), API.get('/api/users'), API.get('/api/oa/capacity'), API.get('/api/config'),
    ]);
    X.users = users;
    X.userById = new Map(users.map((u) => [u.id, u]));
    X.capacity = new Map(capacity.map((c) => [c.agentId, c]));
    X.config = cfg.values; X.version = cfg.version;
    for (const [k, key] of Object.entries(CFG_KEYS)) if (key in cfg.values) CFG[k] = cfg.values[key];
    NO_ANSWER_MAX = CFG.noAnswerMax; QUIET_MAX = CFG.quietMax; QUIET_GAP = CFG.quietGapD; // eslint-disable-line no-global-assign
    for (const r of RULES) { const k = `oa.rule.${r.id}.enabled`; if (k in cfg.values) r.on = cfg.values[k]; }
    TEAM = users.filter((u) => u.role === 'OA_AGENT').map((u, i) => ({ // eslint-disable-line no-global-assign
      id: u.id, name: u.name, init: initials(u.name), color: COLORS[i % COLORS.length],
      countries: JSON.parse(u.markets || '[]').map((m) => COUNTRY[m] || m),
    }));
    AMS = users.filter((u) => u.role === 'ACCOUNT_MANAGER').map((u) => u.name); // eslint-disable-line no-global-assign
    S.leads = leads.map(leadOf);
    await loadAnalytics();
    if (isAdminView) await loadAdmin();
    render();
  }

  // Operations / Performance numbers: the server's aggregates replace the prototype's samples.
  async function loadAnalytics() {
    const a = await API.get('/api/oa/analytics').catch(() => null);
    if (!a) return;
    X.analytics = a;
    Object.assign(A, a);
    for (const r of RULES) r.runs = a.ruleRunsWindow?.[r.id] ?? 0;
  }

  async function loadAdmin() {
    const [audit, versions, templates, usage, elevations] = await Promise.all([
      API.get('/api/admin/audit?limit=100').catch(() => []),
      API.get('/api/config/versions').catch(() => []),
      API.get('/api/templates?module=oa').catch(() => []),
      API.get('/api/templates/usage?days=90').catch(() => ({ sends: {} })),
      API.get('/api/admin/elevations').catch(() => null),
    ]);
    TPL_STATE = Object.fromEntries(templates.map((t) => [t.key, { on: t.enabled, used: usage.sends[t.key] ?? 0, status: t.status }])); // eslint-disable-line no-global-assign
    for (const t of TEMPLATES) if (!TPL_STATE[t.key]) TPL_STATE[t.key] = { on: false, used: 0 };
    X.elevations = elevations;
    AUDIT.length = 0;
    for (const e of audit) {
      AUDIT.push({
        at: new Date(e.createdAt), who: e.actorId ? nameOf(e.actorId) : 'Rule (automation)',
        what: `${esc(e.action)} <code>${esc(e.entityType)} ${esc(String(e.entityId).slice(-6))}</code>${e.reason ? ' — ' + esc(e.reason) : ''}`,
        kind: e.entityType === 'config' ? 'cfg' : e.actorId ? 'op' : 'auto',
      });
    }
    VERSIONS.length = 0;
    for (const v of versions) {
      VERSIONS.push({
        v: v.version, at: new Date(v.createdAt), by: nameOf(v.authorId), note: v.note || '', live: v.live,
        diff: Object.entries(v.diff).flatMap(([k, d]) => [['-', `${k}: ${d.before}`], ['+', `${k}: ${d.after}`]]),
      });
    }
  }

  // ───────────── identity & role ─────────────
  window.save = function () {}; // state lives on the server
  window.resetDemo = function () { reload().then(() => toast('Reloaded from the server', 'ok')); };
  window.availability = function (id) {
    return capacityOf(id) || { open: 0, assignable: CFG.shiftMin - CFG.reservedMin, committed: 0, free: 0, pct: 0, cWt: 0, cFc: 0, cCd: 0,
      onCall: false, canTake: false, cost: 17, slots: 0, byMinutes: 0, byCeiling: 0, binding: 'minutes', state: 'full', wtToday: 0, fcDue: 0, cadDue: 0 };
  };
  // Monitoring is not replying (OA 9.2): only the owner gets the composer; admins take over first.
  canEdit = (l) => l.ownerId === ME; // eslint-disable-line no-global-assign

  window.setRole = function (r) {
    if (r === 'admin' && !API.canSeeAdmin(X.me.role)) return toast('The Admin workspace is not part of your role.', 'warn');
    S.role = r; S.sel = []; location.hash = r === 'admin' ? '#/a/ops' : '#/'; render();
  };
  window.renderWho = function () {
    const el = document.getElementById('who'); if (!el) return;
    const adm = S.role === 'admin';
    const canAdmin = API.canSeeAdmin(X.me.role);
    el.innerHTML = `${I18N.toggleHTML()}
      ${canAdmin ? `<span class="roleswitch">
        <button class="${adm ? '' : 'on'}" onclick="setRole('agent')">Agent</button>
        <button class="${adm ? 'on' : ''}" onclick="setRole('admin')">Admin</button></span>` : ''}
      <span class="me" style="${adm ? 'background:#4F46E5' : ''}">
        <span class="av" style="${adm ? 'color:#4F46E5' : ''}">${initials(X.me.name)}</span> <span data-i18n="off">${esc(X.me.name)}</span></span>
      <button class="btn btn-ghost btn-sm" onclick="API.logout()">Sign out</button>`;
  };

  // ───────────── conversation ─────────────
  // Template messages show exactly what was sent (the server renders them), not a re-render.
  const protoMsgHTML = window.msgHTML;
  window.msgHTML = function (l, m) {
    if (m.kind === 'note') {
      return `<div class="msg note"><div><div class="bubble">${ic('file', 11)} <b>Internal note</b> — ${esc(m.body)}</div>
        <div class="meta">${fmtHM(m.at)} · ${esc(m.by || '')} · not visible to the merchant</div></div></div>`;
    }
    if (m.kind === 'tpl' && m.text) {
      const ar = /[؀-ۿ]/.test(m.text);
      return `<div class="msg out">${chDot('whatsapp')}<div><div class="bubble"><span class="tplmark">${ic('file', 9)} template · ${esc(m.body)}</span><br>
        <span ${ar ? 'class="ar" dir="rtl"' : ''}>${esc(m.text)}</span></div>
        <div class="meta">${fmtHM(m.at)} · Sent · billable</div></div></div>`;
    }
    return protoMsgHTML(l, m);
  };

  const tplVars = (key, l, extra = {}) => ({
    oa_intro_v2: [first(l), X.me.name],
    oa_slot_proposal_v3: [first(l), extra.a || 'tomorrow 10:00', extra.b || 'tomorrow 15:00'],
    oa_hub_share_v1: [first(l), 'app.mdm.express/hub', l.country],
    oa_nudge_v2: [first(l)],
    oa_winback_d30: [first(l), 'new delivery options'],
  }[key] || [first(l)]);

  window.sendReply = function (id) {
    const l = lead(id); const body = (S.draft || '').trim();
    if (!body) return toast('Nothing to send');
    act(async () => { await API.post(`/api/conversations/${l.convId}/messages`, { kind: 'text', body }); S.draft = ''; }, 'Sent');
  };
  window.saveNote = function (id) {
    const l = lead(id); const v = (document.getElementById('m-note') || {}).value || '';
    closeModal();
    if (!v.trim()) return;
    act(() => API.post(`/api/conversations/${l.convId}/messages`, { kind: 'note', body: v.trim() }), 'Note saved');
  };
  window.sendTemplate = function (id) {
    const l = lead(id); const key = M.choice;
    closeModal();
    act(() => API.post(`/api/conversations/${l.convId}/messages`, { kind: 'template', templateKey: key, variables: tplVars(key, l) }), 'Template sent');
  };

  // ───────────── calls, macros, cadence ─────────────
  function logOutcome(l, outcome, note) {
    if (outcome === 'junk') return API.post(`/api/oa/tickets/${l.id}/transition`, { to: 'junk_lead', reason: note || 'Not a real seller.' });
    const api = { no_answer: 'no_answer', qualified: 'answered_strong', prequalified: 'answered_soft' }[outcome];
    return API.post(`/api/oa/tickets/${l.id}/log-call`, { outcome: api, note: note || undefined });
  }
  window.saveCall = function (id) {
    const l = lead(id); const note = (document.getElementById('m-note') || {}).value || ''; const outcome = M.choice;
    closeModal();
    act(() => logOutcome(l, outcome, note.trim()), 'Outcome logged');
  };
  window.applyOutcome = function (l, outcome, note) { return act(() => logOutcome(l, outcome, note)); };

  window.runMacro = function (id, key) {
    const l = lead(id); const m = MACROS.find((x) => x.key === key);
    closeModal();
    if (key === 'm_book') return window.openBook(id);
    if (key === 'm_hub') return window.sendHub(id);
    const server = X.macros.find((x) => x.name === m.title);
    if (!server) return toast('This macro is not configured on the server.', 'warn');
    act(() => API.post(`/api/oa/tickets/${l.id}/macros/${server.id}`, { note: m.note }), `${m.title} — applied`);
  };

  window.saveBook = function (id) {
    const l = lead(id); const at = M.slots[M.choice]; const mode = M.mode;
    const others = Object.values(M.slots).filter((s) => s !== at);
    closeModal();
    act(async () => {
      await API.post(`/api/oa/tickets/${l.id}/book-walkthrough`, { at: new Date(at).toISOString(), mode: MODE_TO_API[mode] || 'phone' });
      // The confirmation goes out on the merchant's channel — a template if the window is shut (OA 7.2).
      try {
        if (winState(l) === 'shut') {
          await API.post(`/api/conversations/${l.convId}/messages`, { kind: 'template', templateKey: 'oa_slot_proposal_v3', variables: [first(l), fmtT(at), fmtT(others[0] || at)] });
        } else {
          await API.post(`/api/conversations/${l.convId}/messages`, { kind: 'text', body: `Booked — ${fmtT(at)} · ${mode}, ${CFG.walkthroughMin} minutes. I'll send the Resource Hub link now so you can look at pricing first.` });
        }
      } catch (e) { toast(`Booked, but the confirmation was not sent: ${errText(e)}`, 'warn'); }
    }, 'Booked for ' + fmtT(at));
  };
  window.sendHub = function (id) {
    const l = lead(id);
    closeModal();
    act(() => API.post(`/api/oa/tickets/${l.id}/send-hub`, { variables: tplVars('oa_hub_share_v1', l) }), `Hub sent. Follow-up 1 of ${QUIET_MAX} in ${QUIET_GAP} days`);
  };
  window.toggleCheck = function (id, k) {
    const l = lead(id); if (!canEdit(l)) return;
    act(() => API.patch(`/api/oa/tickets/${l.id}`, { qualification: { [CHECK_KEYS[k]]: !l.checks[k] } }));
  };

  function reasonModal(title, intro, cta, onGo) {
    X.pendingReason = onGo;
    openModal(`<div class="modal-h">${ic('file', 18)}<h3>${title}</h3><span style="flex:1"></span>
        <button class="tb-btn" onclick="closeModal()">${ic('x', 16)}</button></div>
      <div class="modal-b"><div class="banner bn-slate" style="margin-bottom:14px">${ic('shield', 15)}<div>${intro}</div></div>
        <label class="fl">Reason — required, written to the audit log</label>
        <textarea class="fi" id="m-note"></textarea></div>
      <div class="modal-f"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-red" onclick="MDM.submitReason()">${cta}</button></div>`);
  }
  X.submitReason = function () {
    const v = ((document.getElementById('m-note') || {}).value || '').trim();
    if (!v) return toast('A written reason is required.', 'warn');
    closeModal(); X.pendingReason(v);
  };

  window.reopen = function (id) {
    const l = lead(id);
    reasonModal('Reopen this lead', 'Reopening a Cold or Junk lead returns it to Pre-qualified. The reason is recorded against your name.', 'Reopen',
      (reason) => act(() => API.post(`/api/oa/tickets/${l.id}/transition`, { to: 'prequalified', reason }), 'Reopened'));
  };
  window.requestTransfer = function (id) {
    const l = lead(id);
    reasonModal('Request transfer', `Reassigning a lead is a shift-lead action. Your request goes to the Onboarding shift lead with the reason below. <b>${esc(l.name)}</b> — currently ${esc(nameOf(l.ownerId))}.`, 'Send request',
      (reason) => act(() => API.post(`/api/oa/tickets/${l.id}/request-transfer`, { reason }), 'Transfer request sent to the shift lead'));
  };

  // ───────────── activation (AM is assigned by the platform, AM 3.2) ─────────────
  const protoOpenActivate = window.openActivate;
  window.openActivate = async function (id) {
    const l = lead(id);
    let preview;
    try { preview = await API.get(`/api/oa/tickets/${l.id}/am-preview`); } catch (e) { return fail(e); }
    protoOpenActivate(id);
    const sel = document.getElementById('h-am');
    if (sel) {
      sel.innerHTML = `<option>${esc(preview.name || 'No account manager available')}</option>`;
      sel.disabled = true;
      sel.insertAdjacentHTML('afterend', `<div class="tiny muted" style="margin-top:6px">${ic('shield', 11)} ${preview.name
        ? `Assigned by the platform: same market, smallest book (${preview.bookSize} sellers). Agents never choose.`
        : esc(preview.reason) + ' The seller will be activated unassigned and the Admin alerted.'}</div>`);
    }
  };
  window.saveActivate = function (id) {
    const l = lead(id); const g = (x) => ((document.getElementById(x) || {}).value || '').trim();
    const handoffRecord = { sellerProfile: g('h-profile'), intent: g('h-intent'), servicesDiscussed: g('h-services'), objections: g('h-obj'), commitments: g('h-com'), riskNotes: g('h-risk') };
    closeModal();
    act(async () => {
      await API.patch(`/api/oa/tickets/${l.id}`, { handoffRecord });
      const r = await API.post(`/api/oa/tickets/${l.id}/activate`);
      if (r.handover?.assigned) await API.post(`/api/conversations/${l.convId}/messages`, { kind: 'text', body: `Your account is active. Your Account Manager ${r.handover.managerName} will call you within 24 hours and stays with you daily for your first month.` }).catch(() => {});
    }, `${l.name} activated`);
  };

  // ───────────── admin ─────────────
  window.reassign = function (id, to) {
    const l = lead(id);
    if (!to) return toast('Pick an agent — leads are never left with nobody.', 'warn');
    reasonModal('Reassign', `${esc(l.name)}: ${esc(nameOf(l.ownerId))} → ${esc(nameOf(to))}. The merchant sees nothing; the conversation is unbroken.`, 'Reassign',
      (reason) => act(() => API.post(`/api/oa/tickets/${l.id}/reassign`, { toUserId: to, reason }), 'Reassigned'));
  };
  const bulkToast = (r, verb) => {
    const bad = r.results.filter((x) => !x.ok);
    toast(`${r.succeeded} ${verb}${bad.length ? ` · ${bad.length} refused: ${bad[0].error}` : ''}`, bad.length ? 'warn' : 'ok');
  };
  // Bulk runs go to one server call: per-ticket permission checks, per-ticket results, one audit entry.
  window.doBulkAssign = function () {
    const to = M.choice; const ids = S.sel.slice(); closeModal();
    reasonModal(`Reassign ${ids.length} tickets`, 'Per-ticket permissions are checked individually. Anything that fails is reported, not silently skipped.', 'Reassign', (reason) => act(async () => {
      if (to === 'balance') {
        // spread across the team: each ticket to whoever holds the fewest open leads at that moment
        const load = new Map(TEAM.map((x) => [x.id, S.leads.filter((y) => y.ownerId === x.id && isOpen(y)).length]));
        const groups = new Map();
        for (const id of ids) {
          const target = [...load.entries()].sort((a, b) => a[1] - b[1])[0][0];
          load.set(target, load.get(target) + 1);
          groups.set(target, [...(groups.get(target) ?? []), id]);
        }
        const all = { results: [], succeeded: 0 };
        for (const [toUserId, ticketIds] of groups) {
          const r = await API.post('/api/oa/bulk', { op: 'reassign', ticketIds, toUserId, reason });
          all.results.push(...r.results); all.succeeded += r.succeeded;
        }
        S.sel = []; return bulkToast(all, 'reassigned');
      }
      const r = await API.post('/api/oa/bulk', { op: 'reassign', ticketIds: ids, toUserId: to, reason });
      S.sel = []; bulkToast(r, 'reassigned');
    }));
  };
  window.doBulkStatus = function () {
    const s = M.choice; const note = ((document.getElementById('m-note') || {}).value || '').trim(); const ids = S.sel.slice();
    if (!note) return toast('A written reason is required.', 'warn');
    closeModal();
    act(async () => { const r = await API.post('/api/oa/bulk', { op: 'transition', ticketIds: ids, to: STATUS_BACK[s], reason: note }); S.sel = []; bulkToast(r, 'updated'); });
  };
  window.doTakeOver = function (id) {
    const l = lead(id); const note = ((document.getElementById('m-note') || {}).value || '').trim();
    if (!note) return toast('A written reason is required.', 'warn');
    closeModal();
    act(() => API.post(`/api/conversations/${l.convId}/take-over`, { reason: note }), 'You own this conversation now');
  };
  const protoBlock = window.blockContact;
  window.blockContact = function (id) {
    protoBlock(id);
    const btn = document.querySelector('#modal-root .modal-f .btn-red');
    if (btn) btn.setAttribute('onclick', `MDM.doBlock('${id}')`);
  };
  X.doBlock = function (id) {
    const l = lead(id); const reason = ((document.getElementById('m-note') || {}).value || '').trim();
    if (!reason) return toast('A written reason is required.', 'warn');
    closeModal();
    act(() => API.post(`/api/contacts/${l.contactId}/block`, { reason }), 'Contact blocked — reversible, audited');
  };
  window.forceAssign = function (id) {
    const l = lead(id);
    reasonModal('Assign over capacity', 'Assigns this held lead to the agent with the most free minutes, ignoring the capacity check. Agents on calls are still excluded.', 'Assign',
      (reason) => act(() => API.post(`/api/oa/tickets/${l.id}/assign-over-capacity`, { reason }), 'Assigned over capacity'));
  };
  window.assignAll = function () {
    const held = S.leads.filter((l) => !l.ownerId && isOpen(l));
    if (!held.length) return toast('Nothing is being held right now');
    reasonModal(`Assign ${held.length} held lead(s) over capacity`, 'Each lead goes to the agent with the most free minutes. Results are reported per ticket.', 'Assign all',
      (reason) => act(async () => bulkToast(await API.post('/api/oa/bulk', { op: 'assign_over_capacity', ticketIds: held.map((l) => l.id), reason }), 'assigned over capacity')));
  };

  // ───────────── configuration: draft → simulate → publish → roll back (server) ─────────────
  const draftChanges = () => Object.fromEntries(Object.entries(S.cfgDraft).map(([k, v]) => [CFG_KEYS[k] || k, v]));
  window.simulate = async function () {
    let sim;
    try { sim = await API.post('/api/config/simulate', { changes: draftChanges() }); } catch (e) { return fail(e); }
    const rows = Object.entries(sim.diff).map(([k, d]) => `<div class="minus">− ${esc(k)}: ${esc(d.before)}</div><div class="plus">+ ${esc(k)}: ${esc(d.after)}</div>`).join('');
    const ob = sim.impacts?.onboarding;
    const amI = sim.impacts?.accountManagement;
    openModal(`<div class="modal-h">${ic('spark', 18)}<h3>Simulation — the real rules, run against a copy</h3><span style="flex:1"></span>
        <button class="tb-btn" onclick="closeModal()">${ic('x', 16)}</button></div>
      <div class="modal-b">
        <div class="banner bn-blue" style="margin-bottom:14px">${ic('shield', 15)}
          <div>Nothing has changed yet. The live engine never evaluates a draft — this is what the next sweep would do under it.</div></div>
        ${sim.errors.length ? `<div class="banner bn-red" style="margin-bottom:14px">${ic('flame', 15)}<div>${sim.errors.map((e) => esc(e.message)).join('<br>')}</div></div>` : ''}
        ${ob ? `<div style="padding:12px 0;border-bottom:1px solid var(--line2)"><div class="cond trg" style="margin-bottom:7px">Onboarding</div>
          <div style="font-size:13px;color:var(--ink3);line-height:1.6">${ob.movedToCold} open lead(s) would move to Cold Lead · ${ob.templateSends} template send(s) · ${ob.r3} reminder(s) · ${ob.r8} held lead(s) assigned</div></div>` : ''}
        ${amI ? `<div style="padding:12px 0;border-bottom:1px solid var(--line2)"><div class="cond trg" style="margin-bottom:7px">Account management</div>
          <div style="font-size:13px;color:var(--ink3);line-height:1.6">${amI.tasksOpened} task(s) opened · ${amI.tasksUpgraded} upgraded in place · ${amI.hoursAdded} h added · ${amI.bandMoves.length} seller(s) change band</div></div>` : ''}
        <div class="diff" style="margin-top:16px">${rows}</div>
      </div>
      <div class="modal-f"><button class="btn btn-ghost" onclick="closeModal()">Back to draft</button>
        <button class="btn btn-green" ${sim.publishable ? '' : 'disabled title="Fix the errors above first"'} onclick="publishCfg()">${ic('check', 14)} Publish</button></div>`, true);
  };
  window.publishCfg = function () {
    const changes = draftChanges();
    closeModal();
    act(async () => {
      await API.del('/api/config/draft');
      await API.patch('/api/config/draft', { changes });
      const r = await API.post('/api/config/publish', { expectedVersion: X.version, note: Object.keys(changes).join(', ') });
      S.cfgDraft = {};
      toast(`Published v${r.version}. The agent view is already using it.`, 'ok');
    });
  };
  window.rollback = function (v) {
    act(async () => { const r = await API.post('/api/config/rollback', { targetVersion: v }); toast(`Rolled back to v${v} (new version v${r.version})`, 'warn'); });
  };
  window.toggleRule = function (id) {
    const key = `oa.rule.${id}.enabled`;
    const r = RULES.find((x) => x.id === id);
    act(async () => {
      await API.del('/api/config/draft');
      await API.patch('/api/config/draft', { changes: { [key]: !r.on } });
      await API.post('/api/config/publish', { expectedVersion: X.version, note: `${r.on ? 'Disable' : 'Enable'} ${id}` });
    }, `${r.name} — ${r.on ? 'disabled' : 'enabled'}`);
  };
  window.toggleTpl = function (k) {
    const on = TPL_STATE[k]?.on;
    act(() => API.post(`/api/templates/${k}/${on ? 'disable' : 'enable'}`), `${k} ${on ? 'disabled' : 'enabled'}`);
  };

  // ───────────── admin panels that read the record ─────────────
  const pctOf = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  X.perfInsight = function () {
    const ag = (A.agents || []).filter((a) => a.reg > 0);
    if (ag.length < 2) return 'Too few leads in this window to compare agents yet — the comparison appears once each agent has worked leads.';
    const bySpeed = ag.slice().sort((a, b) => a.avgH - b.avgH);
    const fast = bySpeed[0]; const slow = bySpeed[bySpeed.length - 1];
    return `${esc(fast.name)} reaches new leads in ${fast.avgH} h on average and activates ${pctOf(fast.act, fast.reg)}%; ${esc(slow.name)} takes ${slow.avgH} h and activates ${pctOf(slow.act, slow.reg)}%.
      Speed to first contact is the strongest predictor in this table — coach the cadence discipline before the closing skill.`;
  };
  X.tplSpendLine = function () {
    const ag = (A.agents || []).filter((a) => a.tpl > 0).sort((a, b) => b.tpl - a.tpl);
    return ag.length ? `${ag.map((a) => `${esc(a.name)} ${a.tpl}`).join(' · ')} sends in the last ${A.windowDays} days.` : 'No template sends in this window yet.';
  };
  X.tplInsight = function (total) {
    const rows = Object.entries(TPL_STATE).filter(([, v]) => v.used > 0).sort((a, b) => b[1].used - a[1].used);
    if (!rows.length) return 'No template has been sent yet. Spend appears here per template once the cadence starts sending.';
    const [k, v] = rows[0];
    return `<b>${esc(k)} is ${pctOf(v.used, total)}% of spend.</b> The cohort table shows where activations stop; a follow-up that lands after that point costs a send and recovers little. Changing the cadence is a draft on the Automation page.`;
  };
  X.marksNote = () => (A.marks || []).length
    ? `Every configuration publish in this window is dated on the chart (${A.marks.map((m) => `${esc(m.w)}: ${esc(m.t)}`).join(' · ')}) — the only way to tell whether a rule change caused the movement.`
    : 'No configuration has been published in this window. Every publish is dated on this chart, so a rule change can be read against the rate it was meant to move.';
  X.macroUses = (m) => X.macros.find((x) => x.name === m.title)?.usageCount ?? 0;
  X.qaEmpty = () => `<div class="banner bn-slate tiny">${ic('shield', 14)}<div>No quality reviews yet. Reviews are recorded per conversation by a supervisor; nothing is sampled or scored automatically.</div></div>`;
  X.mine = function (k) {
    const a = (A.agents || []).find((x) => x.id === ME);
    if (!a) return k === 'avgH' ? '—' : 0;
    if (k === 'tpl') return `${a.tpl} in ${A.windowDays} days`;
    return a[k];
  };
  X.elevationsHTML = function () {
    if (!X.elevations) return '<p class="tiny muted">Only an Administrator manages elevations.</p>';
    const rows = X.elevations.map((e) => `<div class="lrow"><div class="grow"><div class="t">${esc(nameOf(e.userId))} → ${esc(e.role.replace('_', ' ').toLowerCase())}</div>
      <div class="s">${esc(e.reason)} · expires ${fmtT(e.endsAt)}</div></div>
      <button class="btn btn-ghost btn-sm" onclick="MDM.endElevation('${e.id}')">End now</button></div>`).join('');
    return `${rows || '<p class="tiny muted" style="margin:0">No elevation is active.</p>'}
      <button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="MDM.grantCover()">${ic('plus', 12)} Grant cover</button>`;
  };
  X.endElevation = (id) => reasonModal('End elevation early', 'The user returns to their own role immediately. Audited.', 'End now',
    (reason) => act(() => API.del(`/api/admin/elevations/${id}`, { reason }), 'Elevation ended — audited'));
  X.grantCover = function () {
    const agents = X.users.filter((u) => u.role === 'OA_AGENT');
    openModal(`<div class="modal-h">${ic('users', 18)}<h3>Grant time-bound cover</h3><span style="flex:1"></span>
        <button class="tb-btn" onclick="closeModal()">${ic('x', 16)}</button></div>
      <div class="modal-b">
        <label class="fl">Who</label><select class="fi" id="el-user">${agents.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
        <label class="fl">Acting as</label><select class="fi" id="el-role"><option value="SHIFT_LEAD">Shift lead</option></select>
        <label class="fl">Until</label><input class="fi" id="el-end" type="date" value="${new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10)}">
        <label class="fl">Reason — required, written to the audit log</label><textarea class="fi" id="m-note" placeholder="Covering leave…"></textarea>
      </div>
      <div class="modal-f"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-red" onclick="MDM.doGrant()">Grant</button></div>`);
  };
  X.doGrant = function () {
    const g = (id) => (document.getElementById(id) || {}).value || '';
    const reason = g('m-note').trim();
    if (!reason) return toast('A written reason is required.', 'warn');
    const endsAt = new Date(`${g('el-end')}T16:30:00`).toISOString();
    closeModal();
    act(() => API.post('/api/admin/elevations', { userId: g('el-user'), role: g('el-role'), endsAt, reason }), 'Cover granted — it expires by itself');
  };
  window.togPerm = function () { toast('Roles and grants are fixed by the specification; changes are an Administrator release.', 'warn'); };

  // ───────────── boot ─────────────
  async function boot() {
    const me = await API.me();
    X.me = me.user; X.grants = me.grants;
    ME = me.user.id; // eslint-disable-line no-global-assign
    if (me.user.role === 'ACCOUNT_MANAGER') { location.href = '/am'; return; }
    S.role = API.canSeeAdmin(me.user.role) && me.user.role !== 'OA_AGENT' && location.hash.startsWith('#/a/') ? 'admin' : (me.user.role === 'OA_AGENT' ? 'agent' : (location.hash.startsWith('#/a/') ? 'admin' : 'agent'));
    X.macros = await API.get('/api/oa/macros').catch(() => []);
    await reload();
    // Pick up inbound messages and rule changes without losing a draft or an open modal.
    setInterval(() => {
      const busy = document.querySelector('#modal-root .ovl') || document.activeElement?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (!busy && !X.busy) reload().catch(() => {});
    }, 30000);
  }
  // The admin router forces S.role='admin' on #/a/ routes; agents are sent home instead.
  const protoRender = window.render;
  window.render = function () {
    if (!X.me) return;
    if ((location.hash || '').startsWith('#/a/') && !API.canSeeAdmin(X.me.role)) { location.hash = '#/'; return; }
    protoRender();
    renderWho();
  };
  boot().catch(fail);
})();
