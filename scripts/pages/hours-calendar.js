/* ============================================================
   hours-calendar.js — Hours Tracker · Calendar view.
   The same shifts as the Hours Tracker, laid out on a calendar so
   a period reads at a glance: week / month / year, showing pay or
   hours, optionally narrowed to one job. Read-only — logging and
   editing stay on the tracker. Math is the pure ShiftEngine.
   ============================================================ */

/* IIFE-wrapped: store.js (loaded first) already declares globals like
   `todayISO`, and a top-level `const` clash there is a SyntaxError that aborts
   the whole file. */
(function () {
'use strict';

let _shifts = [];
let _view    = 'month';   /* 'week' | 'month' | 'year' */
let _metric  = 'pay';     /* 'pay'  | 'hours' */
let _job     = '';        /* employer name, '' = all jobs */
let _anchor  = null;      /* any YYYY-MM-DD inside the shown period */
let _selected = null;     /* YYYY-MM-DD of the open day detail, or null */

const iso = d => isoLocal(d);
const today = () => iso(new Date());
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

/* YYYY-MM-DD → local Date (never `new Date(str)`, which parses as UTC) */
function parse(dateStr) { return new Date(dateStr + 'T00:00:00'); }
function addDays(dateStr, n) { const d = parse(dateStr); d.setDate(d.getDate() + n); return iso(d); }
function startOfWeek(dateStr) { const d = parse(dateStr); d.setDate(d.getDate() - d.getDay()); return iso(d); }

function fmtHours(h) { return `${(Math.round(h * 100) / 100).toFixed(h % 1 === 0 ? 0 : 1)} h`; }
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m ?? 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
/* compact money for tight calendar cells (e.g. $1.2k) */
function moneyShort(v) {
  if (v >= 1000) return '$' + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
  return '$' + Math.round(v);
}
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

/* The shifts the current job filter lets through. */
function visible() {
  return _job ? _shifts.filter(s => (s.employer || '').trim() === _job) : _shifts;
}
/* The metric's value for one shift — what every cell is sized and labelled by. */
function metricOf(shift) {
  return _metric === 'hours' ? ShiftEngine.hours(shift) : ShiftEngine.pay(shift);
}
function metricLabel(v) {
  return _metric === 'hours' ? fmtHours(v) : formatCurrency(v);
}

/* ============================================================
   PERIOD — the [from, to] window the current view covers
   ============================================================ */
function period() {
  const a = parse(_anchor);
  if (_view === 'week') {
    const from = startOfWeek(_anchor);
    return { from, to: addDays(from, 6) };
  }
  if (_view === 'year') {
    return { from: iso(new Date(a.getFullYear(), 0, 1)), to: iso(new Date(a.getFullYear(), 11, 31)) };
  }
  return { from: iso(new Date(a.getFullYear(), a.getMonth(), 1)),
           to:   iso(new Date(a.getFullYear(), a.getMonth() + 1, 0)) };
}

function periodLabel() {
  const a = parse(_anchor);
  if (_view === 'year') return String(a.getFullYear());
  if (_view === 'month') return `${MONTHS[a.getMonth()]} ${a.getFullYear()}`;
  const { from, to } = period();
  const f = parse(from), t = parse(to);
  const fm = f.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const tm = t.toLocaleDateString('en-US',
    f.getMonth() === t.getMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
  return `${fm} – ${tm}, ${t.getFullYear()}`;
}

/* Step one period back (dir -1) or forward (dir +1). */
function step(dir) {
  const a = parse(_anchor);
  if (_view === 'week')      _anchor = addDays(_anchor, dir * 7);
  else if (_view === 'year') _anchor = iso(new Date(a.getFullYear() + dir, a.getMonth(), 1));
  else                       _anchor = iso(new Date(a.getFullYear(), a.getMonth() + dir, 1));
  _selected = null;
  render();
}

/* ============================================================
   PERIOD SUMMARY STRIP
   ============================================================ */
function renderSummary() {
  const p = period();
  const sum = ShiftEngine.summarize(visible(), p);
  const rate = sum.hours > 0 ? Math.round((sum.pay / sum.hours) * 100) / 100 : 0;
  const unit = _view === 'week' ? 'this week' : _view === 'year' ? 'this year' : 'this month';

  setText('calPay', formatCurrency(sum.pay));
  setText('calPaySub', `earned ${unit}`);
  setText('calHours', fmtHours(sum.hours));
  setText('calHoursSub', `${sum.count} shift${sum.count === 1 ? '' : 's'}`);
  setText('calRate', rate > 0 ? formatCurrency(rate) : '—');

  /* days actually worked, and the average of those days */
  const days = new Set(visible()
    .filter(s => s.date >= p.from && s.date <= p.to)
    .map(s => s.date)).size;
  setText('calDays', String(days));
  setText('calDaysSub', days > 0
    ? `avg ${metricLabel((_metric === 'hours' ? sum.hours : sum.pay) / days)} / day`
    : 'none worked');
}

/* ============================================================
   GRID — month / week / year
   ============================================================ */
/* Hours AND pay keyed by day (YYYY-MM-DD) across the filtered shifts. Both are
   kept because a cell shows both figures — the toggled metric only decides
   which one leads (and what the heat fill is scaled to). */
function dayTotals() {
  const map = new Map();
  visible().forEach(s => {
    const g = map.get(s.date) || { hours: 0, pay: 0 };
    g.hours += ShiftEngine.hours(s);
    g.pay   += ShiftEngine.pay(s);
    map.set(s.date, g);
  });
  return map;
}

/* The value the current metric measures a {hours, pay} total by. */
function metricVal(t) { return _metric === 'hours' ? t.hours : t.pay; }

/* Compact cell labels: the toggled metric leads, the other rides along
   underneath, so a day reads as "what I worked" and "what it paid" at once. */
function cellFigures(t) {
  const h = `${Math.round(t.hours * 10) / 10}h`;
  const m = moneyShort(t.pay);
  return _metric === 'hours' ? { lead: h, alt: m } : { lead: m, alt: h };
}

/* A cell's heat fill, as a fraction of the period's busiest cell. Always a
   TINT, never a solid block: the busiest day tops out at 0.42 so the figures
   printed on top stay legible, and the floor keeps a worked day from reading
   as an empty one. */
function heat(v, max) { return max > 0 && v > 0 ? 0.10 + 0.32 * (v / max) : 0; }

function renderMonth(el) {
  const totals = dayTotals();
  const a = parse(_anchor);
  const first = new Date(a.getFullYear(), a.getMonth(), 1);
  const gridStart = startOfWeek(iso(first));
  const p = period();
  /* scale against the busiest day IN this month, so each month reads on its own */
  const max = Math.max(0, ...[...totals.entries()]
    .filter(([d]) => d >= p.from && d <= p.to).map(([, t]) => metricVal(t)));

  let cells = '';
  for (let i = 0; i < 42; i++) {
    const date = addDays(gridStart, i);
    /* stop after a full week once the month is behind us — no dead 6th row */
    if (i >= 35 && date > p.to) break;
    const d = parse(date);
    const out = d.getMonth() !== a.getMonth();
    const t = totals.get(date);
    const v = t ? metricVal(t) : 0;
    const fig = t ? cellFigures(t) : null;
    const cls = ['cal-cell'];
    if (out) cls.push('cal-cell--out');
    if (date === today()) cls.push('cal-cell--today');
    if (date === _selected) cls.push('cal-cell--sel');
    if (t) cls.push('cal-cell--has');
    cells += `<button type="button" class="${cls.join(' ')}" data-date="${date}"
        aria-label="${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}${t ? ` · ${fmtHours(t.hours)} · ${formatCurrency(t.pay)}` : ''}">
      <span class="cal-cell__fill" style="opacity:${heat(v, max).toFixed(3)}"></span>
      <span class="cal-cell__num">${d.getDate()}</span>
      <span class="cal-cell__val">${fig ? fig.lead : ''}</span>
      <span class="cal-cell__alt">${fig ? fig.alt : ''}</span>
    </button>`;
  }

  el.innerHTML =
    `<div class="cal-dow">${DOW.map(x => `<span>${x[0]}</span>`).join('')}</div>
     <div class="cal-grid">${cells}</div>`;
}

function renderWeek(el) {
  const p = period();
  const cols = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(p.from, i);
    const d = parse(date);
    const list = visible().filter(s => s.date === date);
    const total = list.reduce((a, s) => a + metricOf(s), 0);
    const rows = list.map(s => {
      const bits = [escapeHTML(s.employer || 'Shift')];
      if (s.start && s.end) bits.push(`${fmtTime(s.start)}–${fmtTime(s.end)}`);
      return `<div class="cal-chip${s.paid || s.txId ? '' : ' cal-chip--unpaid'}">
        <span class="cal-chip__val">${metricLabel(metricOf(s))}</span>
        <span class="cal-chip__meta">${bits.join(' · ')}</span>
      </div>`;
    }).join('');
    cols.push(`<button type="button" class="cal-day${date === today() ? ' cal-day--today' : ''}${date === _selected ? ' cal-day--sel' : ''}" data-date="${date}">
      <span class="cal-day__head">
        <span class="cal-day__dow">${DOW[d.getDay()]}</span>
        <span class="cal-day__num">${d.getDate()}</span>
      </span>
      <span class="cal-day__total">${total > 0 ? metricLabel(total) : '—'}</span>
      <span class="cal-day__body">${rows}</span>
    </button>`);
  }
  el.innerHTML = `<div class="cal-week">${cols.join('')}</div>`;
}

function renderYear(el) {
  const a = parse(_anchor);
  const year = a.getFullYear();
  const months = MONTHS.map((name, m) => {
    const from = iso(new Date(year, m, 1));
    const to   = iso(new Date(year, m + 1, 0));
    const sum  = ShiftEngine.summarize(visible(), { from, to });
    return { name, m, from, hours: sum.hours, pay: sum.pay,
             v: _metric === 'hours' ? sum.hours : sum.pay, count: sum.count };
  });
  const max = Math.max(0, ...months.map(x => x.v));
  const isNow = m => year === new Date().getFullYear() && m === new Date().getMonth();

  el.innerHTML = `<div class="cal-year">${months.map(x => `
    <button type="button" class="cal-month${isNow(x.m) ? ' cal-month--now' : ''}${x.v > 0 ? ' cal-month--has' : ''}" data-month="${x.m}">
      <span class="cal-cell__fill" style="opacity:${heat(x.v, max).toFixed(3)}"></span>
      <span class="cal-month__name">${x.name.slice(0, 3)}</span>
      <span class="cal-month__val">${x.v > 0 ? metricLabel(x.v) : '—'}</span>
      <span class="cal-month__alt">${x.count > 0 ? (_metric === 'hours' ? formatCurrency(x.pay) : fmtHours(x.hours)) : ''}</span>
      <span class="cal-month__sub">${x.count > 0 ? `${x.count} shift${x.count === 1 ? '' : 's'}` : ''}</span>
    </button>`).join('')}</div>`;
}

function renderGrid() {
  const el = document.getElementById('calBody');
  if (!el) return;
  if (_view === 'week')      renderWeek(el);
  else if (_view === 'year') renderYear(el);
  else                       renderMonth(el);

  /* month/week: tap a day to open its detail; year: tap a month to zoom in */
  el.querySelectorAll('[data-date]').forEach(b =>
    b.addEventListener('click', () => selectDay(b.dataset.date)));
  el.querySelectorAll('[data-month]').forEach(b =>
    b.addEventListener('click', () => {
      _anchor = iso(new Date(parse(_anchor).getFullYear(), Number(b.dataset.month), 1));
      setView('month');
    }));
}

/* ============================================================
   DAY DETAIL
   ============================================================ */
function selectDay(date) {
  _selected = _selected === date ? null : date;
  renderGrid();
  renderDetail();
}

function renderDetail() {
  const panel = document.getElementById('calDetail');
  const list  = document.getElementById('calDetailList');
  if (!panel || !list) return;
  if (!_selected) { panel.hidden = true; return; }

  const day = visible().filter(s => s.date === _selected);
  panel.hidden = false;
  setText('calDetailTitle', parse(_selected).toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric' }));
  const sum = ShiftEngine.summarize(day);
  setText('calDetailSum', day.length
    ? `${fmtHours(sum.hours)} · ${formatCurrency(sum.pay)}`
    : '');

  if (!day.length) {
    list.innerHTML = `<div class="empty-state" style="padding:22px 14px;">Nothing logged this day.</div>`;
    return;
  }
  list.innerHTML = day.map(s => {
    const bits = [];
    if (s.payMode === 'fixed') bits.push('flat rate');
    else if (s.start && s.end) bits.push(`${fmtTime(s.start)}–${fmtTime(s.end)}`);
    if (s.breakMin) bits.push(`${s.breakMin}m break`);
    if (s.tips)     bits.push(`+${formatCurrency(s.tips)} tips`);
    const state = s.paid ? 'paid' : s.txId ? 'paid' : 'unlogged';
    return `<div class="cal-shift">
      <div class="cal-shift__main">
        <div class="cal-shift__job">${escapeHTML(s.employer || 'Shift')}</div>
        <div class="cal-shift__meta">${bits.join(' · ') || 'hours only'}</div>
      </div>
      <div class="cal-shift__figs">
        <div class="cal-shift__hours">${fmtHours(ShiftEngine.hours(s))}</div>
        <div class="cal-shift__pay">${formatCurrency(ShiftEngine.pay(s))}</div>
      </div>
      <span class="cal-shift__badge${state === 'unlogged' ? ' cal-shift__badge--off' : ''}">${state}</span>
    </div>`;
  }).join('');
}

/* ============================================================
   CONTROLS
   ============================================================ */
function setView(view) {
  _view = ['week', 'month', 'year'].includes(view) ? view : 'month';
  try { localStorage.setItem('pf_cal_view', _view); } catch (_) {}
  document.querySelectorAll('#calViewToggle .seg-btn')
    .forEach(b => b.classList.toggle('active', b.dataset.view === _view));
  _selected = null;
  render();
}

function setMetric(metric) {
  _metric = metric === 'hours' ? 'hours' : 'pay';
  try { localStorage.setItem('pf_cal_metric', _metric); } catch (_) {}
  document.querySelectorAll('#calMetricToggle .seg-btn')
    .forEach(b => b.classList.toggle('active', b.dataset.metric === _metric));
  render();
}

/* "All jobs" + one option per employer name found in the shifts. Hidden until
   there's more than one job to choose between (same rule as the tracker). */
function renderJobFilter() {
  const sel = document.getElementById('calJobFilter');
  if (!sel) return;
  const names = [...new Set(_shifts.map(s => (s.employer || '').trim()).filter(Boolean))].sort();
  if (names.length < 2) { sel.hidden = true; _job = ''; return; }
  sel.hidden = false;
  sel.innerHTML = `<option value="">All jobs</option>` +
    names.map(n => `<option value="${escapeHTML(n)}"${n === _job ? ' selected' : ''}>${escapeHTML(n)}</option>`).join('');
}

function render() {
  setText('calPeriod', periodLabel());
  const t = document.getElementById('calToday');
  if (t) t.hidden = period().from <= today() && today() <= period().to;
  renderSummary();
  renderGrid();
  renderDetail();
}

/* ============================================================
   INIT
   ============================================================ */
async function loadShifts() {
  _shifts = await ShiftStore.getAll();
  const paidIds = await PayoutStore.paidShiftIds();
  _shifts.forEach(s => { s.paid = paidIds.has(s.id); });
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await SupaAuth.requireAuth();
  if (!user) return;

  _anchor = today();
  try {
    _view   = localStorage.getItem('pf_cal_view')   || 'month';
    _metric = localStorage.getItem('pf_cal_metric') || 'pay';
  } catch (_) {}

  try {
    await loadShifts();
    renderJobFilter();
    setView(_view);            /* syncs the toggle, then renders everything */
    setMetric(_metric);
  } catch (err) {
    console.error('Hours calendar error:', err);
    showErrorState('calBody', "Couldn't load your shifts. " + (err.message || ''), () => location.reload());
    /* the summary strip ships shimmer placeholders — settle them */
    ['calPay', 'calHours', 'calHoursSub', 'calRate', 'calDays', 'calDaysSub']
      .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
  }

  document.getElementById('calPrev')?.addEventListener('click', () => step(-1));
  document.getElementById('calNext')?.addEventListener('click', () => step(1));
  document.getElementById('calToday')?.addEventListener('click', () => {
    _anchor = today(); _selected = null; render();
  });
  document.getElementById('calDetailClose')?.addEventListener('click', () => {
    _selected = null; renderGrid(); renderDetail();
  });
  document.querySelectorAll('#calViewToggle .seg-btn')
    .forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  document.querySelectorAll('#calMetricToggle .seg-btn')
    .forEach(b => b.addEventListener('click', () => setMetric(b.dataset.metric)));
  document.getElementById('calJobFilter')?.addEventListener('change', e => {
    _job = e.target.value;
    render();
  });

  /* ← / → step through periods, as long as you're not typing in a control */
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });
});

})();
