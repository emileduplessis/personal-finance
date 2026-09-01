/* ============================================================
   add-transaction.js — Add / Edit form (async)
   ============================================================ */

let selectedType     = 'expense';
let selectedCategory = '';
let editId           = null;
let _txTags          = [];   /* kept only to preserve tags already on a tx (e.g. the internal 'subscription' marker) through an edit — tags are no longer user-editable */
let _allTx           = [];   /* history, for category suggestions */
let returnTo         = '/transactions';   /* where to go after edit/delete */

/* Embed mode: the form is loaded inside the site-wide Add-Transaction modal
   (add-modal.js) via an iframe with ?embed=1. On save/delete we post back to the
   parent so it closes the popup and refreshes, instead of navigating away. */
const EMBED = new URLSearchParams(window.location.search).get('embed') === '1';
function closeEmbed(action) {
  try { window.parent.postMessage({ type: 'pf:tx-changed', action }, window.location.origin); } catch (_) {}
}

async function initForm() {
  const params = new URLSearchParams(window.location.search);
  editId       = params.get('id');
  returnTo     = params.get('from') || '/transactions';
  if (/^(https?:)?\/\//i.test(returnTo)) returnTo = '/transactions';   /* internal only */

  await populateAccountSelects();
  await renderCategoryPicker();
  TransactionStore.getAll().then(txs => { _allTx = txs; }).catch(() => {});

  if (editId) {
    const tx = await TransactionStore.getById(editId);
    if (tx) await prefillForm(tx);
    document.getElementById('formTitle').textContent   = 'Edit Transaction';
    document.getElementById('submitBtn').textContent   = 'Save Changes';
    document.getElementById('deleteBtn').style.display = 'inline-flex';
  }

  const dateInput = document.getElementById('txDate');
  if (dateInput && !dateInput.value) dateInput.value = todayISO();

  renderTemplates();
}

async function populateAccountSelects() {
  const accounts = await AccountStore.getAll();
  const sel      = document.getElementById('txAccount');
  const toSel    = document.getElementById('txToAccount');
  const opts     = accounts.length
    ? accounts.map(a => `<option value="${a.id}">${escapeHTML(a.name)}</option>`).join('')
    : `<option value="">No accounts — create one first</option>`;
  if (sel)   sel.innerHTML   = opts;
  if (toSel) toSel.innerHTML = opts;

  /* preselect the user's default account for a *new* transaction */
  const defId = AccountStore.getDefaultId();
  if (sel && !editId && defId && accounts.some(a => a.id === defId)) sel.value = defId;

  const tip = document.getElementById('noAccountTip');
  if (tip) tip.style.display = accounts.length ? 'none' : 'block';
  /* both selects ship data-loading, so the "No accounts — create one first"
     placeholder can't flash before we actually know there are none */
  ['txAccount', 'txToAccount'].forEach(clearFieldLoading);
}

async function renderCategoryPicker() {
  const container = document.getElementById('categoryPicker');
  if (!container) return;
  const cats = selectedType === 'transfer'
    ? []
    : await CategoryStore.getByType(selectedType);
  container.innerHTML = cats.map(c => `
    <button type="button" class="category-btn${selectedCategory === c.id ? ' selected' : ''}" data-cat="${c.id}">
      <span class="cat-icon">${categoryIconHTML(c, 22)}</span>
      <span>${escapeHTML(c.name)}</span>
    </button>
  `).join('') + (selectedType === 'transfer' ? '' : `
    <button type="button" class="category-btn category-btn--new" id="newCatBtn" title="Create a custom category">
      <span class="cat-icon">＋</span>
      <span>New</span>
    </button>
  `);
  container.querySelectorAll('.category-btn[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => { selectedCategory = btn.dataset.cat; renderCategoryPicker(); });
  });
  document.getElementById('newCatBtn')?.addEventListener('click', openNewCatModal);
  updateCategorySuggestion();
  updateBudgetHint();
}

/* Show how this expense lands against the selected category's monthly budget
   (if one is set). Runs on category/amount/type change. */
async function updateBudgetHint() {
  const el = document.getElementById('budgetHint');
  if (!el || typeof BudgetStore === 'undefined') return;
  if (selectedType !== 'expense' || !selectedCategory) { el.hidden = true; el.textContent = ''; return; }
  const monthKey = todayISO().slice(0, 7);
  let limit = 0;
  try { limit = (BudgetStore.getMonth(monthKey) || {})[selectedCategory] || 0; } catch (_) {}
  if (!limit) { el.hidden = true; el.textContent = ''; return; }
  const prefix = monthKey + '-';
  const amount = parseFloat(document.getElementById('txAmount')?.value) || 0;
  const priorSpent = _allTx
    .filter(t => t.type === 'expense' && t.categoryId === selectedCategory && t.date.startsWith(prefix) && t.id !== editId)
    .reduce((s, t) => s + t.amount, 0);
  const after = priorSpent + amount;
  const pct   = Math.round((after / limit) * 100);
  const over  = after > limit;
  el.hidden = false;
  el.style.color = over ? 'var(--color-expense)' : (pct >= 80 ? 'var(--color-transfer)' : 'var(--color-text-muted)');
  el.innerHTML = `At <strong>${pct}%</strong> of its ${formatCurrency(limit)} monthly budget${over ? ` — <strong>${formatCurrency(after - limit)} over</strong>` : ''}.`;
}

/* Suggest a category from the user's own history as they type the note
   (no AI, no network). Shown only when nothing is picked yet. */
async function updateCategorySuggestion() {
  const el = document.getElementById('catSuggestion');
  if (!el || typeof InsightsEngine === 'undefined') return;
  const note = document.getElementById('txNote')?.value || '';
  if (selectedType === 'transfer' || selectedCategory || !note.trim()) {
    el.hidden = true; el.innerHTML = ''; return;
  }
  const s = InsightsEngine.suggestCategory(note, _allTx, { type: selectedType });
  if (!s) { el.hidden = true; el.innerHTML = ''; return; }
  const cat = await CategoryStore.getById(s.categoryId);
  if (!cat) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `
    <span class="cat-suggestion__label">From your history</span>
    <button type="button" class="cat-suggestion__chip" data-cat="${s.categoryId}">
      <span class="cat-icon">${categoryIconHTML(cat, 15)}</span>${escapeHTML(cat.name)}
    </button>`;
  el.querySelector('.cat-suggestion__chip')?.addEventListener('click', () => {
    selectedCategory = s.categoryId;
    renderCategoryPicker();
  });
}

/* ---- quick custom category from the picker ---- */
function openNewCatModal() {
  const modal = document.getElementById('newCatModal');
  if (!modal) return;
  document.getElementById('quickCatName').value = '';
  document.getElementById('quickCatTypeHint').textContent =
    `Will be created as ${selectedType === 'income' ? 'an income' : 'an expense'} category. Manage categories in Settings.`;
  renderIconPicker(document.getElementById('quickCatEmojiRow'), document.getElementById('quickCatIcon'));
  modal.classList.add('open');
  document.getElementById('quickCatName').focus();
}

async function saveQuickCat() {
  const name = document.getElementById('quickCatName')?.value.trim().slice(0, 30);
  const lucide = document.getElementById('quickCatIcon')?.value.trim() || 'tag';
  if (!name) { showToast('Enter a category name', 'error'); return; }

  const all = await CategoryStore.getAll();
  if (all.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    showToast(`A category named “${name}” already exists`, 'error');
    return;
  }

  const btn = document.getElementById('saveNewCat');
  btn.disabled = true;
  try {
    const cats = await SettingsStore.getCustomCategories();
    const cat = { id: 'custom-' + Date.now().toString(36), name, lucide, type: selectedType === 'income' ? 'income' : 'expense' };
    cats.push(cat);
    await SettingsStore.setCustomCategories(cats);
    selectedCategory = cat.id;
    document.getElementById('newCatModal')?.classList.remove('open');
    await renderCategoryPicker();
    showToast(`${name} created`, 'success');
  } catch (err) {
    showToast(err.message || 'Failed to create category', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function prefillForm(tx) {
  setValue('txAmount',    tx.amount);
  setValue('txDate',      tx.date);
  setValue('txNote',      tx.note);
  setValue('txAccount',   tx.accountId);
  setValue('txToAccount', tx.toAccountId || '');
  selectedCategory = tx.categoryId || '';
  _txTags          = Array.isArray(tx.tags) ? [...tx.tags] : [];
  setType(tx.type);
}

/* ---- transaction templates (device-local quick re-logging) ---- */
function renderTemplates() {
  const row   = document.getElementById('tplRow');
  const chips = document.getElementById('tplChips');
  if (!row || !chips || typeof TxTemplateStore === 'undefined') return;
  const list = TxTemplateStore.getAll();
  row.style.display = list.length ? '' : 'none';
  chips.innerHTML = list.map(t => `
    <span class="tpl-chip" style="display:inline-flex;align-items:center;gap:2px;">
      <button type="button" class="btn btn--ghost btn--sm tpl-chip__use" data-id="${escapeHTML(t.id)}">${escapeHTML(t.name)}</button>
      <button type="button" class="btn btn--ghost btn--sm tpl-chip__del" data-id="${escapeHTML(t.id)}" aria-label="Remove ${escapeHTML(t.name)}" style="padding:4px 8px;">×</button>
    </span>`).join('');
  chips.querySelectorAll('.tpl-chip__use').forEach(b =>
    b.addEventListener('click', () => applyTemplate(list.find(t => t.id === b.dataset.id))));
  chips.querySelectorAll('.tpl-chip__del').forEach(b =>
    b.addEventListener('click', async () => {
      if (window.confirmDialog && !(await window.confirmDialog('Remove this template?', { confirmText: 'Remove' }))) return;
      TxTemplateStore.remove(b.dataset.id);
      renderTemplates();
    }));
}

function applyTemplate(tpl) {
  if (!tpl) return;
  setType(tpl.type || 'expense');            /* re-renders the category picker */
  setValue('txAmount', tpl.amount || '');
  setValue('txNote',   tpl.note   || '');
  if (tpl.accountId)   setValue('txAccount',   tpl.accountId);
  if (tpl.toAccountId) setValue('txToAccount', tpl.toAccountId);
  selectedCategory = tpl.categoryId || '';
  _txTags          = Array.isArray(tpl.tags) ? [...tpl.tags] : [];
  renderCategoryPicker();                     /* reflect the picked category */
  document.getElementById('txAmount')?.focus();
}

async function saveCurrentAsTemplate() {
  if (typeof TxTemplateStore === 'undefined') return;
  const defName = document.getElementById('txNote')?.value.trim() || '';
  const name = ((window.promptDialog
    ? await window.promptDialog('Name this template (e.g. “Coffee”):', defName, { confirmText: 'Save', maxlength: 40 })
    : window.prompt('Name this template:', defName)) || '').trim().slice(0, 40);
  if (!name) return;
  TxTemplateStore.save({
    name,
    type:        selectedType,
    amount:      parseFloat(document.getElementById('txAmount').value) || 0,
    note:        document.getElementById('txNote').value.trim(),
    accountId:   document.getElementById('txAccount').value || null,
    toAccountId: document.getElementById('txToAccount')?.value || null,
    categoryId:  selectedCategory || null,
    tags:        [..._txTags],
  });
  renderTemplates();
  showToast(`Template “${name}” saved`, 'success');
}

function setType(type) {
  selectedType = type;
  document.querySelectorAll('.type-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.type === type));
  const toGroup = document.getElementById('toAccountGroup');
  if (toGroup) toGroup.style.display = type === 'transfer' ? 'flex' : 'none';
  renderCategoryPicker();
}

function validateForm() {
  const amount    = parseFloat(document.getElementById('txAmount')?.value);
  const accountId = document.getElementById('txAccount')?.value;
  clearErrors();
  let valid = true;
  if (!amount || amount <= 0) { showError('txAmount', 'Enter a valid amount greater than 0'); valid = false; }
  if (!accountId)             { showError('txAccount', 'Select an account'); valid = false; }
  if (selectedType === 'transfer') {
    const toId = document.getElementById('txToAccount')?.value;
    if (!toId) {
      showError('txToAccount', 'Select a destination account'); valid = false;
    } else if (toId === accountId) {
      showError('txToAccount', 'Choose a different destination account'); valid = false;
    }
  }
  return valid;
}

function showError(fieldId, message) {
  const field = document.getElementById(fieldId);
  if (!field) return;
  field.classList.add('form-control--error');
  const err = document.createElement('div');
  err.className = 'form-error'; err.textContent = message;
  const container = field.closest('.form-group') || field.parentNode;
  container.appendChild(err);
}
function clearErrors() {
  document.querySelectorAll('.form-control--error').forEach(el => el.classList.remove('form-control--error'));
  document.querySelectorAll('.form-error').forEach(el => el.remove());
}
function setValue(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
function todayISO() { return isoLocal(new Date()); }

function showSaveSuccess() {
  const actions = document.getElementById('formActions');
  if (!actions) { setTimeout(() => window.location.href = '/transactions', 500); return; }
  actions.innerHTML = `
    <div class="save-success">
      <div class="save-success__icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <span class="save-success__label">Transaction saved!</span>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <a href="/transactions" class="btn btn--ghost" style="flex:1;justify-content:center;">View Transactions</a>
      <button type="button" class="btn btn--primary" id="addAnotherBtn" style="flex:1;">Add Another</button>
    </div>
  `;
  document.getElementById('addAnotherBtn')?.addEventListener('click', () => {
    selectedType     = 'expense';
    selectedCategory = '';
    _txTags          = [];
    document.getElementById('txForm')?.reset();
    setType('expense');
    document.getElementById('txDate').value = todayISO();
    actions.innerHTML = `
      <button type="submit" class="btn btn--primary" id="submitBtn" style="flex:1;">Add Transaction</button>
      <button type="button" class="btn btn--danger btn--sm" id="deleteBtn" style="display:none;">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        Delete
      </button>
    `;
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await SupaAuth.requireAuth();
  if (!user) return;
  await SettingsStore.hydrateLocalDefaults();   /* pull synced default account */
  try { await BudgetStore.load(); } catch (_) {}   /* for the add-time budget hint */
  /* Set currency prefix */
  SettingsStore.getCurrency().then(c => {
    const prefixEl = document.getElementById('currencyPrefix');
    const amountEl = document.getElementById('txAmount');
    if (!prefixEl) return;
    try {
      /* Use formatCurrency()'s locale so CAD shows "$", not the en-US "CA$". */
      const locale = (typeof CURRENCY_LOCALES !== 'undefined' && CURRENCY_LOCALES[c]) || 'en-CA';
      const sym = (0).toLocaleString(locale, { style: 'currency', currency: c, minimumFractionDigits: 0 }).replace(/[\d,.\s]/g, '').trim();
      prefixEl.textContent = sym || '$';
    } catch { prefixEl.textContent = '$'; }

    /* Pad the input to clear the prefix's real width — a fixed padding
       overlaps multi-char symbols (CA$, US$) as you type, esp. on mobile. */
    const syncPad = () => {
      if (!amountEl) return;
      amountEl.style.paddingLeft = `${Math.ceil(prefixEl.offsetLeft + prefixEl.getBoundingClientRect().width + 8)}px`;
    };
    syncPad();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncPad);
  });

  try {
    await initForm();
  } catch (err) {
    console.error('Form error:', err);
    showToast('Error loading form: ' + err.message, 'error');
    /* hand the fields back and clear the category placeholders */
    clearFieldLoading();
    const picker = document.getElementById('categoryPicker');
    if (picker) picker.innerHTML = '';
  }

  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => setType(btn.dataset.type));
  });

  /* suggest a category from history as the note is typed */
  let _suggestTimer;
  document.getElementById('txNote')?.addEventListener('input', () => {
    clearTimeout(_suggestTimer);
    _suggestTimer = setTimeout(updateCategorySuggestion, 220);
  });

  /* refresh the budget hint as the amount changes */
  document.getElementById('txAmount')?.addEventListener('input', () => { updateBudgetHint(); });

  /* transaction templates */
  document.getElementById('saveTemplateBtn')?.addEventListener('click', saveCurrentAsTemplate);

  /* quick new-category modal */
  document.getElementById('saveNewCat')?.addEventListener('click', saveQuickCat);
  document.getElementById('quickCatName')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveQuickCat(); }
  });
  document.getElementById('cancelNewCat')?.addEventListener('click', () => document.getElementById('newCatModal')?.classList.remove('open'));
  document.getElementById('closeNewCatModal')?.addEventListener('click', () => document.getElementById('newCatModal')?.classList.remove('open'));

  document.getElementById('txForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!validateForm()) return;
    const btn = document.getElementById('submitBtn');
    btn.classList.add('btn--loading');
    btn.disabled = true;
    try {
      const data = {
        amount:      parseFloat(document.getElementById('txAmount').value),
        date:        document.getElementById('txDate').value,
        note:        document.getElementById('txNote').value.trim(),
        accountId:   document.getElementById('txAccount').value,
        toAccountId: document.getElementById('txToAccount')?.value || null,
        categoryId:  selectedCategory,
        type:        selectedType,
        tags:        [..._txTags],
      };
      if (editId) {
        await TransactionStore.update(editId, data);
        showToast('Transaction updated', 'success');
        if (EMBED) { closeEmbed('saved'); return; }
        setTimeout(() => window.location.href = returnTo, 500);
      } else {
        await TransactionStore.add(data);
        if (EMBED) { closeEmbed('saved'); return; }
        showSaveSuccess();
      }
    } catch (err) {
      showToast(err.message || 'Something went wrong', 'error');
      btn.classList.remove('btn--loading');
      btn.disabled = false;
    }
  });

  document.getElementById('deleteBtn')?.addEventListener('click', () => {
    if (!editId) return;
    const modal = document.getElementById('deleteTxModal');
    if (!modal) { return; }
    modal.classList.add('open');
    document.getElementById('confirmTxDelete').onclick = async () => {
      const btn = document.getElementById('confirmTxDelete');
      btn.classList.add('btn--loading'); btn.disabled = true;
      try {
        await TransactionStore.delete(editId);
        showToast('Transaction deleted', 'success');
        if (EMBED) { closeEmbed('deleted'); return; }
        setTimeout(() => window.location.href = returnTo, 500);
      } catch (err) {
        showToast(err.message || 'Failed to delete', 'error');
        btn.classList.remove('btn--loading'); btn.disabled = false;
        modal.classList.remove('open');
      }
    };
    document.getElementById('cancelTxDelete')?.addEventListener('click', () => modal.classList.remove('open'), { once: true });
    document.getElementById('closeTxDeleteModal')?.addEventListener('click', () => modal.classList.remove('open'), { once: true });
  });

  document.getElementById('cancelBtn')?.addEventListener('click', () => {
    history.length > 1 ? history.back() : window.location.href = '/transactions';
  });
});
