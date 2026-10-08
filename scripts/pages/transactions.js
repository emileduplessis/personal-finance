/* ============================================================
   transactions.js — Transaction list (the "Transactions" page,
   served from /transactions alongside the Accounts panel).
   Search · type tabs · category/account filters · date-range
   presets · sort · CSV export of the filtered view. The list is
   grouped by day with a per-day net subtotal. Account add/edit
   lives in accounts.js; this file owns everything transaction.
   ============================================================ */

let currentFilters = { search: '', categoryId: '', accountId: '', type: '', from: '', to: '' };
let currentSort    = 'date-desc';
let currentRange   = 'all';
let displayedCount = 20;
const PAGE_SIZE    = 20;

let _catMap = {};
let _accMap = {};

/* bulk-select state */
let selectMode = false;
const selectedIds = new Set();
let _allFiltered = [];   /* last rendered filtered set, for bulk snapshots */

async function initTransactions() {
  await populateFilters();
  syncControlsFromFilters();
  await Promise.all([renderTransactions(), renderStats()]);
  saveView();
}

/* Persist the current view (filters, sort, range, page depth) for this tab so
   editing a transaction and coming back doesn't reset everything. */
const VIEW_KEY = 'pf_tx_view';
function saveView() {
  try {
    sessionStorage.setItem(VIEW_KEY, JSON.stringify({
      filters: currentFilters, sort: currentSort, range: currentRange, count: displayedCount,
    }));
  } catch (_) {}
}
function restoreView() {
  try {
    const v = JSON.parse(sessionStorage.getItem(VIEW_KEY) || 'null');
    if (!v) return;
    if (v.filters) currentFilters = { search: '', categoryId: '', accountId: '', type: '', from: '', to: '', ...v.filters };
    if (v.sort)  currentSort  = v.sort;
    if (v.range) currentRange = v.range;
    if (v.count) displayedCount = v.count;
  } catch (_) {}
}

/* Seed filters from URL params (used by the Cash-Flow drill-down:
   ?category=&type=&from=&to=&search=). */
function applyUrlFilters() {
  const p = new URLSearchParams(location.search);
  const cat = p.get('category'), type = p.get('type');
  const from = p.get('from'), to = p.get('to'), search = p.get('search');
  if (cat)    currentFilters.categoryId = cat;
  if (type)   currentFilters.type       = type;
  if (from)   currentFilters.from        = from;
  if (to)     currentFilters.to          = to;
  if (search) currentFilters.search      = search;
}

/* Reflect currentFilters into the toolbar controls (after populateFilters
   has built the option lists). */
function syncControlsFromFilters() {
  const catSel = document.getElementById('filterCategory');
  const accSel = document.getElementById('filterAccount');
  if (catSel) catSel.value = currentFilters.categoryId || '';
  if (accSel) accSel.value = currentFilters.accountId || '';
  const searchEl = document.getElementById('searchInput');
  if (searchEl) searchEl.value = currentFilters.search || '';
  const sortSel = document.getElementById('txSort');
  if (sortSel && currentSort) sortSel.value = currentSort;
  document.querySelectorAll('#txTypeTabs .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.type === (currentFilters.type || '')));
  if (currentFilters.from || currentFilters.to) {
    currentRange = 'custom';
    const rangeSel = document.getElementById('txRange');
    if (rangeSel) rangeSel.value = 'custom';
    const cw = document.getElementById('txCustomDates');
    if (cw) cw.hidden = false;
    const f = document.getElementById('filterFrom'); if (f) f.value = currentFilters.from || '';
    const t = document.getElementById('filterTo');   if (t) t.value = currentFilters.to   || '';
  }
}

/* Client-side text search across note, category, account, tags and amount —
   the server query only matches the note, so richer matching happens here. */
/* case- and accent-insensitive: "cafe" finds "Café Olimpico" */
const foldText = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function matchesSearch(t, term) {
  const q = foldText(term).trim();
  if (!q) return true;
  const cat   = _catMap[t.categoryId];
  const acc   = _accMap[t.accountId];
  const toAcc = _accMap[t.toAccountId];
  const hay = [
    t.note, cat?.name, acc?.name, toAcc?.name, ...(t.tags || []),
    t.amount != null ? String(t.amount) : '',
    t.amount != null ? Number(t.amount).toFixed(2) : '',
  ].filter(Boolean).join(' ');
  return foldText(hay).includes(q);
}

async function populateFilters() {
  const [cats, accounts] = await Promise.all([CategoryStore.getAll(), AccountStore.getAll()]);
  _catMap = Object.fromEntries(cats.map(c => [c.id, c]));
  _accMap = Object.fromEntries(accounts.map(a => [a.id, a]));
  const catSel = document.getElementById('filterCategory');
  const accSel = document.getElementById('filterAccount');
  if (catSel) catSel.innerHTML = `<option value="">All categories</option>` +
    cats.map(c => `<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');
  if (accSel) accSel.innerHTML = `<option value="">All accounts</option>` +
    accounts.map(a => `<option value="${a.id}">${escapeHTML(a.name)}</option>`).join('');
  const bulkCat = document.getElementById('bulkCategory');
  if (bulkCat) bulkCat.innerHTML = `<option value="">Recategorize…</option>` +
    cats.map(c => `<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');
  /* the two filter selects ship data-loading so they shimmer instead of
     sitting there empty while the categories/accounts are in flight */
  clearFieldLoading(catSel);
  clearFieldLoading(accSel);
}

/* ---- query + client-side sort ---- */
function sortTxs(txs) {
  const by = {
    'date-desc':   (a, b) => (b.date.localeCompare(a.date)) || ((b.createdAt || '').localeCompare(a.createdAt || '')),
    'date-asc':    (a, b) => (a.date.localeCompare(b.date)) || ((a.createdAt || '').localeCompare(b.createdAt || '')),
    'amount-desc': (a, b) => b.amount - a.amount,
    'amount-asc':  (a, b) => a.amount - b.amount,
  }[currentSort] || ((a, b) => b.date.localeCompare(a.date));
  return txs.slice().sort(by);
}

async function getFiltered() {
  const { search, ...rest } = currentFilters;
  const txs = await TransactionStore.query(rest);
  return sortTxs(txs.filter(t => matchesSearch(t, search)));
}

/* ---- stats (reflect the active filters) ---- */
async function renderStats() {
  const { search, ...rest } = currentFilters;
  const txs    = (await TransactionStore.query(rest)).filter(t => matchesSearch(t, search));
  const totals = SummaryEngine.getTotals(txs);
  const net    = totals.income - totals.expense;
  setText('statIncome',  formatCurrency(totals.income));
  setText('statExpense', formatCurrency(totals.expense));
  setText('statNet',     formatSigned(net));
  setText('statCount',   String(txs.length));
  const netEl = document.getElementById('statNet');
  if (netEl) netEl.style.color = signColor(net);

  const anyFilter = currentFilters.search || currentFilters.categoryId || currentFilters.accountId ||
                    currentFilters.type || currentFilters.from || currentFilters.to;
  const clearBtn = document.getElementById('clearFilters');
  if (clearBtn) clearBtn.hidden = !anyFilter;
  if (typeof updateFilterBadge === 'function') updateFilterBadge(currentFilters);
}

/* ---- list ---- */
/* Mirrors the placeholder rows baked into accounts.html, so re-renders (filter
   changes, search) look the same as the very first paint. */
function txSkeleton() {
  return [[50,30,65],[38,26,52],[58,33,70],[45,29,60],[52,24,58]].map(([w1, w2, amt]) => `
    <div class="tx-item" aria-hidden="true">
      <div class="skeleton skeleton-avatar"></div>
      <div class="tx-info">
        <div class="skeleton skeleton-text" style="width:${w1}%"></div>
        <div class="skeleton skeleton-text" style="width:${w2}%;margin-bottom:0"></div>
      </div>
      <div class="skeleton skeleton-text" style="width:${amt}px;margin-bottom:0"></div>
    </div>`).join('');
}

async function renderTransactions() {
  const el = document.getElementById('txListFull');
  if (!el) return;
  el.innerHTML = txSkeleton();

  const all  = await getFiltered();
  _allFiltered = all;
  const page = all.slice(0, displayedCount);

  if (!all.length) {
    const filtered = currentFilters.search || currentFilters.categoryId || currentFilters.accountId ||
                     currentFilters.type || currentFilters.from || currentFilters.to;
    el.innerHTML = `<div class="empty-state" style="padding:48px 24px;text-align:center;">
        <div style="font-weight:600;color:var(--color-text);margin-bottom:6px;">${filtered ? 'No matches' : 'No transactions yet'}</div>
        <div style="font-size:.8125rem;">${filtered
          ? 'Try clearing or widening your filters.'
          : Object.keys(_accMap).length
          ? '<a href="/add-transaction" style="color:var(--color-text)">Add your first transaction →</a>'
          /* no account yet: that's the step that comes first */
          : 'Start with an account. <button type="button" data-new-account style="background:none;border:0;padding:0;font:inherit;cursor:pointer;color:var(--color-text);text-decoration:underline;">Add an account →</button>'}</div>
      </div>`;
    el.querySelector('[data-new-account]')?.addEventListener('click', () =>
      (typeof openAccountModal === 'function' ? openAccountModal(null) : (location.href = '/transactions?new=account')));
    renderLoadMore(0);
    return;
  }

  if (currentSort.startsWith('date')) {
    /* group by date, with a per-day net subtotal */
    const grouped = {};
    page.forEach(t => { (grouped[t.date] = grouped[t.date] || []).push(t); });
    const orderedDates = Object.keys(grouped).sort((a, b) =>
      currentSort === 'date-asc' ? a.localeCompare(b) : b.localeCompare(a));
    el.innerHTML = orderedDates.map(date => {
      const txs = grouped[date];
      const dayNet = txs.reduce((s, t) => s + (t.type === 'income' ? t.amount : t.type === 'expense' ? -t.amount : 0), 0);
      /* only worth a day-total when more than one transaction shares the day */
      const netStr = (txs.length < 2 || Math.abs(dayNet) < 0.005) ? '' :
        `<span class="tx-date-group__net" style="color:${dayNet >= 0 ? 'var(--color-income)' : 'var(--color-expense)'}">${dayNet >= 0 ? '+' : '−'}${formatCurrency(Math.abs(dayNet))}</span>`;
      return `<div class="tx-date-group"><span>${formatDate(date)}</span>${netStr}</div>
        ${txs.map(t => txItemFullHTML(t, _catMap[t.categoryId], _accMap[t.accountId])).join('')}`;
    }).join('');
  } else {
    /* amount sort: a flat list (date shown per-row, since grouping by day
       would re-impose date order and defeat the sort) */
    el.innerHTML = page.map(t => txItemFullHTML(t, _catMap[t.categoryId], _accMap[t.accountId], true)).join('');
  }

  renderLoadMore(all.length);
  attachTxEvents();
}

function txItemFullHTML(t, cat, acc, showDate = false) {
  const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
  let meta;
  if (t.type === 'transfer') {
    const to = _accMap[t.toAccountId];
    meta = `${escapeHTML(acc?.name) || '—'} <span class="tx-meta__arrow">→</span> ${escapeHTML(to?.name) || '—'}`;
  } else {
    meta = `${escapeHTML(cat?.name) || 'Uncategorized'} · ${escapeHTML(acc?.name) || 'No account'}`;
  }
  if (showDate) meta = `${formatDateShort(t.date)} · ${meta}`;
  /* the user's own tags (the app's bookkeeping tags stay out of sight) —
     they were saved but never shown anywhere */
  const userTags = (t.tags || []).filter(tag => !['subscription', 'shift', 'bonus'].includes(tag));
  if (userTags.length) meta += ` · ${userTags.map(tag => `#${escapeHTML(tag)}`).join(' ')}`;
  const checkbox = selectMode
    ? `<input type="checkbox" class="tx-select" data-id="${t.id}" ${selectedIds.has(t.id) ? 'checked' : ''} style="margin-right:6px;flex-shrink:0;width:16px;height:16px;">`
    : '';
  return `
    <div class="tx-item${selectMode && selectedIds.has(t.id) ? ' tx-item--selected' : ''}" data-id="${t.id}"${selectMode ? ' style="cursor:pointer;"' : ''}>
      ${checkbox}
      <div class="tx-icon tx-icon--${t.type}">${categoryIconHTML(cat, 18)}</div>
      <div class="tx-info">
        <div class="tx-name">${escapeHTML(t.note) || escapeHTML(cat?.name) || (t.type === 'transfer' ? 'Transfer' : 'Transaction')}</div>
        <div class="tx-meta">${meta}</div>
      </div>
      <div class="tx-amount tx-amount--${t.type}">${sign}${formatCurrency(t.amount)}</div>
      <div class="tx-actions"${selectMode ? ' style="display:none;"' : ''}>
        <button class="tx-action-btn" data-action="edit" data-id="${t.id}" title="Edit"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="tx-action-btn tx-action-btn--delete" data-action="delete" data-id="${t.id}" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
      </div>
    </div>`;
}

function renderLoadMore(total) {
  const el = document.getElementById('pagination');
  if (!el) return;
  const shown = Math.min(displayedCount, total);
  if (shown >= total) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <button class="btn btn--ghost load-more-btn" id="loadMoreBtn">
      Load more
      <span class="load-more-count">${shown} of ${total} shown</span>
    </button>`;
  document.getElementById('loadMoreBtn')?.addEventListener('click', async () => {
    displayedCount += PAGE_SIZE;
    await renderTransactions();
    saveView();
  });
}

function attachTxEvents() {
  if (selectMode) {
    document.querySelectorAll('.tx-list-full .tx-item[data-id]').forEach(item => {
      const id = item.dataset.id;
      const set = checked => {
        if (checked) selectedIds.add(id); else selectedIds.delete(id);
        item.style.background = checked ? 'var(--color-surface-2)' : '';
        const cb = item.querySelector('.tx-select'); if (cb) cb.checked = checked;
        updateBulkBar();
      };
      item.addEventListener('click', e => {
        if (e.target.closest('.tx-select')) return;   /* checkbox handles itself */
        set(!selectedIds.has(id));
      });
      item.querySelector('.tx-select')?.addEventListener('change', e => set(e.target.checked));
      if (selectedIds.has(id)) item.style.background = 'var(--color-surface-2)';
    });
    return;
  }
  document.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (window.openAddTransaction) window.openAddTransaction(btn.dataset.id);
      else window.location.href = `/add-transaction?id=${btn.dataset.id}`;
    });
  });
  document.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openDeleteModal(btn.dataset.id); });
  });
  document.querySelectorAll('.tx-list-full .tx-item[data-id]').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.tx-actions')) return;
      if (window.openAddTransaction) window.openAddTransaction(item.dataset.id);
      else window.location.href = `/add-transaction?id=${item.dataset.id}`;
    });
  });
}

function openDeleteModal(id) {
  const modal      = document.getElementById('deleteModal');
  const confirmBtn = document.getElementById('confirmDelete');
  if (!modal || !confirmBtn) return;
  modal.classList.add('open');
  confirmBtn.onclick = async () => {
    /* snapshot the row so the delete can be undone */
    let snapshot = null;
    try {
      const t = await TransactionStore.getById(id);
      if (t) snapshot = {
        amount: t.amount, date: t.date, note: t.note, type: t.type,
        accountId: t.accountId, toAccountId: t.toAccountId || null,
        categoryId: t.categoryId, tags: Array.isArray(t.tags) ? t.tags : [],
      };
    } catch (_) {}
    await TransactionStore.delete(id);
    modal.classList.remove('open');
    await Promise.all([renderTransactions(), renderStats()]);
    if (snapshot && typeof showUndoToast === 'function') {
      showUndoToast('Transaction deleted', async () => {
        try {
          await TransactionStore.add(snapshot);
          await Promise.all([renderTransactions(), renderStats()]);
          showToast('Transaction restored', 'success');
        } catch (err) { showToast(err.message || 'Failed to restore', 'error'); }
      });
    } else {
      showToast('Transaction deleted', 'success');
    }
  };
}

/* ---- bulk select / recategorize / delete ---- */
function toggleSelectMode(on) {
  selectMode = on;
  selectedIds.clear();
  const bar = document.getElementById('txBulkbar');
  if (bar) bar.hidden = !on;
  const btn = document.getElementById('selectModeBtn');
  if (btn) { btn.classList.toggle('active', on); btn.textContent = on ? 'Selecting…' : 'Select'; }
  const all = document.getElementById('bulkSelectAll');
  if (all) all.checked = false;
  updateBulkBar();
  renderTransactions();
}

function updateBulkBar() {
  const n = selectedIds.size;
  setText('bulkCount', `${n} selected`);
  const del = document.getElementById('bulkDelete');
  const rec = document.getElementById('bulkCategory');
  if (del) del.disabled = n === 0;
  if (rec) rec.disabled = n === 0;
}

function selectAllVisible(checked) {
  document.querySelectorAll('.tx-list-full .tx-item[data-id]').forEach(item => {
    const id = item.dataset.id;
    if (checked) selectedIds.add(id); else selectedIds.delete(id);
    item.style.background = checked ? 'var(--color-surface-2)' : '';
    const cb = item.querySelector('.tx-select'); if (cb) cb.checked = checked;
  });
  updateBulkBar();
}

async function refreshAfterBulk() {
  await Promise.all([renderTransactions(), renderStats()]);
  updateBulkBar();
}

async function bulkDelete() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const ok = window.confirmDialog
    ? await window.confirmDialog(`Delete ${ids.length} transaction${ids.length === 1 ? '' : 's'}? This can be undone.`, { confirmText: 'Delete' })
    : true;
  if (!ok) return;
  /* snapshot from the in-memory set so undo can re-add them */
  const snaps = ids
    .map(id => _allFiltered.find(t => t.id === id))
    .filter(Boolean)
    .map(t => ({ amount: t.amount, date: t.date, note: t.note, type: t.type,
      accountId: t.accountId, toAccountId: t.toAccountId || null,
      categoryId: t.categoryId, tags: Array.isArray(t.tags) ? t.tags : [] }));
  for (const id of ids) { try { await TransactionStore.delete(id); } catch (_) {} }
  selectedIds.clear();
  await refreshAfterBulk();
  if (snaps.length && typeof showUndoToast === 'function') {
    showUndoToast(`${snaps.length} deleted`, async () => {
      for (const s of snaps) { try { await TransactionStore.add(s); } catch (_) {} }
      await refreshAfterBulk();
      showToast('Restored', 'success');
    });
  } else {
    showToast(`${ids.length} deleted`, 'success');
  }
}

async function bulkRecategorize(categoryId) {
  const ids = [...selectedIds];
  if (!ids.length || !categoryId) return;
  for (const id of ids) { try { await TransactionStore.update(id, { categoryId }); } catch (_) {} }
  selectedIds.clear();
  await refreshAfterBulk();
  showToast(`Recategorized ${ids.length}`, 'success');
}

/* ---- date-range presets ---- */
function applyRange(range) {
  currentRange = range;
  const customWrap = document.getElementById('txCustomDates');
  if (range === 'custom') { if (customWrap) customWrap.hidden = false; return; }
  if (customWrap) customWrap.hidden = true;
  const fromEl = document.getElementById('filterFrom');
  const toEl   = document.getElementById('filterTo');
  if (fromEl) fromEl.value = '';
  if (toEl) toEl.value = '';

  if (range === 'all') { currentFilters.from = ''; currentFilters.to = ''; return; }
  const today = new Date();
  currentFilters.to = isoLocal(today);
  if (range === 'month') {
    currentFilters.from = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  } else {
    const d = new Date(); d.setDate(d.getDate() - (parseInt(range) - 1));
    currentFilters.from = isoLocal(d);
  }
}

function refresh() { displayedCount = PAGE_SIZE; renderTransactions(); renderStats(); saveView(); }

function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

document.addEventListener('DOMContentLoaded', async () => {
  const user = await SupaAuth.requireAuth();
  if (!user) return;
  /* a fresh drill-down (URL params) wins; otherwise restore this tab's last view */
  if (/[?&](category|type|from|to|search)=/.test(location.search)) applyUrlFilters();
  else restoreView();
  try {
    await initTransactions();
  } catch (err) {
    console.error('Transactions error:', err);
    showErrorState('txListFull', "Couldn't load transactions. " + (err.message || ''), () => location.reload());
    /* don't leave the stat bar and filter selects shimmering */
    ['statIncome','statExpense','statNet','statCount'].forEach(id => setText(id, '—'));
    clearFieldLoading();
  }

  /* search (debounced) */
  let _searchTimer;
  document.getElementById('searchInput')?.addEventListener('input', e => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => { currentFilters.search = e.target.value; refresh(); }, 250);
  });

  /* type tabs */
  document.querySelectorAll('#txTypeTabs .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentFilters.type = btn.dataset.type;
      document.querySelectorAll('#txTypeTabs .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      refresh();
    });
  });

  /* category / account selects */
  document.getElementById('filterCategory')?.addEventListener('change', e => { currentFilters.categoryId = e.target.value; refresh(); });
  document.getElementById('filterAccount')?.addEventListener('change',  e => { currentFilters.accountId  = e.target.value; refresh(); });

  /* date-range preset + custom dates */
  document.getElementById('txRange')?.addEventListener('change', e => { applyRange(e.target.value); refresh(); });
  document.getElementById('filterFrom')?.addEventListener('change', e => { currentFilters.from = e.target.value; refresh(); });
  document.getElementById('filterTo')?.addEventListener('change',   e => { currentFilters.to   = e.target.value; refresh(); });

  /* sort */
  document.getElementById('txSort')?.addEventListener('change', e => { currentSort = e.target.value; refresh(); });

  /* export the current filtered view */
  document.getElementById('exportCsv')?.addEventListener('click', async () => {
    const btn = document.getElementById('exportCsv');
    btn.disabled = true;
    try {
      const txs = await getFiltered();
      if (!txs.length) { showToast('Nothing to export', 'error'); return; }
      await CSVService.export(txs);
      showToast(`Exported ${txs.length} transaction${txs.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      showToast(err.message || 'Export failed', 'error');
    } finally { btn.disabled = false; }
  });

  /* clear all filters */
  document.getElementById('clearFilters')?.addEventListener('click', () => {
    currentFilters = { search: '', categoryId: '', accountId: '', type: '', from: '', to: '' };
    currentRange = 'all';
    document.querySelectorAll('.tx-toolbar select, .tx-toolbar input[type="date"]').forEach(el => { el.value = el.id === 'txRange' ? 'all' : el.id === 'txSort' ? el.value : ''; });
    document.getElementById('txSort').value = currentSort;
    document.getElementById('txRange').value = 'all';
    document.getElementById('txCustomDates').hidden = true;
    document.getElementById('searchInput').value = '';
    document.querySelectorAll('#txTypeTabs .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.type === ''));
    refresh();
  });

  document.getElementById('closeDeleteModal')?.addEventListener('click', () => document.getElementById('deleteModal')?.classList.remove('open'));
  document.getElementById('cancelDelete')?.addEventListener('click',     () => document.getElementById('deleteModal')?.classList.remove('open'));

  /* bulk select / recategorize / delete */
  document.getElementById('selectModeBtn')?.addEventListener('click', () => toggleSelectMode(!selectMode));
  document.getElementById('bulkCancel')?.addEventListener('click', () => toggleSelectMode(false));
  document.getElementById('bulkDelete')?.addEventListener('click', bulkDelete);
  document.getElementById('bulkSelectAll')?.addEventListener('change', e => selectAllVisible(e.target.checked));
  document.getElementById('bulkCategory')?.addEventListener('change', e => { const v = e.target.value; e.target.value = ''; bulkRecategorize(v); });
});
