/* ============================================================
   accounts.js — Accounts page (async)
   ============================================================ */

const ACCOUNT_COLORS = [
  '#e8e8ec','#9a9aa4','#00d18f','#ff5c7a','#d4a64a',
  '#5b8def','#8b5cf6','#67b7c9','#ec4899','#52525b',
];

let editingAccountId = null;

/* Balances are signed: money you owe is negative. A credit card's form field
   asks for the amount owed (a positive number) and stores its negation, so
   a card with $500 owing lowers the total instead of adding to it. */
const isDebtType = type => type === 'credit';
const balanceToField = (type, bal) => (isDebtType(type) ? -bal : bal);
const fieldToBalance = (type, val) => (isDebtType(type) ? -val : val) || 0;

/* colour swatches → the hidden #accColor value. A colour not in the palette
   (set before swatches existed) is kept and shown as an extra swatch. */
function renderColorSwatches() {
  const wrap = document.getElementById('accColorSwatches');
  const input = document.getElementById('accColor');
  if (!wrap || !input) return;
  const current = (input.value || ACCOUNT_COLORS[0]).toLowerCase();
  const palette = ACCOUNT_COLORS.includes(current) ? ACCOUNT_COLORS : [...ACCOUNT_COLORS, current];
  wrap.innerHTML = palette.map(c => `<button type="button" class="color-swatch${c === current ? ' is-on' : ''}"
      role="radio" aria-checked="${c === current}" aria-label="Color ${c}" data-color="${c}" style="--sw:${c}"></button>`).join('');
  wrap.querySelectorAll('.color-swatch').forEach(b => b.addEventListener('click', () => {
    input.value = b.dataset.color;
    renderColorSwatches();
  }));
}

function syncBalanceField() {
  const debt  = isDebtType(document.getElementById('accType')?.value);
  const label = document.getElementById('accBalanceLabel');
  const hint  = document.getElementById('accBalanceHint');
  if (label) label.textContent = debt ? 'Amount owed' : 'Starting Balance';
  if (hint)  hint.textContent  = debt
    ? 'What you owe on this card today. It counts against your balance; purchases add to it, payments (transfers in) reduce it.'
    : 'Balance as of today — transactions adjust it from here.';
  /* the currency was never chosen by the user — say which one is in use */
  const cur = document.getElementById('accCurrencyHint');
  if (cur) {
    let code = 'CAD';
    try { code = localStorage.getItem('pf_currency') || 'CAD'; } catch (_) {}
    cur.innerHTML = `Amounts are in <strong>${escapeHTML(code)}</strong>. <a href="/settings">Change currency</a>`;
  }
}

async function loadAccountsWithBalances() {
  const [accounts, allTx] = await Promise.all([
    AccountStore.getAll(),
    TransactionStore.getAll(),
  ]);
  const balanceMap = SummaryEngine.computeAccountBalances(accounts, allTx);
  return { accounts, balanceMap };
}

async function initAccounts() {
  const data = await loadAccountsWithBalances();
  await renderAccountsGrid(data);
}

const TYPE_LABEL = { bank: 'Bank', cash: 'Cash', savings: 'Savings', investment: 'Investment', credit: 'Credit', other: 'Other' };

async function renderAccountsGrid(data) {
  const el = document.getElementById('accountsGrid');
  if (!el) return;

  /* Same placeholder cards accounts.html ships, so a re-render (after adding or
     editing an account) matches the very first paint. */
  el.innerHTML = [1, 2, 3].map(() => `
    <div class="acc-card" aria-hidden="true">
      <div class="skeleton skeleton-avatar skeleton-avatar--sm"></div>
      <div class="skeleton skeleton-text" style="width:70%;margin-top:10px;"></div>
      <div class="skeleton skeleton-text" style="width:50%;margin-top:8px;height:16px;margin-bottom:0"></div>
    </div>`).join('');

  const { accounts, balanceMap } = data || await loadAccountsWithBalances();

  /* "All accounts" first — on desktop the drawer is the left column and a card
     click filters the list (see wireAccountFilter) */
  const total = accounts.reduce((s, a) => s + (balanceMap[a.id] ?? 0), 0);
  const allCard = accounts.length ? `
      <div class="acc-card acc-card--all" data-filter-acc="" role="button" tabindex="0" title="Show all accounts">
        <div class="acc-card__name">All accounts</div>
        <div class="acc-card__balance" style="color:${signColor(total)}">${formatBalance(total)}</div>
        <div class="acc-card__type">${accounts.length} account${accounts.length === 1 ? '' : 's'}</div>
      </div>` : '';

  const cards = accounts.map(a => {
    const bal    = balanceMap[a.id] ?? 0;
    const letter = escapeHTML(a.name.charAt(0).toUpperCase());
    return `
      <div class="acc-card" data-id="${a.id}" data-filter-acc="${a.id}" role="button" tabindex="0" title="Show ${escapeHTML(a.name)} only">
        <div class="acc-card__head">
          <div class="acc-card__avatar" style="background:${a.color}22;color:${a.color}">${letter}</div>
          <div class="acc-card__actions">
            <button class="tx-action-btn" data-action="edit-acc" data-id="${a.id}" title="Edit"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="tx-action-btn tx-action-btn--delete" data-action="delete-acc" data-id="${a.id}" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
          </div>
        </div>
        <div class="acc-card__name" title="${escapeHTML(a.name)}">${escapeHTML(a.name)}</div>
        <div class="acc-card__balance" style="color:${signColor(bal)}">${formatBalance(bal)}</div>
        <div class="acc-card__type">${TYPE_LABEL[a.type] || 'Account'}</div>
      </div>`;
  }).join('');

  el.innerHTML = allCard + cards + `
    <button class="acc-card acc-card--add" id="addAccountCard">
      <div class="acc-card__add-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </div>
      <span>New account</span>
    </button>`;

  document.getElementById('addAccountCard')?.addEventListener('click', () => openAccountModal(null));
  el.querySelectorAll('[data-action="edit-acc"]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openAccountModal(btn.dataset.id); });
  });
  el.querySelectorAll('[data-action="delete-acc"]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); deleteAccount(btn.dataset.id); });
  });

  updateAccountsSummary(accounts, balanceMap);
  markActiveAccount();
}

/* ---- Account cards filter the transaction list ----
   Clicking a card drives the existing #filterAccount select (transactions.js
   owns the filtering), and the card matching the current filter is marked. */
function markActiveAccount() {
  const cur = document.getElementById('filterAccount')?.value || '';
  document.querySelectorAll('#accountsGrid [data-filter-acc]').forEach(c => {
    const on = c.dataset.filterAcc === cur;
    c.classList.toggle('is-active', on);
    c.setAttribute('aria-pressed', String(on));
  });
}

function wireAccountFilter() {
  const grid = document.getElementById('accountsGrid');
  const sel  = document.getElementById('filterAccount');
  if (!grid || !sel || grid.dataset.filterWired) return;
  grid.dataset.filterWired = '1';
  const pick = card => {
    sel.value = card.dataset.filterAcc;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  grid.addEventListener('click', e => {
    if (e.target.closest('[data-action]')) return;          /* edit / delete buttons */
    const card = e.target.closest('[data-filter-acc]');
    if (card) pick(card);
  });
  grid.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('[data-filter-acc]');
    if (card && e.target === card) { e.preventDefault(); pick(card); }
  });
  sel.addEventListener('change', markActiveAccount);
  /* a filter restored from the URL / saved view is set without a change event */
  window.addEventListener('load', () => setTimeout(markActiveAccount, 0));
}

/* ---- Collapsible accounts summary bar ----
   A one-line "N accounts · $total" header; the cards live in a drawer that
   opens on demand so the transaction history starts right below. */
const ACCOUNTS_OPEN_KEY = 'pf_accounts_open';
/* desktop: the accounts are the always-open left column (pages.css) */
const ACCOUNTS_RAIL = window.matchMedia('(min-width: 1100px)');

function savedAccountsOpen() {
  try { return localStorage.getItem(ACCOUNTS_OPEN_KEY) === '1'; } catch (_) { return false; }
}

function setAccountsOpen(open, persist = true) {
  const panel  = document.getElementById('accountsPanel');
  const drawer = document.getElementById('accountsGrid');
  const btn    = document.getElementById('accountsSummary');
  if (!panel || !drawer) return;
  const shown = open || ACCOUNTS_RAIL.matches;
  panel.classList.toggle('is-open', shown);
  drawer.hidden = !shown;
  btn?.setAttribute('aria-expanded', String(shown));
  if (persist) { try { localStorage.setItem(ACCOUNTS_OPEN_KEY, open ? '1' : '0'); } catch (_) {} }
}

function setupAccountsToggle() {
  const btn    = document.getElementById('accountsSummary');
  const drawer = document.getElementById('accountsGrid');
  if (!btn || !drawer) return;
  setAccountsOpen(savedAccountsOpen(), false);     /* collapsed by default on phones */
  btn.addEventListener('click', () => { if (!ACCOUNTS_RAIL.matches) setAccountsOpen(drawer.hidden); });
  /* resizing across the breakpoint: back to the phone's saved state, or open */
  ACCOUNTS_RAIL.addEventListener('change', () => setAccountsOpen(savedAccountsOpen(), false));
}

function updateAccountsSummary(accounts, balanceMap) {
  const countEl = document.getElementById('accountsSummaryCount');
  const totalEl = document.getElementById('accountsSummaryTotal');
  const n = accounts.length;
  if (countEl) countEl.textContent = `${n} account${n === 1 ? '' : 's'}`;
  if (totalEl) {
    const total = accounts.reduce((s, a) => s + (balanceMap[a.id] ?? 0), 0);
    totalEl.textContent = formatBalance(total);
    totalEl.style.color = signColor(total);
  }
  /* no accounts yet → open so the "New account" card is reachable */
  if (n === 0) setAccountsOpen(true, false);
}

async function openAccountModal(id) {
  editingAccountId = id || null;
  const modal = document.getElementById('accountModal');
  const title = document.getElementById('accountModalTitle');
  if (!modal) return;
  if (id) {
    const acc = await AccountStore.getById(id);
    if (acc) {
      setValue('accName',    acc.name);
      setValue('accType',    acc.type);
      setValue('accBalance', balanceToField(acc.type, acc.initialBalance));
      setValue('accColor',   acc.color);
    }
    if (title) title.textContent = 'Edit Account';
  } else {
    document.getElementById('accForm')?.reset();
    const accounts = await AccountStore.getAll();
    setValue('accColor', ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length]);
    if (title) title.textContent = 'New Account';
  }
  syncBalanceField();
  renderColorSwatches();
  modal.classList.add('open');
}

async function deleteAccount(id) {
  const allTx   = await TransactionStore.getAll();
  const linkedTx = allTx.filter(t => t.accountId === id || t.toAccountId === id);
  const txCount = linkedTx.length;

  const modal   = document.getElementById('deleteAccountModal');
  const msgEl   = document.getElementById('deleteAccountMsg');
  const confirm = document.getElementById('confirmDeleteAccount');
  const txRow   = document.getElementById('deleteAccountTxRow');
  const txChk   = document.getElementById('deleteAccountTx');
  const txLabel = document.getElementById('deleteAccountTxLabel');
  if (!modal || !confirm) return;

  if (msgEl) {
    msgEl.textContent = txCount
      ? `This account has ${txCount} transaction${txCount !== 1 ? 's' : ''}. Choose below whether to remove them too. This cannot be undone.`
      : 'This action cannot be undone. The account will be permanently removed.';
  }
  /* offer the choice only when there's something to delete */
  if (txRow) {
    txRow.style.display = txCount ? 'flex' : 'none';
    if (txChk)   txChk.checked = false;
    if (txLabel) txLabel.textContent = `Also delete this account's ${txCount} transaction${txCount !== 1 ? 's' : ''}`;
  }

  modal.classList.add('open');
  confirm.onclick = async () => {
    confirm.classList.add('btn--loading');
    confirm.disabled = true;
    try {
      /* per the user's choice, optionally remove the linked transactions first
         (includes transfers where this account is the destination) */
      if (txChk?.checked && txCount) {
        for (const t of linkedTx) { try { await TransactionStore.delete(t.id); } catch (_) {} }
      }
      await AccountStore.delete(id);
      showToast(txChk?.checked && txCount ? 'Account and transactions deleted' : 'Account deleted', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to delete account', 'error');
    } finally {
      modal.classList.remove('open');
      confirm.classList.remove('btn--loading');
      confirm.disabled = false;
    }
    await initAccounts();
  };

  document.getElementById('cancelDeleteAccount')?.addEventListener('click', () => modal.classList.remove('open'), { once: true });
  document.getElementById('closeDeleteAccountModal')?.addEventListener('click', () => modal.classList.remove('open'), { once: true });
}

function setValue(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
function capitalize(str)   { return str ? str[0].toUpperCase() + str.slice(1) : ''; }

document.addEventListener('DOMContentLoaded', async () => {
  const user = await SupaAuth.requireAuth();
  if (!user) return;
  setupAccountsToggle();          /* apply saved collapsed/expanded state before data loads */
  wireAccountFilter();
  /* /transactions?new=account — the dashboard's "Add account" step */
  if (new URLSearchParams(location.search).get('new') === 'account') {
    history.replaceState(null, '', location.pathname);
    openAccountModal(null);
  }
  try {
    await initAccounts();
  } catch (err) {
    console.error('Accounts error:', err);
    showErrorState('accountsGrid', "Couldn't load your accounts. " + (err.message || ''), () => location.reload());
    /* the collapsed summary ships shimmer placeholders — settle them */
    const cnt = document.getElementById('accountsSummaryCount');
    const tot = document.getElementById('accountsSummaryTotal');
    if (cnt) cnt.textContent = 'Accounts unavailable';
    if (tot) tot.textContent = '—';
  }

  document.getElementById('accType')?.addEventListener('change', syncBalanceField);
  document.getElementById('accForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const data = {
      name:           document.getElementById('accName').value.trim(),
      type:           document.getElementById('accType').value,
      initialBalance: fieldToBalance(document.getElementById('accType').value,
                                     parseFloat(document.getElementById('accBalance').value) || 0),
      color:          document.getElementById('accColor').value,
    };
    if (!data.name) return;
    /* first account of a brand-new user → hand them straight to step 2 */
    const firstRun = !editingAccountId
      && !(await AccountStore.getAll()).length && !(await TransactionStore.getAll()).length;
    if (editingAccountId) { await AccountStore.update(editingAccountId, data); showToast('Account updated', 'success'); }
    else                  { await AccountStore.add(data);                      showToast(firstRun ? 'Account created — now log your first transaction' : 'Account created', 'success'); }
    document.getElementById('accountModal')?.classList.remove('open');
    await initAccounts();
    /* the activity list's filters/empty state know about accounts too */
    if (typeof populateFilters === 'function') {
      await populateFilters();
      if (typeof syncControlsFromFilters === 'function') syncControlsFromFilters();
      if (typeof refresh === 'function') refresh();
    }
    if (firstRun) window.openAddTransaction?.();
  });

  document.getElementById('closeAccountModal')?.addEventListener('click', () => document.getElementById('accountModal')?.classList.remove('open'));
  document.getElementById('cancelAccount')?.addEventListener('click',     () => document.getElementById('accountModal')?.classList.remove('open'));
});
