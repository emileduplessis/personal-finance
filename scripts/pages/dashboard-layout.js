/* ============================================================
   dashboard-layout.js — customizable dashboard (locked slots).

   Model: a DESIGN is a locked template — a fixed set of SLOTS whose
   positions and sizes are hand-authored in dashboard.css. The grid
   itself can't be rearranged; the only thing the user changes is WHICH
   panel sits in each slot (click a slot's name to pick, or drag one
   panel onto another to swap them).

   Because every slot's geometry is declared in CSS, alignment is exact
   by construction — nothing reflows, so nothing can go ragged. And
   because assignments only change on drop (never during the drag), the
   old drag-jitter is impossible here.

   Two families:
     classic — the original two independent columns, exactly as the live
       site renders it. Its "slots" are positions in those columns, and
       the data-driven panels (crypto/bills/over-budget) still hide
       themselves when empty, as they always have.
     focus / tracker / compact — locked grid templates (grid-template-
       areas). A slot here is never empty: panels with no data aren't
       offered, and if a slotted panel loses its data it's auto-swapped
       for one that has some.

   Config lives in the synced `ui_prefs.dashboardLayout` blob, mirrored
   to localStorage. With no saved config nothing moves — the static
   markup in index.html already IS Classic.

   IIFE-wrapped so its locals can't collide with store.js globals.
   ============================================================ */
(function () {
  'use strict';

  /* `conditional: true` = dashboard.js hides this panel (via the `hidden`
     attribute) when it has no data. Order doubles as priority when we need to
     auto-fill a slot. */
  const PANELS = [
    { id: 'balanceChart',  label: 'Balance & forecast' },
    { id: 'transactions',  label: 'Transactions' },
    { id: 'accounts',      label: 'Accounts' },
    { id: 'overview',      label: 'Overview' },
    { id: 'moneyDuo',      label: 'Allocation & month' },
    /* conditional: only shown to people who track hours (Main use = hours or
       both) or who already logged some — see applyQuickLogVisibility */
    { id: 'quickLog',      label: 'Log hours',          conditional: true },
    /* conditional because it can be switched off in Settings → Goals, which
       hides the panel exactly the way an empty data-driven panel hides: a
       locked slot then auto-fills and the picker stops offering it. */
    { id: 'nwGoal',        label: 'Net-worth goal',     conditional: true },
    { id: 'crypto',        label: 'Crypto',             conditional: true },
    { id: 'budgetWatch',   label: 'Over budget',        conditional: true },
    { id: 'upcomingBills', label: 'Upcoming bills',     conditional: true },
  ];
  const BY_ID  = Object.fromEntries(PANELS.map(p => [p.id, p]));
  const LS_KEY = 'pf_dash_layout';
  const SCHEMA = 7;   /* bump to retire an incompatible saved config */
  const MIGRATABLE = [6, 7];   /* versions normalize() can read; anything older is dropped */

  /* Slot geometry lives in dashboard.css (grid-template-areas). Keep the slot
     ids here in sync with the areas declared there. */
  const DESIGNS = [
    {
      /* the original dashboard, exactly as the live site renders it:
         two independent columns, l* = main column, r* = side column */
      /* Overview is deliberately NOT placed here: the base template leaves it
         out. It's still a real panel — Focus and Compact use it, and it stays
         in the slot picker, so it can be dropped into any Classic slot. */
      id: 'classic', label: 'Classic', type: 'columns',
      slots: ['l1', 'l2', 'l3', 'l4', 'l5', 'r1', 'r2', 'r3', 'r4'],
      assign: {
        l1: 'accounts', l2: 'crypto', l3: 'moneyDuo', l4: 'nwGoal', l5: 'balanceChart',
        r1: 'quickLog', r2: 'budgetWatch', r3: 'upcomingBills', r4: 'transactions',
      },
    },
    {
      /* "a a" / "b c" / "d d" */
      id: 'focus', label: 'Focus', type: 'grid',
      slots: ['a', 'b', 'c', 'd'],
      assign: { a: 'balanceChart', b: 'transactions', c: 'overview', d: 'accounts' },
    },
    {
      /* "a a b" / "c d b" / "e e e" */
      id: 'tracker', label: 'Tracker', type: 'grid',
      slots: ['a', 'b', 'c', 'd', 'e'],
      assign: { a: 'balanceChart', b: 'quickLog', c: 'accounts', d: 'moneyDuo', e: 'transactions' },
    },
    {
      /* "a a b b c c" / "d d d e e e" / "f f f f f f" */
      id: 'compact', label: 'Compact', type: 'grid',
      slots: ['a', 'b', 'c', 'd', 'e', 'f'],
      assign: { a: 'accounts', b: 'nwGoal', c: 'overview', d: 'balanceChart', e: 'transactions', f: 'moneyDuo' },
    },
  ];
  const designById = id => DESIGNS.find(d => d.id === id) || DESIGNS[0];

  const ICON_LAYOUT = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="18"/><rect x="14" y="3" width="7" height="9"/><rect x="14" y="16" width="7" height="5"/></svg>';
  const ICON_DRAG   = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

  let cfg = null;
  let editing = false;
  let saveTimer = null;
  let dataObserver = null;

  const $    = id => document.getElementById(id);
  const grid = () => $('dashGrid');
  const panelEl = id => grid()?.querySelector(`[data-panel="${id}"]`);

  /* A panel "has data" unless it's one of the conditional ones and dashboard.js
     has hidden it. */
  function hasData(id) {
    const p = BY_ID[id];
    if (!p) return false;
    if (!p.conditional) return true;
    const el = panelEl(id);
    return !!el && !el.hidden;
  }

  /* ---- config ---------------------------------------------------------- */
  /* Every design keeps its OWN slot assignments (cfg.byDesign[designId]), so
     rearranging Compact and switching to Focus and back returns you to the
     Compact you built. A design you've never opened is seeded from its
     defaults on first use. */
  const defaults = () => ({
    v: SCHEMA,
    design: DESIGNS[0].id,                                   /* Classic = the live layout */
    byDesign: { [DESIGNS[0].id]: { ...DESIGNS[0].assign } },
    evicted: {},
  });

  /* Validate one design's assignments: drop unknown/duplicate panels, then
     fill any empty slot from the design's own default (or any unused panel) —
     a slot must never be empty. */
  function normalizeAssign(d, raw) {
    const assign = {};
    const used = new Set();
    for (const s of d.slots) {
      const id = raw && raw[s];
      if (BY_ID[id] && !used.has(id)) { assign[s] = id; used.add(id); }
    }
    for (const s of d.slots) {
      if (assign[s]) continue;
      const pick = (!used.has(d.assign[s]) && d.assign[s])
        || PANELS.find(p => !used.has(p.id))?.id;
      if (pick) { assign[s] = pick; used.add(pick); }
    }
    return assign;
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return defaults();
    /* v6 stored a single `assign` for whichever design was active — fold it
       into that design's slot rather than discarding the user's layout. */
    if (raw.v === 6 && raw.design && raw.assign) {
      raw = { v: SCHEMA, design: raw.design, byDesign: { [raw.design]: raw.assign } };
    }
    if (raw.v !== SCHEMA) return defaults();
    const d = DESIGNS.find(x => x.id === raw.design) || DESIGNS[0];
    const byDesign = {};
    for (const des of DESIGNS) {
      const saved = raw.byDesign && raw.byDesign[des.id];
      if (saved) byDesign[des.id] = normalizeAssign(des, saved);   /* keep only what's been used */
    }
    if (!byDesign[d.id]) byDesign[d.id] = normalizeAssign(d, d.assign);
    /* `evicted` is carried through as-is: it's an optional field, so configs
       saved before it existed simply arrive without one (no schema bump, so
       nobody's layout resets). Shape: { designId: { slot: panelId } }. */
    const evicted = {};
    for (const des of DESIGNS) {
      const saved = raw.evicted && raw.evicted[des.id];
      if (!saved || typeof saved !== 'object') continue;
      const keep = {};
      for (const s of des.slots) if (BY_ID[saved[s]]) keep[s] = saved[s];
      if (Object.keys(keep).length) evicted[des.id] = keep;
    }
    return { v: SCHEMA, design: d.id, byDesign, evicted };
  }

  /* the active design's assignments, seeded on first use */
  function curAssign() {
    const d = designById(cfg.design);
    if (!cfg.byDesign[d.id]) cfg.byDesign[d.id] = normalizeAssign(d, d.assign);
    return cfg.byDesign[d.id];
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;                    /* untouched → leave the markup alone */
      const parsed = JSON.parse(raw);
      if (!parsed || !MIGRATABLE.includes(parsed.v)) { localStorage.removeItem(LS_KEY); return null; }
      return normalize(parsed);
    } catch (_) { return null; }
  }

  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (_) {}
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (typeof SettingsStore !== 'undefined' && SettingsStore.setUiPref) {
        try { SettingsStore.setUiPref({ dashboardLayout: cfg }); } catch (_) {}
      }
    }, 400);
  }

  /* ---- data rule (locked templates only) --------------------------------
     A slot must never be empty, so a panel with no data can't stay in one. If
     it loses its data we swap in the highest-priority panel that has some and
     isn't already placed. Classic is exempt: there the data-driven panels hide
     themselves and the column closes up, exactly as the live site does. */
  function enforceData(d) {
    if (d.type !== 'grid') return false;
    const assign = curAssign();
    let changed = false;
    const used = new Set(d.slots.map(s => assign[s]).filter(Boolean));
    if (!cfg.evicted) cfg.evicted = {};
    const eviction = cfg.evicted[d.id] || (cfg.evicted[d.id] = {});

    /* Reclaim first: a panel that was auto-swapped out gets its slot back once
       it has data again — otherwise switching a goal off and on again (or a
       wallet regaining a balance) would leave the panel gone for good, because
       the substitution is saved. The stand-in simply becomes unplaced. */
    for (const s of d.slots) {
      const orig = eviction[s];
      if (!orig || !hasData(orig) || used.has(orig)) continue;
      used.delete(assign[s]);
      assign[s] = orig;
      used.add(orig);
      delete eviction[s];
      changed = true;
    }

    for (const s of d.slots) {
      const cur = assign[s];
      if (cur && hasData(cur)) continue;
      const rep = PANELS.find(p => hasData(p.id) && !used.has(p.id));
      if (!rep) continue;
      used.delete(cur);
      assign[s] = rep.id;
      used.add(rep.id);
      if (cur) eviction[s] = cur;      /* remember who to give the slot back to */
      changed = true;
    }
    return changed;
  }

  /* ---- FLIP animation ---------------------------------------------------
     Panels glide from where they were to where they land (First-Last-Invert-
     Play): measure, move, translate back to the old spot, then release. It's
     translate-only on purpose — scaling a panel to its new size would stretch
     its text and charts; letting the size snap while the position glides is
     what makes the iOS icon-rearrange read cleanly. */
  const reducedMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function snapshot() {
    const m = new Map();
    for (const p of PANELS) {
      const el = panelEl(p.id);
      if (el && getComputedStyle(el).display !== 'none') m.set(el, el.getBoundingClientRect());
    }
    return m;
  }

  function flip(first) {
    if (!first) return;
    /* Drop any leftover transform (the drag we just finished still has one) so
       the "Last" measurement is the panel's true resting position. r0 was
       captured WITH it, which is what makes the panel glide from the cursor. */
    for (const [el] of first) { el.style.transition = 'none'; el.style.transform = ''; }
    if (reducedMotion()) { for (const [el] of first) el.style.transition = ''; return; }
    const moving = [];
    for (const [el, r0] of first) {
      if (getComputedStyle(el).display === 'none') continue;
      const r1 = el.getBoundingClientRect();
      const dx = r0.left - r1.left, dy = r0.top - r1.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.style.transition = 'none';                 /* invert without animating */
      el.style.transform  = `translate(${dx}px, ${dy}px)`;
      el.classList.add('is-flipping');
      moving.push(el);
    }
    /* panels that just appeared (weren't visible before) fade in instead */
    for (const p of PANELS) {
      const el = panelEl(p.id);
      if (!el || first.has(el) || getComputedStyle(el).display === 'none') continue;
      el.classList.add('is-entering');
      el.addEventListener('animationend', () => el.classList.remove('is-entering'), { once: true });
    }
    if (!moving.length) return;
    requestAnimationFrame(() => {
      for (const el of moving) {
        el.style.transition = '';                   /* hand back to the CSS transition */
        el.style.transform  = '';
        const done = () => {
          el.classList.remove('is-flipping');
          el.removeEventListener('transitionend', done);
        };
        el.addEventListener('transitionend', done);
      }
    });
  }

  /* Canvas charts size their pixel buffer from the canvas's layout size at
     draw time, so a panel that changed width leaves a stretched (or, if it was
     hidden, blank) chart behind. Nothing else re-renders them, so do it here
     whenever the layout actually changed. */
  let refitTimer = null;
  function refitCharts() {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => {
      try {
        if (typeof renderBalanceChart === 'function') Promise.resolve(renderBalanceChart()).catch(() => {});
        if (typeof renderMonthlyChart === 'function' && typeof TransactionStore !== 'undefined') {
          TransactionStore.getAll().then(tx => renderMonthlyChart(tx)).catch(() => {});
        }
      } catch (_) { /* dashboard.js not loaded (e.g. under test) */ }
    }, 60);   /* let the new layout settle before measuring */
  }

  /* ---- apply ----------------------------------------------------------- */
  function apply(opts = {}) {
    const g = grid();
    if (!g || !cfg) return;
    const first = opts.animate ? snapshot() : null;
    const d = designById(cfg.design);
    const swapped = enforceData(d);      /* a panel lost its data and was replaced */
    if (swapped) save();
    g.dataset.design = d.id;
    if (d.type === 'columns') applyColumns(d); else applyGrid(d);
    if (editing) { removeChrome(); addChrome(); }
    if (first) flip(first);
    if (opts.refit || swapped) refitCharts();
  }

  function applyColumns(d) {
    const g = grid();
    let cols = [...g.querySelectorAll('.dash-col')];
    while (cols.length < 2) {
      const c = document.createElement('div');
      c.className = 'dash-col';
      g.appendChild(c);
      cols = [...g.querySelectorAll('.dash-col')];
    }
    const assign = curAssign();
    const placed = new Set();
    for (const s of d.slots) {
      const el = panelEl(assign[s]);
      if (!el) continue;
      el.dataset.slot = s;
      placed.add(assign[s]);
      cols[s[0] === 'l' ? 0 : 1].appendChild(el);   /* appendChild moves */
    }
    /* A panel this design doesn't place (Overview in Classic) must be marked
       unplaced, exactly as applyGrid does. Without this it would keep the slot
       a locked template gave it and linger outside both columns — a stray item
       in the .dash-body grid, reading as a third column. */
    for (const p of PANELS) {
      if (placed.has(p.id)) continue;
      const el = panelEl(p.id);
      if (el) el.dataset.slot = 'none';
    }
  }

  function applyGrid(d) {
    const g = grid();
    /* unwrap the classic columns — panels become direct grid items */
    g.querySelectorAll('.dash-col').forEach(c => {
      g.append(...c.querySelectorAll('[data-panel]'));
      c.remove();
    });
    const assign = curAssign();
    const placed = new Set();
    for (const s of d.slots) {
      const el = panelEl(assign[s]);
      if (!el) continue;
      el.dataset.slot = s;
      placed.add(assign[s]);
      g.appendChild(el);
    }
    /* anything not in this template simply isn't rendered */
    for (const p of PANELS) {
      if (placed.has(p.id)) continue;
      const el = panelEl(p.id);
      if (el) el.dataset.slot = 'none';
    }
  }

  const slotOf = el => el?.dataset.slot;

  /* ---- assignment ------------------------------------------------------ */
  /* A slot the user has just set by hand is theirs: drop any auto-eviction
     record for it, so the reclaim pass can't take it back off them later. */
  function clearEviction(...slots) {
    const e = cfg.evicted && cfg.evicted[cfg.design];
    if (!e) return;
    for (const s of slots) if (s) delete e[s];
  }

  function assignToSlot(slot, panelId) {
    const d = designById(cfg.design);
    const assign = curAssign();
    const other = d.slots.find(s => assign[s] === panelId);
    const cur = assign[slot];
    assign[slot] = panelId;
    if (other && other !== slot) assign[other] = cur;   /* swap the two */
    clearEviction(slot, other);
    apply({ animate: true, refit: true }); save();
  }

  function swapSlots(s1, s2) {
    if (!s1 || !s2 || s1 === s2) return;
    const assign = curAssign();
    const t = assign[s1];
    assign[s1] = assign[s2];
    assign[s2] = t;
    clearEviction(s1, s2);
    apply({ animate: true, refit: true }); save();
  }

  /* ---- edit chrome ----------------------------------------------------- */
  function addChrome() {
    const d = designById(cfg.design);
    const assign = curAssign();
    for (const s of d.slots) {
      const id = assign[s];
      const el = panelEl(id);
      if (!el || el.querySelector('.dash-panel__chrome')) continue;
      const bar = document.createElement('div');
      bar.className = 'dash-panel__chrome';
      bar.innerHTML = `
        <span class="dash-panel__handle" title="Drag onto another panel to swap" aria-label="Drag ${BY_ID[id].label}">${ICON_DRAG}</span>
        <button type="button" class="dash-panel__name dash-panel__name--btn" data-act="pick" aria-haspopup="listbox">
          ${BY_ID[id].label} <span class="dash-panel__caret">▾</span>
        </button>`;
      el.prepend(bar);
      bar.querySelector('[data-act="pick"]').addEventListener('click', ev => {
        ev.stopPropagation();
        openSlotMenu(s, bar.querySelector('[data-act="pick"]'));
      });
      bar.querySelector('.dash-panel__handle').addEventListener('pointerdown', e => startDrag(e, el));
    }
  }
  const removeChrome = () => {
    grid()?.querySelectorAll('.dash-panel__chrome').forEach(n => n.remove());
    closeSlotMenu();
  };

  /* ---- slot picker ----------------------------------------------------- */
  function closeSlotMenu() { $('dashSlotMenu')?.remove(); }

  function openSlotMenu(slot, anchor) {
    closeSlotMenu();
    const d = designById(cfg.design);
    const cur = curAssign()[slot];
    /* only offer panels that actually have data — a slot must never be empty */
    const options = PANELS.filter(p => hasData(p.id));
    const menu = document.createElement('div');
    menu.className = 'dash-slotmenu';
    menu.id = 'dashSlotMenu';
    menu.setAttribute('role', 'listbox');
    menu.innerHTML = options.map(p =>
      `<button type="button" class="dash-slotmenu__item${p.id === cur ? ' is-current' : ''}" role="option" data-pick="${p.id}">${p.id === cur ? '✓ ' : ''}${p.label}</button>`).join('');
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
    menu.style.top  = (r.bottom + window.scrollY) + 'px';
    menu.querySelectorAll('[data-pick]').forEach(b =>
      b.addEventListener('click', () => { assignToSlot(slot, b.dataset.pick); closeSlotMenu(); }));
    setTimeout(() => document.addEventListener('click', closeSlotMenu, { once: true }), 0);
  }

  /* ---- drag to swap (pointer-based: touch + mouse) ----------------------
     The dragged panel is lifted out of the flow and follows the pointer; the
     slot under it is highlighted. Assignments change only on DROP, so nothing
     reflows mid-drag — the jitter the insert-as-you-go approach suffered from
     can't happen here. A 5px threshold keeps a plain click from lurching. */
  const DRAG_THRESHOLD = 5;
  const EDGE = 72, EDGE_SPEED = 16;

  function startDrag(e, el) {
    if (!editing) return;
    const startX = e.clientX, startY = e.clientY;
    let lifted = false, lastY = startY, raf = null, target = null;
    /* the page can scroll under the pointer (edge auto-scroll), so track it or
       the panel would drift away from the cursor */
    const scroll0 = { x: window.scrollX, y: window.scrollY };

    const lift = () => {
      el.classList.add('is-dragging');
      document.body.classList.add('dash-dragging');
      lifted = true;
      raf = requestAnimationFrame(edgeScroll);
    };
    const edgeScroll = () => {
      if (!lifted) return;
      if (lastY < EDGE) window.scrollBy(0, -EDGE_SPEED);
      else if (lastY > window.innerHeight - EDGE) window.scrollBy(0, EDGE_SPEED);
      raf = requestAnimationFrame(edgeScroll);
    };
    const clearTarget = () => { target?.classList.remove('is-drop-target'); target = null; };

    const move = ev => {
      if (!lifted) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        lift();
      }
      ev.preventDefault();
      lastY = ev.clientY;
      /* translate by the pointer delta (+ any scroll since we picked it up) —
         relative to the panel's own box, so no containing-block surprises */
      const dx = (ev.clientX - startX) + (window.scrollX - scroll0.x);
      const dy = (ev.clientY - startY) + (window.scrollY - scroll0.y);
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      /* .is-dragging is pointer-events:none, so this sees what's underneath */
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-panel]');
      const valid = over && over !== el && slotOf(over) && slotOf(over) !== 'none';
      if (valid && over !== target) { clearTarget(); target = over; target.classList.add('is-drop-target'); }
      else if (!valid && target) clearTarget();
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (!lifted) return;                 /* just a click — nothing moved */
      cancelAnimationFrame(raf);
      const dest = target;
      clearTarget();
      el.classList.remove('is-dragging');
      document.body.classList.remove('dash-dragging');
      if (dest) {
        /* keep the drag transform on: flip() snapshots from where you actually
           dropped it, so the panel glides from the cursor into its new slot */
        swapSlots(slotOf(el), slotOf(dest));
      } else {
        /* dropped on nothing — glide back home */
        el.classList.add('is-flipping');
        requestAnimationFrame(() => { el.style.transform = ''; });
        el.addEventListener('transitionend', () => el.classList.remove('is-flipping'), { once: true });
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  /* ---- toolbar --------------------------------------------------------- */
  function mountButton(tries = 0) {
    const actions = document.querySelector('#topbar .topbar-actions');
    if (!actions) { if (tries < 20) requestAnimationFrame(() => mountButton(tries + 1)); return; }
    if ($('dashCustomizeBtn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'dashCustomizeBtn';
    btn.className = 'topbar-icon-btn';
    btn.setAttribute('aria-label', 'Customize dashboard');
    btn.innerHTML = ICON_LAYOUT;
    btn.addEventListener('click', () => setEditing(!editing));
    actions.prepend(btn);
  }

  function buildToolbar() {
    const g = grid();
    if (!g || $('dashToolbar')) return;
    const bar = document.createElement('div');
    bar.className = 'dash-toolbar';
    bar.id = 'dashToolbar';
    bar.hidden = true;
    bar.innerHTML = `
      <span class="dash-toolbar__label">Design</span>
      <div class="seg-toggle dash-gridpick" id="dashDesignPick" role="group" aria-label="Dashboard design">
        ${DESIGNS.map(d => `<button type="button" class="seg-btn" data-design="${d.id}">${d.label}</button>`).join('')}
      </div>
      <span class="dash-toolbar__hint">The layout is fixed — click a panel’s name to swap it, or drag one onto another</span>
      <div class="dash-toolbar__spacer"></div>
      <button type="button" class="btn btn--primary btn--sm" id="dashDoneBtn">Done</button>`;
    g.parentNode.insertBefore(bar, g);
    $('dashDoneBtn').addEventListener('click', () => setEditing(false));
    $('dashDesignPick').querySelectorAll('[data-design]').forEach(b =>
      b.addEventListener('click', () => applyDesign(b.dataset.design)));
  }

  /* Switching design keeps each design's own arrangement — we only change which
     one is active. A design opened for the first time is seeded from its
     defaults (curAssign does that); one you've customised comes back exactly as
     you left it. */
  function applyDesign(id) {
    const d = designById(id);
    if (!cfg) cfg = defaults();
    cfg.design = d.id;
    curAssign();                       /* seed on first visit */
    apply({ animate: true, refit: true }); save(); syncDesignPick();
    if (typeof showToast === 'function') showToast(`${d.label} design applied`, 'success');
  }

  const syncDesignPick = () => $('dashDesignPick')?.querySelectorAll('[data-design]')
    .forEach(b => b.classList.toggle('active', b.dataset.design === cfg.design));

  function setEditing(on) {
    editing = on;
    if (on && !cfg) cfg = defaults();
    buildToolbar();
    document.body.classList.toggle('dash-editing', on);
    grid()?.classList.toggle('is-editing', on);
    $('dashCustomizeBtn')?.classList.toggle('topbar-icon-btn--active', on);
    const bar = $('dashToolbar');
    if (bar) bar.hidden = !on;
    if (on) { addChrome(); syncDesignPick(); }
    else    { removeChrome(); }
  }

  /* ---- boot ------------------------------------------------------------ */
  function watchData() {
    /* dashboard.js flips `hidden` on the conditional panels once data loads —
       re-run the slot rule when that happens */
    dataObserver?.disconnect();
    dataObserver = new MutationObserver(() => { if (cfg) apply(); });
    for (const p of PANELS) {
      if (!p.conditional) continue;
      const el = panelEl(p.id);
      if (el) dataObserver.observe(el, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  function boot() {
    if (!grid()) return;
    mountButton();
    watchData();

    const local = loadLocal();
    if (local) { cfg = local; apply(); }   /* no saved config → markup is already Classic */

    if (typeof SettingsStore !== 'undefined' && SettingsStore.getUiPrefs) {
      SettingsStore.getUiPrefs()
        .then(prefs => {
          const saved = prefs && prefs.dashboardLayout;
          if (!saved || !MIGRATABLE.includes(saved.v)) return;   /* stale/absent → keep Classic */
          const server = normalize(saved);
          if (cfg && JSON.stringify(server) === JSON.stringify(cfg)) return;
          cfg = server;
          try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (_) {}
          apply();
          if (editing) syncDesignPick();
        })
        .catch(() => {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
