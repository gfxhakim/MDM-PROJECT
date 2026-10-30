// UI language (AC-OA-24): English and Arabic with right-to-left mirroring.
// The consoles render English HTML (their wording is normative); this layer translates the
// rendered DOM from a dictionary (i18n-ar.js) and flips the document direction. Switching
// language re-renders in place, so the route, filters and any unsent draft survive.
(function () {
  const KEY = 'mdm.lang';
  const ORIGINAL = new Map(); // text node → English source (kept so switching back restores it)
  const ATTRS = ['placeholder', 'title', 'aria-label'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE']);
  let lang = 'en';
  try { lang = localStorage.getItem(KEY) || 'en'; } catch { /* private mode */ }

  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  function translate(text) {
    const dict = window.I18N_AR || {};
    const key = norm(text);
    if (!key) return null;
    const lead = text.match(/^\s*/)[0];
    const trail = text.match(/\s*$/)[0];
    if (dict[key] !== undefined) return lead + dict[key] + trail;
    // Strings carrying numbers ("3 of 5", "due in 4 days") are looked up with {n} for each number.
    const nums = key.match(/\d+([.,]\d+)?/g);
    if (nums) {
      const t = (window.I18N_AR_TEMPLATES || {})[key.replace(/\d+([.,]\d+)?/g, '{n}')];
      if (t !== undefined) { let i = 0; return lead + t.replace(/\{n\}/g, () => nums[i++] ?? '') + trail; }
    }
    for (const [re, rep] of window.I18N_AR_PATTERNS || []) {
      if (re.test(key)) return lead + key.replace(re, rep) + trail;
    }
    return null;
  }

  // User content is never translated: message bubbles, names typed by people, anything marked
  // data-i18n="off" or already Arabic.
  const isUserContent = (el) => !!el.closest('[data-i18n="off"], .bubble, .ar, [contenteditable="true"]');

  function apply(root) {
    if (lang !== 'ar' || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName) || isUserContent(p)) return NodeFilter.FILTER_REJECT;
        return /[A-Za-z]/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    if (ORIGINAL.size > 20000) for (const n of ORIGINAL.keys()) if (!n.isConnected) ORIGINAL.delete(n);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const src = ORIGINAL.get(n) ?? n.nodeValue;
      const t = translate(src);
      if (t !== null && t !== n.nodeValue) { ORIGINAL.set(n, src); n.nodeValue = t; }
    }
    const els = root.querySelectorAll ? root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(',')) : [];
    for (const el of els) {
      if (isUserContent(el)) continue;
      for (const a of ATTRS) {
        const v = el.getAttribute(`data-en-${a}`) ?? el.getAttribute(a);
        if (!v || !/[A-Za-z]/.test(v)) continue;
        const t = translate(v);
        if (t !== null) { el.setAttribute(`data-en-${a}`, v); el.setAttribute(a, t); }
      }
    }
  }

  // Back to English: put every translated string back (nodes that left the DOM are dropped).
  function restore() {
    for (const [n, src] of ORIGINAL) if (n.isConnected) n.nodeValue = src;
    ORIGINAL.clear();
    for (const a of ATTRS) {
      for (const el of document.querySelectorAll(`[data-en-${a}]`)) { el.setAttribute(a, el.getAttribute(`data-en-${a}`)); el.removeAttribute(`data-en-${a}`); }
    }
  }

  function setDocumentDir() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.classList.toggle('lang-ar', lang === 'ar');
  }

  let pending = false;
  const observer = new MutationObserver((records) => {
    if (lang !== 'ar' || pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      observer.disconnect();
      for (const r of records) for (const n of r.addedNodes) apply(n.nodeType === 1 ? n : n.parentElement);
      apply(document.body);
      observe();
    });
  });
  const observe = () => observer.observe(document.body, { childList: true, subtree: true, characterData: false });

  window.I18N = {
    get lang() { return lang; },
    t: (s) => (lang === 'ar' ? translate(s) ?? s : s),
    set(next) {
      lang = next === 'ar' ? 'ar' : 'en';
      try { localStorage.setItem(KEY, lang); } catch { /* private mode */ }
      setDocumentDir();
      if (lang === 'en') restore();
      if (typeof window.render === 'function') window.render(); // re-render in place: hash, S.* and drafts persist
      apply(document.body);
    },
    toggleHTML() {
      return `<button class="btn btn-ghost btn-sm" data-i18n="off" onclick="I18N.set(I18N.lang==='ar'?'en':'ar')"
        title="${lang === 'ar' ? 'English' : 'العربية'}" style="font-family:Cairo,Inter,sans-serif">${lang === 'ar' ? 'English' : 'العربية'}</button>`;
    },
    apply,
  };

  const style = document.createElement('style');
  style.textContent = `
    html.lang-ar body { font-family: Cairo, Inter, system-ui, sans-serif; }
    html[dir="rtl"] .chev, html[dir="rtl"] .back-btn svg { transform: scaleX(-1); }
    html[dir="rtl"] .num, html[dir="rtl"] code, html[dir="rtl"] .k { unicode-bidi: plaintext; }
  `;
  document.head.appendChild(style);
  setDocumentDir();
  if (document.body) observe(); else document.addEventListener('DOMContentLoaded', observe);
})();
