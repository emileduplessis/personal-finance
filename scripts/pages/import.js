/* ============================================================
   import.js — guided bank-statement CSV importer.
   Wrapped in an IIFE so its locals never collide with store.js
   globals (see project note on the stub-harness missing clashes).
   ============================================================ */
(function () {
  'use strict';

  const MAX_RENDER = 150;   /* cap rows drawn in the preview table (all still import) */

  const state = {
    header: [],
    rows: [],            /* raw string[][] */
    accounts: [],
    cats: [],
    existingKeys: new Set(),
    allTx: [],           /* for history-based category suggestions */
    accountId: null,
    parsed: [],          /* [{ date, note, amount, type, categoryId, dup, include, ok }] */
    catOptionsHTML: '',
  };

  const $ = id => document.getElementById(id);

  /* ---------- step navigation ---------- */
  const STEP_SECTIONS = { 1: 'step1', 2: 'step2', 3: 'step3', done: 'stepDone' };
  function showStep(n) {
    Object.values(STEP_SECTIONS).forEach(id => $(id)?.classList.add('imp-hidden'));
    $(STEP_SECTIONS[n])?.classList.remove('imp-hidden');
    const cur = typeof n === 'number' ? n : 4;   /* 'done' sits past step 3 */
    document.querySelectorAll('.imp-step').forEach(el => {
      const s = Number(el.dataset.stepInd);
      el.classList.toggle('is-active', s === cur);
      el.classList.toggle('is-done', s < cur);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------- helpers ---------- */
  const norm = s => String(s || '').toLowerCase().trim();
  const dupKey = (accId, date, amount, note) => `${accId}|${date}|${Number(amount).toFixed(2)}|${norm(note)}`;

  function colOptions(selectedIdx, { allowNone = false } = {}) {
    let html = allowNone ? `<option value="-1">— None —</option>` : '';
    html += state.header.map((h, i) =>
      `<option value="${i}"${i === selectedIdx ? ' selected' : ''}>${escapeHTML(h || `Column ${i + 1}`)}</option>`).join('');
    return html;
  }

  /* ---------- STEP 1: load ---------- */
  async function loadAccounts() {
    const sel = $('impAccount');
    /* sel ships data-loading so it shimmers instead of showing "No accounts"
       while the account list is still on the wire */
    try { state.accounts = await AccountStore.getAll(); }
    finally { clearFieldLoading(sel); }
    if (!state.accounts.length) {
      sel.innerHTML = `<option value="">No accounts</option>`;
      $('impNoAccount').style.display = 'block';
      $('impLoadBtn').disabled = true;
      return;
    }
    sel.innerHTML = state.accounts.map(a => `<option value="${a.id}">${escapeHTML(a.name)}</option>`).join('');
    const defId = AccountStore.getDefaultId?.();
    if (defId && state.accounts.some(a => a.id === defId)) sel.value = defId;
  }

  async function handleLoad() {
    const file = $('impFile').files?.[0];
    if (!file) { showToast('Choose a CSV file first', 'error'); return; }
    state.accountId = $('impAccount').value || state.accounts[0]?.id;
    if (!state.accountId) { showToast('Create an account first', 'error'); return; }

    const btn = $('impLoadBtn');
    btn.classList.add('btn--loading'); btn.disabled = true;
    try {
      const text = await file.text();
      const { header, rows } = CSVService.splitRows(text);
      if (!rows.length) throw new Error('That file has no data rows.');
      state.header = header;
      state.rows = rows;

      /* load categories + existing tx once, for suggestions & dedupe */
      const [cats, allTx] = await Promise.all([CategoryStore.getAll(), TransactionStore.getAll()]);
      state.cats = cats;
      state.allTx = allTx;
      state.existingKeys = new Set(allTx.map(t => dupKey(t.accountId, t.date, t.amount, t.note)));
      state.catOptionsHTML = `<option value="">Uncategorized</option>` +
        cats.map(c => `<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');

      buildMappingUI();
      showStep(2);
    } catch (err) {
      showToast(err.message || 'Could not read that file', 'error');
    } finally {
      btn.classList.remove('btn--loading'); btn.disabled = false;
    }
  }

  /* ---------- STEP 2: mapping ---------- */
  function buildMappingUI() {
    const det = CSVService.autoDetect(state.header);

    $('mapDate').innerHTML   = colOptions(det.dateIdx);
    $('mapDesc').innerHTML   = colOptions(det.descIdx);
    $('mapAmount').innerHTML = colOptions(det.amountIdx);
    $('mapDebit').innerHTML  = colOptions(det.debitIdx, { allowNone: true });
    $('mapCredit').innerHTML = colOptions(det.creditIdx, { allowNone: true });

    /* stash the detected type column (our own export) for parse time */
    state._typeIdx = det.typeIdx;

    const dc = det.mode === 'debitcredit';
    setAmountMode(dc ? 'debitcredit' : 'signed');

    const named = i => i >= 0 ? `“${state.header[i] || 'Column ' + (i + 1)}”` : null;
    const bits = [named(det.dateIdx) && `date ${named(det.dateIdx)}`,
                  named(det.descIdx) && `description ${named(det.descIdx)}`,
                  dc ? 'separate debit/credit columns' : (named(det.amountIdx) && `amount ${named(det.amountIdx)}`)]
                  .filter(Boolean);
    $('impDetectNote').textContent = bits.length
      ? `Auto-detected ${bits.join(', ')}. Change anything that looks wrong.`
      : `Couldn’t confidently detect the columns — please pick them below.`;
  }

  function setAmountMode(mode) {
    document.querySelectorAll('[data-amode]').forEach(b => b.classList.toggle('active', b.dataset.amode === mode));
    $('mapSignedWrap').classList.toggle('imp-hidden', mode !== 'signed');
    $('mapDCWrap').classList.toggle('imp-hidden', mode !== 'debitcredit');
    state._amode = mode;
  }

  /* ---------- STEP 2 → 3: parse rows ---------- */
  function buildPreview() {
    const dateIdx = +$('mapDate').value;
    const descIdx = +$('mapDesc').value;
    const mode    = state._amode;
    const amtIdx  = +$('mapAmount').value;
    const debIdx  = +$('mapDebit').value;
    const creIdx  = +$('mapCredit').value;
    const signPos = $('mapSign').value === 'pos';    /* expenses shown as positive */
    const fmt     = $('mapDateFmt').value;
    const dayFirst = fmt === 'dmy';
    const typeIdx = state._typeIdx;

    if (mode === 'signed' && !(amtIdx >= 0)) { showToast('Pick the amount column', 'error'); return false; }
    if (mode === 'debitcredit' && debIdx < 0 && creIdx < 0) { showToast('Pick a debit or credit column', 'error'); return false; }

    const cell = (row, i) => (i >= 0 && i < row.length ? String(row[i] || '').trim() : '');
    const parsed = [];

    for (const row of state.rows) {
      const note = cell(row, descIdx);
      const date = CSVService.parseDate(cell(row, dateIdx), dayFirst);
      let amount = NaN, type = 'expense';

      if (mode === 'debitcredit') {
        const deb = debIdx >= 0 ? CSVService.parseAmount(cell(row, debIdx)) : NaN;
        const cre = creIdx >= 0 ? CSVService.parseAmount(cell(row, creIdx)) : NaN;
        if (!isNaN(deb) && Math.abs(deb) > 0)      { amount = Math.abs(deb); type = 'expense'; }
        else if (!isNaN(cre) && Math.abs(cre) > 0) { amount = Math.abs(cre); type = 'income'; }
      } else {
        /* our own export carries an explicit type column — honour it */
        const explicit = typeIdx >= 0 ? cell(row, typeIdx).toLowerCase() : '';
        const n = CSVService.parseAmount(cell(row, amtIdx));
        if (!isNaN(n)) {
          amount = Math.abs(n);
          if (['income', 'expense', 'transfer'].includes(explicit)) type = explicit;
          else type = signPos ? (n > 0 ? 'expense' : 'income') : (n < 0 ? 'expense' : 'income');
        }
      }

      const ok = !!date && !isNaN(amount) && amount > 0;
      let categoryId = null;
      if (ok && type !== 'transfer' && typeof InsightsEngine !== 'undefined') {
        const s = InsightsEngine.suggestCategory(note, state.allTx, { type });
        if (s && s.categoryId) categoryId = s.categoryId;
      }
      const dup = ok && state.existingKeys.has(dupKey(state.accountId, date, amount, note));
      parsed.push({ date, note, amount, type, categoryId, ok, dup, include: ok && !dup });
    }

    state.parsed = parsed;
    renderPreview();
    return true;
  }

  function renderPreview() {
    const rows = state.parsed;
    const okRows  = rows.filter(r => r.ok);
    const dupRows = okRows.filter(r => r.dup);
    const badRows = rows.length - okRows.length;

    const tbody = $('impRows');
    const render = okRows.slice(0, MAX_RENDER);
    tbody.innerHTML = render.map((r) => {
      const gi = rows.indexOf(r);
      const amtCls = r.type === 'income' ? 'imp-amt--inc' : 'imp-amt--exp';
      const sign = r.type === 'income' ? '+' : '−';
      return `<tr class="${r.dup ? 'is-dup' : ''}" data-i="${gi}">
        <td><input type="checkbox" class="imp-row-chk" data-i="${gi}" ${r.include ? 'checked' : ''} /></td>
        <td>${escapeHTML(r.date)}</td>
        <td title="${escapeHTML(r.note)}">${escapeHTML(r.note.slice(0, 42))}${r.dup ? '<span class="imp-dup-badge">dup</span>' : ''}</td>
        <td class="imp-amt ${amtCls}">${sign}${formatCurrency(r.amount)}</td>
        <td><select class="form-control imp-cat-select" data-i="${gi}">${state.catOptionsHTML}</select></td>
      </tr>`;
    }).join('');

    /* set each select to its suggested category */
    tbody.querySelectorAll('.imp-cat-select').forEach(sel => {
      const r = rows[+sel.dataset.i];
      sel.value = r.categoryId || '';
      sel.addEventListener('change', () => { r.categoryId = sel.value || null; });
    });
    tbody.querySelectorAll('.imp-row-chk').forEach(chk => {
      chk.addEventListener('change', () => { rows[+chk.dataset.i].include = chk.checked; refreshCounts(); });
    });

    $('impMoreRows').textContent = okRows.length > MAX_RENDER
      ? `Showing the first ${MAX_RENDER} of ${okRows.length} rows. Category guesses apply to the rest; you can edit them after import.`
      : '';
    $('impReviewNote').innerHTML = dupRows.length
      ? `<strong>${dupRows.length}</strong> row(s) look like transactions you already have in this account — they’re unchecked so you don’t double-count. Check them if you want them anyway.`
      : `Categories were guessed from your history where possible. Adjust any before importing.`;

    refreshCounts();
  }

  function refreshCounts() {
    const rows = state.parsed;
    const toImport = rows.filter(r => r.ok && r.include).length;
    const dup = rows.filter(r => r.ok && r.dup).length;
    const bad = rows.filter(r => !r.ok).length;
    $('sumImport').textContent = toImport;
    $('sumDup').textContent = dup;
    $('sumSkip').textContent = bad;
    $('impCommit').disabled = toImport === 0;
    $('impCommit').textContent = `Import ${toImport} transaction${toImport === 1 ? '' : 's'}`;
  }

  /* ---------- STEP 3: commit ---------- */
  async function commit() {
    const chosen = state.parsed.filter(r => r.ok && r.include);
    if (!chosen.length) { showToast('Nothing selected', 'error'); return; }
    const btn = $('impCommit');
    btn.classList.add('btn--loading'); btn.disabled = true;
    try {
      const payload = chosen.map(r => ({
        date: r.date, amount: r.amount, type: r.type,
        note: r.note, categoryId: r.categoryId || null,
        accountId: state.accountId, tags: ['imported'],
      }));
      const added = await TransactionStore.bulkAdd(payload);
      $('impDoneMsg').textContent = `Imported ${added.length} transaction${added.length === 1 ? '' : 's'}`;
      showStep('done');
    } catch (err) {
      showToast(err.message || 'Import failed', 'error');
      btn.classList.remove('btn--loading'); btn.disabled = false;
    }
  }

  /* ---------- wire up ---------- */
  document.addEventListener('DOMContentLoaded', async () => {
    const user = await SupaAuth.requireAuth();
    if (!user) return;
    try { await SettingsStore.hydrateLocalDefaults(); } catch (_) {}
    await loadAccounts();

    $('impFile').addEventListener('change', () => {
      const f = $('impFile').files?.[0];
      $('impFileName').textContent = f ? f.name : '';
      $('impLoadBtn').disabled = !f || !state.accounts.length;
    });
    $('impLoadBtn').addEventListener('click', handleLoad);

    document.querySelectorAll('[data-amode]').forEach(b =>
      b.addEventListener('click', () => setAmountMode(b.dataset.amode)));
    $('impBackTo1').addEventListener('click', () => showStep(1));
    $('impToReview').addEventListener('click', () => { if (buildPreview()) showStep(3); });

    $('impBackTo2').addEventListener('click', () => showStep(2));
    $('impCheckAll').addEventListener('change', e => {
      const on = e.target.checked;
      state.parsed.forEach(r => { if (r.ok) r.include = on; });
      $('impRows').querySelectorAll('.imp-row-chk').forEach(c => { c.checked = on; });
      refreshCounts();
    });
    $('impCommit').addEventListener('click', commit);

    $('impAnother').addEventListener('click', () => {
      state.parsed = []; state.rows = []; state.header = [];
      $('impFile').value = ''; $('impFileName').textContent = '';
      $('impLoadBtn').disabled = true;
      showStep(1);
    });
  });
})();
