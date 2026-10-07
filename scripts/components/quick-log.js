/* ============================================================
   quick-log.js — Dashboard "Log hours" widget.
   Pick a day of the current week, enter the hours (or a start→end
   time range), and log — the hourly rate, deposit account and job
   name come from your Job defaults (Settings). Like the Hours
   Tracker quick-log, a shift is added "unlogged" — no income
   transaction until you flip it from the Hours Tracker list.
   Exposes window.QuickLog.init.
   Depends on ShiftStore, ShiftEngine, AccountStore,
   formatCurrency, escapeHTML, showToast.
   ============================================================ */
(function () {
'use strict';

let _accounts = [];
let _incomeCats = [];
let _jobs = [];
let _onLogged = null;

/* The default job chosen in Settings (a JobStore job), or null. */
function defaultJob() {
  if (typeof JobStore === 'undefined') return null;
  return _jobs.find(j => j.id === JobStore.getDefaultId()) || null;
}
let _selected = null;            /* selected day, YYYY-MM-DD */
let _mode = 'hours';             /* 'hours' | 'times' */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const iso = d => isoLocal(d);
const todayISO = () => iso(new Date());
function fmtHours(h) { return `${(Math.round(h * 100) / 100).toFixed(h % 1 === 0 ? 0 : 1)} h`; }

function weekRange() {
  const from = ShiftEngine.weekStart(todayISO());
  const to = new Date(from + 'T00:00:00'); to.setDate(to.getDate() + 6);
  return { from, to: iso(to) };
}

/* current week, Sunday→Saturday */
function weekDays() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = todayISO();
  const sunday = new Date(today); sunday.setDate(today.getDate() - today.getDay());
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sunday); d.setDate(sunday.getDate() + i);
    const ds = iso(d);
    out.push({ date: ds, dow: DOW[i], num: d.getDate(), isToday: ds === t, isFuture: ds > t });
  }
  return out;
}

/* Shared save: add the shift as "unlogged" — no income transaction. Flip it
   to income from the Hours Tracker list once you're actually paid. Mirrors the
   Hours Tracker quick-log default. */
async function logShift(data) {
  const pay = ShiftEngine.pay(data);
  data.txId = null;
  await ShiftStore.add(data);
  return pay;
}

/* ---- day chips ---- */
function renderDays() {
  const row = document.getElementById('qlDays');
  if (!row) return;
  row.innerHTML = weekDays().map(d => `
    <button type="button" class="ql-day${d.date === _selected ? ' selected' : ''}${d.isFuture ? ' ql-day--disabled' : ''}"
            data-date="${d.date}"${d.isFuture ? ' disabled' : ''}>
      <span class="ql-day__dow">${d.isToday ? 'Today' : d.dow}</span>
      <span class="ql-day__num">${d.num}</span>
    </button>`).join('');
  row.querySelectorAll('.ql-day:not([disabled])').forEach(b =>
    b.addEventListener('click', () => { _selected = b.dataset.date; renderDays(); }));
}

/* ---- rate/account caption ---- */
function renderHint() {
  const el = document.getElementById('qlRateHint');
  if (!el) return;
  const job = ShiftStore.getJobDefaults();
  const dj  = defaultJob();
  const name = dj ? `${escapeHTML(dj.name)} · ` : '';
  const rate = dj ? dj.rate : job.rate;
  const acc = _accounts.find(a => a.id === ((dj && dj.accountId) || job.accountId)) || _accounts[0];
  if (_mode === 'pay') {
    if (acc) { el.innerHTML = `${name}Deposited → ${escapeHTML(acc.name)}`; el.hidden = false; }
    else if (name) { el.innerHTML = name.replace(/ · $/, ''); el.hidden = false; }
    else { el.innerHTML = ''; el.hidden = true; }
  } else if (rate > 0) {
    el.innerHTML = `${name}Paid <strong>${formatCurrency(rate)}/h</strong>${acc ? ` → ${escapeHTML(acc.name)}` : ''}`;
    el.hidden = false;
  } else {
    /* no rate yet: hours still log, but say why the pay reads $0 */
    el.innerHTML = `${name}No pay rate yet — <a href="/hours-tracker">set one</a> to see what you’ve earned.`;
    el.hidden = false;
  }
}

function setMode(mode) {
  _mode = (mode === 'times' || mode === 'pay') ? mode : 'hours';
  document.querySelectorAll('#qlMode .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === _mode));
  document.getElementById('qlHoursRow').hidden = _mode !== 'hours';
  document.getElementById('qlTimesRow').hidden = _mode !== 'times';
  document.getElementById('qlPayRow').hidden   = _mode !== 'pay';
  const btn = document.getElementById('qlSubmit');
  if (btn) btn.textContent = _mode === 'pay' ? 'Log pay' : 'Log hours';
  renderHint();
}

/* ---- submit ---- */
async function submitForm(e) {
  e.preventDefault();
  const job = ShiftStore.getJobDefaults();
  const dj  = defaultJob();
  const base = {
    date: _selected || todayISO(),
    employer: dj ? dj.name : (job.employer || ''),
    jobId: dj ? dj.id : null,
    breakMin: 0, tips: 0,
    accountId: (dj && dj.accountId) || job.accountId || _accounts[0]?.id || null,
    categoryId: (dj && dj.categoryId) || _incomeCats[0]?.id || null,
  };

  let data;
  if (_mode === 'pay') {
    const amt = parseFloat(document.getElementById('qlPay').value) || 0;
    if (amt <= 0) { showToast('Enter the amount you were paid', 'error'); return; }
    data = { ...base, start: '', end: '', payMode: 'fixed', rate: 0, fixedPay: amt };
  } else {
    let start, end;
    if (_mode === 'times') {
      start = document.getElementById('qlStart').value;
      end   = document.getElementById('qlEnd').value;
      if (!start || !end) { showToast('Enter a start and end time', 'error'); return; }
    } else {
      const hours = parseFloat(document.getElementById('qlHours').value) || 0;
      if (hours <= 0) { showToast('Enter the number of hours', 'error'); return; }
      start = ''; end = '';     /* hours only — don't invent clock times */
      base.hours = hours;
    }
    data = { ...base, start, end, payMode: 'hourly', rate: (dj ? dj.rate : job.rate) || 0, fixedPay: 0 };
  }

  const btn = document.getElementById('qlSubmit');
  btn.disabled = true;
  try {
    const pay = await logShift(data);
    const hrs = ShiftEngine.hours(data);
    const msg = _mode === 'pay'
      ? `Logged ${formatCurrency(pay)} · unlogged`
      : (pay > 0 ? `Logged ${fmtHours(hrs)} · unlogged` : `Logged ${fmtHours(hrs)}`);
    showToast(msg, 'success');
    ['qlHours', 'qlStart', 'qlEnd', 'qlPay'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    await afterLog();
  } catch (err) {
    showToast(err.message || 'Failed to log', 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ---- this-week stat ---- */
async function renderStat() {
  const el = document.getElementById('quicklogStat');
  if (!el) return;
  try {
    const shifts = await ShiftStore.getAll();
    const wk = ShiftEngine.summarize(shifts, weekRange());
    el.innerHTML = wk.count
      ? `This week · <strong>${fmtHours(wk.hours)}</strong> · <strong>${formatCurrency(wk.pay)}</strong>`
      : `No hours logged this week yet.`;
  } catch { el.textContent = ''; }
}

async function afterLog() {
  await renderStat();
  renderDays();   /* "Today" highlight, in case the day rolled over */
  if (typeof _onLogged === 'function') { try { await _onLogged(); } catch (_) {} }
}

/* ---- init ---- */
async function init(opts = {}) {
  if (typeof ShiftStore === 'undefined' || typeof ShiftEngine === 'undefined') return;
  _onLogged = opts.onLogged || null;
  if (!document.getElementById('quickLog')) return;

  try {
    if (typeof SettingsStore !== 'undefined') await SettingsStore.hydrateLocalDefaults();
    _accounts   = await AccountStore.getAll();
    _incomeCats = await CategoryStore.getByType('income');
    _jobs       = (typeof JobStore !== 'undefined') ? await JobStore.getAll() : [];
  } catch (_) { _accounts = []; _incomeCats = []; _jobs = []; }

  _selected = todayISO();
  setMode('hours');
  renderDays();
  renderHint();
  await renderStat();

  document.querySelectorAll('#qlMode .seg-btn').forEach(b =>
    b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.getElementById('quicklogForm')?.addEventListener('submit', submitForm);
}

window.QuickLog = { init };

})();
