/* ============================================================
   spending.js — Spending / Income analysis (toggle between the two;
   desktop shows both side by side)
   Pages through Week / Month / Year / All-time ranges via PeriodEngine.
   ============================================================ */

const RANGE_KEY = 'pf_spend_range';

let period = { mode: 'month', offset: 0 };   /* mode ∈ week|month|year|all */
let mode   = 'expense';                       /* 'expense' (Spending) | 'income' (Income) */

/* Desktop shows Spending and Income side by side (two category panels + one
   income-vs-spending trend); narrower screens keep the toggle and show one. */
const COMBINED = window.matchMedia('(min-width: 1100px)');

try {
  const saved = localStorage.getItem(RANGE_KEY);
  if (saved && PeriodEngine.MODES.includes(saved)) period.mode = saved;
} catch (_) {}

function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

/* Wipe a canvas and drop its chart state so a stale chart from a previous
   period never shows through the empty overlay. */
function clearCanvas(id) {
  const cv = document.getElementById(id);
  if (cv) { const ctx = cv.getContext('2d'); ctx && ctx.clearRect(0, 0, cv.width, cv.height); }
  if (typeof Charts !== 'undefined' && Charts._state) delete Charts._state[id];
}

function syncRangeControls(rangeLabel) {
  document.querySelectorAll('#rangeToggle .seg-btn').forEach(b => {
    const on = b.dataset.range === period.mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  setText('periodLabel', rangeLabel);
  const prev = document.getElementById('periodPrev');
  const next = document.getElementById('periodNext');
  if (prev) prev.disabled = !PeriodEngine.canPrev(period.mode, period.offset);
  if (next) next.disabled = !PeriodEngine.canNext(period.mode, period.offset);
}

/* One category panel: donut + ranked list for `kind` ('expense' | 'income'). */
async function renderCategoryPanel(kind, rangeTx, from, to, ids) {
  const isIncome = kind === 'income';
  const byCategory = SummaryEngine.getByCategory(rangeTx, kind);
  const catEmpty = document.getElementById(ids.empty);
  const breakdownEl = document.getElementById(ids.list);
  const amtColor = isIncome ? 'var(--color-income)' : 'var(--color-expense)';

  if (catEmpty) catEmpty.querySelector('span').textContent = isIncome ? 'No income this period.' : 'No expenses this period.';

  if (!byCategory.length) {
    /* Clear the donut so last period's slices don't show behind the empty state */
    clearCanvas(ids.canvas);
    catEmpty?.removeAttribute('hidden');
    if (breakdownEl) breakdownEl.innerHTML = `<div class="empty-state">No ${isIncome ? 'income' : 'expenses'} this period.</div>`;
    return;
  }

  catEmpty?.setAttribute('hidden', '');
  const catObjects = await Promise.all(byCategory.map(b => CategoryStore.getById(b.categoryId)));
  const slices = byCategory.map((b, i) => ({
    label: escapeHTML(catObjects[i]?.name) || 'Other',
    value: b.total,
    cat:   catObjects[i],
    catId: b.categoryId,
  }));

  Charts.drawDonutChart(ids.canvas, slices, false, isIncome ? 'Total earned' : 'Total spent');

  const total = slices.reduce((s, sl) => s + sl.value, 0);
  if (!breakdownEl) return;
  breakdownEl.innerHTML = slices.map((sl, i) => {
    const pct = total > 0 ? Math.round((sl.value / total) * 100) : 0;
    return `
      <div class="spending-item" data-cat="${sl.catId || ''}" role="link" tabindex="0" title="View these transactions" style="cursor:pointer;">
        <div class="spending-item__icon">${categoryIconHTML(sl.cat, 18)}</div>
        <div class="spending-item__info">
          <div class="spending-item__name">${sl.label}</div>
          <div class="spending-item__bar-wrap">
            <div class="spending-item__bar" style="width:${pct}%;background:${Charts.COLORS[i % Charts.COLORS.length]}"></div>
          </div>
        </div>
        <div class="spending-item__meta">
          <div class="spending-item__amount" style="color:${amtColor}">${formatCurrency(sl.value)}</div>
          <div class="spending-item__pct">${pct}%</div>
        </div>
      </div>`;
  }).join('');

  /* drill-down: a category row jumps to the Transactions list, pre-filtered
     to that category + type over the same period */
  breakdownEl.querySelectorAll('.spending-item[data-cat]').forEach(row => {
    const go = () => {
      const params = new URLSearchParams({ type: kind });
      if (row.dataset.cat) params.set('category', row.dataset.cat);
      if (from) params.set('from', from);
      if (to)   params.set('to', to);
      window.location.href = `/transactions?${params.toString()}`;
    };
    row.addEventListener('click', go);
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });
}

async function renderSpending() {
  const combined = COMBINED.matches;
  const shown = combined ? 'expense' : mode;   /* what the main panel shows */
  const isIncome = shown === 'income';

  /* Panel titles reflect the active mode (topbar stays "Cash Flow") */
  setText('catTitle',   isIncome ? 'Income by Category' : 'Spending by Category');
  setText('trendTitle', combined ? 'Income vs Spending' : isIncome ? 'Income Trend' : 'Spending Trend');

  const allTx = await TransactionStore.getAll();
  const { from, to, label } = PeriodEngine.range(period.mode, period.offset, allTx);
  syncRangeControls(label);
  setText('trendRangeLabel', label);

  const rangeTx = PeriodEngine.filter(allTx, from, to);

  /* The data is in — retire the first-paint chart placeholders (spending.html).
     From here on the real charts, or their "no data" overlays, take over. */
  ['spendCatSkeleton', 'incomeCatSkeleton', 'spendTrendSkeleton'].forEach(id =>
    document.getElementById(id)?.setAttribute('hidden', ''));

  const totals = SummaryEngine.getTotals(rangeTx);
  const net = totals.income - totals.expense;

  setText('spendTotal',  formatCurrency(totals.expense));
  setText('spendIncome', formatCurrency(totals.income));
  setText('spendNet',    formatSigned(net));
  const netEl = document.getElementById('spendNet');
  if (netEl) netEl.style.color = signColor(net);

  await renderCategoryPanel(shown, rangeTx, from, to,
    { canvas: 'categoryCanvas', empty: 'categoryChartEmpty', list: 'spendingBreakdown' });
  if (combined) {
    await renderCategoryPanel('income', rangeTx, from, to,
      { canvas: 'categoryCanvasIncome', empty: 'categoryChartEmptyIncome', list: 'incomeBreakdown' });
  }

  /* Trend bar chart — buckets within the selected range. Desktop draws both
     series together; otherwise just the active one. */
  const buckets = PeriodEngine.buckets(period.mode, period.offset, allTx);
  const trendEmpty = document.getElementById('trendChartEmpty');
  if (trendEmpty) trendEmpty.querySelector('span').textContent =
    combined ? 'No data yet.' : isIncome ? 'No income data yet.' : 'No expense data yet.';
  const hasData = buckets.some(b => combined
    ? (b.income > 0 || b.expense > 0)
    : (isIncome ? b.income : b.expense) > 0);
  if (hasData) {
    trendEmpty?.setAttribute('hidden', '');
    const bars = buckets.map(b => ({
      label: b.label,
      income:  combined || isIncome  ? b.income  : 0,
      expense: combined || !isIncome ? b.expense : 0,
      highlight: b.highlight,
    }));
    Charts.drawBarChart('trendCanvas', bars);
  } else {
    clearCanvas('trendCanvas');
    trendEmpty?.removeAttribute('hidden');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await SupaAuth.requireAuth();
  if (!user) return;

  try {
    await renderSpending();
  } catch (err) {
    console.error('Spending page error:', err);
    showErrorState('spendingBreakdown', "Couldn't load your cash flow. " + (err.message || ''), () => location.reload());
    ['spendTotal', 'spendIncome', 'spendNet'].forEach(id => setText(id, '—'));
    ['spendCatSkeleton', 'incomeCatSkeleton', 'spendTrendSkeleton'].forEach(id =>
      document.getElementById(id)?.setAttribute('hidden', ''));
  }

  /* crossing the desktop breakpoint switches between one and two panels */
  COMBINED.addEventListener('change', () => renderSpending().catch(console.error));

  /* Spending / Income toggle (phones and narrow windows) */
  document.querySelectorAll('#modeToggle .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === mode) return;
      mode = btn.dataset.mode;
      document.querySelectorAll('#modeToggle .seg-btn').forEach(b => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      renderSpending().catch(console.error);
    });
  });

  /* Range toggle (Week / Month / Year / All) — reset to the current period */
  document.querySelectorAll('#rangeToggle .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.range === period.mode) return;
      period.mode = btn.dataset.range;
      period.offset = 0;
      try { localStorage.setItem(RANGE_KEY, period.mode); } catch (_) {}
      renderSpending().catch(console.error);
    });
  });

  document.getElementById('periodPrev')?.addEventListener('click', async () => {
    if (!PeriodEngine.canPrev(period.mode, period.offset)) return;
    period.offset--;
    await renderSpending();
  });

  document.getElementById('periodNext')?.addEventListener('click', async () => {
    if (!PeriodEngine.canNext(period.mode, period.offset)) return;
    period.offset++;
    await renderSpending();
  });
});
