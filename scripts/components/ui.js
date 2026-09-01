/* ============================================================
   ui.js — Theme, sidebar, nav, page transitions, shortcuts
   ============================================================ */

/* Vercel Web Analytics + Speed Insights — injected at runtime, the same way
   the @vercel/analytics package does it (this is a no-build static app, so the
   "@vercel/analytics/next" React imports don't apply). Loads on every app page
   that includes ui.js; the scripts only report on the Vercel deployment and
   404 harmlessly elsewhere. */
(function injectVercelInsights() {
  if (window.__vercelInsights) return;
  window.__vercelInsights = true;
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
  window.si = window.si || function () { (window.siq = window.siq || []).push(arguments); };
  ['/_vercel/insights/script.js', '/_vercel/speed-insights/script.js'].forEach(src => {
    const s = document.createElement('script');
    s.defer = true; s.src = src;
    (document.head || document.documentElement).appendChild(s);
  });
})();

/* --- Theme (black / white switch in the topbar) ---
   Applied at parse time so the page paints in the right theme.
   Device-local (pf_theme) + best-effort cross-device sync. */
const PFTheme = {
  current() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; },
  apply(theme) {
    if (theme === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#f5f5f7' : '#000000';
  },
  toggle() {
    const next = this.current() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('pf_theme', next); } catch (_) {}
    if (typeof SettingsStore !== 'undefined' && SettingsStore.setUiPref) {
      try { SettingsStore.setUiPref({ theme: next }); } catch (_) {}
    }
    this.apply(next);   /* flip the CSS variables instantly (no flash) */
    /* Canvas charts are painted imperatively and won't repaint on a CSS-var
       change, so reload only on pages that actually have one — and give the
       toggle's moon⇄sun animation a beat to play first. Plain pages switch
       live with no reload at all. */
    if (document.querySelector('canvas')) {
      setTimeout(() => window.location.reload(), 300);
    }
    return next;
  },
};
try { PFTheme.apply(localStorage.getItem('pf_theme') === 'light' ? 'light' : 'dark'); } catch (_) {}

let _sidebarOpen = false;
let _sidebar, _overlay;

function openSidebar() {
  _sidebarOpen = true;
  _sidebar?.classList.add('open');
  _overlay?.classList.add('active');
  document.body.style.overflow = 'hidden';
}
function closeSidebar() {
  _sidebarOpen = false;
  _sidebar?.classList.remove('open');
  _overlay?.classList.remove('active');
  document.body.style.overflow = '';
}

document.addEventListener('DOMContentLoaded', () => {

  /* --- Sidebar toggle (mobile) --- */
  _sidebar = document.getElementById('sidebar');
  _overlay = document.getElementById('overlay');
  const menuBtn = document.getElementById('menuBtn');

  menuBtn?.addEventListener('click', openSidebar);
  _overlay?.addEventListener('click', closeSidebar);

  /* refresh server-side settings (currency) so every page picks up changes made on other devices */
  if (typeof SettingsStore !== 'undefined' && typeof SupaAuth !== 'undefined') {
    SettingsStore._load().catch(() => {});
  }

  /* PWA: register the service worker (https or localhost only) */
  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  /* --- Active nav link (tolerates clean URLs; data-match lists extra pages, e.g. the Money tab) --- */
  const norm = p => (p.split('/').pop() || 'index.html').replace(/\.html$/, '');
  const currentPath = norm(window.location.pathname);
  document.querySelectorAll('.nav-item, .bottom-nav__item').forEach(link => {
    const href = link.getAttribute('href');
    if (!href) return;
    const matches = (link.dataset.match || href).split(',').map(norm);
    link.classList.toggle('active', matches.includes(currentPath));
  });

  /* --- Page transitions (nav + topbar + any internal link) --- */
  function navigateTo(href) {
    closeSidebar();
    document.body.classList.add('page-exit');
    setTimeout(() => { window.location.href = href; }, 130);
  }

  document.querySelectorAll(
    'a.nav-item, a.bottom-nav__item, .btn[href], a.topbar-nav-link, a.topbar-logo, a.money-tab, a.more-sheet__item'
  ).forEach(link => {
    link.addEventListener('click', e => {
      const href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('http') || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      navigateTo(href);
    });
  });

  /* --- Keyboard shortcuts --- */
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    /* N — new transaction */
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      if (window.openAddTransaction) window.openAddTransaction();
      else navigateTo('/add-transaction');
      return;
    }

    /* / — focus search */
    if (e.key === '/') {
      const searchEl = document.getElementById('searchInput');
      if (searchEl) { e.preventDefault(); searchEl.focus(); searchEl.select(); }
      return;
    }

    /* Escape — close modal / sidebar */
    if (e.key === 'Escape') {
      const openModal = document.querySelector('.modal-overlay.open');
      if (openModal) { openModal.classList.remove('open'); return; }
      if (_sidebarOpen) { closeSidebar(); }
    }
  });

  /* --- Shortcut hint tooltip on search input --- */
  const searchEl = document.getElementById('searchInput');
  if (searchEl && !searchEl.placeholder.includes('/')) {
    searchEl.setAttribute('title', 'Press / to focus');
  }

  /* --- Redraw charts on resize (width-only: ignore mobile URL bar height changes) --- */
  let resizeTimer;
  let _lastInnerWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    if (w === _lastInnerWidth) return;
    _lastInnerWidth = w;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (typeof initDashboard === 'function') initDashboard().catch(console.error);
    }, 250);
  });
});

/* --- Filter badge helper (called by transactions.js) --- */
function updateFilterBadge(filters) {
  const clearBtn = document.getElementById('clearFilters');
  if (!clearBtn) return;
  const activeCount = Object.values(filters).filter(v => v !== '').length;
  if (activeCount > 0) {
    clearBtn.innerHTML = `Clear <span class="filter-count">${activeCount}</span>`;
  } else {
    clearBtn.textContent = 'Clear';
  }
}

/* --- Consistent error state (replaces ad-hoc per-page error markup) ---
   Renders a centered "couldn't load" card with an optional Retry button
   into `target` (an element or element id). */
function showErrorState(target, message, onRetry) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return;
  const esc = typeof escapeHTML === 'function' ? escapeHTML : (s => String(s));
  el.innerHTML = `
    <div class="error-state">
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <div class="error-state__msg">${esc(message || "Couldn't load this. Check your connection and try again.")}</div>
      ${onRetry ? '<button type="button" class="btn btn--ghost btn--sm" data-retry>Retry</button>' : ''}
    </div>`;
  const btn = el.querySelector('[data-retry]');
  if (btn) btn.addEventListener('click', () => onRetry());
  clearFieldLoading(el);
}

/* --- First-paint loading state on form controls ---
   Inputs/selects whose options or value come from the network ship with
   data-loading in the static HTML (see .form-control[data-loading]) so they
   shimmer instead of showing an empty or zeroed field on a slow connection.
   Page scripts call this once the field is populated.
   `root` is an element, an element id, or omitted for the whole document. */
function clearFieldLoading(root) {
  const scope = (typeof root === 'string' ? document.getElementById(root) : root) || document;
  if (!scope) return;
  if (scope.removeAttribute && scope.hasAttribute?.('data-loading')) scope.removeAttribute('data-loading');
  scope.querySelectorAll?.('[data-loading]').forEach(el => el.removeAttribute('data-loading'));
}

/* Safety net: a page script that throws before it clears its fields would
   leave them shimmering (and unusable — data-loading sets pointer-events:none)
   forever. Hand them back after a beat regardless. */
window.addEventListener('load', () => {
  setTimeout(() => clearFieldLoading(), 15000);
});

/* --- Number count-up animation --- */
function animateValue(el, endValue, formatter, duration = 550) {
  if (!el) return;
  const startValue = parseFloat(el.dataset.animFrom || '0');
  el.dataset.animFrom = String(endValue);
  /* rAF doesn't fire in background tabs — set the final value directly */
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (document.hidden || reduced || Math.abs(endValue - startValue) < 0.01) { el.textContent = formatter(endValue); return; }
  const startTime = performance.now();
  const ease = t => 1 - Math.pow(1 - t, 3);
  function tick(now) {
    const t = Math.min((now - startTime) / duration, 1);
    el.textContent = formatter(startValue + (endValue - startValue) * ease(t));
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = formatter(endValue);
  }
  requestAnimationFrame(tick);
}

/* --- Toast with an Undo action (reuses the .toast container styles) ---
   Shows `message` with an Undo button; clicking it runs onUndo. Auto-dismisses
   after `ms`. Used for reversible deletes. */
function showUndoToast(message, onUndo, ms = 6000) {
  const container = document.getElementById('toastContainer') || (() => {
    const el = document.createElement('div');
    el.id = 'toastContainer'; el.className = 'toast-container';
    document.body.appendChild(el);
    return el;
  })();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.style.display = 'flex';
  toast.style.alignItems = 'center';
  toast.style.gap = '12px';
  const label = document.createElement('span');
  label.textContent = message;
  label.style.flex = '1';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--ghost btn--sm';
  btn.textContent = 'Undo';
  btn.style.flexShrink = '0';
  toast.append(label, btn);
  container.appendChild(toast);

  let settled = false;
  const remove = () => {
    if (settled) return; settled = true;
    toast.classList.add('toast--dismissing');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 400);
  };
  btn.addEventListener('click', async e => {
    e.stopPropagation();
    if (settled) return; settled = true;
    toast.remove();
    try { await onUndo(); } catch (_) {}
  });
  setTimeout(remove, ms);
}

