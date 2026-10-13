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
    allTx: [],           /* for history-based category suggestions + dedupe */
    detect: null,        /* column roles from CSVService.analyze */
    bank: null,          /* recognised export, e.g. 'RBC' (label only) */
    isOFX: false,        /* QFX/OFX skips the column step entirely */
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
  const OFX_RE = /\.(ofx|qfx|qbo)$/i;

  /* Banks in Quebec still export Windows-1252; decoding that as UTF-8 turns
     "Épicerie" into "?picerie". Retry as 1252 when replacement chars appear. */
  async function readFileText(file) {
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('\uFFFD')) {
      try { text = new TextDecoder('windows-1252').decode(buf); } catch (_) {}
    }
    return text.replace(/^\uFEFF/, '');
  }

  /* Category for an imported row: an exact match from your own history wins,
     then a known merchant name, then a looser history match. (Bank strings
     share filler tokens like "POS PURCHASE", which make loose history matches
     noisy — so they go last.) */
  function suggestCategory(note, type) {
    if (type === 'transfer') return null;
    const hist = typeof InsightsEngine !== 'undefined'
      ? InsightsEngine.suggestCategory(note, state.allTx, { type }) : null;
    if (hist && hist.confidence === 'exact') return hist.categoryId;
    const known = CSVService.guessCategory(note, type);
    if (known && state.cats.some(c => c.id === known)) return known;
    return hist ? hist.categoryId : null;
  }

  /* categories + duplicate flags; unreadable and duplicate rows start unchecked */
  function enrich(parsed) {
    parsed.forEach(r => { r.categoryId = r.ok ? suggestCategory(r.note, r.type) : null; });
    CSVService.markDuplicates(parsed, state.allTx, state.accountId);
    parsed.forEach(r => { r.include = r.ok && !r.dup; });
    return parsed;
  }

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
    if (!file) { showToast('Choose a file first', 'error'); return; }
    state.accountId = $('impAccount').value || state.accounts[0]?.id;
    if (!state.accountId) { showToast('Create an account first', 'error'); return; }

    const btn = $('impLoadBtn');
    btn.classList.add('btn--loading'); btn.disabled = true;
    try {
      const text = await readFileText(file);
      state.isOFX = OFX_RE.test(file.name) || /<OFX>/i.test(text);

      /* load categories + existing tx once, for suggestions & dedupe */
      const [cats, allTx] = await Promise.all([CategoryStore.getAll(), TransactionStore.getAll()]);
      state.cats = cats;
      state.allTx = allTx;
      state.catOptionsHTML = `<option value="">Uncategorized</option>` +
        cats.map(c => `<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');

      if (state.isOFX) {
        /* OFX is self-describing (signed amounts, real dates) — no mapping step */
        const txs = CSVService.parseOFX(text);
        if (!txs.length) throw new Error('No transactions found in that file.');
        state.parsed = enrich(txs.map(t => ({
          date: t.date, note: t.note, amount: Math.abs(t.amount),
          type: t.amount < 0 ? 'expense' : 'income', ok: t.amount !== 0,
        })));
        renderPreview();
        showStep(3);
        return;
      }

      const a = CSVService.analyze(text);
      if (!a.rows.length) throw new Error('That file has no data rows.');
      state.header = a.header;
      state.rows = a.rows;
      state.detect = a.detect;
      state.bank = a.bank;
      state.headerless = a.headerless;

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
    const det = state.detect;

    $('mapDate').innerHTML   = colOptions(det.dateIdx);
    $('mapDesc').innerHTML   = colOptions(det.descIdx);
    $('mapDesc2').innerHTML  = colOptions(det.desc2Idx, { allowNone: true });
    $('mapAmount').innerHTML = colOptions(det.amountIdx);
    $('mapDebit').innerHTML  = colOptions(det.debitIdx, { allowNone: true });
    $('mapCredit').innerHTML = colOptions(det.creditIdx, { allowNone: true });

    const dc = det.mode === 'debitcredit';
    setAmountMode(dc ? 'debitcredit' : 'signed');
    guessSign();

    const named = i => i >= 0 ? `“${state.header[i] || 'Column ' + (i + 1)}”` : null;
    const bits = [named(det.dateIdx) && `date ${named(det.dateIdx)}`,
                  named(det.descIdx) && `description ${named(det.descIdx)}`,
                  dc ? 'separate debit/credit columns' : (named(det.amountIdx) && `amount ${named(det.amountIdx)}`)]
                  .filter(Boolean);
    const lead = state.bank ? `Looks like a ${state.bank} export. `
      : state.headerless ? `This file has no header row, so columns were read from the values. ` : '';
    $('impDetectNote').textContent = bits.length
      ? `${lead}Auto-detected ${bits.join(', ')}. Change anything that looks wrong.`
      : `Couldn’t confidently detect the columns — please pick them below.`;
  }

  /* pre-pick "Expenses appear as" from which sign dominates the amount column */
  function guessSign() {
    const i = +$('mapAmount').value;
    if (!(i >= 0)) return;
    $('mapSign').value = CSVService.guessExpensesPositive(state.rows.map(r => r[i])) ? 'pos' : 'neg';
  }

  function setAmountMode(mode) {
    document.querySelectorAll('[data-amode]').forEach(b => b.classList.toggle('active', b.dataset.amode === mode));
    $('mapSignedWrap').classList.toggle('imp-hidden', mode !== 'signed');
    $('mapDCWrap').classList.toggle('imp-hidden', mode !== 'debitcredit');
    state._amode = mode;
  }

  /* ---------- STEP 2 → 3: parse rows ---------- */
  function buildPreview() {
    const mode    = state._amode;
    const amtIdx  = +$('mapAmount').value;
    const debIdx  = +$('mapDebit').value;
    const creIdx  = +$('mapCredit').value;
    const dateIdx = +$('mapDate').value;
    const fmt     = $('mapDateFmt').value;

    if (mode === 'signed' && !(amtIdx >= 0)) { showToast('Pick the amount column', 'error'); return false; }
    if (mode === 'debitcredit' && debIdx < 0 && creIdx < 0) { showToast('Pick a debit or credit column', 'error'); return false; }

    const dayFirst = fmt === 'dmy' ? true : fmt === 'mdy' ? false
      : CSVService.guessDayFirst(state.rows.map(r => r[dateIdx]));

    state.parsed = enrich(CSVService.mapRows(state.rows, {
      dateIdx, descIdx: +$('mapDesc').value, desc2Idx: +$('mapDesc2').value,
      mode, amountIdx: amtIdx, debitIdx: debIdx, creditIdx: creIdx,
      /* our own export carries an explicit type column — honour it */
      typeIdx: mode === 'signed' ? state.detect.typeIdx : -1,
      expensesPositive: $('mapSign').value === 'pos', dayFirst,
    }));
    renderPreview();
    return true;
  }

  function dupBadge(r) {
    if (r.dup === 'exact') return '<span class="imp-dup-badge">dup</span>';
    if (r.dup !== 'likely') return '';
    const m = r.match || {};
    const tip = `Same amount as “${m.note || 'a transaction'}” on ${m.date || ''}`;
    return `<span class="imp-dup-badge" title="${escapeHTML(tip)}">logged?</span>`;
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
        <td title="${escapeHTML(r.note)}">${escapeHTML(r.note.slice(0, 42))}${dupBadge(r)}</td>
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
      ? `<strong>${dupRows.length}</strong> row(s) look like transactions you already have in this account: “dup” is an exact match, “logged?” is the same amount within 3 days (hover to see which). They’re unchecked so you don’t double-count — check any you want anyway.`
      : `Categories were guessed from your history and common store names. Adjust any before importing.`;

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

    $('impBackTo2').addEventListener('click', () => showStep(state.isOFX ? 1 : 2));
    $('mapAmount').addEventListener('change', guessSign);
    $('impCheckAll').addEventListener('change', e => {
      const on = e.target.checked;
      state.parsed.forEach(r => { if (r.ok) r.include = on; });
      $('impRows').querySelectorAll('.imp-row-chk').forEach(c => { c.checked = on; });
      refreshCounts();
    });
    $('impCommit').addEventListener('click', commit);

    $('impAnother').addEventListener('click', () => {
      state.parsed = []; state.rows = []; state.header = []; state.isOFX = false;
      $('impFile').value = ''; $('impFileName').textContent = '';
      $('impLoadBtn').disabled = true;
      showStep(1);
    });
  });
})();
