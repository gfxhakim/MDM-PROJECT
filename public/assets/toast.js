// Toasts that don't pile up. The prototypes append a new toast on every click, so clicking the
// same disabled item a few times stacks identical notices. This replaces the page's toast():
// the same message is shown once (a repeat click restarts its timer), at most three are on screen,
// each fades after a few seconds and a click dismisses it at once. Same look, same wording.
(function () {
  if (typeof window.toast !== 'function') return;
  const SHOW_MS = 3400;
  const MAX = 3;
  const live = new Map(); // message → { el, timer }

  function dismiss(msg) {
    const t = live.get(msg);
    if (!t) return;
    live.delete(msg);
    clearTimeout(t.timer);
    t.el.style.transition = 'opacity .3s';
    t.el.style.opacity = '0';
    setTimeout(() => t.el.remove(), 300);
  }

  window.toast = function (msg, kind = '') {
    const box = document.getElementById('toasts');
    if (!box) return;
    const key = String(msg);
    const existing = live.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => dismiss(key), SHOW_MS);
      return;
    }
    while (live.size >= MAX) dismiss(live.keys().next().value);
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.style.cursor = 'pointer';
    el.innerHTML = `<span style="flex:0 0 auto;margin-top:1px">${ic(kind === 'ok' ? 'check' : 'spark', 14)}</span><span>${esc(key)}</span>`;
    el.onclick = () => dismiss(key);
    box.appendChild(el);
    live.set(key, { el, timer: setTimeout(() => dismiss(key), SHOW_MS) });
  };
})();
