/* ============================================================
   add-modal.js — site-wide "Add transaction" popup.

   Rather than navigate to the full /add-transaction page, any add trigger
   opens that page inside a modal <iframe> (?embed=1, which strips its chrome —
   see add-transaction.html). The embedded form posts back a `pf:tx-changed`
   message on save/delete; we close the popup and refresh the current page so
   the change shows. The page still works as a normal fallback if this script
   isn't active. Loaded on every page by nav.js.
   ============================================================ */
(function () {
  'use strict';

  /* never run inside the iframe itself, and only once per page */
  if (window.top !== window.self) return;
  if (window.__pfAddModal) return;
  window.__pfAddModal = true;

  let overlay = null, frame = null, isOpen = false, lastFocus = null;

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'addtx-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Add transaction');
    overlay.innerHTML =
      '<div class="addtx-modal__panel">' +
        '<button type="button" class="addtx-modal__close" aria-label="Close">' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
        '<iframe class="addtx-modal__frame" title="Add transaction"></iframe>' +
      '</div>';
    document.body.appendChild(overlay);
    frame = overlay.querySelector('.addtx-modal__frame');
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    overlay.querySelector('.addtx-modal__close').addEventListener('click', close);
  }

  function open(id) {
    if (!overlay) build();
    lastFocus = document.activeElement;
    /* cache-bust the frame URL: the embed page's headers (e.g. X-Frame-Options)
       can change between deploys while the HTML stays byte-identical, so a plain
       reload revalidates (304) and the browser reuses the STALE cached response —
       which showed as a blocked, blank iframe. A unique query forces a fresh 200
       with the current headers every time. */
    frame.src = '/add-transaction?embed=1' + (id ? '&id=' + encodeURIComponent(id) : '') + '&_=' + Date.now();
    overlay.classList.add('open');
    document.body.classList.add('addtx-open');
    isOpen = true;
  }

  function close() {
    if (!overlay || !isOpen) return;
    overlay.classList.remove('open');
    document.body.classList.remove('addtx-open');
    frame.src = 'about:blank';           /* unload the form */
    isOpen = false;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (_) {} }
  }

  window.openAddTransaction = open;
  window.closeAddTransaction = close;

  /* the embedded form tells us it saved / deleted / was cancelled */
  window.addEventListener('message', e => {
    if (e.origin !== window.location.origin) return;
    if (!e.data || e.data.type !== 'pf:tx-changed') return;
    close();
    if (e.data.action === 'saved' || e.data.action === 'deleted') {
      window.location.reload();          /* reflect the change on the current page */
    }
  });

  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen) close(); });

  /* Intercept add-transaction triggers so they open the popup instead of
     navigating. Capture phase + stopImmediatePropagation beats ui.js's own
     click→navigate handler on the same links. The href stays "/add-transaction"
     so it still works as a plain link if this script ever fails to load. */
  document.addEventListener('click', e => {
    /* the bottom-bar + only when it adds a transaction — for hours-focused
       users it links to /hours-tracker#log instead (nav.js) */
    const trigger = e.target.closest('[data-add-tx], a[href="/add-transaction"], .bottom-nav__item--add[href="/add-transaction"]');
    if (!trigger) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;   /* let "open in new tab" work */
    e.preventDefault();
    e.stopImmediatePropagation();
    open();
  }, true);
})();
