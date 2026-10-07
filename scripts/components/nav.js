/* ============================================================
   nav.js — Single source of truth for all navigation chrome.
   Renders the sidebar, topbar, bottom nav, Money pill tabs and
   the "More" bottom sheet from one config array.
   Must be loaded BEFORE ui.js (which wires menu/theme buttons).

   To add a new section: add one entry to NAV_ITEMS below.
   ============================================================ */

(function () {
  'use strict';

  /* ---- icons (lucide-style, stroke inherits currentColor) ---- */
  const I = (paths, size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

  const ICONS = {
    dashboard:     '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    transactions:  '<path d="M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4"/>',
    spending:      '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
    income:        '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    budget:        '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    subscriptions: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    crypto:        '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
    settings:      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    insights:      '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/>',
    shifts:        '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    add:           '<path d="M12 5v14M5 12h14"/>',
    money:         '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>',
    more:          '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    menu:          '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    /* theme switch — the button shows the mode it switches TO */
    sun:           '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon:          '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  };

  /* ---- nav config — hrefs are root-relative ----
     sidebar: shown in desktop sidebar / mobile drawer
     money:   grouped under the Money hub (pill tabs + Money bottom tab)
     sheet:   shown in the mobile "More" sheet                          */
  const NAV_ITEMS = [
    { id: 'dashboard',     label: 'Dashboard',       icon: 'dashboard',     href: 'dashboard.html',            sidebar: true, bottom: true },
    { id: 'transactions',  label: 'Transactions',    icon: 'transactions',  href: 'pages/accounts.html',       sidebar: true, bottom: true },
    /* not a page: the top-bar lightbulb (and a pinned bottom slot) open the
       Insights popover — scripts/components/insights-popover.js */
    { id: 'insights',      label: 'Insights',        icon: 'insights',      popover: true },
    /* `alt`: extra page keys that keep this item highlighted — the calendar is a
       second view of the Hours Tracker, not its own section. */
    { id: 'shifts',        label: 'Hours Tracker',   icon: 'shifts',        href: 'pages/shifts.html',         sidebar: true, sheet: true, alt: ['hours-calendar'] },
    /* "Money" is a hub: one sidebar/sheet entry that opens the money pages,
       which switch via the pill tabs at the top (Cash Flow · Budget · Subscriptions). */
    { id: 'money',         label: 'Money',           icon: 'money',         href: 'pages/spending.html',       sidebar: true, sheet: true, hub: true },
    { id: 'spending',      label: 'Cash Flow',       icon: 'spending',      href: 'pages/spending.html',       money: true },
    { id: 'budget',        label: 'Budget',          icon: 'budget',        href: 'pages/budget.html',         money: true },
    { id: 'subscriptions', label: 'Subscriptions',   icon: 'subscriptions', href: 'pages/subscriptions.html',  money: true },
    { id: 'crypto',        label: 'Crypto',          icon: 'crypto',        href: 'pages/crypto.html',         sidebar: true, sheet: true },
    { id: 'settings',      label: 'Settings',        icon: 'settings',      href: 'pages/settings.html',       sidebar: true, sheet: true },
    { id: 'add',           label: 'Add Transaction', icon: 'add',           href: 'pages/add-transaction.html', sidebar: true, accent: true },
  ];

  /* Clean, absolute section URLs. The files still live at /pages/*.html and are
     exposed at these paths by rewrites (vercel.json / serve.json), so links
     never carry the "pages/" folder or a ".html" suffix. The dashboard is
     "/dashboard"; "/" is the public landing page. */
  const CLEAN = {
    'dashboard.html':             '/dashboard',
    'pages/accounts.html':        '/transactions',
    'pages/shifts.html':          '/hours-tracker',
    'pages/hours-calendar.html':  '/hours-calendar',
    'pages/spending.html':        '/cash-flow',
    'pages/budget.html':          '/budget',
    'pages/subscriptions.html':   '/subscriptions',
    'pages/crypto.html':          '/crypto',
    'pages/settings.html':        '/settings',
    'pages/import.html':          '/import',
    'pages/privacy.html':         '/privacy',
    'pages/terms.html':           '/terms',
    'pages/add-transaction.html': '/add-transaction',
  };
  function resolve(href) {
    return CLEAN[href] || '/' + href.replace(/^pages\//, '').replace(/\.html$/, '');
  }

  /* last URL segment (".html" stripped) — the key we match active state on */
  function pageKey(href) { return (href.split('/').pop() || 'index.html').replace(/\.html$/, '') || 'index'; }
  const CURRENT = pageKey(window.location.pathname || '/');

  /* compare against the item's CLEAN url so renamed sections still match
     (e.g. pages/shifts.html → /hours-tracker) */
  function isActive(item) {
    return pageKey(resolve(item.href)) === CURRENT || (item.alt || []).includes(CURRENT);
  }

  const moneyItems = NAV_ITEMS.filter(n => n.money);
  const onMoneyPage = moneyItems.some(isActive);
  const moneyMatch = moneyItems.map(n => resolve(n.href)).join(',');

  /* data-match for ui.js's active-link pass, which otherwise only compares
     the href and would un-highlight the Money hub on /budget or the Hours
     Tracker on /hours-calendar. */
  function matchAttr(n) {
    const list = n.hub ? moneyMatch : n.alt ? [resolve(n.href), ...n.alt.map(a => '/' + a)].join(',') : '';
    return list ? ` data-match="${list}"` : '';
  }

  /* Nav prefs — same shape/validation as SettingsStore.getNavPrefs, read
     directly because nav.js renders before store.js is guaranteed loaded. */
  function navPrefs() {
    const p = { focus: null, slot: 'money' };
    try {
      const raw = JSON.parse(localStorage.getItem('pf_nav') || '{}');
      if (['money', 'hours', 'both'].includes(raw.focus)) p.focus = raw.focus;
      if (['money', 'shifts', 'crypto'].includes(raw.slot)) p.slot = raw.slot;
    } catch (_) {}
    return p;
  }

  /* ---- sidebar ----
     Desktop lists the money pages as their own entries; the mobile drawer
     keeps the single Money hub (pill tabs switch between them there).
     Both are rendered — CSS picks one per breakpoint. */
  function renderSidebar() {
    const el = document.getElementById('sidebar');
    if (!el) return;
    const link = (n, cls, active) => `
          <a href="${resolve(n.href)}" class="nav-item${cls}${active ? ' active' : ''}"${matchAttr(n)}>
            <span class="nav-icon">${I(ICONS[n.icon], 18)}</span>
            <span class="nav-label">${n.label}</span>
          </a>`;
    el.innerHTML = `
      <div class="sidebar-header">
        <a href="${resolve('dashboard.html')}" class="logo"><span class="logo-text">Flow</span></a>
      </div>
      <nav class="sidebar-nav">
        ${NAV_ITEMS.filter(n => n.sidebar).map(n => n.hub
          ? link(n, ' nav-item--hub', onMoneyPage) + moneyItems.map(m => link(m, ' nav-item--money', isActive(m))).join('')
          : link(n, n.accent ? ' nav-item--accent' : '', isActive(n))
        ).join('')}
      </nav>`;
  }

  /* ---- topbar ---- */
  function renderTopbar() {
    const el = document.getElementById('topbar');
    if (!el) return;
    const title   = document.body.dataset.title || document.title.split('—')[0].trim();
    const titleId = document.body.dataset.titleId ? ` id="${document.body.dataset.titleId}"` : '';
    /* light active → show a moon (tap for dark); dark active → show a sun */
    const themeIsLight = document.documentElement.dataset.theme === 'light';
    el.innerHTML = `
      <button class="menu-btn" id="menuBtn" aria-label="Open menu">${I(ICONS.menu, 20)}</button>
      <a class="topbar-logo" href="${resolve('dashboard.html')}">Flow</a>
      <div class="topbar-title"${titleId}>${title}</div>
      <div class="topbar-actions">
        <button type="button" class="topbar-icon-btn" data-insights-btn aria-label="Insights" title="Insights" aria-haspopup="dialog" aria-expanded="false">${I(ICONS.insights, 17)}</button>
        <button type="button" class="topbar-icon-btn theme-toggle" id="themeToggle" data-theme-btn="${themeIsLight ? 'light' : 'dark'}" aria-label="${themeIsLight ? 'Switch to dark theme' : 'Switch to light theme'}" title="${themeIsLight ? 'Switch to dark theme' : 'Switch to light theme'}">
          <span class="theme-toggle__icon theme-toggle__icon--moon">${I(ICONS.moon, 17)}</span>
          <span class="theme-toggle__icon theme-toggle__icon--sun">${I(ICONS.sun, 17)}</span>
        </button>
        <a href="${resolve('pages/settings.html')}" class="topbar-icon-btn${CURRENT === 'settings' ? ' topbar-icon-btn--active' : ''}" aria-label="Settings" title="Settings">${I(ICONS.settings, 17)}</a>
      </div>`;
    document.getElementById('themeToggle')?.addEventListener('click', (e) => {
      if (typeof PFTheme === 'undefined') return;
      const btn = e.currentTarget;
      const next = PFTheme.toggle();                 /* flips CSS instantly, returns 'light'|'dark' */
      const light = next === 'light';
      btn.dataset.themeBtn = light ? 'light' : 'dark';   /* drives the moon⇄sun swap */
      const label = light ? 'Switch to dark theme' : 'Switch to light theme';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    });
  }

  /* ---- bottom nav: Dashboard · Transactions · [+] · <slot> · More ----
     <slot> is the user's pinned section (Money by default; Settings picks it).
     With focus 'hours' the + logs hours instead of adding a transaction. */
  const SHORT_LABEL = { shifts: 'Hours' };
  function renderBottomNav() {
    const el = document.getElementById('bottomNav');
    if (!el) return;
    const item = (n, label) => n.popover ? `
      <button type="button" class="bottom-nav__item" data-insights-btn aria-haspopup="dialog" aria-expanded="false">
        <span class="bottom-nav__icon">${I(ICONS[n.icon], 20)}</span>
        <span class="bottom-nav__label">${label || n.label}</span>
      </button>` : `
      <a href="${resolve(n.href)}" class="bottom-nav__item${(n.hub ? onMoneyPage : isActive(n)) ? ' active' : ''}"${matchAttr(n)}>
        <span class="bottom-nav__icon">${I(ICONS[n.icon], 20)}</span>
        <span class="bottom-nav__label">${label || n.label}</span>
      </a>`;
    const { focus, slot } = navPrefs();
    const dash   = NAV_ITEMS.find(n => n.id === 'dashboard');
    const txs    = NAV_ITEMS.find(n => n.id === 'transactions');
    const add    = NAV_ITEMS.find(n => n.id === 'add');
    const pinned = NAV_ITEMS.find(n => n.id === slot);
    const plus   = focus === 'hours'
      ? { href: resolve('pages/shifts.html') + '#log', label: 'Log hours' }
      : { href: resolve(add.href), label: 'Add transaction' };
    el.innerHTML = `
      ${item(dash)}
      ${item(txs)}
      <a href="${plus.href}" class="bottom-nav__item bottom-nav__item--add" aria-label="${plus.label}">
        <span class="bottom-nav__icon">${I(ICONS.add, 22)}</span>
      </a>
      ${item(pinned, SHORT_LABEL[slot])}
      <button type="button" class="bottom-nav__item" id="moreNavBtn" aria-haspopup="dialog" aria-expanded="false">
        <span class="bottom-nav__icon">${I(ICONS.more, 20)}</span>
        <span class="bottom-nav__label">More</span>
      </button>`;
  }

  /* ---- Money hub pill tabs (only on money pages) ---- */
  function renderMoneyTabs() {
    if (!onMoneyPage) return;
    const main = document.querySelector('.main-content');
    if (!main) return;
    const wrap = document.createElement('nav');
    wrap.className = 'money-tabs';
    wrap.setAttribute('aria-label', 'Money sections');
    wrap.innerHTML = moneyItems.map(n =>
      `<a href="${resolve(n.href)}" class="money-tab${isActive(n) ? ' active' : ''}">${n.label}</a>`
    ).join('');
    main.prepend(wrap);
  }

  /* ---- "More" bottom sheet ---- */
  /* everything in the sheet except whatever is already pinned to the bar.
     When Money isn't pinned, its pages are listed one by one (like the desktop
     sidebar) instead of behind the single Money hub. */
  function sheetGridHtml() {
    const { slot } = navPrefs();
    return NAV_ITEMS.filter(n => n.sheet && n.id !== slot)
      .flatMap(n => n.hub ? moneyItems : [n])
      .map(n => `
          <a href="${resolve(n.href)}" class="more-sheet__item${(n.hub ? onMoneyPage : isActive(n)) ? ' active' : ''}">
            <span class="more-sheet__icon">${I(ICONS[n.icon], 20)}</span>
            <span>${n.label}</span>
          </a>`).join('');
  }

  function renderMoreSheet() {
    const backdrop = document.createElement('div');
    backdrop.className = 'more-backdrop';
    backdrop.id = 'moreBackdrop';
    const sheet = document.createElement('div');
    sheet.className = 'more-sheet';
    sheet.id = 'moreSheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'More sections');
    sheet.innerHTML = `
      <div class="more-sheet__handle"></div>
      <div class="more-sheet__grid">${sheetGridHtml()}</div>`;
    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);

    /* the More button is looked up per click — refresh() re-renders the bar */
    const expand = on => document.getElementById('moreNavBtn')?.setAttribute('aria-expanded', String(on));
    const open  = () => { sheet.classList.add('open'); backdrop.classList.add('open'); expand(true); };
    const close = () => { sheet.classList.remove('open'); backdrop.classList.remove('open'); expand(false); };
    document.addEventListener('click', e => {
      if (e.target.closest('#moreNavBtn')) sheet.classList.contains('open') ? close() : open();
    });
    backdrop.addEventListener('click', close);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }

  /* Re-render the pref-driven chrome after the user changes their nav prefs
     (Settings, or the dashboard focus question) — no reload needed. */
  window.PFNav = {
    refresh() {
      renderBottomNav();
      const grid = document.querySelector('#moreSheet .more-sheet__grid');
      if (grid) grid.innerHTML = sheetGridHtml();
    },
  };

  /* ---- topbar Log in / Sign up — only while nobody is logged in ----
     Shown straight away when there's no stored session (no flash on first
     paint), then confirmed against the real session. */
  function setTopbarAuth(guest) {
    const bar = document.getElementById('topbar');
    if (!bar) return;
    let el = document.getElementById('topbarAuth');
    if (!guest) { el?.remove(); return; }
    if (el) return;
    el = document.createElement('div');
    el.className = 'topbar-auth';
    el.id = 'topbarAuth';
    el.innerHTML = `
      <span class="topbar-auth__sep" aria-hidden="true"></span>
      <a class="topbar-auth__login" href="/login">Log in</a>
      <a class="topbar-auth__signup" href="/login?mode=signup">Sign up</a>`;
    bar.querySelector('.topbar-actions')?.appendChild(el);
  }

  renderSidebar();
  renderTopbar();
  renderBottomNav();
  renderMoneyTabs();
  renderMoreSheet();
  if (typeof SupaAuth !== 'undefined' && window.top === window.self) {
    setTopbarAuth(!SupaAuth.hasStoredSession());
    SupaAuth.isGuest().then(setTopbarAuth);
  }

  /* Insights popover — its script loads on the first click. /insights (the old
     page) redirects to /dashboard?insights=1, which opens it straight away. */
  function loadInsights() {
    if (window.PFInsights) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/scripts/components/insights-popover.js';
      s.onload = res; s.onerror = rej;
      document.body.appendChild(s);
    });
  }
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-insights-btn]');
    if (btn) loadInsights().then(() => window.PFInsights.toggle(btn)).catch(() => {});
  });
  if (new URLSearchParams(location.search).get('insights') === '1') {
    history.replaceState(null, '', location.pathname + location.hash);
    const btn = document.querySelector('#topbar [data-insights-btn]');
    if (btn) window.addEventListener('load', () => loadInsights().then(() => window.PFInsights.toggle(btn)));
  }

  /* Load the site-wide Add-Transaction popup once. Skipped inside the embed
     iframe (which is itself the add form) so it never nests. */
  if (window.top === window.self && !document.getElementById('pf-add-modal-js')) {
    const s = document.createElement('script');
    s.id = 'pf-add-modal-js';
    s.src = '/scripts/components/add-modal.js';
    document.body.appendChild(s);
  }
})();
