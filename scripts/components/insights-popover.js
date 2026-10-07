/* ============================================================
   insights-popover.js — the Insights feed as a popover under the
   top-bar lightbulb (it replaced the near-empty /insights page).
   Loaded on first click by nav.js; detection lives in
   scripts/engine/insights.js (InsightsEngine.generateInsights),
   which is pulled in on demand if the page didn't load it.
     PFInsights.toggle(anchorEl)  — open under/over the button, or close
   ============================================================ */

(function () {
  'use strict';

  const ICON = {
    up:     '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
    down:   '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>',
    spike:  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    repeat: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    bulb:   '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/></svg>',
  };

  const monthName = k => {
    if (!k) return 'that month';
    const [y, m] = k.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long' });
  };

  function copyFor(ins, catName) {
    switch (ins.kind) {
      case 'spendTrend':
        return {
          icon: ins.diff > 0 ? ICON.down : ICON.up,
          title: ins.diff > 0 ? 'Spending is up this month' : 'Spending is down this month',
          text: `You've spent ${formatCurrency(ins.current)} so far this month — ${formatCurrency(Math.abs(ins.diff))} (${ins.pct}%) ${ins.diff > 0 ? 'more' : 'less'} than by the same day last month (${formatCurrency(ins.previous)}).`,
        };
      case 'categorySpike':
        return {
          icon: ICON.spike,
          title: `${escapeHTML(catName(ins.categoryId))} spiked`,
          text: `${escapeHTML(catName(ins.categoryId))} is ${formatCurrency(ins.current)} this month — ${ins.pct}% above its 3-month average of ${formatCurrency(ins.avg)}.`,
        };
      case 'savingsRate':
        return {
          icon: ins.tone === 'up' ? ICON.up : ICON.down,
          title: ins.tone === 'up' ? "You saved more last month" : "You saved less last month",
          text: `You kept ${Math.round(ins.rate * 100)}% of your income in ${monthName(ins.month)}, vs ${Math.round(ins.prevRate * 100)}% in ${monthName(ins.prevMonth)}.`,
        };
      case 'untrackedRecurring':
        return {
          icon: ICON.repeat,
          title: 'Recurring payment not tracked',
          text: `<strong>${escapeHTML(ins.name)}</strong> repeats about every ${ins.cadenceDays} days (~${formatCurrency(ins.amount)}). Track it as a recurring bill to see it in Upcoming bills and your forecast. <a href="/subscriptions">Track it →</a>${ins.more ? `<br><span class="insight-card__more">+${ins.more} more recurring payment${ins.more === 1 ? '' : 's'} like this.</span>` : ''}`,
        };
      default:
        return null;
    }
  }

  function cardHTML(ins, catName) {
    const c = copyFor(ins, catName);
    if (!c) return '';
    return `
      <div class="insight-card insight-card--${ins.tone}">
        <span class="insight-card__icon">${c.icon}</span>
        <div class="insight-card__body">
          <div class="insight-card__title">${c.title}</div>
          <div class="insight-card__text">${c.text}</div>
        </div>
      </div>`;
  }

  /* InsightsEngine isn't on every page — load it once when needed */
  let engineReady = null;
  function loadEngine() {
    if (typeof InsightsEngine !== 'undefined') return Promise.resolve();
    return engineReady || (engineReady = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/scripts/engine/insights.js';
      s.onload = res;
      s.onerror = () => { engineReady = null; rej(new Error('Could not load insights')); };
      document.head.appendChild(s);
    }));
  }

  let pop = null, anchor = null;

  function position() {
    if (!pop || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight, gutter = 16, gap = 8;
    const pw = pop.offsetWidth;
    const left = Math.min(vw - gutter - pw, Math.max(gutter, r.right - pw));   /* right-aligned to the button */
    const below = r.bottom + gap;
    const spaceBelow = vh - below - gutter, spaceAbove = r.top - gap - gutter;
    /* bottom-nav buttons open upwards */
    if (spaceBelow >= 240 || spaceBelow >= spaceAbove) {
      pop.style.top = `${Math.round(below)}px`; pop.style.bottom = '';
      pop.style.maxHeight = `${Math.round(spaceBelow)}px`;
    } else {
      pop.style.top = ''; pop.style.bottom = `${Math.round(vh - r.top + gap)}px`;
      pop.style.maxHeight = `${Math.round(spaceAbove)}px`;
    }
    pop.style.left = `${Math.round(left)}px`;
  }

  function onDocClick(e) {
    if (!pop) return;
    if (pop.contains(e.target) || (anchor && anchor.contains(e.target))) return;
    close();
  }
  function onKey(e) { if (e.key === 'Escape') { close(); anchor?.focus(); } }
  function onMove() { requestAnimationFrame(position); }

  function close() {
    if (!pop) return;
    pop.remove(); pop = null;
    anchor?.setAttribute('aria-expanded', 'false');
    anchor?.classList.remove('topbar-icon-btn--active');
    document.removeEventListener('mousedown', onDocClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onMove);
    window.removeEventListener('scroll', onMove, true);
  }

  async function render() {
    const body = pop.querySelector('.insights-pop__list');
    const sub = pop.querySelector('.insights-pop__sub');
    try {
      await loadEngine();
      const [txs, cats, subs] = await Promise.all([
        TransactionStore.getAll(),
        CategoryStore.getAll(),
        SubscriptionStore.getAll().catch(() => []),
      ]);
      if (!pop) return;                                   /* closed while loading */
      const catName = id => (cats.find(c => c.id === id)?.name) || 'Uncategorized';
      const list = InsightsEngine.generateInsights(txs, { subscriptions: subs });
      sub.textContent = list.length
        ? `${list.length} thing${list.length === 1 ? '' : 's'} worth a look this month`
        : 'Patterns and changes in your spending';
      body.innerHTML = list.length
        ? list.map(i => cardHTML(i, catName)).join('')
        : `<div class="insights-empty">
             <span class="insights-empty__icon">${ICON.bulb}</span>
             <div class="insights-empty__title">Nothing notable right now</div>
             <div class="insights-empty__text">Insights appear as you log transactions across a few months — spending spikes, savings-rate shifts, and recurring charges you aren't tracking yet.</div>
           </div>`;
    } catch (err) {
      if (!pop) return;
      body.innerHTML = `<div class="insights-empty"><div class="insights-empty__text">Couldn't load insights. ${escapeHTML(err.message || '')}</div></div>`;
    }
    position();
  }

  function open(el) {
    anchor = el;
    pop = document.createElement('div');
    pop.className = 'insights-pop';
    pop.id = 'insightsPop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Insights');
    pop.innerHTML = `
      <div class="insights-pop__head">
        <div class="insights-pop__title">Insights</div>
        <div class="insights-pop__sub">Looking at your transactions…</div>
      </div>
      <div class="insights-pop__list">
        <div class="insight-skeleton"></div><div class="insight-skeleton"></div>
      </div>`;
    document.body.appendChild(pop);
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', 'insightsPop');
    if (anchor.closest('#topbar')) anchor.classList.add('topbar-icon-btn--active');
    position();
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    render();
  }

  window.PFInsights = {
    toggle(el) { if (pop) { const same = el === anchor; close(); if (same) return; } open(el); },
    close,
  };
})();
