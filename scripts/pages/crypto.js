/* ============================================================
   crypto.js (page) — read-only crypto portfolio.
   Public addresses only; never handles keys/seeds. See
   scripts/data/crypto.js for the security model and storage.
   ============================================================ */

function sparklineSVG(values, w = 120, h = 48) {
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) =>
    `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / range) * (h - 4)).toFixed(1)}`
  ).join(' ');
  const first = values[0], last = values[values.length - 1];
  const color = Math.abs(last - first) < 1e-9
    ? 'var(--color-text-muted)'
    : (last >= first ? 'var(--color-income)' : 'var(--color-expense)');
  return `<svg class="spark" width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function delta24hHTML(change24h) {
  if (change24h == null) return `<span class="delta delta--flat">· 24h</span>`;
  const cls = change24h >= 0 ? 'up' : 'down';
  return `<span class="delta delta--${cls}">${change24h >= 0 ? '▲ +' : '▼ −'}${Math.abs(change24h).toFixed(1)}% · 24h</span>`;
}

/* Account-style wallet tile (matches the dashboard) */
function cryptoTileHTML(r) {
  const w = r.wallet;
  const chain = CHAINS[w.chain] || { symbol: '?', label: w.chain, color: 'var(--color-text)' };
  let fiat, sub, foot;
  if (r.loading) {
    fiat = '…'; sub = ''; foot = '';
  } else if (r.error) {
    fiat = '—'; sub = `<span style="color:var(--color-expense)">lookup failed</span>`; foot = '';
  } else {
    fiat = r.fiat != null ? formatCurrency(r.fiat) : '—';
    const dec = CHAINS[w.chain]?.decimals ?? 8;
    const amt = `${r.amount != null ? r.amount.toFixed(dec).replace(/\.?0+$/, '') : '0'} ${chain.symbol}`;
    sub = r.stale ? `${amt} <span title="Live lookup failed — showing the last fetched balance.">· last known</span>` : amt;
    const sp = (r.sparkline && r.sparkline.length > 1) ? sparklineSVG(r.sparkline) : '';
    foot = sp;
  }
  const delta = (!r.loading && !r.error) ? delta24hHTML(r.change24h) : '';
  return `
    <div class="acct-tile crypto-acct-tile" style="--chain:${chain.color};" data-id="${w.id}">
      <div class="crypto-tile__actions">
        <button class="crypto-tile__edit" data-id="${w.id}" aria-label="Rename wallet">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        </button>
        <button class="crypto-tile__del" data-id="${w.id}" aria-label="Remove wallet">✕</button>
      </div>
      <div class="acct-tile__top">
        <span class="acct-tile__avatar">${chain.symbol}</span>
        <div class="acct-tile__id">
          <div class="acct-tile__name">${escapeHTML(w.label)}</div>
          <div class="acct-tile__type">${chain.label}</div>
        </div>
      </div>
      <div class="acct-tile__main">
        <div class="acct-tile__figures">
          <div class="acct-tile__bal font-display">${fiat}</div>
          <div class="acct-tile__sub">${sub}</div>
        </div>
        <div class="acct-tile__chartcol">
          <div class="acct-tile__chart">${foot}</div>
          ${delta}
        </div>
      </div>
    </div>`;
}

function renderHeroChange(items) {
  const el = document.getElementById('cryptoHeroChange');
  if (!el) return;
  let num = 0, den = 0;
  items.forEach(it => { if (it.fiat != null && it.change24h != null) { num += it.fiat * it.change24h; den += it.fiat; } });
  if (!den) { el.hidden = true; return; }
  const pct = num / den;
  el.hidden = false;
  el.className = 'delta ' + (pct >= 0 ? 'delta--up' : 'delta--down');
  el.textContent = `${pct >= 0 ? '▲ +' : '▼ −'}${Math.abs(pct).toFixed(1)}% · 24h`;
}

function renderAllocation(items) {
  const allocEl  = document.getElementById('cryptoAlloc');
  const legendEl = document.getElementById('cryptoLegend');
  if (!allocEl || !legendEl) return;

  const byChain = {};
  items.forEach(it => { if (it.fiat) byChain[it.wallet.chain] = (byChain[it.wallet.chain] || 0) + it.fiat; });
  const total = Object.values(byChain).reduce((s, v) => s + v, 0);
  if (!total) { allocEl.hidden = true; legendEl.hidden = true; return; }

  const entries = Object.entries(byChain).sort((a, b) => b[1] - a[1]);
  allocEl.hidden = false; legendEl.hidden = false;
  allocEl.innerHTML = entries.map(([chain, v]) => {
    const c = CHAINS[chain]?.color || 'var(--color-text-muted)';
    return `<span class="crypto-alloc__seg" style="width:${(v / total) * 100}%;background:${c};"></span>`;
  }).join('');
  legendEl.innerHTML = entries.map(([chain, v]) => {
    const pct = (v / total) * 100;
    const c = CHAINS[chain]?.color || 'var(--color-text-muted)';
    return `<span class="crypto-legend__item"><span class="crypto-legend__dot" style="background:${c};"></span>${CHAINS[chain]?.symbol || chain} ${pct.toFixed(pct < 10 ? 1 : 0)}%</span>`;
  }).join('');
}

async function renderCryptoPage() {
  const listEl  = document.getElementById('cryptoList');
  const totalEl = document.getElementById('cryptoTotal');
  const countEl = document.getElementById('cryptoWalletCount');
  const curEl   = document.getElementById('cryptoCurrency');
  if (!listEl) return;

  let wallets;
  try { wallets = await CryptoStore.getAll(); }
  catch (e) {
    listEl.innerHTML = `<div class="empty-state" style="grid-column:1/-1;background:var(--color-surface);color:var(--color-expense);padding:24px;">${escapeHTML(e.message || 'Failed to load wallets')}</div>`;
    /* the hero ships shimmer placeholders (crypto.html) — settle them too */
    totalEl.textContent = '—';
    countEl.textContent = 'wallets unavailable';
    return;
  }

  countEl.textContent = `${wallets.length} wallet${wallets.length === 1 ? '' : 's'}`;

  if (!wallets.length) {
    totalEl.textContent = formatCurrency(0);
    document.getElementById('cryptoHeroChange').hidden = true;
    document.getElementById('cryptoAlloc').hidden = true;
    document.getElementById('cryptoLegend').hidden = true;
    listEl.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;background:var(--color-surface);padding:36px 24px;text-align:center;">
        <div style="font-weight:600;color:var(--color-text);margin-bottom:6px;">No wallets yet</div>
        <div style="font-size:.8125rem;line-height:1.6;">Add a Bitcoin or Solana <strong>public address</strong> to see its live balance.</div>
      </div>`;
    return;
  }

  /* loading state */
  listEl.innerHTML = wallets.map(w => cryptoTileHTML({ wallet: w, loading: true })).join('');
  totalEl.textContent = '…';

  const snap = await CryptoBalances.snapshot(wallets);
  curEl.textContent = snap.currency;
  totalEl.textContent = formatCurrency(snap.total) + (snap.anyMissing ? ' +' : '');
  renderHeroChange(snap.items);
  renderAllocation(snap.items);
  listEl.innerHTML = snap.items.map(cryptoTileHTML).join('');
  wireTileActions(listEl);
}

function wireTileActions(container) {
  container.querySelectorAll('.crypto-tile__del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const w = (await CryptoStore.getAll()).find(x => x.id === btn.dataset.id);
      if (!w) return;
      if (!await confirmDialog(`Remove "${w.label}"? This only removes it from this view — your wallet and funds are untouched.`, { confirmText: "Remove" })) return;
      try {
        await CryptoStore.remove(btn.dataset.id);
        await renderCryptoPage();
        showToast('Wallet removed', 'success');
      } catch (e2) { showToast(e2.message || 'Failed to remove', 'error'); }
    });
  });

  /* inline rename: pencil → editable name input, save on Enter/blur */
  container.querySelectorAll('.crypto-tile__edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const nameEl = btn.closest('.acct-tile')?.querySelector('.acct-tile__name');
      if (!nameEl) return;
      const current = nameEl.textContent;
      const input = document.createElement('input');
      input.type = 'text'; input.value = current; input.maxLength = 32;
      input.className = 'crypto-rename-input';
      nameEl.replaceWith(input);
      input.focus(); input.select();

      let settled = false;
      const finish = async (commit) => {
        if (settled) return; settled = true;
        const next = input.value.trim();
        if (commit && next && next !== current) {
          try { await CryptoStore.update(id, { label: next }); showToast('Wallet renamed', 'success'); }
          catch (err) { showToast(err.message || 'Rename failed', 'error'); }
        }
        renderCryptoPage();
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        else if (ev.key === 'Escape') { finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    });
  });
}

function wireAddForm() {
  const toggle    = document.getElementById('cwToggle');
  const panel     = document.getElementById('cwPanel');
  const chainEl   = document.getElementById('cwChain');
  const labelEl   = document.getElementById('cwLabel');
  const addrEl    = document.getElementById('cwAddress');
  const errEl     = document.getElementById('cwError');
  const btcHintEl = document.getElementById('cwBtcHint');
  const addBtn    = document.getElementById('cwAddBtn');

  const showError = (msg) => { errEl.textContent = msg; errEl.style.display = msg ? '' : 'none'; };
  const syncHint  = () => { btcHintEl.style.display = chainEl.value === 'btc' ? '' : 'none'; };

  toggle.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) addrEl.focus();
  });
  chainEl.addEventListener('change', () => { syncHint(); showError(''); });
  addrEl.addEventListener('input', () => showError(''));
  syncHint();

  const submit = async () => {
    const chain = chainEl.value;
    const check = CryptoBalances.validateAddress(chain, addrEl.value);
    if (!check.ok) { showError(check.error); return; }
    addBtn.disabled = true;
    try {
      await CryptoStore.add({ label: labelEl.value, chain, addresses: [check.value] });
      labelEl.value = ''; addrEl.value = ''; showError('');
      panel.hidden = true; toggle.setAttribute('aria-expanded', 'false');
      await renderCryptoPage();
      showToast('Wallet added', 'success');
    } catch (e) {
      showError(e.message || 'Failed to add wallet');
    } finally {
      addBtn.disabled = false;
    }
  };

  addBtn.addEventListener('click', submit);
  addrEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await SupaAuth.requireAuth();
  if (!user) return;
  wireAddForm();
  renderCryptoPage();
  document.getElementById('cryptoRefresh')?.addEventListener('click', (e) => { e.preventDefault(); renderCryptoPage(); });
});
