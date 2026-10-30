// Collision detection (AC-OA-13): while a conversation is on screen this sends a heartbeat every
// few seconds ("viewing", or "typing" while the composer has fresh input) and shows who else is
// on the same conversation, live. The banner slot (#mdm-collide) is updated in place, so a draft
// or the caret is never disturbed by a re-render.
(function () {
  const BEAT_MS = 4000;
  const st = { conv: null, others: [], typedAt: 0, lastSent: 0, lastState: null, inflight: false };

  function line(others) {
    if (!others.length) return '';
    const typing = others.filter((o) => o.state === 'typing');
    const lead = (typing[0] || others[0]).name;
    const more = others.length > 1 ? ` and ${others.length - 1} more` : '';
    return typing.length ? `${lead}${more} is replying in this conversation right now.` : `${lead}${more} is viewing this conversation right now.`;
  }

  function paint() {
    const slot = document.getElementById('mdm-collide');
    if (!slot) return;
    const text = line(st.others);
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    slot.innerHTML = text ? `<div class="collide">${typeof ic === 'function' ? ic('users', 13) : ''} ${esc(text)}</div>` : '';
    if (window.I18N) I18N.apply(slot);
  }

  async function beat(force) {
    const onScreen = !!document.getElementById('mdm-collide');
    if (st.inflight) return;
    if (!onScreen || !st.conv) {
      if (st.lastState && st.lastState !== 'left' && st.sentConv) { st.inflight = true; API.post(`/api/conversations/${st.sentConv}/presence`, { state: 'left' }).catch(() => {}).finally(() => { st.inflight = false; }); st.lastState = 'left'; }
      return;
    }
    const state = Date.now() - st.typedAt < 6000 ? 'typing' : 'viewing';
    if (!force && state === st.lastState && Date.now() - st.lastSent < BEAT_MS - 200) return;
    if (document.visibilityState === 'hidden' && !force) return;
    st.inflight = true;
    const conv = st.conv;
    try {
      if (st.sentConv && st.sentConv !== conv) await API.post(`/api/conversations/${st.sentConv}/presence`, { state: 'left' }).catch(() => {});
      const r = await API.post(`/api/conversations/${conv}/presence`, { state });
      st.sentConv = conv; st.lastSent = Date.now(); st.lastState = state;
      if (conv === st.conv) { st.others = r.others || []; paint(); }
    } catch { /* presence is best-effort */ } finally { st.inflight = false; }
  }

  window.Presence = {
    /** Called by the conversation pane on render: remembers the open conversation, returns the banner text. */
    watch(convId) {
      if (!convId) return '';
      if (convId !== st.conv) { st.conv = convId; st.others = []; setTimeout(() => beat(true), 0); }
      return line(st.others);
    },
    line,
  };

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.isContentEditable) && t.closest('.pane') && document.getElementById('mdm-collide')) {
      const was = Date.now() - st.typedAt < 6000;
      st.typedAt = Date.now();
      if (!was) beat(true);
    }
  });
  window.addEventListener('pagehide', () => {
    const token = st.sentConv && window.API && API.session()?.token;
    if (token) fetch(`/api/conversations/${st.sentConv}/presence`, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{"state":"left"}' }).catch(() => {});
  });
  setInterval(() => beat(false), BEAT_MS);
})();
