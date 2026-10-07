/* ============================================================
   budget.js — Monthly Budget Report page
   ============================================================ */

let currentMonth = '';

function getMonthKey() {
  const params = new URLSearchParams(window.location.search);
  return params.get('month') || new Date().toISOString().slice(0, 7);
}

function setMonthKey(m) {
  const url = new URL(window.location.href);
  url.searchParams.set('month', m);
  history.replaceState({}, '', url.toString());
  currentMonth = m;
}

function monthLabel(key) {
  const [y, mo] = key.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function prevMonthKey(key) {
  const d = new Date(key + '-01T00:00:00');
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
}

function nextMonthKey(key) {
  const d = new Date(key + '-01T00:00:00');
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 7);
}

async function loadMonthData(monthKey) {
  const [y, mo] = monthKey.split('-').map(Number);
  const from    = `${y}-${String(mo).padStart(2, '0')}-01`;
  const lastDay = new Date(y, mo, 0).getDate();
  const to      = `${y}-${String(mo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const [txs, cats] = await Promise.all([
    TransactionStore.query({ from, to }),
    CategoryStore.getAll(),
  ]);

  const budgets = BudgetStore.getMonth(monthKey);
  const expCats = cats.filter(c => c.type === 'expense' || c.type === 'both');

  const spending = {};
  txs.filter(t => t.type === 'expense').forEach(t => {
    spending[t.categoryId] = (spending[t.categoryId] || 0) + t.amount;
  });

  return { txs, expCats, budgets, spending };
}

/* Phase 2 intelligence — recommend a monthly budget per category from the
   trailing 3 full months of history. Returns a { catId: amount } map. */
async function getRecommendations(monthKey) {
  if (typeof InsightsEngine === 'undefined') return {};
  const ref  = new Date(monthKey + '-01T00:00:00');
  const from = new Date(ref.getFullYear(), ref.getMonth() - 3, 1);
  const to   = new Date(ref.getFullYear(), ref.getMonth(), 0); /* last day of prev month */
  const iso  = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let txs = [];
  try { txs = await TransactionStore.query({ from: iso(from), to: iso(to) }); } catch { return {}; }
  const map = {};
  InsightsEngine.recommendBudgets(txs, { months: 3, asOf: ref }).forEach(r => { map[r.categoryId] = r.amount; });
  return map;
}

async function renderBudgetPage() {
  const { expCats, budgets, spending } = await loadMonthData(currentMonth);
  const recs = await getRecommendations(currentMonth);

  /* Month nav */
  document.getElementById('monthLabel').textContent = monthLabel(currentMonth);
  const today = new Date().toISOString().slice(0, 7);
  const nextBtn = document.getElementById('nextMonthBtn');
  if (nextBtn) nextBtn.disabled = currentMonth >= today;

  /* Summary */
  const totalBudget = expCats.reduce((s, c) => s + (budgets[c.id] || 0), 0);
  const totalSpent  = Object.values(spending).reduce((s, v) => s + v, 0);
  const noBudgets   = totalBudget === 0;
  const remaining   = totalBudget - totalSpent;
  const overBudget  = !noBudgets && remaining < 0;

  setText('summaryBudget',  formatCurrency(totalBudget));
  setText('summarySpent',   formatCurrency(totalSpent));
  const remEl = document.getElementById('summaryRemaining');
  if (remEl) {
    /* with no budgets set, this isn't "over budget" — it's just unbudgeted */
    remEl.textContent = noBudgets ? formatCurrency(totalSpent) : formatCurrency(Math.abs(remaining));
    remEl.style.color = noBudgets ? 'var(--color-text-muted)'
      : (overBudget ? 'var(--color-expense)' : remaining === 0 ? 'var(--color-text-muted)' : 'var(--color-income)');
  }
  const remLabel = document.getElementById('summaryRemainingLabel');
  if (remLabel) remLabel.textContent = noBudgets ? 'Unbudgeted' : (overBudget ? 'Over budget' : 'Remaining');

  /* Category rows */
  const listEl = document.getElementById('budgetCategoryList');
  if (!listEl) return;

  const hasBudgets  = Object.keys(budgets).length > 0;
  const hasSpending = Object.keys(spending).length > 0;

  /* Partition categories */
  const budgeted   = expCats.filter(c => budgets[c.id] > 0).sort((a, b) => {
    const pa = (spending[a.id] || 0) / budgets[a.id];
    const pb = (spending[b.id] || 0) / budgets[b.id];
    return pb - pa;
  });
  const unbudgeted = expCats.filter(c => !budgets[c.id] && spending[c.id] > 0);
  const dormant    = expCats.filter(c => !budgets[c.id] && !spending[c.id]);

  let html = '';

  if (!hasBudgets && !hasSpending) {
    html += `
      <div class="budget-onboarding-hint">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Use <strong>+ Set limit</strong> on any category to give it a monthly budget.
      </div>`;
  }

  if (budgeted.length) {
    html += budgeted.map(c => categoryRowHTML(c, spending[c.id] || 0, budgets[c.id], recs[c.id])).join('');
  }

  if (unbudgeted.length) {
    html += `<div class="budget-section-label">Unbudgeted spending</div>`;
    html += unbudgeted.map(c => categoryRowHTML(c, spending[c.id], 0, recs[c.id])).join('');
  }

  if (dormant.length) {
    if (budgeted.length || unbudgeted.length) {
      html += `<div class="budget-section-label">No activity</div>`;
    }
    html += dormant.map(c => categoryRowHTML(c, 0, 0, recs[c.id])).join('');
  }

  listEl.innerHTML = html;

  /* Inline edit wiring */
  listEl.querySelectorAll('.budget-amount-display').forEach(el => {
    el.addEventListener('click', () => startEdit(el));
  });

  /* Per-row "apply suggested budget" chips */
  listEl.querySelectorAll('.budget-suggest-chip').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      await BudgetStore.set(currentMonth, el.dataset.cat, parseFloat(el.dataset.amount));
      await renderBudgetPage();
      showToast('Budget set from suggestion', 'success');
    });
  });

  /* Bulk "Suggest budgets from your last 3 months" banner */
  const unbudgetedWithRec = expCats.filter(c => !budgets[c.id] && recs[c.id] > 0);
  const suggestCard = document.getElementById('suggestBudgets');
  if (suggestCard) {
    if (unbudgetedWithRec.length) {
      suggestCard.style.display = '';
      setText('suggestBudgetsText', `Suggest budgets for ${unbudgetedWithRec.length} categor${unbudgetedWithRec.length === 1 ? 'y' : 'ies'} from your last 3 months`);
      const btn = suggestCard.querySelector('#suggestBtn');
      btn.onclick = async () => {
        btn.disabled = true;
        for (const c of unbudgetedWithRec) await BudgetStore.set(currentMonth, c.id, recs[c.id]);
        await renderBudgetPage();
        showToast('Budgets suggested from your history', 'success');
      };
    } else {
      suggestCard.style.display = 'none';
    }
  }

  /* Copy from last month button */
  const prevKey = prevMonthKey(currentMonth);
  const prevBudgets = BudgetStore.getMonth(prevKey);
  const hasPrev     = Object.keys(prevBudgets).length > 0;

  const copyWrap = document.getElementById('copyFromPrev');
  if (copyWrap) {
    if (hasPrev && !hasBudgets) {
      copyWrap.style.display = '';
      copyWrap.querySelector('#copyBtn')?.addEventListener('click', async () => {
        await BudgetStore.copyFromPrevious(currentMonth);
        await renderBudgetPage();
        showToast('Budgets copied from last month', 'success');
      });
    } else {
      copyWrap.style.display = 'none';
    }
  }
}

function categoryRowHTML(cat, spent, budget, rec) {
  const pct      = budget > 0 ? (spent / budget) * 100 : 0;
  const over     = budget > 0 && spent > budget;
  const barPct   = Math.min(pct, 100);
  const barColor = pct >= 100 ? 'var(--color-expense)' : pct >= 75 ? 'var(--color-transfer)' : 'var(--color-income)';

  const suggestChip = (!(budget > 0) && rec > 0)
    ? `<button type="button" class="budget-suggest-chip" data-cat="${cat.id}" data-amount="${rec}" title="Apply suggested budget from your last 3 months">~${formatCurrency(rec)}</button>`
    : '';
  const budgetDisplay = budget > 0
    ? `<button type="button" class="budget-amount-display" data-cat="${cat.id}" data-value="${budget}" title="Edit limit">${formatCurrency(budget)}</button>`
    : `<button type="button" class="budget-amount-display budget-set-btn" data-cat="${cat.id}" data-value="0" aria-label="Set a monthly limit for ${escapeHTML(cat.name)}">+ Set limit</button>${suggestChip}`;

  return `
    <div class="budget-row" data-cat="${cat.id}">
      <div class="budget-row__cat">
        <div class="budget-row__icon">${categoryIconHTML(cat, 18)}</div>
        <div class="budget-row__name">${cat.name}</div>
      </div>
      <div class="budget-row__bar-wrap">
        ${budget > 0 ? `
          <div class="budget-bar-track">
            <div class="budget-bar-fill" style="width:${barPct.toFixed(1)}%;background:${barColor};"></div>
          </div>
        ` : `<div class="budget-bar-empty">— no budget</div>`}
      </div>
      <div class="budget-row__numbers">
        ${budget > 0 || spent > 0 ? `<span class="budget-row__spent ${over ? 'budget-row__spent--over' : ''}">${formatCurrency(spent)}</span>` : ''}
        ${budget > 0 ? '<span class="budget-row__sep">of</span>' : ''}
        ${budgetDisplay}
        ${budget > 0 ? `<span class="budget-row__pct" style="color:${barColor}">${Math.round(pct)}%</span>` : ''}
      </div>
    </div>
  `;
}

function startEdit(displayEl) {
  const catId   = displayEl.dataset.cat;
  const current = parseFloat(displayEl.dataset.value) || 0;

  const input = document.createElement('input');
  input.type        = 'number';
  input.className   = 'budget-inline-input';
  input.value       = current > 0 ? current : '';
  input.placeholder = '0.00';
  input.min         = '0';
  input.step        = '0.01';

  displayEl.replaceWith(input);
  input.focus();
  if (current > 0) input.select();

  const save = async () => {
    const val = parseFloat(input.value) || 0;
    await BudgetStore.set(currentMonth, catId, val);
    renderBudgetPage().catch(console.error);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); save(); }
    if (e.key === 'Escape') { renderBudgetPage().catch(console.error); }
  });
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await SupaAuth.requireAuth();
  if (!user) return;

  currentMonth = getMonthKey();

  try {
    await BudgetStore.load();
    await renderBudgetPage();
  } catch (err) {
    console.error('Budget error:', err);
    showErrorState('budgetCategoryList', "Couldn't load your budget. " + (err.message || ''), () => location.reload());
    /* the summary strip ships shimmer placeholders — don't leave them running */
    ['summaryBudget', 'summarySpent', 'summaryRemaining'].forEach(id => setText(id, '—'));
  }

  document.getElementById('prevMonthBtn')?.addEventListener('click', () => {
    setMonthKey(prevMonthKey(currentMonth));
    renderBudgetPage().catch(console.error);
  });

  document.getElementById('nextMonthBtn')?.addEventListener('click', () => {
    const next = nextMonthKey(currentMonth);
    if (next > new Date().toISOString().slice(0, 7)) return;
    setMonthKey(next);
    renderBudgetPage().catch(console.error);
  });
});
