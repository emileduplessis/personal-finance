/* ============================================================
   tour.js — first-visit guided tour (replaces the old "Welcome
   to Flow" card). The rest of the page blurs and darkens; a white
   frame marks one important control at a time and a small popup
   beside it explains it, with Back / Skip / Next and a progress bar.

   Runs once per browser (pf_tour_done). Settings → "Replay tour"
   clears that and opens /dashboard?tour=1.
   Usage: PFTour.maybeStart()  — call once the dashboard rendered.
   ============================================================ */

(function () {
  'use strict';

  const DONE_KEY = 'pf_tour_done';

  /* Each step targets the first VISIBLE match of its selectors, so one list
     serves desktop (sidebar/statbar) and phones (bottom nav). Steps whose
     target is hidden — a panel switched off, a guest-only control for a
     signed-in user — are skipped. */
  const STEPS = [
    {
      id: 'accounts', label: 'Start here',
      sel: ['#accountTiles'],
      title: 'Start with an account',
      body: 'Add your bank, cash or credit card with today’s balance. Every number on the dashboard builds from your accounts.',
    },
    {
      id: 'add', label: 'Add',
      sel: ['.statbar__add', '.bottom-nav__item--add'],
      title: 'Log anything in seconds',
      body: el => /log hours/i.test(el.getAttribute('aria-label') || '')
        ? 'Tap + to log the hours you worked. Transactions are one tap away in Transactions.'
        : 'Add an expense, income or transfer. It’s always one tap away.',
    },
    {
      /* only when the Log hours panel is on the dashboard (people who track hours) */
      id: 'hours', label: 'Hours',
      sel: ['#quickLog'],
      title: 'Track the hours you work',
      body: 'Log a shift here and see what you’ve earned before payday.',
    },
    {
      id: 'insights', label: 'Insights',
      sel: ['#topbar [data-insights-btn]'],
      title: 'Where did the month go?',
      body: 'The lightbulb shows patterns and alerts from your spending once you’ve logged a few weeks.',
    },
    {
      id: 'settings', label: 'Settings',
      sel: ['#topbar a[aria-label="Settings"]'],
      title: 'Currency and defaults',
      body: el => `Amounts show in ${localStorage.getItem('pf_currency') || 'CAD'} until you change it here. Your default account lives here too.`,
    },
    {
      id: 'signup', label: 'Sign up',
      sel: ['.topbar-auth__signup', '.topbar-auth__login'],
      title: 'Keep your data safe',
      body: 'Everything is saved on this device for now. Sign up to back it up and sync it — nothing you’ve added is lost.',
    },
  ];

  const isVisible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const findTarget = step => step.sel.map(s => document.querySelector(s)).find(isVisible) || null;

  let steps = [], i = 0, frame = null, pop = null, shade = null, target = null, onKey = null, onMove = null;

  function done() {
    try { localStorage.setItem(DONE_KEY, '1'); } catch (_) {}
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onMove);
    window.removeEventListener('scroll', onMove, true);
    frame?.remove(); pop?.remove(); shade?.remove();
    frame = pop = shade = target = null;
  }

  function place() {
    if (!target || !frame || !pop) return;
    const r = target.getBoundingClientRect();
    const pad = 4, gutter = 16, gap = 12;
    Object.assign(frame.style, {
      top: `${r.top - pad}px`, left: `${r.left - pad}px`,
      width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
    });

    const vw = document.documentElement.clientWidth, vh = window.innerHeight;

    /* blurred, darkened backdrop in four strips around the framed control,
       so the control itself stays sharp and lit (a single overlay with a hole
       can't exclude part of a backdrop-filter) */
    const hole = {
      t: Math.max(0, r.top - pad), l: Math.max(0, r.left - pad),
      b: Math.min(vh, r.bottom + pad), r: Math.min(vw, r.right + pad),
    };
    const [sTop, sBottom, sLeft, sRight] = shade.children;
    Object.assign(sTop.style,    { top: '0', left: '0', width: '100%', height: `${hole.t}px` });
    Object.assign(sBottom.style, { top: `${hole.b}px`, left: '0', width: '100%', height: `${Math.max(0, vh - hole.b)}px` });
    Object.assign(sLeft.style,   { top: `${hole.t}px`, left: '0', width: `${hole.l}px`, height: `${hole.b - hole.t}px` });
    Object.assign(sRight.style,  { top: `${hole.t}px`, left: `${hole.r}px`, width: `${Math.max(0, vw - hole.r)}px`, height: `${hole.b - hole.t}px` });
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    /* below the target if it fits, else above, else pinned inside the viewport */
    let top = r.bottom + pad + gap;
    if (top + ph > vh - gutter) top = r.top - pad - gap - ph;
    /* neither fits (a tall panel): sit at the bottom edge, over its lower part */
    if (top < gutter) top = vh - gutter - ph;
    const left = Math.min(vw - gutter - pw, Math.max(gutter, r.left + r.width / 2 - pw / 2));
    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(left)}px`;
  }

  function show(n) {
    i = n;
    const step = steps[i];
    target = findTarget(step);
    if (!target) {                               /* vanished since we started */
      steps.splice(i, 1);
      if (!steps.length) return done();
      return show(Math.min(i, steps.length - 1));
    }
    /* bring page content into view (instantly — the frame must land on it);
       fixed chrome (top bar, bottom nav, sidebar) is always on screen */
    const r = target.getBoundingClientRect();
    const inChrome = target.closest('#topbar, #bottomNav, #sidebar');
    const tall = r.height > window.innerHeight * 0.4;
    if (!inChrome && tall) {
      /* tall panel: pin its top just under the top bar so the popup fits below */
      window.scrollBy({ top: r.top - 72, behavior: 'instant' });
    } else if (!inChrome && (r.top < 64 || r.bottom > window.innerHeight - 80)) {
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
    }

    const total = steps.length, last = i === total - 1;
    const pad2 = x => String(x).padStart(2, '0');
    const body = typeof step.body === 'function' ? step.body(target) : step.body;
    pop.innerHTML = `
      <div class="tour-pop__kicker">${pad2(i + 1)} / ${pad2(total)} · ${step.label.toUpperCase()}</div>
      <div class="tour-pop__title" id="tourTitle">${step.title}</div>
      <p class="tour-pop__body" id="tourBody">${body}</p>
      <div class="tour-pop__row">
        <span class="tour-pop__links">
          ${i > 0 ? '<button type="button" class="tour-pop__link" data-tour="back">← Back</button><span aria-hidden="true">·</span>' : ''}
          ${last ? '' : '<button type="button" class="tour-pop__link" data-tour="skip">Skip</button>'}
        </span>
        <button type="button" class="tour-pop__next" data-tour="next">${last ? 'Done' : 'Next →'}</button>
      </div>
      <div class="tour-pop__progress" aria-hidden="true">
        ${steps.map((_, k) => `<span class="${k <= i ? 'is-on' : ''}"></span>`).join('')}
      </div>`;
    place();
    pop.querySelector('[data-tour="next"]').focus({ preventScroll: true });
  }

  function start() {
    if (frame) return;
    steps = STEPS.filter(s => findTarget(s))
      /* the Get started card already says "add an account first" — don't
         spend a tour step repeating it */
      .filter(s => !(s.id === 'accounts' && document.querySelector('#accountTiles .get-started')));
    if (!steps.length) return;

    shade = document.createElement('div');
    shade.className = 'tour-shade';
    shade.setAttribute('aria-hidden', 'true');
    shade.innerHTML = '<div></div><div></div><div></div><div></div>';
    frame = document.createElement('div');
    frame.className = 'tour-frame';
    frame.setAttribute('aria-hidden', 'true');
    pop = document.createElement('div');
    pop.className = 'tour-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-labelledby', 'tourTitle');
    pop.setAttribute('aria-describedby', 'tourBody');
    document.body.append(shade, frame, pop);

    pop.addEventListener('click', e => {
      const a = e.target.closest('[data-tour]')?.dataset.tour;
      if (a === 'next') i < steps.length - 1 ? show(i + 1) : done();
      else if (a === 'back' && i > 0) show(i - 1);
      else if (a === 'skip') done();
    });
    onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); done(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); i < steps.length - 1 ? show(i + 1) : done(); }
      else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); show(i - 1); }
    };
    onMove = () => requestAnimationFrame(place);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    show(0);
  }

  window.PFTour = {
    start,
    /* first visit (or ?tour=1 from Settings → Replay tour) */
    maybeStart() {
      const params = new URLSearchParams(location.search);
      const forced = params.get('tour') === '1';
      if (forced) history.replaceState(null, '', location.pathname + location.hash);
      let seen = false;
      try { seen = !!localStorage.getItem(DONE_KEY); } catch (_) {}
      if (seen && !forced) return;
      /* let the loader fade and late chrome (layout button, Log in) mount */
      setTimeout(start, 450);
    },
    reset() { try { localStorage.removeItem(DONE_KEY); } catch (_) {} },
  };
})();
