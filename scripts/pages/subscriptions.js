/* ============================================================
   subscriptions.js — Subscription / recurring-bill tracker
   ============================================================ */

const SUB_COLORS = ['#e8e8ec','#9a9aa4','#00d18f','#ff5c7a','#d4a64a','#5b8def','#8b5cf6','#67b7c9','#ec4899','#a3e635'];

const SUB_PRESETS = [
  { name: 'Netflix',         amount: 18.99, frequency: 'monthly', color: '#ff5c7a' },
  { name: 'Spotify',         amount: 11.99, frequency: 'monthly', color: '#00d18f' },
  { name: 'YouTube Premium', amount: 13.99, frequency: 'monthly', color: '#f97316' },
  { name: 'Disney+',         amount: 11.99, frequency: 'monthly', color: '#6366f1' },
  { name: 'Amazon Prime',    amount: 99,    frequency: 'yearly',  color: '#0ea5e9' },
  { name: 'iCloud+',         amount: 3.99,  frequency: 'monthly', color: '#8b5cf6' },
  { name: 'Gym',             amount: 35,    frequency: 'monthly', color: '#d4a64a' },
  { name: 'Phone plan',      amount: 45,    frequency: 'monthly', color: '#10b981' },
];
const FREQ_LABEL  = { monthly: 'Monthly', yearly: 'Yearly', weekly: 'Weekly' };
const FREQ_FACTOR = { monthly: 1, yearly: 1/12, weekly: 4.33 };

/* tax rates by region — only Quebec for now (GST 5% + QST 9.975%) */
const TAX_RATES = { qc: 0.14975 };

/* ---- helpers ---- */
function todayISO() { return isoLocal(new Date()); }

function applyTax(amount, region = 'qc') {
  return Math.round(amount * (1 + (TAX_RATES[region] || 0)) * 100) / 100;
}

function daysUntil(isoDate) {
  const now = new Date(); now.setHours(0,0,0,0);
  const d   = new Date(isoDate + 'T00:00:00');
  return Math.round((d - now) / 86400000);
}

function monthlyEquiv(sub) {
  return sub.amount * (FREQ_FACTOR[sub.frequency] || 1);
}

/* ---- auto-log due subscriptions ----
   Catch up: log every missed occurrence from nextDue through today in one
   pass (not one-per-visit), then persist the advanced next_due once. */
async function autoLogDue() {
  const today = todayISO();
  const due = (await SubscriptionStore.getDue()).filter(s => s.autoLog !== false);
  if (!due.length) return [];
  const logged = [];
  for (const sub of due) {
    let cursor = sub.nextDue;
    let count  = 0;
    const MAX  = 120;   /* safety cap against a malformed-frequency date loop */
    while (cursor && cursor <= today && count < MAX) {
      try {
        await TransactionStore.add({
          date:       cursor,
          amount:     sub.amount,
          type:       'expense',
          categoryId: sub.categoryId || null,
          accountId:  sub.accountId  || null,
          note:       sub.name,
          tags:       ['subscription'],
        });
      } catch (_) { break; }
      count++;
      const next = advanceDate(cursor, sub.frequency);
      if (!next || next <= cursor) { cursor = next || cursor; break; }   /* can't advance → stop */
      cursor = next;
    }
    if (count > 0) {
      try { await SubscriptionStore.setNextDue(sub.id, cursor); } catch (_) {}
      logged.push(count > 1 ? `${sub.name} ×${count}` : sub.name);
    }
  }
  return logged;
}

/* ---- render stats ---- */
function renderStats(subs) {
  const active  = subs.filter(s => s.active !== false);
  const monthly = active.reduce((s, sub) => s + monthlyEquiv(sub), 0);
  const yearly  = monthly * 12;
  const today   = todayISO();
  const dueThisMonth = active.filter(s => {
    if (!s.nextDue) return false;
    return s.nextDue.slice(0, 7) === today.slice(0, 7);
  }).length;

  setText('statMonthly', formatCurrency(monthly));
  setText('statYearly',  formatCurrency(yearly));
  setText('statActive',  active.length);
  setText('statDue',     dueThisMonth);
}

/* ---- render subscription row ---- */
function subRowHTML(sub, paused) {
  const days   = daysUntil(sub.nextDue);
  const isOver = days < 0;
  const dueTxt = isOver
    ? `<span style="color:var(--color-expense);">${Math.abs(days)}d overdue</span>`
    : days === 0
      ? `<span style="color:#d4a64a;">Due today</span>`
      : days <= 7
        ? `<span style="color:#d4a64a;">In ${days}d</span>`
        : `<span style="color:var(--color-text-muted);">${formatDate(sub.nextDue)}</span>`;

  return `
    <div class="subs-row" data-id="${sub.id}">
      <div class="subs-row__dot" style="background:${sub.color || '#6366f1'};"></div>
      <div class="subs-row__info">
        <div class="subs-row__name">${escapeHTML(sub.name)}${paused ? ' <span class="subs-paused-badge">paused</span>' : ''}</div>
        <div class="subs-row__meta">${FREQ_LABEL[sub.frequency] || sub.frequency} · Next: ${dueTxt}</div>
      </div>
      <div class="subs-row__amount tx-amount--expense">−${formatCurrency(sub.amount)}</div>
      <div class="subs-row__actions">
        <button class="btn btn--ghost btn--sm sub-edit-btn" data-id="${sub.id}" title="Edit">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn btn--ghost btn--sm sub-toggle-btn" data-id="${sub.id}" title="${paused ? 'Resume' : 'Pause'}" aria-label="${paused ? 'Resume' : 'Pause'} ${escapeHTML(sub.name)}">
          ${paused
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 4 19 12 6 20 6 4"/></svg>`
            : `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="9" y1="5" x2="9" y2="19"/><line x1="15" y1="5" x2="15" y2="19"/></svg>`
          }
        </button>
        ${!paused && days <= 0
          ? `<button class="btn btn--primary btn--sm sub-log-btn" data-id="${sub.id}">Log</button>`
          : ''}
      </div>
    </div>`;
}

/* ---- render list ---- */
function renderList(subs) {
  const active = subs.filter(s => s.active !== false);
  const paused = subs.filter(s => s.active === false);

  const listEl   = document.getElementById('subsList');
  const pausedEl = document.getElementById('pausedList');
  const pausedCard = document.getElementById('pausedCard');

  if (listEl) {
    listEl.innerHTML = active.length
      ? active.sort((a,b) => a.nextDue.localeCompare(b.nextDue)).map(s => subRowHTML(s, false)).join('')
      : `<div style="padding:40px 24px;text-align:center;color:var(--color-text-muted);">
           <div style="margin-bottom:12px;opacity:.5;" aria-hidden="true">${typeof lucideSVG === 'function' ? lucideSVG('package', 28) : ''}</div>
           <div style="font-size:.9375rem;font-weight:600;color:var(--color-text);margin-bottom:6px;">No subscriptions yet</div>
           <div style="font-size:.8125rem;">Click <strong>Add subscription</strong> to track your first service.</div>
         </div>`;
  }

  if (pausedCard && pausedEl) {
    pausedCard.style.display = paused.length ? '' : 'none';
    pausedEl.innerHTML = paused.map(s => subRowHTML(s, true)).join('');
  }

  wireRowActions();
}

/* ---- wire row buttons ---- */
function wireRowActions() {
  document.querySelectorAll('.sub-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openEditForm(btn.dataset.id));
  });

  document.querySelectorAll('.sub-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sub = (await SubscriptionStore.getAll()).find(s => s.id === btn.dataset.id);
      if (!sub) return;
      await SubscriptionStore.update(sub.id, { active: sub.active === false ? true : false });
      renderPage();
    });
  });

  document.querySelectorAll('.sub-log-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sub = (await SubscriptionStore.getAll()).find(s => s.id === btn.dataset.id);
      if (!sub) return;
      btn.disabled = true;
      try {
        await TransactionStore.add({
          date: todayISO(), amount: sub.amount, type: 'expense',
          categoryId: sub.categoryId || null, accountId: sub.accountId || null,
          note: sub.name, tags: ['subscription'],
        });
        await SubscriptionStore.advanceNext(sub.id);
        showToast(`${sub.name} logged`, 'success');
        renderPage();
      } catch (err) {
        showToast(err.message || 'Failed to log', 'error');
        btn.disabled = false;
      }
    });
  });
}

/* ---- form ---- */
let _accounts = [];
let _categories = [];

async function loadFormOptions() {
  _accounts   = await AccountStore.getAll();
  _categories = await CategoryStore.getAll();

  const accSel = document.getElementById('fAccount');
  if (accSel) {
    accSel.innerHTML = '<option value="">— none —</option>' +
      _accounts.map(a => `<option value="${a.id}">${escapeHTML(a.name)}</option>`).join('');
  }

  const catSel = document.getElementById('fCategory');
  if (catSel) {
    const expense = _categories.filter(c => c.type === 'expense' || c.type === 'both');
    catSel.innerHTML = '<option value="">— none —</option>' +
      expense.map(c => `<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');
  }

  const colorRow = document.getElementById('colorRow');
  if (colorRow) {
    colorRow.innerHTML = SUB_COLORS.map((c, i) =>
      `<button type="button" class="subs-color-dot${i === 0 ? ' selected' : ''}" data-color="${c}" style="background:${c};" aria-label="${c}"></button>`
    ).join('');
    colorRow.querySelectorAll('.subs-color-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        colorRow.querySelectorAll('.subs-color-dot').forEach(d => d.classList.remove('selected'));
        dot.classList.add('selected');
      });
    });
  }
}

function renderPresets() {
  const row = document.getElementById('presetRow');
  if (!row) return;
  row.innerHTML = SUB_PRESETS.map((p, i) =>
    `<button type="button" class="subs-preset-chip" data-i="${i}">
       <span class="subs-preset-chip__dot" style="background:${p.color};"></span>${p.name}
     </button>`
  ).join('');
  row.querySelectorAll('.subs-preset-chip').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(SUB_PRESETS[Number(btn.dataset.i)]));
  });
}

function applyPreset(preset) {
  document.getElementById('fName').value      = preset.name;
  document.getElementById('fAmount').value    = preset.amount;
  document.getElementById('fFrequency').value = preset.frequency;
  setSelectedColor(preset.color);
  updateTaxHint();
  document.getElementById('fAmount').focus();
}

function updateTaxHint() {
  const hint    = document.getElementById('taxHint');
  if (!hint) return;
  const amount  = parseFloat(document.getElementById('fAmount').value);
  const checked = document.getElementById('fTax').checked;
  if (checked && amount > 0) {
    hint.style.display = '';
    hint.textContent = `Total with taxes: ${formatCurrency(applyTax(amount))}`;
  } else {
    hint.style.display = 'none';
  }
}

function setPresetVisible(visible) {
  const field = document.getElementById('presetField');
  if (field) field.style.display = visible ? '' : 'none';
}

function getSelectedColor() {
  return document.querySelector('.subs-color-dot.selected')?.dataset.color || SUB_COLORS[0];
}

function setSelectedColor(color) {
  const colorRow = document.getElementById('colorRow');
  colorRow?.querySelectorAll('.subs-color-dot').forEach(d => {
    d.classList.toggle('selected', d.dataset.color === color);
  });
}

function openAddForm() {
  document.getElementById('editId').value = '';
  document.getElementById('fName').value  = '';
  document.getElementById('fAmount').value = '';
  document.getElementById('fFrequency').value = 'monthly';
  document.getElementById('fNextDue').value = todayISO();
  document.getElementById('fAccount').value = '';
  document.getElementById('fCategory').value = '';
  document.getElementById('fAutoLog').checked = true;
  document.getElementById('fTax').checked = false;
  updateTaxHint();
  document.getElementById('formTitle').textContent = 'New subscription';
  document.getElementById('formSubmitBtn').textContent = 'Save';
  document.getElementById('deleteSubBtn').style.display = 'none';
  setSelectedColor(SUB_COLORS[0]);
  setPresetVisible(true);
  showForm();
}

async function openEditForm(id) {
  const sub = (await SubscriptionStore.getAll()).find(s => s.id === id);
  if (!sub) return;
  document.getElementById('editId').value = id;
  document.getElementById('fName').value  = sub.name;
  document.getElementById('fAmount').value = sub.amount;
  document.getElementById('fFrequency').value = sub.frequency || 'monthly';
  document.getElementById('fNextDue').value = sub.nextDue;
  document.getElementById('fAccount').value = sub.accountId || '';
  document.getElementById('fCategory').value = sub.categoryId || '';
  document.getElementById('fAutoLog').checked = sub.autoLog !== false;
  document.getElementById('fTax').checked = false; /* stored amount is already final */
  updateTaxHint();
  document.getElementById('formTitle').textContent = 'Edit subscription';
  document.getElementById('formSubmitBtn').textContent = 'Update';
  document.getElementById('deleteSubBtn').style.display = '';
  setSelectedColor(sub.color || SUB_COLORS[0]);
  setPresetVisible(false);
  showForm();
}

function showForm() {
  const card = document.getElementById('subFormCard');
  document.querySelector('.subs-main-grid')?.classList.add('form-open');
  if (card) { card.style.display = ''; card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}
function hideForm() {
  const card = document.getElementById('subFormCard');
  document.querySelector('.subs-main-grid')?.classList.remove('form-open');
  if (card) card.style.display = 'none';
}

/* ---- analytics ---- */
let _trendChart = null;
let _catChart   = null;

function chartTheme() {
  return {
    grid:          'rgba(255,255,255,.06)',
    ticks:         '#62626c',
    tooltipBg:     '#0d0d0f',
    tooltipTitle:  '#ffffff',
    tooltipBody:   '#9a9aa4',
    tooltipBorder: '#2a2a30',
  };
}

async function renderAnalytics(subs) {
  const analyticsEl = document.getElementById('analyticsSection');
  if (!analyticsEl) return;
  if (!subs.length) { analyticsEl.style.display = 'none'; return; }
  analyticsEl.style.display = '';

  const allTx = await TransactionStore.getAll();
  const subNames = new Set(subs.map(s => s.name.toLowerCase()));

  /* ---- trend: last 6 months of subscription transactions ---- */
  const months = [];
  const monthTotals = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7);
    months.push(key);
    monthTotals[key] = 0;
  }
  allTx.forEach(tx => {
    if (tx.type !== 'expense') return;
    const m = tx.date.slice(0, 7);
    if (!monthTotals.hasOwnProperty(m)) return;
    const noteLower = (tx.note || '').toLowerCase();
    const tagMatch  = (tx.tags || []).includes('subscription');
    if (tagMatch || subNames.has(noteLower)) monthTotals[m] += tx.amount;
  });

  const trendLabels = months.map(m => {
    const [y, mo] = m.split('-');
    return new Date(Number(y), Number(mo) - 1).toLocaleString('en-US', { month: 'short' });
  });
  const trendData = months.map(m => monthTotals[m]);

  document.getElementById('trendSkeleton').style.display = 'none';

  /* No matched subscription charges yet → show an empty state instead of a
     flat chart with a misleading default ($1) axis. */
  const trendCanvas = document.getElementById('trendCanvas');
  const trendEmpty  = document.getElementById('trendEmpty');
  const hasTrend    = trendData.some(v => v > 0);
  if (trendEmpty) trendEmpty.hidden = hasTrend;
  if (trendCanvas) trendCanvas.style.display = hasTrend ? '' : 'none';
  if (_trendChart) { _trendChart.destroy(); _trendChart = null; }
  if (hasTrend) _trendChart = new Chart(trendCanvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: trendLabels,
      datasets: [{
        data: trendData,
        backgroundColor: 'rgba(255,255,255,.18)',
        borderColor: '#ffffff',
        borderWidth: 2,
        borderRadius: 4,
      }],
    },
    options: (() => { const th = chartTheme(); return {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { label: ctx => formatCurrency(ctx.raw) },
        backgroundColor: th.tooltipBg, titleColor: th.tooltipTitle, bodyColor: th.tooltipBody,
        borderColor: th.tooltipBorder, borderWidth: 1,
      }},
      scales: {
        x: { grid: { color: th.grid }, ticks: { color: th.ticks, font: { size: 11 } } },
        y: { grid: { color: th.grid }, ticks: { color: th.ticks, font: { size: 11 }, callback: v => formatCurrency(v) }, beginAtZero: true },
      },
    }; })(),
  });

  /* ---- upcoming 30 days ---- */
  const upcomingEl = document.getElementById('upcomingList');
  if (upcomingEl) {
    const today = todayISO();
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 30);
    const cutoffISO = isoLocal(cutoff);
    const upcoming = subs
      .filter(s => s.active !== false && s.nextDue >= today && s.nextDue <= cutoffISO)
      .sort((a, b) => a.nextDue.localeCompare(b.nextDue));

    if (!upcoming.length) {
      upcomingEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--color-text-muted);font-size:.8125rem;">No bills due in the next 30 days.</div>`;
    } else {
      upcomingEl.innerHTML = upcoming.map(s => {
        const d = daysUntil(s.nextDue);
        const badge = d === 0 ? `<span class="subs-badge subs-badge--today">Today</span>`
          : d <= 3 ? `<span class="subs-badge subs-badge--soon">In ${d}d</span>`
          : `<span class="subs-badge subs-badge--normal">${formatDateShort(s.nextDue)}</span>`;
        return `
          <div class="subs-upcoming-row">
            <div class="subs-row__dot" style="background:${s.color || '#6366f1'};flex-shrink:0;"></div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:.875rem;font-weight:500;color:var(--color-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHTML(s.name)}</div>
              <div style="font-size:.75rem;color:var(--color-text-muted);">${FREQ_LABEL[s.frequency] || s.frequency}</div>
            </div>
            ${badge}
            <div style="font-size:.9375rem;font-weight:600;color:var(--color-expense);white-space:nowrap;">−${formatCurrency(s.amount)}</div>
          </div>`;
      }).join('');
    }
  }

  /* ---- category breakdown ---- */
  const catMap = {};
  const active = subs.filter(s => s.active !== false);
  active.forEach(s => {
    const key = s.categoryId || '__none__';
    catMap[key] = (catMap[key] || 0) + monthlyEquiv(s);
  });
  const catEntries = Object.entries(catMap).sort((a,b) => b[1] - a[1]);
  const cats = await CategoryStore.getAll();
  const catLookup = Object.fromEntries(cats.map(c => [c.id, c]));

  document.getElementById('catSkeleton').style.display = 'none';
  const catCtx = document.getElementById('catCanvas').getContext('2d');
  if (_catChart) _catChart.destroy();

  if (!catEntries.length) {
    catCtx.canvas.style.display = 'none';
  } else {
    catCtx.canvas.style.display = '';
    _catChart = new Chart(catCtx, {
      type: 'doughnut',
      data: {
        labels: catEntries.map(([id]) => catLookup[id]?.name || 'Uncategorized'),
        datasets: [{
          data: catEntries.map(([,v]) => v),
          backgroundColor: catEntries.map((_, i) => SUB_COLORS[i % SUB_COLORS.length]),
          borderWidth: 0,
          hoverOffset: 4,
        }],
      },
      options: (() => { const th = chartTheme(); return {
        responsive: true, maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: { label: ctx => `${ctx.label}: ${formatCurrency(ctx.raw)}/mo` },
            backgroundColor: th.tooltipBg, titleColor: th.tooltipTitle, bodyColor: th.tooltipBody,
            borderColor: th.tooltipBorder, borderWidth: 1,
          },
        },
      }; })(),
    });

    const legendEl = document.getElementById('catLegend');
    if (legendEl) {
      legendEl.innerHTML = catEntries.map(([id, val], i) => {
        const name = escapeHTML(catLookup[id]?.name) || 'Uncategorized';
        const icon = categoryIconHTML(catLookup[id], 14);
        return `
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="width:8px;height:8px;border-radius:50%;background:${SUB_COLORS[i % SUB_COLORS.length]};flex-shrink:0;"></span>
            <span style="font-size:.8125rem;color:var(--color-text-muted);flex:1;display:inline-flex;align-items:center;gap:5px;">${icon}${name}</span>
            <span style="font-size:.8125rem;font-weight:600;color:var(--color-text);">${formatCurrency(val)}/mo</span>
          </div>`;
      }).join('');
    }
  }

  /* ---- pattern insights ---- */
  renderPatternInsights(subs, allTx);
}

function renderPatternInsights(subs, allTx) {
  const patternEl = document.getElementById('patternList');
  if (!patternEl) return;

  const insights = [];

  subs.filter(s => s.active !== false).forEach(sub => {
    const nameLower = sub.name.toLowerCase();
    const related = allTx
      .filter(tx => tx.type === 'expense' && (tx.note || '').toLowerCase() === nameLower)
      .sort((a,b) => a.date.localeCompare(b.date));

    if (related.length < 2) return;

    /* price change detection */
    const amounts = [...new Set(related.map(t => t.amount))];
    if (amounts.length > 1) {
      const first = related[0].amount;
      const last  = related[related.length - 1].amount;
      if (last !== first) {
        const diff = last - first;
        const pct  = Math.round(Math.abs(diff) / first * 100);
        insights.push({
          icon: diff > 0 ? '▲' : '▼',
          color: diff > 0 ? 'var(--color-expense)' : 'var(--color-income)',
          text: `<strong>${escapeHTML(sub.name)}</strong> ${diff > 0 ? 'increased' : 'decreased'} by ${formatCurrency(Math.abs(diff))} (${pct}%) since ${formatDateShort(related[0].date)}.`,
        });
      }
    }

    /* usage frequency check: less than expected logs */
    const months = Math.max(1, Math.round(
      (new Date(related[related.length-1].date) - new Date(related[0].date)) / (1000*60*60*24*30)
    ));
    const expected = Math.max(1, sub.frequency === 'yearly' ? Math.floor(months/12) : sub.frequency === 'weekly' ? months*4 : months);
    if (related.length < expected * 0.6 && expected > 2) {
      insights.push({
        icon: '!',
        color: '#d4a64a',
        text: `<strong>${escapeHTML(sub.name)}</strong> was logged ${related.length} time${related.length!==1?'s':''} but expected ~${expected} over ${months} months. Check if it's still active.`,
      });
    }
  });

  /* total subscription spend trend */
  /* compare the last two COMPLETE months — the current one is still filling
     up, so it always looked "lower than last month" early on */
  const monthKey = back => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - back); return isoLocal(d).slice(0, 7); };
  const thisMonth = monthKey(1);
  const lastMonth = monthKey(2);
  const subNames = new Set(subs.map(s => s.name.toLowerCase()));
  const sumMonth = (m) => allTx
    .filter(tx => tx.type==='expense' && tx.date.startsWith(m) && (
      (tx.tags||[]).includes('subscription') || subNames.has((tx.note||'').toLowerCase())
    ))
    .reduce((s, tx) => s + tx.amount, 0);
  const thisTotal = sumMonth(thisMonth);
  const lastTotal = sumMonth(lastMonth);
  if (lastTotal > 0 && thisTotal > 0) {
    const diff = thisTotal - lastTotal;
    if (Math.abs(diff) > 1) {
      insights.push({
        icon: diff > 0 ? '▲' : '▼',
        color: diff > 0 ? 'var(--color-expense)' : 'var(--color-income)',
        text: `Subscription spend in ${new Date(thisMonth + '-01T00:00:00').toLocaleString('en-US', { month: 'long' })} was <strong>${formatCurrency(Math.abs(diff))} ${diff > 0 ? 'higher' : 'lower'}</strong> than the month before.`,
      });
    }
  }

  if (!insights.length) {
    patternEl.innerHTML = `<div style="padding:20px 20px;font-size:.8125rem;color:var(--color-text-muted);">No patterns detected yet — insights appear after a few months of logged transactions.</div>`;
    return;
  }

  patternEl.innerHTML = insights.map(ins => `
    <div class="subs-insight-row">
      <span class="subs-insight-row__icon" style="color:${ins.color}" aria-hidden="true">${ins.icon}</span>
      <span style="font-size:.8125rem;color:var(--color-text-muted);line-height:1.5;">${ins.text}</span>
    </div>`).join('');
}

/* ---- main render ---- */
async function renderPage() {
  const subs = await SubscriptionStore.getAll();
  renderStats(subs);
  renderList(subs);
  await renderAnalytics(subs);
}

/* ---- form helpers ---- */
function setText(id, val) {
  const el = document.getElementById(id); if (el) el.textContent = val;
}

/* ---- init ---- */
document.addEventListener('DOMContentLoaded', async () => {
  const user = await SupaAuth.requireAuth();
  if (!user) return;

  /* The page ships first-paint placeholders (see subscriptions.html); if the
     load fails they'd shimmer forever, so settle them in the catch. */
  try {
    await loadFormOptions();
    renderPresets();

    /* auto-log due subscriptions */
    const logged = await autoLogDue();
    if (logged.length) {
      const banner = document.getElementById('autoLogBanner');
      const msg    = document.getElementById('autoLogMsg');
      if (banner && msg) {
        msg.textContent = `Auto-logged: ${logged.join(', ')}`;
        banner.style.display = '';
      }
    }

    await renderPage();
  } catch (err) {
    console.error('Subscriptions error:', err);
    ['statMonthly', 'statYearly', 'statActive', 'statDue'].forEach(id => setText(id, '—'));
    showErrorState('subsList', "Couldn't load your subscriptions. " + (err.message || ''), () => location.reload());
    showErrorState('upcomingList', 'Upcoming bills unavailable.');
    showErrorState('patternList', 'Insights unavailable.');
    ['trendSkeleton', 'catSkeleton'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }

  /* add button */
  document.getElementById('addSubBtn')?.addEventListener('click', openAddForm);
  document.getElementById('closeFormBtn')?.addEventListener('click', hideForm);

  /* tax hint */
  document.getElementById('fAmount')?.addEventListener('input', updateTaxHint);
  document.getElementById('fTax')?.addEventListener('change', updateTaxHint);

  /* form submit */
  document.getElementById('subForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const id       = document.getElementById('editId').value;
    const name     = document.getElementById('fName').value.trim();
    const amount   = parseFloat(document.getElementById('fAmount').value);
    const freq     = document.getElementById('fFrequency').value;
    const nextDue  = document.getElementById('fNextDue').value;
    const accId    = document.getElementById('fAccount').value;
    const catId    = document.getElementById('fCategory').value;
    const autoLog  = document.getElementById('fAutoLog').checked;
    const withTax  = document.getElementById('fTax').checked;
    const color    = getSelectedColor();

    if (!name || !amount || !nextDue) return;

    const finalAmount = withTax ? applyTax(amount) : amount;

    const payload = { name, amount: finalAmount, frequency: freq, nextDue, accountId: accId || null, categoryId: catId || null, autoLog, color, active: true };

    if (id) {
      await SubscriptionStore.update(id, payload);
      showToast('Subscription updated', 'success');
    } else {
      await SubscriptionStore.add(payload);
      showToast('Subscription added', 'success');
    }

    hideForm();
    await renderPage();
  });

  /* delete */
  document.getElementById('deleteSubBtn')?.addEventListener('click', async () => {
    const id = document.getElementById('editId').value;
    if (!id) return;
    if (!await confirmDialog('Delete this subscription? Existing logged transactions are not affected.', { confirmText: 'Delete' })) return;
    await SubscriptionStore.remove(id);
    hideForm();
    await renderPage();
    showToast('Subscription deleted', 'success');
  });
});
