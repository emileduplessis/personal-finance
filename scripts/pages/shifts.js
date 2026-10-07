/* ============================================================
   shifts.js (page) — Hours Tracker.
   A data-rich work-hours hub: live stats with week-over-week
   change, a weekly goal ring, a 10-week earnings bar chart,
   day-of-week and per-job breakdowns, fast preset logging, and a
   filterable weekly-grouped log. Hours/pay math is pure in
   scripts/engine/shifts.js (ShiftEngine). A logged shift creates a
   linked income transaction (tags:['shift']).
   ============================================================ */

/* Wrapped in an IIFE: store.js (loaded first) already declares globals like
   `todayISO`, and top-level `const`/`let` in a plain script share global
   scope — a name clash there is a SyntaxError that aborts the whole file. */
(function () {
'use strict';

let _shifts = [];
let _payouts = [];
let _accounts = [];
let _incomeCats = [];
let _payMode = 'hourly';
let _goal = { metric: 'pay', target: 0 };
let _chartMetric = 'pay';
let _employerFilter = '';    /* Logged hours panel filter */
let _chartJob = '';          /* Earnings chart filter (independent of the list) */
let _qlDate = null;          /* quick-log selected day */
let _paidContext = null;     /* snapshot of what the mark-as-paid modal is settling */
let _jobs = [];              /* saved jobs (cross-device, from JobStore) */

/* The job currently picked in the quick-log selector, or null. */
function activeJob() {
  const id = document.getElementById('qlJob')?.value;
  return _jobs.find(j => j.id === id) || null;
}

/* Hourly rate to show/estimate with: the active job's rate, then the saved
   default. 0 means "not set yet" — callers prompt instead of guessing. */
function jobRate() { return (activeJob()?.rate) || ShiftStore.getDefaultRate() || 0; }

const iso = d => isoLocal(d);
const todayISO = () => iso(new Date());

function startOfWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();                       /* 0 = Sunday */
  d.setDate(d.getDate() - dow);
  return iso(d);
}
function weekRange() {
  const from = startOfWeek(todayISO());
  const to = new Date(from + 'T00:00:00'); to.setDate(to.getDate() + 6);
  return { from, to: iso(to) };
}
function lastWeekRange() {
  const from = new Date(startOfWeek(todayISO()) + 'T00:00:00'); from.setDate(from.getDate() - 7);
  const to = new Date(from); to.setDate(to.getDate() + 6);
  return { from: iso(from), to: iso(to) };
}
function monthRange() {
  const d = new Date();
  return { from: iso(new Date(d.getFullYear(), d.getMonth(), 1)),
           to:   iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
}
function last30Range() {
  const to = new Date();
  const from = new Date(); from.setDate(from.getDate() - 29);
  return { from: iso(from), to: iso(to) };
}
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m ?? 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function fmtDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtHours(h) { return `${(Math.round(h * 100) / 100).toFixed(h % 1 === 0 ? 0 : 1)} h`; }
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ============================================================
   STATS BAR
   ============================================================ */
function renderStats() {
  const wk = ShiftEngine.summarize(_shifts, weekRange());
  const lwk = ShiftEngine.summarize(_shifts, lastWeekRange());
  const mo = ShiftEngine.summarize(_shifts, monthRange());
  const all = ShiftEngine.summarize(_shifts);
  const eff = ShiftEngine.effectiveRate(_shifts, last30Range());

  setText('weekPay',  formatCurrency(wk.pay));
  setText('weekHours', `${fmtHours(wk.hours)} · ${wk.count} shift${wk.count === 1 ? '' : 's'}`);
  setText('monthPay', formatCurrency(mo.pay));
  setText('monthHours', `${fmtHours(mo.hours)} · ${mo.count} shift${mo.count === 1 ? '' : 's'}`);
  setText('effRate', eff > 0 ? formatCurrency(eff) : '—');
  setText('totalPay', formatCurrency(all.pay));
  setText('totalShifts', `${all.count} shift${all.count === 1 ? '' : 's'} · ${fmtHours(all.hours)}`);

  /* week-over-week change pill */
  const pill = document.getElementById('weekDelta');
  if (pill) {
    if (lwk.pay > 0.005 || wk.pay > 0.005) {
      const diff = wk.pay - lwk.pay;
      const pct = lwk.pay > 0.005 ? (diff / lwk.pay) * 100 : (wk.pay > 0 ? 100 : 0);
      const up = diff >= 0;
      pill.hidden = false;
      pill.className = `flow-pill ${Math.abs(diff) < 0.005 ? 'flow-pill--flat' : up ? 'flow-pill--up' : 'flow-pill--down'}`;
      pill.textContent = `${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}% wk`;
    } else {
      pill.hidden = true;
    }
  }
}

/* ============================================================
   SALARY PROJECTION — annualise the average logged week, then show
   gross (brut) vs net two ways: the REAL deductions from your payout
   history, and an estimated Québec tax breakdown.
   ============================================================ */
/* The salary bar is collapsed behind a toggle so the stat area stays compact.
   State is remembered per-device; default collapsed. */
function salaryExpanded() {
  try { return localStorage.getItem('pf_salary_expanded') === '1'; } catch (_) { return false; }
}
function applySalaryExpanded(expanded) {
  const panel = document.getElementById('salaryPanel');
  const toggle = document.getElementById('salaryToggle');
  if (panel) panel.hidden = !expanded;
  if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}
function toggleSalary() {
  const next = !salaryExpanded();
  try { localStorage.setItem('pf_salary_expanded', next ? '1' : '0'); } catch (_) {}
  applySalaryExpanded(next);
}

function renderSalary() {
  const panel = document.getElementById('salaryPanel');
  const toggle = document.getElementById('salaryToggle');
  if (!panel) return;

  const { weekly } = ShiftEngine.averageWeeklyPay(_shifts, { weeks: 8, today: todayISO() });
  if (weekly <= 0) {                                  /* nothing logged yet */
    panel.hidden = true;
    if (toggle) toggle.hidden = true;
    return;
  }

  const proj = ShiftEngine.projectSalary(weekly);
  setText('salWeekly',  formatCurrency(proj.weekly));
  setText('salMonthly', formatCurrency(proj.monthly));
  setText('salAnnual',  formatCurrency(proj.annual));

  /* ---- Actual, from the estimate-vs-payout gap ---- */
  const act = ShiftEngine.payoutDeductions(_payouts);
  if (act.count && act.estimated > 0) {
    const net    = proj.annual * (1 - act.rate);
    const ded    = proj.annual - net;
    const isBonus = act.deduction < -0.005;
    const pct = `${(Math.abs(act.rate) * 100).toFixed(1)}%`;
    setText('salActualNet', formatCurrency(net));
    setText('salActualDedLabel', isBonus ? 'Extra' : 'Deductions');
    setText('salActualDed', `${isBonus ? '+' : ded > 0.005 ? '−' : ''}${formatCurrency(Math.abs(ded))}`);
    setText('salActualNote',
      `${pct} ${isBonus ? 'over' : 'under'} estimate · from ${act.count} payout${act.count === 1 ? '' : 's'}: estimated ${formatCurrency(act.estimated)}, received ${formatCurrency(act.actual)}.`);
  } else {
    setText('salActualNet', '—');
    setText('salActualDedLabel', 'Deductions');
    setText('salActualDed', '—');
    setText('salActualNote', 'Mark shifts as paid to see the real deductions from your pay.');
  }

  /* reveal the toggle and preview the annual figure, then honour saved state */
  if (toggle) {
    toggle.hidden = false;
    setText('salaryTogglePreview', `${formatCurrency(proj.annual)} / yr`);
  }
  applySalaryExpanded(salaryExpanded());
}

/* ============================================================
   UNPAID PANEL + MARK-AS-PAID  (estimate vs actual)
   ============================================================ */
function renderUnpaid() {
  const panel = document.getElementById('unpaidPanel');
  if (!panel) return;
  const u = ShiftEngine.unpaidSummary(_shifts);
  panel.hidden = false;
  const amt = document.getElementById('unpaidAmount');
  const sub = document.getElementById('unpaidSub');
  const btn = document.getElementById('markPaidBtn');

  if (u.count === 0) {
    amt.textContent = formatCurrency(0);
    sub.textContent = "All caught up — nothing waiting to be paid.";
    btn.disabled = true;
    btn.hidden = true;             /* nothing to settle — don't offer the action */
    panel.classList.add('hours-unpaid--clear');
  } else {
    amt.textContent = '~' + formatCurrency(u.estimated);
    sub.textContent = `${fmtHours(u.hours)} · ${u.count} day${u.count === 1 ? '' : 's'} unpaid · est. at ${formatCurrency(jobRate())}/h`;
    btn.disabled = false;
    btn.hidden = false;
    panel.classList.remove('hours-unpaid--clear');
  }
}

function openPaidModal() {
  const u = ShiftEngine.unpaidSummary(_shifts);
  if (u.count === 0) return;
  _paidContext = { hours: u.hours, estimated: u.estimated, shiftIds: _shifts.filter(s => !s.paid && !s.txId).map(s => s.id) };
  document.getElementById('paidHours').textContent = fmtHours(u.hours);
  document.getElementById('paidEstimated').textContent = formatCurrency(u.estimated);
  const actual = document.getElementById('paidActual');
  actual.value = u.estimated.toFixed(2);          /* prefill with the estimate */
  document.getElementById('paidAddBonus').checked = true;
  updatePaidBonus();
  document.getElementById('paidModal').hidden = false;
  actual.focus();
  actual.select();
}

function closePaidModal() {
  document.getElementById('paidModal').hidden = true;
  _paidContext = null;
}

function updatePaidBonus() {
  if (!_paidContext) return;
  const actual = parseFloat(document.getElementById('paidActual').value) || 0;
  const s = ShiftEngine.settlePay(_paidContext.estimated, actual);
  const el = document.getElementById('paidBonus');
  if (s.bonus > 0.005) {
    el.textContent = `+${formatCurrency(s.bonus)} over the estimate (bonus)`;
    el.className = 'paid-bonus paid-bonus--up';
  } else if (s.bonus < -0.005) {
    el.textContent = `${formatCurrency(s.bonus)} under the estimate`;
    el.className = 'paid-bonus paid-bonus--down';
  } else {
    el.textContent = 'Matches the estimate exactly';
    el.className = 'paid-bonus';
  }
}

async function confirmPaid() {
  if (!_paidContext) return;
  const actual = parseFloat(document.getElementById('paidActual').value) || 0;
  const s = ShiftEngine.settlePay(_paidContext.estimated, actual);
  const addBonus = document.getElementById('paidAddBonus').checked;
  const btn = document.getElementById('paidConfirm');
  btn.disabled = true;
  const jd = ShiftStore.getJobDefaults();
  try {
    /* Consolidate the whole payout into ONE income transaction (the payday
       deposit), instead of one row per day. Days already logged as income keep
       their own entry — their pay is already in the balance — so this single
       row only covers the still-unlogged days. The payout owns the row (its
       txId), so an Undo removes exactly this one transaction. */
    const unlogged = _paidContext.shiftIds
      .map(id => _shifts.find(x => x.id === id))
      .filter(sh => sh && !sh.txId);
    const basePay = unlogged.reduce((sum, sh) => sum + ShiftEngine.pay(sh), 0);
    /* pay from days already logged as income (already counted in the balance) */
    const loggedPay = Math.max(0, Math.round((_paidContext.estimated - basePay) * 100) / 100);
    /* With "match my balance" ticked, book the REAL cash for the unlogged days —
       the actual amount minus whatever's already logged — so tax and other
       deductions are reflected (and bonuses too). Unticked just books the
       pre-tax estimate. Guard against going below zero. */
    let amount = addBonus
      ? Math.round((actual - loggedPay) * 100) / 100
      : Math.round(basePay * 100) / 100;
    if (amount < 0) amount = 0;

    let txId = null;
    if (amount > 0.005) {
      const ref = unlogged.find(sh => sh.employer) || unlogged[0] || {};
      const days = unlogged.length;
      txId = (await TransactionStore.add({
        date: todayISO(), amount, type: 'income',
        categoryId: ref.categoryId || null,
        accountId: ref.accountId || jd.accountId || null,
        note: (ref.employer || jd.employer || 'Shift pay') +
              (days > 1 ? ` · ${days} days` : ''),
        tags: (addBonus && s.bonus > 0.005) ? ['shift', 'payout', 'bonus'] : ['shift', 'payout'],
      })).id;
    }
    await PayoutStore.add({
      date: todayISO(), hours: _paidContext.hours,
      estimated: s.estimated, actual: s.actual, bonus: s.bonus,
      shiftIds: _paidContext.shiftIds, txId, note: '',
    });
    closePaidModal();
    await renderPage();
    showToast('Marked as paid', 'success');
  } catch (err) {
    showToast(err.message || 'Failed to record payout', 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================
   PAYOUT HISTORY
   ============================================================ */
/* The transactions that back a payout: each linked day's own income entry plus
   the payout's own row. Legacy payouts (settled before the one-transaction
   change) have one entry per day; new ones already have exactly one. */
function payoutTxIds(p) {
  const ids = new Set();
  (p.shiftIds || []).forEach(id => {
    const sh = _shifts.find(x => x.id === id);
    if (sh && sh.txId) ids.add(sh.txId);
  });
  if (p.txId) ids.add(p.txId);
  return [...ids];
}

function renderPayouts() {
  const panel = document.getElementById('payoutsPanel');
  const list = document.getElementById('payoutsList');
  if (!panel) return;
  if (!_payouts.length) { panel.hidden = true; return; }
  panel.hidden = false;

  const totalBonus = Math.round(_payouts.reduce((a, p) => a + p.bonus, 0) * 100) / 100;
  document.getElementById('payoutsTotal').textContent =
    totalBonus > 0.005 ? `+${formatCurrency(totalBonus)} over estimate · all-time` : '';

  /* offer a one-click cleanup for older payouts still split across day-entries */
  const legacy = _payouts.filter(p => payoutTxIds(p).length > 1);
  const banner = document.getElementById('payoutsMergeBanner');
  if (banner) {
    banner.hidden = legacy.length === 0;
    const txt = document.getElementById('payoutsMergeText');
    if (txt) txt.textContent = legacy.length === 1
      ? '1 payout is split across a transaction per day.'
      : `${legacy.length} payouts are split across a transaction per day.`;
  }

  list.innerHTML = _payouts.map(p => {
    const days = p.shiftIds.length;
    const bonus = p.bonus > 0.005
      ? `<span class="payout__bonus payout__bonus--up">+${formatCurrency(p.bonus)}</span>`
      : p.bonus < -0.005
      ? `<span class="payout__bonus payout__bonus--down">${formatCurrency(p.bonus)}</span>`
      : '';
    const nTx = payoutTxIds(p).length;
    const merge = nTx > 1
      ? `<button type="button" class="btn btn--ghost btn--sm payout-merge" data-id="${p.id}" title="Combine this payout's ${nTx} day-transactions into one">Merge</button>`
      : '';
    return `<div class="payout-row" data-id="${p.id}">
      <div class="payout-row__main">
        <div class="payout-row__date">${fmtDay(p.date)}</div>
        <div class="payout-row__meta">${fmtHours(p.hours)} · est ${formatCurrency(p.estimated)} · ${days} day${days === 1 ? '' : 's'}</div>
      </div>
      <div class="payout-row__figs">
        <div class="payout-row__actual">${formatCurrency(p.actual)}</div>
        ${bonus}
      </div>
      ${merge}
      <button type="button" class="btn btn--ghost btn--sm payout-undo" data-id="${p.id}">Undo</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.payout-undo').forEach(b =>
    b.addEventListener('click', () => undoPayout(b.dataset.id)));
  list.querySelectorAll('.payout-merge').forEach(b =>
    b.addEventListener('click', () => mergePayout(b.dataset.id)));
}

/* Fold a payout's per-day transactions into a single payday transaction.
   Balance-preserving: the first entry is repurposed to the summed amount and
   the rest are deleted, so the ledger total never moves. The payout then owns
   that one transaction (like a freshly-settled payout), so Undo still works. */
async function mergePayoutData(p, { silent = false } = {}) {
  const txIds = payoutTxIds(p);
  if (txIds.length <= 1) return false;
  const txs = (await Promise.all(txIds.map(t => TransactionStore.getById(t)))).filter(Boolean);
  if (!txs.length) return false;

  const total = Math.round(txs.reduce((sum, t) => sum + Math.abs(t.amount), 0) * 100) / 100;
  const keep = txs[0];
  const days = (p.shiftIds || []).length;
  const jd = ShiftStore.getJobDefaults();
  const ref = _shifts.find(x => (p.shiftIds || []).includes(x.id) && x.employer) || {};
  const note = (ref.employer || keep.note || jd.employer || 'Shift pay') + (days > 1 ? ` · ${days} days` : '');

  /* repurpose the first entry as the single payday deposit */
  await TransactionStore.update(keep.id, { amount: total, date: p.date, note, tags: ['shift', 'payout'] });
  /* delete the remaining day-entries (now folded into `keep`) */
  for (const t of txs.slice(1)) { try { await TransactionStore.delete(t.id); } catch (_) {} }
  /* unlink every day from its old per-day entry — they now read "paid" */
  for (const sid of (p.shiftIds || [])) {
    const sh = _shifts.find(x => x.id === sid);
    if (sh && sh.txId) { try { await ShiftStore.update(sid, { txId: null }); } catch (_) {} }
  }
  /* point the payout at the surviving single transaction */
  await PayoutStore.update(p.id, { txId: keep.id });
  if (!silent) showToast('Merged into one transaction', 'success');
  return true;
}

async function mergePayout(id) {
  const p = _payouts.find(x => x.id === id);
  if (!p) return;
  const n = payoutTxIds(p).length;
  if (n <= 1) { showToast('Already a single transaction', 'success'); return; }
  if (!await confirmDialog(`Combine this payout's ${n} day-entries into one transaction? Your balance won't change.`, { confirmText: 'Merge' })) return;
  try {
    await mergePayoutData(p);
    await renderPage();
  } catch (err) {
    showToast(err.message || 'Failed to merge', 'error');
  }
}

async function mergeAllPayouts() {
  const legacy = _payouts.filter(p => payoutTxIds(p).length > 1);
  if (!legacy.length) return;
  if (!await confirmDialog(`Combine ${legacy.length} older payout${legacy.length === 1 ? '' : 's'} so each becomes a single transaction? Your balance won't change.`, { confirmText: 'Merge all' })) return;
  try {
    let done = 0;
    for (const p of legacy) { if (await mergePayoutData(p, { silent: true })) done++; }
    await renderPage();
    showToast(`Merged ${done} payout${done === 1 ? '' : 's'} into single transactions`, 'success');
  } catch (err) {
    showToast(err.message || 'Failed to merge', 'error');
  }
}

async function undoPayout(id) {
  const p = _payouts.find(x => x.id === id);
  if (!p) return;
  if (!await confirmDialog('Undo this payout? Those days go back to unpaid' + (p.txId ? ' and the payout income entry is removed.' : '.'), { confirmText: 'Undo' })) return;
  try {
    if (p.txId) { try { await TransactionStore.delete(p.txId); } catch (_) {} }
    await PayoutStore.remove(id);
    await renderPage();
    showToast('Payout undone', 'success');
  } catch (err) {
    showToast(err.message || 'Failed to undo', 'error');
  }
}

/* ============================================================
   QUICK LOG — just total hours for a day
   ============================================================ */
function renderQuickChips(selected) {
  _qlDate = selected;
  const el = document.getElementById('quickDayChips');
  if (!el) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let html = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const val = iso(d);
    const dow = i === 0 ? 'Today' : i === 1 ? 'Yest' : d.toLocaleDateString('en-US', { weekday: 'short' });
    html += `<button type="button" class="day-chip${val === selected ? ' selected' : ''}" data-date="${val}">
      <span class="day-chip__dow">${dow}</span>
      <span class="day-chip__date">${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
    </button>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.day-chip').forEach(b =>
    b.addEventListener('click', () => renderQuickChips(b.dataset.date)));
}

function renderQuickMeta() {
  const el = document.getElementById('qlMeta');
  if (!el) return;
  const rate = jobRate();
  el.textContent = rate > 0
    ? `at ${formatCurrency(rate)}/h · added unlogged — tap a shift to log it`
    : 'Set an hourly rate on your job to see what you’ve earned.';
}

async function quickLog(e) {
  e.preventDefault();
  const hoursVal = parseFloat(document.getElementById('qlHours').value) || 0;
  if (hoursVal <= 0) { showToast('Enter hours worked', 'error'); return; }
  const job = activeJob();
  if (!job) { showToast('Add a job first', 'error'); openJobModal(); return; }
  localStorage.setItem('pf_quick_job', job.id);   /* remember the pick on this device */
  const rate = job.rate || ShiftStore.getDefaultRate() || 0;
  if (rate <= 0) {
    /* never invent a rate — ask once, it sticks on the job from then on */
    showToast('Set an hourly rate for this job first', 'error');
    openJobModal(job.id);
    return;
  }
  ShiftStore.setDefaultRate(rate);
  const data = {
    date: _qlDate || todayISO(), hours: hoursVal, rate, payMode: 'hourly', tips: 0,
    start: '', end: '', breakMin: 0,
    employer: job.name, jobId: job.id,
    accountId: job.accountId || null, categoryId: job.categoryId || null,
  };
  const btn = document.getElementById('qlAdd');
  btn.disabled = true;
  try {
    /* Quick-log records the hours only — the shift starts "unlogged" (no income
       transaction). Tap the badge in the list to log it as income when you're
       ready (e.g. once the boss has actually paid you). */
    await ShiftStore.add(data);
    document.getElementById('qlHours').value = '';
    await renderPage();
    if (!localStorage.getItem('pf_seen_unlogged_hint')) {
      showToast('Saved as unlogged hours — tap the badge (or Mark as paid) when you get paid to count it as income', 'success');
      try { localStorage.setItem('pf_seen_unlogged_hint', '1'); } catch (_) {}
    } else {
      showToast(`Logged ${fmtHours(hoursVal)} · unlogged`, 'success');
    }
  } catch (err) {
    showToast(err.message || 'Failed to log hours', 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================
   WEEKLY GOAL — ring + pace
   ============================================================ */
function ringSVG(pct) {
  const r = 30, c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, pct / 100));
  const reached = pct >= 100;
  const color = reached ? 'var(--color-income)' : 'var(--color-primary)';
  return `<svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true">
    <circle cx="38" cy="38" r="${r}" fill="none" stroke="var(--color-border)" stroke-width="7"/>
    <circle cx="38" cy="38" r="${r}" fill="none" stroke="${color}" stroke-width="7"
      stroke-dasharray="${c}" stroke-dashoffset="${(c * (1 - frac)).toFixed(1)}"
      stroke-linecap="round" transform="rotate(-90 38 38)" style="transition:stroke-dashoffset .5s ease"/>
  </svg>`;
}

function renderGoal() {
  /* Switched off in Settings → Goals. The panel shares a flex row with the pay
     period, whose `flex: 1 1 300px` simply takes the freed width. */
  const panel = document.getElementById('goalPanel');
  const off = !SettingsStore.goalEnabled('hours');
  if (panel) panel.hidden = off;
  if (off) return;

  const ring = document.getElementById('goalRing');
  const pctEl = document.getElementById('goalPct');
  const detail = document.getElementById('goalDetail');
  const pace = document.getElementById('goalPace');
  if (!ring) return;

  if (!_goal.target) {
    ring.innerHTML = ringSVG(0);
    pctEl.textContent = '—';
    detail.textContent = 'No goal set yet';
    pace.textContent = '';
    pace.className = 'goal-info__pace';
    return;
  }

  const wk = ShiftEngine.summarize(_shifts, weekRange());
  const current = _goal.metric === 'hours' ? wk.hours : wk.pay;
  const fmt = v => _goal.metric === 'hours' ? fmtHours(v) : formatCurrency(v);
  const pct = _goal.target > 0 ? (current / _goal.target) * 100 : 0;

  ring.innerHTML = ringSVG(pct);
  pctEl.textContent = `${Math.round(pct)}%`;
  detail.innerHTML = `${fmt(current)} <span class="goal-info__of">of ${fmt(_goal.target)}</span>`;

  /* pace vs how far through the week we are (Sun=day 1 … Sat=day 7) */
  const dow = new Date().getDay();                    /* 0=Sun */
  const elapsed = dow + 1;
  const expected = _goal.target * (elapsed / 7);
  if (pct >= 100) {
    pace.textContent = '✓ Goal reached';
    pace.className = 'goal-info__pace goal-info__pace--up';
  } else {
    const gap = current - expected;
    const remaining = _goal.target - current;
    if (gap >= -0.005) {
      pace.textContent = `On pace · ${fmt(remaining)} to go`;
      pace.className = 'goal-info__pace goal-info__pace--up';
    } else {
      pace.textContent = `${fmt(Math.abs(gap))} behind pace`;
      pace.className = 'goal-info__pace goal-info__pace--down';
    }
  }
}

function setGoalMetric(metric) {
  const m = metric === 'hours' ? 'hours' : 'pay';
  document.querySelectorAll('#goalEdit .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.metric === m));
  document.getElementById('goalPrefix').textContent = m === 'hours' ? '' : '$';
  document.getElementById('goalSuffix').textContent = m === 'hours' ? 'h / week' : '/ week';
  document.getElementById('goalEdit').dataset.metric = m;
}
function openGoalEdit() {
  document.getElementById('goalDisplay').hidden = true;
  document.getElementById('goalEdit').hidden = false;
  setGoalMetric(_goal.metric);
  document.getElementById('goalTarget').value = _goal.target || '';
  document.getElementById('goalTarget').focus();
}
function closeGoalEdit() {
  document.getElementById('goalEdit').hidden = true;
  document.getElementById('goalDisplay').hidden = false;
}
function saveGoal(e) {
  e.preventDefault();
  const metric = document.getElementById('goalEdit').dataset.metric || 'pay';
  const target = parseFloat(document.getElementById('goalTarget').value) || 0;
  _goal = ShiftStore.setGoal({ metric, target });
  closeGoalEdit();
  renderGoal();
  showToast(target > 0 ? 'Goal saved' : 'Goal cleared', 'success');
}
function clearGoal() {
  _goal = ShiftStore.setGoal({ metric: _goal.metric, target: 0 });
  closeGoalEdit();
  renderGoal();
}

/* ============================================================
   EARNINGS CHART — 10-week bars (pay or hours)
   ============================================================ */
function renderChart() {
  const el = document.getElementById('hoursBars');
  if (!el) return;
  const shifts = _chartJob
    ? _shifts.filter(s => (s.employer || '').trim() === _chartJob)
    : _shifts;
  const series = ShiftEngine.weeklySeries(shifts, 10, todayISO());
  const vals = series.map(w => _chartMetric === 'hours' ? w.hours : w.pay);
  const max = Math.max(...vals, 0);
  const thisWk = startOfWeek(todayISO());

  if (max <= 0) {
    el.innerHTML = `<div class="hours-bars__empty">No earnings in the last 10 weeks${_chartJob ? ' for that job' : ''} yet.</div>`;
    return;
  }
  el.innerHTML = series.map((w, i) => {
    const v = vals[i];
    const h = max > 0 ? (v / max) * 100 : 0;
    const isNow = w.weekStart === thisWk;
    const label = new Date(w.weekStart + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const valLabel = _chartMetric === 'hours' ? fmtHours(w.hours) : formatCurrency(w.pay);
    return `<div class="hbar${isNow ? ' hbar--now' : ''}" title="Week of ${label} · ${valLabel}">
      <div class="hbar__val">${v > 0 ? (_chartMetric === 'hours' ? Math.round(w.hours) : formatCurrencyShort(w.pay)) : ''}</div>
      <div class="hbar__track"><div class="hbar__fill" style="height:${Math.max(v > 0 ? 3 : 0, h)}%"></div></div>
      <div class="hbar__label">${label.replace(/ \d+$/, m => m)}</div>
    </div>`;
  }).join('');
}

/* compact money for tight bar tops (e.g. $1.2k) */
function formatCurrencyShort(v) {
  if (v >= 1000) return '$' + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
  return '$' + Math.round(v);
}

/* ============================================================
   BY DAY OF WEEK
   ============================================================ */
function renderDayOfWeek() {
  const el = document.getElementById('dowGrid');
  if (!el) return;
  const rows = ShiftEngine.byDayOfWeek(_shifts);
  const max = Math.max(...rows.map(r => r.pay), 0);
  const best = rows.reduce((a, b) => (b.pay > a.pay ? b : a), rows[0]);
  setText('dowBest', max > 0 ? `best · ${DOW[best.dow]}` : '');

  el.innerHTML = rows.map(r => {
    const h = max > 0 ? (r.pay / max) * 100 : 0;
    const isBest = max > 0 && r.dow === best.dow;
    return `<div class="dow-col" title="${DOW[r.dow]} · ${fmtHours(r.hours)} · ${formatCurrency(r.pay)}">
      <div class="dow-col__track"><div class="dow-col__fill${isBest ? ' dow-col__fill--best' : ''}" style="height:${Math.max(r.pay > 0 ? 4 : 0, h)}%"></div></div>
      <div class="dow-col__day">${DOW[r.dow][0]}</div>
    </div>`;
  }).join('');
}

/* ============================================================
   BY JOB / EMPLOYER
   ============================================================ */
function renderJobs() {
  const el = document.getElementById('jobList');
  if (!el) return;
  if (!_jobs.length) {
    el.innerHTML = `<div class="empty-state" style="padding:22px 14px;text-align:center;">
        <div style="margin-bottom:10px;">No jobs yet — add one to log hours against it.</div>
        <button type="button" class="btn btn--ghost btn--sm" id="emptyAddJob">+ Add your first job</button>
      </div>`;
    document.getElementById('emptyAddJob')?.addEventListener('click', () => openJobModal());
    return;
  }
  /* all-time hours/pay per job, matched to the saved job by name */
  const stats  = ShiftEngine.byEmployer(_shifts);
  const byName = Object.fromEntries(stats.map(s => [s.employer, s]));
  const max    = Math.max(...stats.map(s => s.pay), 0);
  el.innerHTML = _jobs.map(j => {
    const st = byName[j.name] || { hours: 0, pay: 0, count: 0 };
    const w  = max > 0 ? (st.pay / max) * 100 : 0;
    return `<button type="button" class="job-row job-row--btn" data-id="${j.id}" title="Edit job">
      <div class="job-row__bar" style="width:${Math.max(2, w)}%"></div>
      <div class="job-row__main">
        <span class="job-row__name">${escapeHTML(j.name)}</span>
        <span class="job-row__meta">${j.rate > 0 ? `${formatCurrency(j.rate)}/h` : 'no rate'} · ${fmtHours(st.hours)} · ${st.count} shift${st.count === 1 ? '' : 's'}</span>
      </div>
      <span class="job-row__pay">${formatCurrency(st.pay)}</span>
    </button>`;
  }).join('');
  el.querySelectorAll('.job-row--btn').forEach(b =>
    b.addEventListener('click', () => openJobModal(b.dataset.id)));
}

/* ============================================================
   PRESETS (quick log)
   ============================================================ */
function renderPresets() {
  const row = document.getElementById('hoursPresets');
  const hint = document.getElementById('quickHint');
  if (!row) return;
  const presets = ShiftStore.getPresets();
  if (hint) hint.hidden = presets.length > 0;
  row.innerHTML = presets.map(p => `
    <span class="hours-preset">
      <button type="button" class="hours-preset__use" data-id="${p.id}">${escapeHTML(p.name)}</button>
      <button type="button" class="hours-preset__del" data-id="${p.id}" aria-label="Remove preset">✕</button>
    </span>`).join('');
  row.querySelectorAll('.hours-preset__use').forEach(b =>
    b.addEventListener('click', () => usePreset(b.dataset.id)));
  row.querySelectorAll('.hours-preset__del').forEach(b =>
    b.addEventListener("click", async () => {
      if (!await confirmDialog("Remove this preset?", { confirmText: "Remove" })) return;
      ShiftStore.removePreset(b.dataset.id);
      renderPresets();
    }));
}

function usePreset(id) {
  const p = ShiftStore.getPresets().find(x => x.id === id);
  if (!p) return;
  openAdd();
  const sj = document.getElementById('sJob');
  if (sj) sj.value = _jobs.find(j => j.name === (p.employer || '').trim())?.id || '';
  document.getElementById('sStart').value = p.start || '';
  document.getElementById('sEnd').value = p.end || '';
  document.getElementById('sBreak').value = p.breakMin || 0;
  document.getElementById('sRate').value = p.rate || '';
  document.getElementById('sFixed').value = p.fixedPay || '';
  if (p.accountId)  document.getElementById('sAccount').value = p.accountId;
  if (p.categoryId) document.getElementById('sCategory').value = p.categoryId;
  setPayMode(p.payMode === 'fixed' ? 'fixed' : 'hourly');
  payPreview();
}

/* ============================================================
   LIST (grouped by week, filterable by employer)
   ============================================================ */
function weekLabel(weekStart) {
  const thisWk = startOfWeek(todayISO());
  const lastWk = (() => { const d = new Date(thisWk + 'T00:00:00'); d.setDate(d.getDate() - 7); return iso(d); })();
  if (weekStart === thisWk) return 'This week';
  if (weekStart === lastWk) return 'Last week';
  return 'Week of ' + new Date(weekStart + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function shiftRowHTML(s) {
  const hours = ShiftEngine.hours(s);
  const pay   = ShiftEngine.pay(s);
  const bits  = [escapeHTML(s.employer || 'Shift')];
  if (s.payMode === 'fixed') bits.push('flat');
  else if (s.start && s.end) bits.push(`${fmtTime(s.start)}–${fmtTime(s.end)}`);
  if (s.breakMin) bits.push(`${s.breakMin}m brk`);
  if (s.tips)     bits.push(`+${formatCurrency(s.tips)} tips`);
  return `
    <div class="shift-row" data-id="${s.id}">
      <div class="shift-row__main">
        <div class="shift-row__date">${fmtDay(s.date)}</div>
        <div class="shift-row__meta">${bits.join(' · ')}</div>
      </div>
      <div class="shift-row__figs">
        <div class="shift-row__hours">${hours > 0 ? hours.toFixed(2) + ' h' : '—'}</div>
        <div class="shift-row__pay">${pay > 0 ? '+' + formatCurrency(pay) : '—'}</div>
      </div>
      ${s.paid
        ? `<span class="shift-row__badge shift-row__badge--paid" title="Settled in a payout — see Payouts below">paid</span>`
        : s.txId
        ? `<button type="button" class="shift-row__badge shift-toggle" data-id="${s.id}" title="Logged as income — you're paid. Tap to mark unlogged">paid</button>`
        : `<button type="button" class="shift-row__badge shift-row__badge--off shift-toggle" data-id="${s.id}" title="Not logged — tap to log as income">unlogged</button>`}
      <button type="button" class="btn btn--ghost btn--sm shift-edit" data-id="${s.id}">Edit</button>
    </div>`;
}

/* Flip a shift between "unlogged" (hours only) and "income" (linked income
   entry). Mirrors the log/unlog branch in saveShift, but driven straight from
   the badge in the list so a day can be settled without opening the form. */
async function toggleLogged(id) {
  const s = _shifts.find(x => x.id === id);
  if (!s) return;
  if (s.paid) { showToast('This day is settled in a payout — undo the payout to change it', 'error'); return; }
  try {
    if (s.txId) {
      try { await TransactionStore.delete(s.txId); } catch (_) {}
      await ShiftStore.update(id, { txId: null });
      showToast('Marked unlogged', 'success');
    } else {
      const pay = ShiftEngine.pay(s);
      if (pay <= 0) { showToast('Nothing to log for this shift', 'error'); return; }
      const txId = (await TransactionStore.add({
        date: s.date, amount: pay, type: 'income',
        categoryId: s.categoryId || null, accountId: s.accountId || null,
        note: s.employer || 'Shift', tags: ['shift'],
      })).id;
      await ShiftStore.update(id, { txId });
      showToast('Logged as income', 'success');
    }
    await renderPage();
  } catch (err) {
    showToast(err.message || 'Failed to update', 'error');
  }
}

/* distinct job/employer names across all logged shifts, sorted */
function jobNames() {
  return [...new Set(_shifts.map(s => (s.employer || '').trim()).filter(Boolean))].sort();
}

/* Populate a "All jobs" + per-job <select>. Hidden (and its filter reset) until
   there's more than one job to choose between. Shared by the Logged hours list
   and the Earnings chart; `current` is the panel's own selected value. */
function fillJobFilter(sel, current) {
  const names = jobNames();
  if (names.length < 2) { sel.hidden = true; return false; }
  sel.hidden = false;
  sel.innerHTML = `<option value="">All jobs</option>` +
    names.map(n => `<option value="${escapeHTML(n)}"${n === current ? ' selected' : ''}>${escapeHTML(n)}</option>`).join('');
  return true;
}

function renderEmployerFilter() {
  const sel = document.getElementById('employerFilter');
  if (!sel) return;
  fillJobFilter(sel, _employerFilter);
}

function renderChartJobFilter() {
  const sel = document.getElementById('chartJobFilter');
  if (!sel) return;
  /* drop a stale filter if we're back to a single job so the chart isn't
     silently narrowed to a job that no longer stands apart */
  if (!fillJobFilter(sel, _chartJob)) _chartJob = '';
}

function renderList() {
  const el = document.getElementById('shiftsList');
  if (!el) return;
  if (!_shifts.length) {
    el.innerHTML = `<div class="empty-state" style="padding:36px 24px;text-align:center;">
        <div style="font-weight:600;color:var(--color-text);margin-bottom:6px;">No hours logged yet</div>
        <div style="font-size:.8125rem;">Add a job, then type your hours in <strong>Quick log</strong> — or use <strong>More options</strong> for start/end times and tips.</div>
      </div>`;
    return;
  }
  const list = _employerFilter
    ? _shifts.filter(s => (s.employer || '').trim() === _employerFilter)
    : _shifts;
  if (!list.length) {
    el.innerHTML = `<div class="empty-state" style="padding:28px 24px;">No shifts for that job.</div>`;
    return;
  }
  const groups = {};
  list.forEach(s => { const k = startOfWeek(s.date); (groups[k] = groups[k] || []).push(s); });
  const keys = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  el.innerHTML = keys.map(k => {
    const sum = ShiftEngine.summarize(groups[k]);
    return `<div class="week-group">
      <div class="week-group__head">
        <span class="week-group__title">${weekLabel(k)}</span>
        <span class="week-group__sub">${fmtHours(sum.hours)} · ${formatCurrency(sum.pay)}</span>
      </div>
      ${groups[k].map(shiftRowHTML).join('')}
    </div>`;
  }).join('');
  el.querySelectorAll('.shift-edit').forEach(b => b.addEventListener('click', () => openEdit(b.dataset.id)));
  el.querySelectorAll('.shift-toggle').forEach(b => b.addEventListener('click', () => toggleLogged(b.dataset.id)));
}

/* ============================================================
   FORM HELPERS
   ============================================================ */
function renderDayChips(selected) {
  const el = document.getElementById('dayChips');
  if (!el) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let html = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const val = iso(d);
    const dow = i === 0 ? 'Today' : i === 1 ? 'Yest' : d.toLocaleDateString('en-US', { weekday: 'short' });
    html += `<button type="button" class="day-chip${val === selected ? ' selected' : ''}" data-date="${val}">
      <span class="day-chip__dow">${dow}</span>
      <span class="day-chip__date">${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
    </button>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.day-chip').forEach(b => b.addEventListener('click', () => setDate(b.dataset.date)));
}
function setDate(val) {
  document.getElementById('sDate').value = val;
  renderDayChips(val);
}

function setPayMode(mode) {
  _payMode = mode === 'fixed' ? 'fixed' : 'hourly';
  document.querySelectorAll('.paymode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === _payMode));
  document.getElementById('hourlyField').hidden = _payMode !== 'hourly';
  document.getElementById('fixedField').hidden  = _payMode !== 'fixed';
  payPreview();
}

function readForm() {
  const job = _jobs.find(j => j.id === document.getElementById('sJob').value);
  return {
    date:       document.getElementById('sDate').value,
    jobId:      job ? job.id   : null,
    employer:   job ? job.name : '',
    start:      document.getElementById('sStart').value,
    end:        document.getElementById('sEnd').value,
    breakMin:   parseInt(document.getElementById('sBreak').value) || 0,
    payMode:    _payMode,
    rate:       parseFloat(document.getElementById('sRate').value) || 0,
    fixedPay:   parseFloat(document.getElementById('sFixed').value) || 0,
    tips:       parseFloat(document.getElementById('sTips').value) || 0,
    accountId:  document.getElementById('sAccount').value || null,
    categoryId: document.getElementById('sCategory').value || null,
  };
}

function payPreview() {
  const s = readForm();
  const h = ShiftEngine.hours(s), p = ShiftEngine.pay(s);
  const el = document.getElementById('shiftPayPreview');
  if (!el) return;
  if (p <= 0 && h <= 0) { el.textContent = '—'; return; }
  const tips = Number(s.tips) || 0;
  el.textContent = `${h > 0 ? h.toFixed(2) + ' h  ·  ' : ''}${formatCurrency(p)}${tips > 0 ? `  (incl. ${formatCurrency(tips)} tips)` : ''}`;
}

function syncIncomeFields() {
  document.getElementById('shiftIncomeFields').style.display =
    document.getElementById('sLogIncome').checked ? '' : 'none';
}
function showForm(show) {
  const card = document.getElementById('shiftFormCard');
  card.hidden = !show;
  if (show) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function openAdd() {
  document.getElementById('sEditId').value = '';
  document.getElementById('shiftFormTitle').textContent = 'Log shift';
  const aj = activeJob();
  document.getElementById('sJob').value = aj?.id || '';
  document.getElementById('sStart').value = '';
  document.getElementById('sEnd').value = '';
  document.getElementById('sBreak').value = '0';
  document.getElementById('sTips').value = '';
  document.getElementById('sRate').value = ShiftStore.getDefaultRate() || '';
  document.getElementById('sFixed').value = '';
  document.getElementById('sLogIncome').checked = true;
  document.getElementById('shiftDelete').hidden = true;
  setDate(todayISO());
  setPayMode('hourly');
  if (aj) applyJobToForm(aj);
  syncIncomeFields(); payPreview(); showForm(true);
}

function openEdit(id) {
  const s = _shifts.find(x => x.id === id);
  if (!s) return;
  document.getElementById('sEditId').value = s.id;
  document.getElementById('shiftFormTitle').textContent = 'Edit shift';
  const sj = document.getElementById('sJob');
  if (sj) sj.value = (s.jobId && _jobs.some(j => j.id === s.jobId)) ? s.jobId
    : (_jobs.find(j => j.name === (s.employer || '').trim())?.id || '');
  document.getElementById('sStart').value = s.start || '';
  document.getElementById('sEnd').value = s.end || '';
  document.getElementById('sBreak').value = s.breakMin || 0;
  document.getElementById('sTips').value = s.tips || '';
  document.getElementById('sRate').value = s.rate || '';
  document.getElementById('sFixed').value = s.fixedPay || '';
  document.getElementById('sLogIncome').checked = !!s.txId;
  document.getElementById('shiftDelete').hidden = false;
  setDate(s.date || todayISO());
  setPayMode(s.payMode === 'fixed' ? 'fixed' : 'hourly');
  if (s.accountId)  document.getElementById('sAccount').value = s.accountId;
  if (s.categoryId) document.getElementById('sCategory').value = s.categoryId;
  syncIncomeFields(); payPreview(); showForm(true);
}

/* ============================================================
   SAVE / DELETE (with income-transaction linking)
   ============================================================ */
async function saveShift(e) {
  e.preventDefault();
  const editId = document.getElementById('sEditId').value;
  const logIncome = document.getElementById('sLogIncome').checked;
  const data = readForm();
  if (!data.date) { showToast('Pick a day', 'error'); return; }

  const btn = document.getElementById('shiftSubmit');
  btn.disabled = true;
  try {
    const pay = ShiftEngine.pay(data);
    if (data.payMode === 'hourly' && data.rate > 0) ShiftStore.setDefaultRate(data.rate);

    const existing = editId ? _shifts.find(s => s.id === editId) : null;
    let txId = existing ? existing.txId : null;

    if (logIncome && pay > 0) {
      const payload = {
        date: data.date, amount: pay, type: 'income',
        categoryId: data.categoryId || null, accountId: data.accountId || null,
        note: data.employer || 'Shift', tags: ['shift'],
      };
      if (txId) { try { await TransactionStore.update(txId, payload); } catch { txId = (await TransactionStore.add(payload)).id; } }
      else      { txId = (await TransactionStore.add(payload)).id; }
    } else if (txId) {
      try { await TransactionStore.delete(txId); } catch (_) {}
      txId = null;
    }
    data.txId = txId;

    if (editId) await ShiftStore.update(editId, data);
    else        await ShiftStore.add(data);

    showForm(false);
    await renderPage();
    showToast(editId ? 'Shift updated' : 'Shift logged', 'success');
  } catch (err) {
    showToast(err.message || 'Failed to save shift', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteShift() {
  const id = document.getElementById('sEditId').value;
  const s = _shifts.find(x => x.id === id);
  if (!s) return;
  if (!await confirmDialog(s.txId ? 'Delete this shift and its logged income entry?' : 'Delete this shift?', { confirmText: 'Delete' })) return;
  try {
    if (s.txId) { try { await TransactionStore.delete(s.txId); } catch (_) {} }
    await ShiftStore.remove(id);
    showForm(false);
    await renderPage();
    showToast('Shift deleted', 'success');
  } catch (err) {
    showToast(err.message || 'Failed to delete', 'error');
  }
}

async function saveAsPreset() {
  const d = readForm();
  const name = ((await promptDialog('Name this preset (e.g. “Café day”):', d.employer || '', { confirmText: 'Save preset', maxlength: 40 })) || '').trim().slice(0, 40);
  if (!name) return;
  ShiftStore.savePreset({
    name, employer: d.employer, start: d.start, end: d.end, breakMin: d.breakMin,
    payMode: d.payMode, rate: d.rate, fixedPay: d.fixedPay,
    accountId: d.accountId, categoryId: d.categoryId,
  });
  renderPresets();
  showToast(`Preset “${name}” saved`, 'success');
}

/* ============================================================
   INIT
   ============================================================ */
async function loadOptions() {
  _accounts   = await AccountStore.getAll();
  _incomeCats = await CategoryStore.getByType('income');
  const acctOpts = '<option value="">— none —</option>' +
    _accounts.map(a => `<option value="${a.id}">${escapeHTML(a.name)}</option>`).join('');
  const catOpts  = '<option value="">— none —</option>' +
    _incomeCats.map(c => `<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');
  ['sAccount', 'jAccount'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = acctOpts; });
  ['sCategory', 'jCategory'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = catOpts; });
  /* these ship data-loading so they shimmer rather than sitting empty */
  ['sAccount', 'sCategory'].forEach(clearFieldLoading);
}

/* Load saved jobs and (re)fill the quick-log + form selectors. Keeps the
   quick-log job picked across renders when it still exists. */
async function loadJobs() {
  _jobs = await JobStore.getAll();
  populateJobSelects();
}

function populateJobSelects() {
  /* Quick-log picker: just the jobs (no "none" — quick-log needs a job's rate).
     Falls back to a hint option when there are none yet. */
  const ql = document.getElementById('qlJob');
  if (ql) {
    const keep = ql.value;
    if (!_jobs.length) {
      ql.innerHTML = '<option value="">Add a job first →</option>';
    } else {
      ql.innerHTML = _jobs.map(j => `<option value="${j.id}">${escapeHTML(j.name)}</option>`).join('');
      /* prefer the current pick, then the Settings default job, then the
         last-used one, then just the first job */
      ql.value = [keep, JobStore.getDefaultId(), localStorage.getItem('pf_quick_job')]
        .find(id => id && _jobs.some(j => j.id === id)) || _jobs[0].id;
    }
  }
  /* Shift form picker: optional, plus an inline "new job" shortcut. */
  const sj = document.getElementById('sJob');
  if (sj) {
    const keep = sj.value;
    sj.innerHTML = '<option value="">— No job —</option>' +
      _jobs.map(j => `<option value="${j.id}">${escapeHTML(j.name)}</option>`).join('') +
      '<option value="__new__">+ New job…</option>';
    sj.value = _jobs.some(j => j.id === keep) ? keep : '';
  }
  ['qlJob', 'sJob'].forEach(clearFieldLoading);
}

/* ============================================================
   JOB EDITOR (modal) + form job selector
   ============================================================ */
let _jobModalFromForm = false;   /* opened via the shift form's "+ New job"? */

/* Fill the shift form's rate/account/category from a job's defaults. */
function applyJobToForm(job) {
  if (!job) return;
  setPayMode('hourly');
  if (job.rate) document.getElementById('sRate').value = job.rate;
  document.getElementById('sAccount').value  = job.accountId  || '';
  document.getElementById('sCategory').value = job.categoryId || '';
  payPreview();
}

function onShiftJobChange() {
  const sel = document.getElementById('sJob');
  if (sel.value === '__new__') {
    sel.value = '';                 /* revert; the modal selects it on save */
    openJobModal(null, true);
    return;
  }
  applyJobToForm(_jobs.find(j => j.id === sel.value));
}

function openJobModal(id = null, fromForm = false) {
  _jobModalFromForm = fromForm;
  const job = id ? _jobs.find(j => j.id === id) : null;
  document.getElementById('jEditId').value = job ? job.id : '';
  document.getElementById('jobModalTitle').textContent = job ? 'Edit job' : 'New job';
  document.getElementById('jName').value = job ? job.name : '';
  document.getElementById('jRate').value = job && job.rate ? job.rate : (ShiftStore.getDefaultRate() || '');
  document.getElementById('jAccount').value  = job ? (job.accountId || '') : (ShiftStore.getJobDefaults().accountId || '');
  document.getElementById('jCategory').value = job ? (job.categoryId || '') : '';
  document.getElementById('jobDelete').hidden = !job;
  document.getElementById('jobModal').hidden = false;
  document.getElementById('jName').focus();
}

function closeJobModal() {
  document.getElementById('jobModal').hidden = true;
  _jobModalFromForm = false;
}

async function saveJob() {
  const id   = document.getElementById('jEditId').value;
  const name = document.getElementById('jName').value.trim();
  if (!name) { showToast('Name the job', 'error'); return; }
  const data = {
    name,
    rate:       parseFloat(document.getElementById('jRate').value) || 0,
    accountId:  document.getElementById('jAccount').value  || null,
    categoryId: document.getElementById('jCategory').value || null,
  };
  const btn = document.getElementById('jobSave');
  btn.disabled = true;
  try {
    const saved = id ? await JobStore.update(id, data) : await JobStore.add(data);
    if (data.rate > 0) ShiftStore.setDefaultRate(data.rate);   /* keep a sensible fallback rate */
    const fromForm = _jobModalFromForm;
    closeJobModal();
    await loadJobs();
    if (fromForm && saved) {
      const sel = document.getElementById('sJob');
      if (sel) { sel.value = saved.id; applyJobToForm(saved); }
    }
    renderJobs();
    showToast(id ? 'Job saved' : 'Job added', 'success');
  } catch (err) {
    showToast(err.message || 'Failed to save job', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteJob() {
  const id = document.getElementById('jEditId').value;
  if (!id) return;
  if (!await confirmDialog('Delete this job? Your logged shifts stay, but lose their job link.', { confirmText: 'Delete' })) return;
  try {
    await JobStore.remove(id);
    closeJobModal();
    await loadJobs();
    renderJobs();
    showToast('Job deleted', 'success');
  } catch (err) {
    showToast(err.message || 'Failed to delete job', 'error');
  }
}

async function renderPage() {
  _shifts = await ShiftStore.getAll();
  _payouts = await PayoutStore.getAll();
  const paidIds = await PayoutStore.paidShiftIds();
  _shifts.forEach(s => { s.paid = paidIds.has(s.id); });
  await loadJobs();
  renderStats();
  renderSalary();
  renderUnpaid();
  renderGoal();
  renderQuickChips(_qlDate || todayISO());
  renderQuickMeta();
  renderChartJobFilter();
  renderChart();
  renderDayOfWeek();
  renderJobs();
  renderPresets();
  renderEmployerFilter();
  renderPayouts();
  renderList();
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await SupaAuth.requireAuth();
  if (!user) return;
  await SettingsStore.hydrateLocalDefaults();   /* pull synced job/account defaults */
  _goal = ShiftStore.getGoal();
  try {
    await loadOptions();
    /* one-time: turn any existing shift job names into saved jobs */
    await JobStore.seedFromShifts(await ShiftStore.getAll());
    await renderPage();
  } catch (err) {
    console.error('Hours Tracker error:', err);
    showErrorState('shiftsList', "Couldn't load your shifts. " + (err.message || ''), () => location.reload());
    /* the page ships first-paint placeholders (shifts.html) — settle them all
       so nothing is left shimmering after a failed load */
    ['weekPay', 'weekHours', 'monthPay', 'monthHours', 'effRate', 'totalPay', 'totalShifts',
     'goalPct', 'goalDetail'].forEach(id => setText(id, '—'));
    showErrorState('jobList', 'Jobs unavailable.');
    ['hoursBars', 'dowGrid'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
    clearFieldLoading();
  }

  /* /hours-tracker#log — the bottom-bar + when the user's main use is hours */
  const focusQuickLog = () => {
    if (location.hash !== '#log') return;
    document.getElementById('quickPanel')?.scrollIntoView({ block: 'center' });
    document.getElementById('qlHours')?.focus({ preventScroll: true });
    history.replaceState(null, '', location.pathname);   /* so a second tap fires hashchange again */
    document.body.classList.remove('page-exit');           /* ui.js fades out before a same-page hop */
  };
  focusQuickLog();
  window.addEventListener('hashchange', focusQuickLog);

  /* quick log + mark-as-paid */
  document.getElementById('quickLogForm')?.addEventListener('submit', quickLog);
  document.getElementById('markPaidBtn')?.addEventListener('click', openPaidModal);
  document.getElementById('salaryToggle')?.addEventListener('click', toggleSalary);
  document.getElementById('paidActual')?.addEventListener('input', updatePaidBonus);
  document.getElementById('paidConfirm')?.addEventListener('click', confirmPaid);
  document.getElementById('paidCancel')?.addEventListener('click', closePaidModal);
  document.getElementById('paidBackdrop')?.addEventListener('click', closePaidModal);
  document.getElementById('payoutsMergeAll')?.addEventListener('click', mergeAllPayouts);

  /* jobs */
  document.getElementById('addJobBtn')?.addEventListener('click', () => openJobModal());
  document.getElementById('jobSave')?.addEventListener('click', saveJob);
  document.getElementById('jobDelete')?.addEventListener('click', deleteJob);
  document.getElementById('jobCancel')?.addEventListener('click', closeJobModal);
  document.getElementById('jobBackdrop')?.addEventListener('click', closeJobModal);
  document.getElementById('sJob')?.addEventListener('change', onShiftJobChange);
  document.getElementById('qlJob')?.addEventListener('change', e => {
    localStorage.setItem('pf_quick_job', e.target.value);
    renderQuickMeta();
  });

  /* form */
  document.getElementById('addShiftBtn')?.addEventListener('click', openAdd);
  document.getElementById('closeShiftForm')?.addEventListener('click', () => showForm(false));
  document.getElementById('shiftForm')?.addEventListener('submit', saveShift);
  document.getElementById('shiftDelete')?.addEventListener('click', deleteShift);
  document.getElementById('savePresetBtn')?.addEventListener('click', saveAsPreset);
  document.getElementById('sLogIncome')?.addEventListener('change', syncIncomeFields);
  document.getElementById('sDate')?.addEventListener('change', e => renderDayChips(e.target.value));
  document.querySelectorAll('.paymode-btn').forEach(b => b.addEventListener('click', () => setPayMode(b.dataset.mode)));
  ['sStart', 'sEnd', 'sBreak', 'sRate', 'sFixed', 'sTips'].forEach(id =>
    document.getElementById(id)?.addEventListener('input', payPreview));

  /* goal */
  document.getElementById('editGoalBtn')?.addEventListener('click', openGoalEdit);
  document.getElementById('goalEdit')?.addEventListener('submit', saveGoal);
  document.getElementById('clearGoalBtn')?.addEventListener('click', clearGoal);
  document.querySelectorAll('#goalEdit .seg-btn').forEach(b =>
    b.addEventListener('click', () => setGoalMetric(b.dataset.metric)));

  /* chart metric toggle */
  document.querySelectorAll('#chartMetricToggle .seg-btn').forEach(b =>
    b.addEventListener('click', () => {
      _chartMetric = b.dataset.metric === 'hours' ? 'hours' : 'pay';
      document.querySelectorAll('#chartMetricToggle .seg-btn').forEach(x => x.classList.toggle('active', x === b));
      renderChart();
    }));

  /* employer filter */
  document.getElementById('employerFilter')?.addEventListener('change', e => {
    _employerFilter = e.target.value;
    renderList();
  });

  /* earnings-chart job filter */
  document.getElementById('chartJobFilter')?.addEventListener('change', e => {
    _chartJob = e.target.value;
    renderChart();
  });
});

})();
