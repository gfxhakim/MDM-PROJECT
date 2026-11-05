// Controls both prototypes draw but leave to the parent platform, and the one markup every
// unavailable control uses. Loaded before the adapters, in both consoles.
//  - ☰ "Toggle menu" (the prototypes' "Sidebar collapse"): hides the left menu and brings it back.
//    The choice is kept in this browser.
//  - ⌘K / Ctrl+K, the shortcut printed in the top search box: puts the cursor in that box.
//  - A control that cannot be used is drawn disabled with its reason written under it, never a
//    pop-up note (OA 6.2: a disabled control states its reason; Principle 6).
/* global ic */
(function () {
  const KEY = 'mdm.navHidden';
  const css = document.createElement('style');
  css.textContent = `
    body.nav-hidden .sidebar{display:none}
    .nav-item.nav-off{cursor:default;align-items:flex-start}
    .nav-item.nav-off:hover{background:none}
    .nav-item.nav-off .nav-txt{display:flex;flex-direction:column;gap:2px;line-height:1.3;text-align:start;min-width:0}
    .nav-item.nav-off .why{font-weight:400;white-space:normal}
    .off-wrap{display:inline-flex;flex-direction:column;gap:2px;align-items:flex-start;vertical-align:top}
    .off-wrap .why{display:block;max-width:240px;line-height:1.3}
    .pbrow.off{cursor:default}
    .hub-card.off{cursor:default;opacity:.62}
    .hub-card.off:hover{box-shadow:none;transform:none}
  `;
  document.head.appendChild(css);

  let hidden = false;
  try { hidden = localStorage.getItem(KEY) === '1'; } catch { /* private mode */ }
  function apply() {
    document.body.classList.toggle('nav-hidden', hidden);
    const b = document.querySelector('.burger');
    if (b) b.setAttribute('aria-expanded', String(!hidden));
  }
  if (document.body) apply(); else document.addEventListener('DOMContentLoaded', apply);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // The server's own wording for a role without a grant (src/auth/scope.js denialReason).
  const ROLE_LABEL = { OA_AGENT: 'Onboarding Agent', SHIFT_LEAD: 'Shift lead', MANAGER: 'Manager', ADMIN: 'Admin', ACCOUNT_MANAGER: 'Account Manager', HEAD_OF_AM: 'Head of AM', READ_ONLY: 'Read-only' };

  // The reason written under each control that is greyed out. One place, so both consoles say the
  // same thing and the Arabic dictionary has one entry per sentence.
  const WHY = {
    platform: 'Part of the MDM platform — not in this app',
    omni: 'The full OmniDesk inbox is not connected to this app yet',
    omniSame: 'The full OmniDesk inbox is not connected to this app yet — this is the same conversation',
    kb: 'Onboarding articles are in Resource Hub',
    amOnboarding: "Your sellers' onboarding history is not in this console yet",
    orders: "Read on the MDM platform — each seller's page shows their numbers",
    finance: "Read on the MDM platform — each seller's page shows their wallet",
    hubLink: 'The Hub has no public address yet',
    video: 'Recording not uploaded yet',
    notWritten: 'Not written yet',
    seniorOa: 'Written by the Senior OA',
    schedule: 'The weekly report is not set up yet',
    tags: 'Tags are not set up yet',
    whatsapp: 'WhatsApp is not connected',
    newRule: 'New rules are not available yet — the ten rules below can be switched on or off and tuned',
    addField: 'Extra fields are not available yet',
    addStatus: 'The seven onboarding statuses are fixed for now',
    perms: 'Read-only for now: these are the grants of the permission table in your spec (Appendix A)',
    headCall: "Calls are logged by the seller's account manager",
  };

  window.CTL = {
    WHY,
    /** "Not available to the <role> role." — the sentence the server returns for the same refusal. */
    denied(role) { return `Not available to the ${ROLE_LABEL[role] ?? role} role.`; },
    toggleSidebar() {
      hidden = !hidden;
      try { localStorage.setItem(KEY, hidden ? '1' : '0'); } catch { /* private mode */ }
      apply();
    },
    /** A sidebar item that cannot be opened: greyed, with its reason under the label. */
    navOff(icon, label, why, extra = '') {
      return `<button class="nav-item dim nav-off" disabled aria-disabled="true"><span class="nav-ico">${ic(icon, 15)}</span>`
        + `<span class="nav-txt"><span>${label}</span><span class="why">${esc(why)}</span></span>${extra}</button>`;
    },
    /** A sidebar item that opens another page of this app. */
    navTo(icon, label, href, extra = '', cls = '') {
      return `<button class="nav-item ${cls}" onclick="location.href='${href}'"><span class="nav-ico">${ic(icon, 15)}</span> ${label}${extra}</button>`;
    },
    /** A button that cannot be used: disabled, with its reason written under it. */
    off(cls, icon, label, why, whyHtml = false) {
      return `<span class="off-wrap"><button class="btn ${cls}" disabled>${icon ? ic(icon, cls.includes('btn-sm') ? 12 : 14) + ' ' : ''}${label}</button>`
        + `<span class="why">${whyHtml ? why : esc(why)}</span></span>`;
    },
  };

  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== 'k') return;
    const box = document.querySelector('.topsearch input');
    if (!box) return;
    e.preventDefault();
    box.focus();
    box.select();
  });
})();
