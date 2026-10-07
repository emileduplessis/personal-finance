/* ============================================================
   dashboard.js — Dashboard page logic (async)
   ============================================================ */

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/* How many rows the Transactions feed renders. It's deliberately more than fit
   on screen: the panel grows to fill its column/slot, and the list scrolls
   (.dash-feed .transaction-list is overflow-y:auto), so a fixed small number
   left the panel half-empty in tall layouts. Extra rows just scroll. */
const RECENT_TX_COUNT = 25;

let overview = { mode: 'month', offset: 0 };   /* Overview chart range (week|month|year|all) */
try {
  const _ovr = localStorage.getItem('pf_overview_range');
  if (_ovr && typeof PeriodEngine !== 'undefined' && PeriodEngine.MODES.includes(_ovr)) overview.mode = _ovr;
} catch (_) {}
let _dashboardReady = false;

/* index.html already ships these placeholders so they paint before this script
   has even downloaded (see "First-paint loading states" in components.css).
   This re-applies them for a re-render — matching markup, so nothing jumps. */
function showSkeletons() {
  ['totalBalance','monthIncome','monthExpense','monthNet','ninetyDayChange','yearChange'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<span class="skeleton skeleton-num${id === 'totalBalance' ? ' skeleton-num--lg' : ''}"></span>`;
  });
  const recentEl = document.getElementById('recentTransactions');
  if (recentEl) recentEl.innerHTML = [55,42,62].map(w => `
    <div class="tx-item" aria-hidden="true">
      <div class="skeleton skeleton-avatar"></div>
      <div class="tx-info">
        <div class="skeleton skeleton-text" style="width:${w}%"></div>
        <div class="skeleton skeleton-text" style="width:${Math.round(w * 0.6)}%;margin-bottom:0"></div>
      </div>
      <div class="skeleton skeleton-text" style="width:60px;margin-bottom:0"></div>
    </div>`).join('');
}

function getMonthTransactions(allTx, year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  return allTx.filter(t => t.date.startsWith(prefix));
}

async function initDashboard() {
  if (!_dashboardReady) showSkeletons();
  const [allTx, accounts, subs] = await Promise.all([
    TransactionStore.getAll(),
    AccountStore.getAll(),
    SubscriptionStore.getAll().catch(() => []),
  ]);

  const now = new Date();
  const thisMonthPrefix = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-`;
  const monthTx = allTx.filter(t => t.date.startsWith(thisMonthPrefix));

  const balanceMap   = SummaryEngine.computeAccountBalances(accounts, allTx);
  const totalBalance = Object.values(balanceMap).reduce((s, b) => s + b, 0);
  const monthTotals  = SummaryEngine.getTotals(monthTx);
  const net          = monthTotals.income - monthTotals.expense;

  const heroMonthEl = document.getElementById('heroMonthLabel');
  if (heroMonthEl) heroMonthEl.textContent = '· ' + now.toLocaleString('en-US', { month: 'short', year: 'numeric' });

  /* cinematic count-up for the balance */
  animateValue(document.getElementById('totalBalance'), totalBalance, formatBalance, 1400);
  animateValue(document.getElementById('monthIncome'),  monthTotals.income,  formatCurrency);
  animateValue(document.getElementById('monthExpense'), monthTotals.expense, formatCurrency);
  animateValue(document.getElementById('monthNet'), net, formatSigned);
  _dashboardReady = true;
  const incomeCount  = monthTx.filter(t => t.type === 'income').length;
  const expenseCount = monthTx.filter(t => t.type === 'expense').length;
  setText('monthIncomeSub',  incomeCount  === 1 ? '1 transaction' : `${incomeCount} transactions`);
  setText('monthExpenseSub', expenseCount === 1 ? '1 transaction' : `${expenseCount} transactions`);

  const netEl = document.getElementById('monthNet');
  if (netEl) netEl.style.color = signColor(net);

  /* Change pill next to the balance (wallet staple) */
  const pill = document.getElementById('balanceChangePill');
  if (pill) {
    const prev = totalBalance - net;
    if (!allTx.length || (Math.abs(prev) < 0.005 && Math.abs(net) < 0.005)) {
      pill.hidden = true;
    } else if (Math.abs(prev) > 0.005) {
      const pct  = (net / Math.abs(prev)) * 100;
      const up   = pct >= 0.05, down = pct <= -0.05;
      pill.className = 'flow-pill ' + (up ? 'flow-pill--up' : down ? 'flow-pill--down' : 'flow-pill--flat');
      pill.textContent = `${up ? '▲' : down ? '▼' : '·'} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% this month`;
      pill.hidden = false;
    } else {
      pill.className = 'flow-pill ' + (net >= 0 ? 'flow-pill--up' : 'flow-pill--down');
      pill.textContent = `${net >= 0 ? '▲ +' : '▼ −'}${formatCurrency(Math.abs(net))} this month`;
      pill.hidden = false;
    }
  }

  /* Year & 90-day change */
  /* Net-change windows that adapt to the account's age, so the two cells
     always show distinct, meaningful periods (a fixed 90d + 1y both equal
     "all data" — and look identical — on a young account). */
  const DAY_MS = 86400000;
  const firstDate = allTx.length ? allTx.map(t => t.date).sort()[0] : null;
  const spanDays = firstDate
    ? Math.max(1, Math.ceil((Date.now() - new Date(firstDate + 'T00:00:00').getTime()) / DAY_MS))
    : 0;
  const { shortW, longW } = SummaryEngine.pickChangeWindows(spanDays);

  const netOver = days => {
    const cutoff = isoLocal(new Date(Date.now() - days * DAY_MS));
    const t = SummaryEngine.getTotals(allTx.filter(x => x.date >= cutoff));
    return t.income - t.expense;
  };
  const shortNet = allTx.length ? netOver(shortW.days) : 0;
  const longNet  = allTx.length ? netOver(longW.days)  : 0;

  setText('shortChangeLabel', shortW.label);
  setText('longChangeLabel',  longW.label);
  setText('ninetyDayChange', formatSigned(shortNet));
  setText('yearChange',      formatSigned(longNet));
  const ycEl  = document.getElementById('yearChange');
  const ndcEl = document.getElementById('ninetyDayChange');
  if (ycEl)  ycEl.style.color  = signColor(longNet);
  if (ndcEl) ndcEl.style.color = signColor(shortNet);

  /* Balance / net-worth chart — drawn by renderBalanceChart, which can be
     re-run on its own when the Cash/Net-worth toggle or range changes (or once
     the crypto snapshot arrives). It reads the latest data from here. */
  _lastDashData = { allTx, accounts, subs };
  await renderBalanceChart();

  /* Overview — income/expense buckets for the selected range */
  await renderMonthlyChart(allTx);

  renderAccounts(accounts, balanceMap, allTx);
  renderAllocation(accounts, balanceMap);
  /* net-worth goal starts from cash; renderCrypto upgrades it to cash+crypto */
  renderNwGoal(totalBalance);
  renderUpcomingBills(subs);
  renderBudgetWatch(monthTx, thisMonthPrefix.slice(0, 7)).catch(console.error);
  /* crypto folds into net worth (not the cash balance); non-blocking so a
     wallet/network hiccup never breaks the rest of the dashboard */
  renderCrypto(totalBalance).catch(console.error);
  await renderRecentTransactions(allTx.slice(0, RECENT_TX_COUNT));
}

/* ---- Balance vs. Net-worth chart -------------------------------------------
   "Cash" draws the running cash balance + the dashed cash-flow forecast (as
   before). "Net worth" adds crypto value to each historical point: current
   holdings × the coin's interpolated historical price. Holdings are assumed
   constant — read-only wallets only expose today's balance — which the on-card
   note discloses. The crypto toggle only appears once a wallet exists. */
let _lastDashData = null;
let _balanceMode  = localStorage.getItem('pf_balance_mode') === 'networth' ? 'networth' : 'cash';

function chartDaysForRange(allTx) {
  const rangeVal = document.getElementById('balanceChartRange')?.value || 'all';
  if (rangeVal !== 'all') return parseInt(rangeVal);
  if (allTx.length) {
    const firstDate = allTx.map(t => t.date).sort()[0];
    return Math.max(1, Math.ceil((Date.now() - new Date(firstDate).getTime()) / 86400000) + 1);
  }
  return 30;
}

/* current coin amount per chain, summed across wallets (skips failed lookups) */
function holdingsByChain(snap) {
  const h = {};
  (snap?.items || []).forEach(it => {
    if (it.amount != null) h[it.wallet.chain] = (h[it.wallet.chain] || 0) + it.amount;
  });
  return h;
}
/* smallest CoinGecko range that covers the chart span (falls back to the widest) */
function pickCryptoRangeKey(days) {
  const r = CryptoBalances.RANGES.find(x => x.days >= days);
  return (r || CryptoBalances.RANGES[CryptoBalances.RANGES.length - 1]).key;
}
/* crypto fiat value on a past date: map the date onto the price sparkline by
   its position in the window, then value current holdings at that price. */
function cryptoValueOnDate(dateStr, holdings, charts, rangeDays) {
  const ageDays = (Date.now() - new Date(dateStr + 'T12:00:00').getTime()) / 86400000;
  const frac = Math.max(0, Math.min(1, 1 - ageDays / rangeDays));
  let val = 0;
  for (const chain in holdings) {
    const spark = charts[chain]?.spark;
    if (!spark || !spark.length) continue;
    const price = spark[Math.round(frac * (spark.length - 1))];
    if (Number.isFinite(price)) val += holdings[chain] * price;
  }
  return val;
}

async function renderBalanceChart() {
  if (!_lastDashData) return;
  const { allTx, accounts, subs } = _lastDashData;
  const note = document.getElementById('balanceModeNote');
  document.getElementById('balanceChartSkeleton')?.setAttribute('hidden', '');
  const empty = document.getElementById('balanceChartEmpty');

  if (!allTx.length) {
    empty?.removeAttribute('hidden');
    /* step-aware copy: an account comes first, then the history starts */
    const msg = document.getElementById('balanceChartEmptyMsg');
    const link = document.getElementById('balanceChartEmptyLink');
    if (msg && link) {
      if (accounts.length) {
        msg.textContent = 'Your balance history starts with your first transaction.';
        link.textContent = 'Add a transaction →'; link.href = '/add-transaction';
      } else {
        msg.textContent = 'No balance history yet.';
        link.textContent = 'Add an account to get started →'; link.href = '/transactions?new=account';
      }
    }
    renderForecast(allTx, accounts, subs);   /* hides the forecast header */
    if (note) note.hidden = true;
    return;
  }
  empty?.setAttribute('hidden', '');

  const chartDays  = chartDaysForRange(allTx);
  const cashPoints = SummaryEngine.getBalanceOverTime(allTx, accounts, chartDays);

  const netWorthMode = _balanceMode === 'networth'
    && typeof CryptoBalances !== 'undefined'
    && _cryptoSnap && _cryptoSnap.wallets.length;

  if (!netWorthMode) {
    if (note) note.hidden = true;
    /* Forecast extends this same chart with a dashed 30-day projection + band
       and fills the forecast header; returns the projection points to draw. */
    const projection = renderForecast(allTx, accounts, subs);
    Charts.drawLineChart('balanceCanvas', cashPoints, false, projection);
    return;
  }

  /* Net-worth view: cash history + crypto value history. The forecast is a
     cash-flow concept, so its header + projection are hidden here. */
  const fh = document.getElementById('forecastHead');
  if (fh) fh.hidden = true;
  setText('forecastBasis', '');

  const rangeKey  = pickCryptoRangeKey(chartDays);
  const rangeDays = CryptoBalances.RANGES.find(r => r.key === rangeKey).days;
  let charts = {};
  try { charts = await CryptoBalances.chartFor(rangeKey); } catch (_) {}
  const holdings = holdingsByChain(_cryptoSnap);
  const points = cashPoints.map(p => ({
    ...p, balance: p.balance + cryptoValueOnDate(p.date, holdings, charts, rangeDays),
  }));

  if (note) note.hidden = false;
  Charts.drawLineChart('balanceCanvas', points, false, null);
}

/* Net-worth milestone celebration removed (2026-07) — no achievement pop-ups. */

/* ---- Upcoming bills -------------------------------------------------------- */
function billDueLabel(daysUntil) {
  if (daysUntil < 0)  return `${Math.abs(daysUntil)}d overdue`;
  if (daysUntil === 0) return 'Today';
  if (daysUntil === 1) return 'Tomorrow';
  return `in ${daysUntil}d`;
}
function renderUpcomingBills(subs) {
  const card = document.getElementById('upcomingBills');
  const list = document.getElementById('billsList');
  const foot = document.getElementById('billsFoot');
  if (!card || !list || typeof InsightsEngine === 'undefined') return;

  const u = InsightsEngine.upcomingBills(subs || [], { withinDays: 30, max: 5 });
  if (!u.count) { card.hidden = true; return; }   /* no active subscriptions */
  card.hidden = false;

  list.innerHTML = u.bills.length
    ? u.bills.map(b => {
        const over = b.daysUntil < 0;
        const dot  = b.color ? ` style="--dot:${b.color}"` : '';
        return `
          <div class="bill-row">
            <span class="bill-row__dot"${dot}></span>
            <div class="bill-row__id">
              <div class="bill-row__name">${escapeHTML(b.name)}</div>
              <div class="bill-row__due${over ? ' bill-row__due--over' : ''}">${billDueLabel(b.daysUntil)} · ${formatDateShort(b.date)}</div>
            </div>
            <div class="bill-row__amt font-display">${formatCurrency(b.amount)}</div>
          </div>`;
      }).join('')
    : `<div class="empty-state" style="padding:14px;">Nothing due in the next 30 days.</div>`;

  if (foot) foot.innerHTML =
    `<span>${formatCurrency(u.monthlyTotal)}/mo</span>` +
    `<span class="bills-foot__sep">·</span><span>${formatCurrency(u.annualTotal)}/yr</span>` +
    `<span class="bills-foot__sep">·</span><span>${u.count} active</span>`;
}

/* ---- Over-budget watch -----------------------------------------------------
   Lists expense categories past their monthly limit this month. Reuses the
   bill-row markup for a consistent look; hidden when nothing is over. */
async function renderBudgetWatch(monthTx, monthKey) {
  const card = document.getElementById('budgetWatch');
  const list = document.getElementById('budgetWatchList');
  const foot = document.getElementById('budgetWatchFoot');
  if (!card || !list) return;

  let budgets = {};
  try { await BudgetStore.load(); budgets = BudgetStore.getMonth(monthKey); } catch (_) {}
  const budgetedIds = Object.keys(budgets).filter(id => budgets[id] > 0);
  if (!budgetedIds.length) { card.hidden = true; return; }

  const spent = {};
  monthTx.filter(t => t.type === 'expense').forEach(t => {
    spent[t.categoryId] = (spent[t.categoryId] || 0) + t.amount;
  });

  const cats = await CategoryStore.getAll();
  const catMap = Object.fromEntries(cats.map(c => [c.id, c]));
  const over = budgetedIds
    .map(id => ({ id, cat: catMap[id], limit: budgets[id], spent: spent[id] || 0 }))
    .filter(x => x.spent > x.limit)
    .sort((a, b) => (b.spent - b.limit) - (a.spent - a.limit));

  if (!over.length) { card.hidden = true; return; }
  card.hidden = false;

  list.innerHTML = over.slice(0, 5).map(x => {
    const pct = Math.round((x.spent / x.limit) * 100);
    return `
      <div class="bill-row">
        <span class="bill-row__dot" style="--dot:var(--color-expense)"></span>
        <div class="bill-row__id">
          <div class="bill-row__name">${escapeHTML(x.cat?.name || 'Uncategorized')}</div>
          <div class="bill-row__due bill-row__due--over">${pct}% · ${formatCurrency(x.spent)} of ${formatCurrency(x.limit)}</div>
        </div>
        <div class="bill-row__amt font-display" style="color:var(--color-expense)">+${formatCurrency(x.spent - x.limit)}</div>
      </div>`;
  }).join('');

  const totalOver = over.reduce((s, x) => s + (x.spent - x.limit), 0);
  if (foot) foot.innerHTML =
    `<span>${over.length} over budget</span>` +
    `<span class="bills-foot__sep">·</span><span>${formatCurrency(totalOver)} over</span>`;
}

/* ---- Net-worth savings goal ------------------------------------------------
   A simple progress ring toward a target net worth (cash + crypto). The target
   is a per-device convenience (localStorage), mirroring the shift goal. The
   live value comes from initDashboard (cash) and is upgraded by renderCrypto
   once holdings load, so the ring reflects the same figure as the stat bar. */
const NW_GOAL_KEY = 'pf_nw_goal';
let _lastNetWorth = 0;

function getNwGoal() {
  const v = parseFloat(localStorage.getItem(NW_GOAL_KEY));
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function setNwGoal(target) {
  const t = Math.max(0, Number(target) || 0);
  try { if (t > 0) localStorage.setItem(NW_GOAL_KEY, String(t)); else localStorage.removeItem(NW_GOAL_KEY); }
  catch (_) {}
  /* sync cross-device (mirrors the balance-mode pref) — fire and forget */
  try { SettingsStore.setUiPref({ nwGoal: t }); } catch (_) {}
  return t;
}
function renderNwGoal(netWorth) {
  if (Number.isFinite(netWorth)) _lastNetWorth = netWorth;

  /* Switched off in Settings → Goals: hide the whole panel. dashboard-layout
     treats nwGoal as conditional, so flipping `hidden` is all it takes — the
     classic column closes up and a locked slot auto-fills with another panel. */
  const card = document.getElementById('nwGoalCard');
  if (card) {
    const off = typeof SettingsStore !== 'undefined' && SettingsStore.goalEnabled
      && !SettingsStore.goalEnabled('netWorth');
    card.hidden = !!off;
    if (off) return;
  }

  const ringEl   = document.getElementById('nwGoalRing');
  const pctEl    = document.getElementById('nwGoalPct');
  const detailEl = document.getElementById('nwGoalDetail');
  const paceEl   = document.getElementById('nwGoalPace');
  const editBtn  = document.getElementById('nwGoalEditBtn');
  if (!ringEl || !pctEl) return;

  const target = getNwGoal();
  if (editBtn) editBtn.textContent = target ? 'Edit' : 'Set goal';

  if (!target) {
    ringEl.innerHTML = ringSVG(0, 'var(--color-text-light)', 54);
    pctEl.textContent = '—';
    if (detailEl) detailEl.textContent = 'No goal set yet';
    if (paceEl) { paceEl.textContent = 'Set a target to track progress.'; paceEl.className = 'nw-goal__pace'; }
    return;
  }

  const cur = _lastNetWorth;
  const pct = target > 0 ? Math.max(0, (cur / target) * 100) : 0;
  ringEl.innerHTML = ringSVG(Math.min(pct, 100), pct >= 100 ? 'var(--color-income)' : '#ffffff', 54);
  pctEl.textContent = `${Math.round(pct)}%`;
  if (detailEl) detailEl.innerHTML = `${formatBalance(cur)} <span class="nw-goal__of">of ${formatCurrency(target)}</span>`;
  if (paceEl) {
    if (cur >= target) { paceEl.textContent = '✓ Goal reached'; paceEl.className = 'nw-goal__pace nw-goal__pace--up'; }
    else { paceEl.textContent = `▲ ${formatCurrency(target - cur)} to go`; paceEl.className = 'nw-goal__pace'; }
  }
}
function openNwGoalEdit() {
  document.getElementById('nwGoalDisplay').hidden = true;
  document.getElementById('nwGoalEdit').hidden = false;
  const inp = document.getElementById('nwGoalTarget');
  inp.value = getNwGoal() || '';
  inp.focus();
}
function closeNwGoalEdit() {
  document.getElementById('nwGoalEdit').hidden = true;
  document.getElementById('nwGoalDisplay').hidden = false;
}
function saveNwGoal(e) {
  e?.preventDefault();
  const t = setNwGoal(document.getElementById('nwGoalTarget').value);
  closeNwGoalEdit();
  renderNwGoal(_lastNetWorth);
  showToast(t > 0 ? 'Net-worth goal saved' : 'Goal cleared', 'success');
}
function clearNwGoal() {
  setNwGoal(0);
  closeNwGoalEdit();
  renderNwGoal(_lastNetWorth);
  showToast('Goal cleared', 'success');
}

/* Crypto holdings — one panel per wallet; total counts toward net worth.
   A timeframe toggle (24H · 1W · 1M · 1Y · 5Y) re-fetches just the
   sparkline + change for the chosen range; balances are not re-fetched. */
let _cryptoSnap = null;
/* remembered per-device so the chosen timeframe sticks across reloads */
let _cryptoRangeIdx = Math.max(0, parseInt(localStorage.getItem('pf_crypto_range'), 10) || 0);

async function renderCrypto(bankBalance) {
  const section = document.getElementById('cryptoSection');
  const tilesEl = document.getElementById('cryptoTiles');
  const totalEl = document.getElementById('cryptoSectionTotal');
  const nwCell  = document.getElementById('statbarNetWorth');
  const cryCell = document.getElementById('statbarCrypto');
  const modeToggle = document.getElementById('balanceModeToggle');
  const hideStatCells = () => {
    if (nwCell) nwCell.hidden = true;
    if (cryCell) cryCell.hidden = true;
    if (modeToggle) modeToggle.hidden = true;   /* no crypto → net worth == cash */
  };
  if (!section || !tilesEl) return;
  if (typeof CryptoBalances === 'undefined') { return; }

  let snap;
  try { snap = await CryptoBalances.snapshot(); }
  catch { section.hidden = true; hideStatCells(); return; }

  if (!snap.wallets.length) { section.hidden = true; hideStatCells(); return; }
  section.hidden = false;
  _cryptoSnap = snap;

  /* Reveal the Cash / Net-worth toggle now that holdings exist, and — if the
     user left it on Net worth — upgrade the chart (it first drew as cash,
     before this async snapshot was ready). */
  if (modeToggle) {
    modeToggle.hidden = false;
    modeToggle.querySelectorAll('.seg-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === _balanceMode));
  }
  if (_balanceMode === 'networth') renderBalanceChart().catch(console.error);

  totalEl.textContent = formatCurrency(snap.total) + (snap.anyMissing ? ' +' : '');

  /* surface net worth (cash + crypto) and the crypto total in the top stat bar.
     Count both up like the hero balance so they feel as rewarding, not static. */
  if (nwCell) {
    nwCell.hidden = false;
    animateValue(document.getElementById('statNetWorth'), bankBalance + snap.total, formatBalance, 1400);
  }
  if (cryCell) {
    cryCell.hidden = false;
    const suffix = snap.anyMissing ? ' +' : '';
    animateValue(document.getElementById('statCryptoTotal'), snap.total, v => formatCurrency(v) + suffix, 1400);
  }

  /* goal uses the real net worth (cash + crypto) */
  renderNwGoal(bankBalance + snap.total);

  const btn = document.getElementById('cryptoRangeBtn');
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      _cryptoRangeIdx = (_cryptoRangeIdx + 1) % CryptoBalances.RANGES.length;
      try { localStorage.setItem('pf_crypto_range', String(_cryptoRangeIdx)); } catch (_) {}
      loadCryptoChart();
    });
  }
  await loadCryptoChart();
}

/* Fetch the sparkline/change for the current range and (re)render the tiles.
   A cache hit (chartFor) returns instantly; on a miss we show a thin loading
   bar because the bigger ranges take a moment to come back from CoinGecko. */
async function loadCryptoChart() {
  if (!_cryptoSnap || typeof CryptoBalances === 'undefined') return;
  const tilesEl = document.getElementById('cryptoTiles');
  const btn = document.getElementById('cryptoRangeBtn');
  const bar = document.getElementById('cryptoLoadbar');
  const idx = _cryptoRangeIdx % CryptoBalances.RANGES.length;
  const range = CryptoBalances.RANGES[idx];
  if (btn) { btn.textContent = range.label; btn.disabled = true; }
  if (bar) bar.hidden = false;
  let chart = {};
  try { chart = await CryptoBalances.chartFor(range.key); } catch (_) {}
  if (bar) bar.hidden = true;
  if (btn) btn.disabled = false;
  if (tilesEl) tilesEl.innerHTML = _cryptoSnap.items
    .map(it => cryptoTileHTML(it, chart[it.wallet.chain], range.label)).join('');
}

/* Crypto wallet tile — mirrors the account tile design (avatar + name +
   type, big value, sparkline + change foot), with a chain-colored coin
   badge. Shows the wallet's current fiat value and its coin amount. */
function cryptoTileHTML(r, chart, rangeLabel) {
  const w = r.wallet;
  const chain = CHAINS[w.chain] || { symbol: '?', label: w.chain, color: 'var(--color-text)' };
  const ok   = !r.error;
  const fiat = (ok && r.fiat != null) ? formatCurrency(r.fiat) : '—';
  const dec  = CHAINS[w.chain]?.decimals ?? 8;
  const amt  = `${r.amount != null ? r.amount.toFixed(dec).replace(/\.?0+$/, '') : '0'} ${chain.symbol}`;
  const sub  = ok
    ? (r.stale ? `${amt} <span title="Live lookup failed — showing the last fetched balance.">· last known</span>` : amt)
    : `<span style="color:var(--color-expense)">lookup failed</span>`;
  /* sparkline + change track the selected timeframe when available, else
     fall back to the 7-day snapshot data */
  const sparkData = (chart && chart.spark && chart.spark.length > 1) ? chart.spark : r.sparkline;
  const change    = (chart && chart.changePct != null) ? chart.changePct : r.change24h;
  const spark = (ok && sparkData && sparkData.length > 1) ? sparklineSVG(sparkData) : '';
  return `
    <div class="acct-tile crypto-acct-tile" style="--chain:${chain.color};">
      <div class="acct-tile__row1">
        <div class="acct-tile__top">
          <span class="acct-tile__avatar">${chain.symbol}</span>
          <div class="acct-tile__id">
            <div class="acct-tile__name">${escapeHTML(w.label)}</div>
            <div class="acct-tile__type">${chain.label}</div>
          </div>
        </div>
        <div class="acct-tile__chart">${spark}</div>
      </div>
      <div class="acct-tile__row2">
        <div class="acct-tile__figures">
          <div class="acct-tile__bal font-display">${fiat}</div>
          <div class="acct-tile__sub">${sub}</div>
        </div>
        ${ok ? cryptoDeltaHTML(change, rangeLabel || '24H') : ''}
      </div>
    </div>`;
}

function cryptoDeltaHTML(change, label = '24H') {
  const lbl = String(label).toLowerCase();
  if (change == null) return `<span class="delta delta--flat">· ${lbl}</span>`;
  const cls = change >= 0 ? 'up' : 'down';
  return `<span class="delta delta--${cls}">${change >= 0 ? '▲ +' : '▼ −'}${Math.abs(change).toFixed(1)}% · ${lbl}</span>`;
}

/* Cash-flow forecast (Phase 1) — folded into the balance-over-time card.
   Fills the forecast header + low-balance warning and RETURNS the projection
   points (or null) for drawLineChart to append to the balance chart. Pure
   math lives in InsightsEngine. */
function renderForecast(allTx, accounts, subs) {
  const head = document.getElementById('forecastHead');
  const hideHead = () => { if (head) head.hidden = true; setText('forecastBasis', ''); };
  if (typeof InsightsEngine === 'undefined') { hideHead(); return null; }
  /* need some history + an account to project a meaningful trend */
  if (!allTx.length || !accounts.length) { hideHead(); return null; }

  const recurring = (subs || [])
    .filter(s => s && s.active !== false && s.nextDue && s.amount > 0)
    .map(s => ({ amount: s.amount, frequency: s.frequency, nextDue: s.nextDue, name: s.name }));

  const fc = InsightsEngine.forecastBalance(allTx, accounts, { horizonDays: 30, recurring });
  /* too little history for a trend and no bills on the calendar → nothing honest to project */
  if (!fc.basis.trendReady && !fc.scheduled.length) { hideHead(); return null; }
  if (head) head.hidden = false;

  setText('forecastEnd', formatBalance(fc.endBalance));

  const netEl = document.getElementById('forecastNet');
  if (netEl) {
    const n = fc.projectedNet;
    netEl.textContent = `${n >= 0 ? '▲ +' : '▼ −'}${formatCurrency(Math.abs(n))} in 30 days`;
    netEl.style.color = n >= 0 ? 'var(--color-income)' : 'var(--color-expense)';
  }

  const warn = document.getElementById('forecastWarning');
  if (warn) {
    if (fc.belowZero) {
      warn.hidden = false;
      warn.className = 'forecast-warning forecast-warning--danger';
      warn.innerHTML = `Projected to dip below ${formatCurrency(0)} around <strong>${formatDateShort(fc.belowZeroDate)}</strong>.`;
    } else if (fc.riskBelowZero) {
      warn.hidden = false;
      warn.className = 'forecast-warning forecast-warning--caution';
      warn.innerHTML = `At the low end of the range, your balance could run close to ${formatCurrency(0)} this month.`;
    } else {
      warn.hidden = true;
    }
  }

  const bills = fc.scheduled.length;
  setText('forecastBasis', !fc.basis.trendReady
    ? `Scheduled bills only — your spending trend joins the forecast after ${fc.basis.minHistoryDays} days of history. An estimate, not a guarantee.`
    : fc.basis.sampleCount
    ? `Forecast from your ${fc.basis.lookbackDays}-day trend${bills ? ` + ${bills} scheduled bill${bills === 1 ? '' : 's'}` : ''}. An estimate, not a guarantee.`
    : 'Not enough history yet for a confident projection.');

  /* projection for the balance chart (skip day 0 — it duplicates today) */
  return fc.points.slice(1).map(p => ({ label: p.label, balance: p.balance, lower: p.lower, upper: p.upper }));
}

/* Sync the overview range toggle, period label and prev/next bounds */
function syncOverviewControls(label) {
  const el = document.getElementById('monthNavLabel');
  if (el) el.textContent = label;
  document.querySelectorAll('#ovRangeToggle .seg-btn').forEach(b => {
    const on = b.dataset.range === overview.mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const prev = document.getElementById('monthNavPrev');
  const next = document.getElementById('monthNavNext');
  if (prev) prev.disabled = !PeriodEngine.canPrev(overview.mode, overview.offset);
  if (next) next.disabled = !PeriodEngine.canNext(overview.mode, overview.offset);
}

async function renderMonthlyChart(allTx) {
  const { label } = PeriodEngine.range(overview.mode, overview.offset, allTx);
  syncOverviewControls(label);
  const buckets = PeriodEngine.buckets(overview.mode, overview.offset, allTx);
  const monthlyEmpty    = document.getElementById('monthlyChartEmpty');
  const monthlySkeleton = document.getElementById('monthlyChartSkeleton');
  monthlySkeleton?.setAttribute('hidden', '');
  const hasData = buckets.some(w => w.income > 0 || w.expense > 0);
  if (hasData) {
    monthlyEmpty?.setAttribute('hidden', '');
    Charts.drawBarChart('monthlyCanvas', buckets);
  } else {
    /* Clear any bars left from a previous month, otherwise switching to a
       month with no data shows the old chart behind the empty state. */
    const cv = document.getElementById('monthlyCanvas');
    if (cv) { const ctx = cv.getContext('2d'); ctx && ctx.clearRect(0, 0, cv.width, cv.height); }
    delete Charts._state['monthlyCanvas'];
    monthlyEmpty?.removeAttribute('hidden');
  }
}

/* Per-account daily balance history (last `days` days, oldest first).
   Walks backwards from the current balance using transaction effects. */
function accountHistory(allTx, accountId, currentBal, days = 30) {
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const dateAt = i => isoLocal(new Date(today.getTime() - (days - 1 - i) * 86400000));
  const startStr = dateAt(0);

  const delta = {};
  allTx.forEach(t => {
    if (t.date < startStr) return;
    let eff = 0;
    if (t.type === 'income'  && t.accountId === accountId) eff += t.amount;
    if (t.type === 'expense' && t.accountId === accountId) eff -= t.amount;
    if (t.type === 'transfer') {
      if (t.accountId === accountId)   eff -= t.amount;
      if (t.toAccountId === accountId) eff += t.amount;
    }
    if (eff !== 0) delta[t.date] = (delta[t.date] || 0) + eff;
  });

  const out = new Array(days);
  let bal = currentBal;
  for (let i = days - 1; i >= 0; i--) {
    out[i] = bal;
    bal -= (delta[dateAt(i)] || 0);
  }
  return out;
}

/* Responsive sparkline — stretches to its container (preserveAspectRatio
   none) with a non-scaling stroke so the line stays crisp at any size. */
function sparklineSVG(values, w = 120, h = 48) {
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) =>
    `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / range) * (h - 4)).toFixed(1)}`
  ).join(' ');
  const first = values[0], last = values[values.length - 1];
  const color = Math.abs(last - first) < 0.005
    ? 'var(--color-text-muted)'
    : (last >= first ? 'var(--color-income)' : 'var(--color-expense)');
  return `<svg class="spark" width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function deltaHTML(bal, base) {
  const diff = bal - base;
  if (Math.abs(diff) < 0.005) {
    return `<span class="delta delta--flat">· 30d</span>`;
  }
  if (Math.abs(base) > 0.005) {
    const pct = (diff / Math.abs(base)) * 100;
    const cls = pct >= 0 ? 'up' : 'down';
    return `<span class="delta delta--${cls}">${pct >= 0 ? '▲ +' : '▼ '}${pct.toFixed(1)}%</span>`;
  }
  const cls = diff >= 0 ? 'up' : 'down';
  return `<span class="delta delta--${cls}">${diff >= 0 ? '▲ +' : '▼ −'}${formatCurrency(Math.abs(diff))}</span>`;
}

/* Wallet-style account tiles */
function renderAccounts(accounts, balanceMap, allTx) {
  const el = document.getElementById('accountTiles');
  if (!el) return;

  /* First run: spell out the two steps, in order — every number on the
     dashboard builds from an account, so that comes first. */
  if (!accounts.length) {
    el.innerHTML = `
      <div class="get-started" style="grid-column:1/-1;">
        <div class="term-label">Get started</div>
        <ol class="get-started__steps">
          <li class="get-started__step is-current">
            <span class="get-started__num" aria-hidden="true">1</span>
            <div class="get-started__text">
              <strong>Add an account</strong>
              <span>Your bank, cash or credit card, with today’s balance. Every number here builds from it.</span>
            </div>
            <a class="btn btn--primary btn--sm" href="/transactions?new=account">Add account</a>
          </li>
          <li class="get-started__step">
            <span class="get-started__num" aria-hidden="true">2</span>
            <div class="get-started__text">
              <strong>Log your first transaction</strong>
              <span>An expense, income or transfer — it takes a few seconds.</span>
            </div>
          </li>
        </ol>
      </div>`;
    return;
  }

  const TYPE_LABEL = { bank: 'Bank', cash: 'Cash', savings: 'Savings', investment: 'Investment', credit: 'Credit', other: 'Other' };

  /* the order set in customize mode (AccountStore already applied it), else
     largest balance first */
  const sorted = AccountStore.hasCustomOrder()
    ? accounts
    : [...accounts].sort((a, b) => (balanceMap[b.id] ?? 0) - (balanceMap[a.id] ?? 0));

  el.innerHTML = sorted.map((a) => {
    const bal  = balanceMap[a.id] ?? 0;
    const hist = accountHistory(allTx, a.id, bal, 30);
    const name = escapeHTML(a.name);
    return `
      <div class="acct-tile" data-acct-id="${a.id}">
        <div class="acct-tile__move">
          <span class="acct-tile__grip" data-acct-grip title="Drag onto another account to swap" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
          </span>
          <button type="button" class="acct-tile__swap" data-acct-swap aria-haspopup="listbox" aria-label="Swap ${name} with another account">Swap <span aria-hidden="true">▾</span></button>
        </div>
        <div class="acct-tile__row1">
          <div class="acct-tile__top">
            <span class="acct-tile__avatar">${escapeHTML((a.name || '?').charAt(0).toUpperCase())}</span>
            <div class="acct-tile__id">
              <div class="acct-tile__name">${name}</div>
              <div class="acct-tile__type">${TYPE_LABEL[a.type] || a.type}</div>
            </div>
          </div>
          <div class="acct-tile__chart">${sparklineSVG(hist)}</div>
        </div>
        <div class="acct-tile__row2">
          <div class="acct-tile__figures">
            <div class="acct-tile__bal font-display" style="${bal < 0 ? 'color:var(--color-expense)' : ''}">${formatBalance(bal)}</div>
          </div>
          ${deltaHTML(bal, hist[0])}
        </div>
      </div>`;
  }).join('');
  fillLastTileRow();
}

/* The tiles are hairline cells in an auto-fit grid: 5 accounts in a 4-wide
   row left three empty grey cells beside the 5th. Stretch the last tile
   across whatever its row has left. Re-run on resize (column count changes). */
function fillLastTileRow() {
  const el = document.getElementById('accountTiles');
  if (!el) return;
  const tiles = [...el.querySelectorAll(':scope > .acct-tile')];
  tiles.forEach(t => { t.style.gridColumn = ''; });
  if (tiles.length < 2) return;
  const cols = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length;
  const rem = tiles.length % cols;
  if (cols > 1 && rem) tiles[tiles.length - 1].style.gridColumn = `span ${cols - rem + 1}`;
}
let _tileResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_tileResizeTimer);
  _tileResizeTimer = setTimeout(fillLastTileRow, 120);
});

/* ---- Swap accounts (dashboard customize mode) ------------------------------
   Same model as the panels: two accounts trade places. Drag one by its grip
   onto another, or pick one from its "Swap" menu. The controls only show
   while customizing (body.dash-editing). The swap happens in the DOM, then
   the resulting id order is saved — synced via AccountStore.setOrder and
   applied everywhere accounts are listed. */
function saveAccountOrder(container) {
  const ids = [...container.querySelectorAll('.acct-tile[data-acct-id]')].map(t => t.dataset.acctId);
  AccountStore.setOrder(ids).catch(() => {});   /* still applied on this device */
}

function swapTiles(a, b) {
  if (!a || !b || a === b) return;
  const parent = a.parentNode;
  const after = a.nextSibling === b ? a : a.nextSibling;
  b.replaceWith(a);
  parent.insertBefore(b, after);
}

function closeAcctSwapMenu() { document.getElementById('acctSwapMenu')?.remove(); }

function openAcctSwapMenu(tile, anchor, container) {
  closeAcctSwapMenu();
  const others = [...container.querySelectorAll('.acct-tile[data-acct-id]')].filter(t => t !== tile);
  if (!others.length) return;
  const menu = document.createElement('div');
  menu.className = 'dash-slotmenu';
  menu.id = 'acctSwapMenu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', 'Swap with');
  menu.innerHTML = `<div class="acct-swapmenu__label">Swap with</div>` + others.map(t =>
    `<button type="button" class="dash-slotmenu__item" role="option" data-swap-with="${t.dataset.acctId}">${escapeHTML(t.querySelector('.acct-tile__name')?.textContent || '')}</button>`).join('');
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top  = (r.bottom + window.scrollY) + 'px';
  menu.querySelector('[data-swap-with]')?.focus();
  menu.addEventListener('click', ev => {
    const id = ev.target.closest('[data-swap-with]')?.dataset.swapWith;
    if (!id) return;
    swapTiles(tile, container.querySelector(`.acct-tile[data-acct-id="${id}"]`));
    closeAcctSwapMenu();
    saveAccountOrder(container);
    tile.querySelector('[data-acct-swap]')?.focus();
  });
  const onKey = ev => { if (ev.key === 'Escape') { closeAcctSwapMenu(); anchor.focus(); document.removeEventListener('keydown', onKey, true); } };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('click', ev => {
    if (!ev.target.closest('#acctSwapMenu')) closeAcctSwapMenu();
  }, { once: true }), 0);
}

function initAccountReorder() {
  const el = document.getElementById('accountTiles');
  if (!el || el.dataset.reorderWired) return;
  el.dataset.reorderWired = '1';

  el.addEventListener('click', e => {
    const btn = e.target.closest('[data-acct-swap]');
    if (!btn) return;
    e.stopPropagation();
    openAcctSwapMenu(btn.closest('.acct-tile'), btn, el);
  });

  /* drag by the grip: the tile follows the pointer, the account under it is
     marked, and on drop the two trade places */
  el.addEventListener('pointerdown', e => {
    const grip = e.target.closest('[data-acct-grip]');
    if (!grip || !document.body.classList.contains('dash-editing')) return;
    e.preventDefault();
    e.stopPropagation();
    closeAcctSwapMenu();
    const tile = grip.closest('.acct-tile');
    const sx = e.clientX, sy = e.clientY;
    let target = null;
    tile.classList.add('acct-tile--dragging');
    const mark = t => { target?.classList.remove('acct-tile--drop'); target = t; target?.classList.add('acct-tile--drop'); };
    const move = ev => {
      tile.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px)`;
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.acct-tile[data-acct-id]');
      mark(over && over !== tile && el.contains(over) ? over : null);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      tile.classList.remove('acct-tile--dragging');
      tile.style.transform = '';
      if (target) {
        const dest = target;
        mark(null);
        swapTiles(tile, dest);
        saveAccountOrder(el);
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  });
}

/* Allocation — share of total positive balances, mono ring per account */
function ringSVG(pct, color, size = 26) {
  const r = 10, c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(pct, 100) / 100);
  return `<svg class="alloc-row__ring" width="${size}" height="${size}" viewBox="0 0 26 26" aria-hidden="true">
    <circle cx="13" cy="13" r="${r}" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="3"/>
    <circle cx="13" cy="13" r="${r}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 13 13)"/>
  </svg>`;
}

function renderAllocation(accounts, balanceMap) {
  const el = document.getElementById('allocationList');
  if (!el) return;

  const pos = accounts
    .map(a => ({ a, bal: Math.max(0, balanceMap[a.id] ?? 0) }))
    .filter(x => x.bal > 0)
    .sort((x, y) => y.bal - x.bal);
  const total = pos.reduce((s, x) => s + x.bal, 0);

  if (!total) {
    el.innerHTML = `<div class="empty-state">No balances yet.</div>`;
    return;
  }

  const SHADES = ['#ffffff', '#9a9aa4', '#62626c', '#46464e', '#34343c'];
  const top = pos.slice(0, 4);
  const rest = pos.slice(4);
  const rows = top.map((x, i) => ({ name: x.a.name, bal: x.bal, color: SHADES[i] }));
  if (rest.length) rows.push({ name: `Other (${rest.length})`, bal: rest.reduce((s, x) => s + x.bal, 0), color: SHADES[4] });

  el.innerHTML = rows.map(r => {
    const pct = (r.bal / total) * 100;
    return `
      <div class="alloc-row">
        ${ringSVG(pct, r.color)}
        <span class="alloc-row__pct">${pct.toFixed(0)}%</span>
        <span class="alloc-row__name">${escapeHTML(r.name)}</span>
        <span class="alloc-row__amt">${formatCurrency(r.bal)}</span>
      </div>`;
  }).join('');
}

async function renderRecentTransactions(txs) {
  const el = document.getElementById('recentTransactions');
  if (!el) return;
  if (!txs.length) {
    el.innerHTML = `<div class="empty-state">No transactions yet. <a href="/add-transaction">Add one →</a></div>`;
    return;
  }
  const cats = await Promise.all(txs.map(t => CategoryStore.getById(t.categoryId)));
  el.innerHTML = txs.map((t, i) => txItemHTML(t, cats[i])).join('');
  /* tap a recent row to edit it; return here (dashboard) when done */
  el.querySelectorAll('.tx-item[data-id]').forEach(item => {
    item.style.cursor = 'pointer';
    item.addEventListener('click', () => {
      if (window.openAddTransaction) window.openAddTransaction(item.dataset.id);
      else window.location.href = `/add-transaction?id=${item.dataset.id}&from=${encodeURIComponent('/dashboard')}`;
    });
  });
}

function txItemHTML(t, cat) {
  const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '↔';
  return `
    <div class="tx-item" data-id="${t.id}">
      <div class="tx-icon tx-icon--${t.type}">${categoryIconHTML(cat, 18)}</div>
      <div class="tx-info">
        <div class="tx-name">${escapeHTML(t.note) || cat?.name || 'Transaction'}</div>
        <div class="tx-meta">${formatDate(t.date)} · ${cat?.name || '—'}</div>
      </div>
      <div class="tx-amount tx-amount--${t.type}">${sign}${formatCurrency(t.amount)}</div>
    </div>
  `;
}

function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

/* The Log hours panel is for people who track hours: shown when Main use is
   "hours" or "both", or once any shift exists — not pushed on everyone. */
async function applyQuickLogVisibility() {
  const panel = document.getElementById('quickLog');
  if (!panel) return;
  const focus = SettingsStore.getNavPrefs().focus;
  let show = focus === 'hours' || focus === 'both';
  if (!show && typeof ShiftStore !== 'undefined') {
    try { show = (await ShiftStore.getAll()).length > 0; } catch (_) {}
  }
  panel.hidden = !show;
}

/* Show the focus-question popup; `then` runs once it's answered or skipped.
   Skip saves the plain-finance default (money) so it isn't asked again; the
   Log hours panel still appears once a shift is logged. */
function openFocusAsk(then) {
  const overlay = document.getElementById('focusAsk');
  if (!overlay) { then?.(); return; }
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));
  overlay.querySelector('[data-focus]')?.focus();

  let closed = false;
  async function close(focus, skipped) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.remove('open');
    setTimeout(() => { overlay.hidden = true; }, 200);
    try {
      await SettingsStore.setNavPrefs({ focus, slot: focus === 'hours' ? 'shifts' : 'money' });
    } catch (_) {}   /* still saved on this device */
    window.PFNav?.refresh();
    await applyQuickLogVisibility();
    if (!skipped) showToast(focus === 'hours' ? 'Hours Tracker pinned — + now logs hours' : 'Saved — change it any time in Settings', 'success');
    then?.();
  }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close('money', true); } }

  overlay.querySelectorAll('[data-focus]').forEach(btn =>
    btn.addEventListener('click', () => close(btn.dataset.focus, false)));
  overlay.querySelector('[data-focus-skip]')?.addEventListener('click', () => close('money', true));
  document.addEventListener('keydown', onKey, true);
}

document.addEventListener('DOMContentLoaded', async () => {
  let user;
  try {
    user = await SupaAuth.requireAuth();
  } catch (err) {
    console.error('Auth error:', err);
    window.hideAppLoader?.();   /* reveal the page rather than hang on the loader */
    return;
  }
  if (!user) return;            /* requireAuth redirected to login — keep the loader up */

  /* pull synced settings, then re-read the balance mode (set at module load) */
  try { await SettingsStore.hydrateLocalDefaults(); } catch (_) {}
  _balanceMode = localStorage.getItem('pf_balance_mode') === 'networth' ? 'networth' : 'cash';

  try {
    await initDashboard();
  } catch (err) {
    console.error('Dashboard error:', err);
    showToast('Error loading data: ' + err.message, 'error');
    ['totalBalance','monthIncome','monthExpense','monthNet',
     'monthIncomeSub','monthExpenseSub','ninetyDayChange','yearChange'].forEach(id => setText(id, '—'));
    /* The panels ship first-paint skeletons (see index.html) — without this
       they'd shimmer forever on a failed load. One Retry, on the top panel. */
    showErrorState('accountTiles', "Couldn't load your accounts. Check your connection.", () => location.reload());
    showErrorState('allocationList', 'Balances unavailable.');
    showErrorState('recentTransactions', 'Transactions unavailable.');
  } finally {
    window.hideAppLoader?.();   /* data rendered (or errored) — fade the boot screen out */
  }

  /* Focus question — a popup on the first visit (guests too — it decides
     whether the Log hours panel shows),
     until answered; the answer sets the mobile bottom bar. Read after
     hydrateLocalDefaults so an answer from another device counts. The
     first-visit tour (scripts/components/tour.js) waits until it's closed. */
  await applyQuickLogVisibility();
  const startTour = () => window.PFTour?.maybeStart();
  if (!SettingsStore.getNavPrefs().focus) openFocusAsk(startTour);
  else startTour();

  initAccountReorder();

  /* Quick-log hours widget — refresh the dashboard after a shift is logged. */
  QuickLog?.init({ onLogged: () => initDashboard() }).catch(console.error);

  document.getElementById('balanceChartRange')?.addEventListener('change', () => initDashboard().catch(console.error));

  /* Cash / Net-worth toggle — redraws just the balance chart, no full reload */
  document.querySelectorAll('#balanceModeToggle .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode === 'networth' ? 'networth' : 'cash';
      if (mode === _balanceMode) return;
      _balanceMode = mode;
      try { localStorage.setItem('pf_balance_mode', mode); } catch (_) {}
      SettingsStore.setUiPref({ balanceMode: mode });   /* sync cross-device */
      document.querySelectorAll('#balanceModeToggle .seg-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.mode === mode));
      renderBalanceChart().catch(console.error);
    });
  });

  /* Net-worth goal — inline set / edit / clear */
  document.getElementById('nwGoalEditBtn')?.addEventListener('click', openNwGoalEdit);
  document.getElementById('nwGoalEdit')?.addEventListener('submit', saveNwGoal);
  document.getElementById('nwGoalClear')?.addEventListener('click', clearNwGoal);

  document.getElementById('monthNavPrev')?.addEventListener('click', async () => {
    if (!PeriodEngine.canPrev(overview.mode, overview.offset)) return;
    overview.offset--;
    await renderMonthlyChart(await TransactionStore.getAll());
  });

  document.getElementById('monthNavNext')?.addEventListener('click', async () => {
    if (!PeriodEngine.canNext(overview.mode, overview.offset)) return;
    overview.offset++;
    await renderMonthlyChart(await TransactionStore.getAll());
  });

  document.querySelectorAll('#ovRangeToggle .seg-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.range === overview.mode) return;
      overview.mode = btn.dataset.range;
      overview.offset = 0;
      try { localStorage.setItem('pf_overview_range', overview.mode); } catch (_) {}
      await renderMonthlyChart(await TransactionStore.getAll());
    });
  });
});
