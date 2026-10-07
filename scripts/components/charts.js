/* ============================================================
   charts.js — Canvas charts with hover tooltips
   ============================================================ */

const Charts = {

  COLORS: [
    '#e8e8ec','#9a9aa4','#00d18f','#ff5c7a','#d4a64a',
    '#5b8def','#8b5cf6','#67b7c9','#ec4899','#52525b',
  ],

  _state: {},

  /* First draw: set pixel buffer from layout size. Subsequent redraws: only clearRect. */
  _setup(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    /* No layout size = the panel is hidden (or not laid out yet). Sizing the
       buffer to 0 wipes the bitmap and leaves the chart permanently blank once
       it's shown again, so keep what we have and let the next draw — when it's
       actually visible — measure properly. Callers all treat null as "skip". */
    if (!w || !h) return null;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, w, h, canvas };
  },

  _clear(s) {
    s._ctx.clearRect(0, 0, s._w, s._h);
    return { ctx: s._ctx, w: s._w, h: s._h, canvas: s._canvas };
  },

  /* Flow mono chart palette — follows the black/white theme switch */
  _isLight()    { return document.documentElement.dataset.theme === 'light'; },
  _textColor()  { return this._isLight() ? '#71717a' : '#62626c'; },
  _textLight()  { return this._isLight() ? '#8a8a94' : '#9a9aa4'; },
  _textStrong() { return this._isLight() ? '#101014' : '#ffffff'; },
  _gridColor()  { return this._isLight() ? 'rgba(0,0,0,0.08)'  : 'rgba(255,255,255,0.07)'; },
  _surface()    { return this._isLight() ? '#ffffff' : '#0d0d0f'; },
  _lineColor()  { return this._isLight() ? '#101014' : '#ffffff'; },
  _tooltipBg()      { return this._isLight() ? 'rgba(255,255,255,0.97)' : 'rgba(10,10,12,0.96)'; },
  _tooltipBorder()  { return this._isLight() ? 'rgba(0,0,0,0.18)'       : 'rgba(255,255,255,0.18)'; },
  /* monochrome ink at a given alpha — white on black, black on white */
  _mono(a)          { return this._isLight() ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`; },

  _reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  },

  /* Match formatCurrency()'s locale so the symbol agrees across the page
     (e.g. CAD → en-CA → "$", not the en-US "CA$"). */
  _locale() {
    const c = localStorage.getItem('pf_currency') || 'CAD';
    return (typeof CURRENCY_LOCALES !== 'undefined' && CURRENCY_LOCALES[c]) || 'en-CA';
  },

  _currencySymbol() {
    const c = localStorage.getItem('pf_currency') || 'CAD';
    try { return (0).toLocaleString(this._locale(), { style: 'currency', currency: c, minimumFractionDigits: 0 }).replace(/[\d,.\s]/g, '').trim() || '$'; }
    catch { return '$'; }
  },

  _fmt(val) {
    const sym = this._currencySymbol();
    const abs = Math.abs(val);
    const sign = Math.round(val) < 0 ? '−' : '';     /* −$400, not $-400 */
    if (abs >= 1000000) return `${sign}${sym}${(abs / 1000000).toFixed(1)}M`;
    if (abs >= 1000)    return `${sign}${sym}${(abs / 1000).toFixed(1)}k`;
    return `${sign}${sym}${Math.round(abs)}`;
  },

  _fmtFull(val) {
    const currency = localStorage.getItem('pf_currency') || 'CAD';
    try { return new Intl.NumberFormat(this._locale(), { style: 'currency', currency }).format(val); }
    catch { return `$${Math.abs(val).toFixed(2)}`; }
  },

  /* ── LINE CHART ──────────────────────────────────────────────
     Optional `projection`: an array of forecast points appended after the
     historical series, drawn as a dashed line with a shaded ±band and a
     "now" divider. Each may carry { balance, lower, upper, label }. Passing
     no projection renders exactly as before (fully backward-compatible). */
  drawLineChart(canvasId, points, _redraw, projection) {
    if (!_redraw) {
      const r = this._setup(canvasId);
      if (!r) return;
      this._state[canvasId] = { type: 'line', data: points, proj: projection || [], hoverIdx: -1,
        _ctx: r.ctx, _w: r.w, _h: r.h, _canvas: r.canvas };
    }
    const s = this._state[canvasId];
    if (!s || !s._ctx) return;
    const { ctx, w, h } = _redraw ? this._clear(s) : { ctx: s._ctx, w: s._w, h: s._h };
    if (!_redraw) ctx.clearRect(0, 0, w, h);

    if (!points.length) return;

    const proj     = s.proj || [];
    const all      = proj.length ? points.concat(proj) : points;
    const splitIdx = points.length;          /* first projected index */

    const pad = { top: 28, right: 20, bottom: 44, left: 68 };
    const cw  = w - pad.left - pad.right;
    const ch  = h - pad.top  - pad.bottom;

    const values   = all.map(p => p.balance);
    const bandVals = proj.flatMap(p => [p.lower ?? p.balance, p.upper ?? p.balance]);
    const minVal   = Math.min(...values, ...bandVals);
    const maxVal   = Math.max(...values, ...bandVals);
    const rawRange = maxVal - minVal || Math.abs(maxVal) || 1;
    const lo    = minVal - rawRange * 0.12;
    const hiVal = maxVal + rawRange * 0.12;
    const range = hiVal - lo;

    const toX = i => pad.left + (i / Math.max(all.length - 1, 1)) * cw;
    const toY = v => pad.top + ch - ((v - lo) / range) * ch;

    /* Grid + Y labels */
    const gridCount = 4;
    for (let g = 0; g <= gridCount; g++) {
      const v = lo + (g / gridCount) * range;
      const y = toY(v);
      ctx.strokeStyle = this._gridColor();
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
      ctx.fillStyle = this._textColor();
      ctx.font = '11px "Inter", sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(this._fmt(v), pad.left - 8, y);
    }

    /* X labels — evenly spaced; always include the last, but if it lands too
       close to the previous tick, replace it rather than overprint (avoids the
       collision seen at the right edge). */
    const maxLabels = Math.max(2, Math.floor(cw / 46));
    const labelStep = Math.max(1, Math.ceil(all.length / maxLabels));
    const labelIdx  = [];
    for (let i = 0; i < all.length; i += labelStep) labelIdx.push(i);
    const lastI = all.length - 1;
    if (labelIdx[labelIdx.length - 1] !== lastI) {
      if (lastI - labelIdx[labelIdx.length - 1] < labelStep * 0.6) labelIdx[labelIdx.length - 1] = lastI;
      else labelIdx.push(lastI);
    }
    ctx.fillStyle = this._textColor();
    ctx.font = '11px "Inter", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    labelIdx.forEach(i => ctx.fillText(all[i].label, toX(i), pad.top + ch + 10));

    /* Draw-in: clip fill + line to animated progress (1 = fully drawn) */
    const animT = s.animT === undefined ? 1 : s.animT;
    ctx.save();
    if (animT < 1) {
      ctx.beginPath();
      ctx.rect(0, 0, pad.left + cw * animT + 2, h);
      ctx.clip();
    }

    /* Gradient fill — white fading up from the baseline (historical only) */
    const lastHist = splitIdx - 1;
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
    grad.addColorStop(0, this._mono(0.13));
    grad.addColorStop(1, this._mono(0));
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(values[0]));
    for (let i = 1; i <= lastHist; i++) ctx.lineTo(toX(i), toY(values[i]));
    ctx.lineTo(toX(lastHist), pad.top + ch);
    ctx.lineTo(toX(0), pad.top + ch);
    ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    /* Historical line (solid) */
    ctx.beginPath();
    ctx.strokeStyle = this._lineColor(); ctx.lineWidth = 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.moveTo(toX(0), toY(values[0]));
    for (let i = 1; i <= lastHist; i++) ctx.lineTo(toX(i), toY(values[i]));
    ctx.stroke();

    /* Projection: shaded band + dashed line + "now" divider */
    if (proj.length) {
      /* band (connects from the last historical point for continuity) */
      ctx.beginPath();
      ctx.moveTo(toX(lastHist), toY(values[lastHist]));
      for (let i = splitIdx; i < all.length; i++) ctx.lineTo(toX(i), toY(all[i].upper ?? all[i].balance));
      for (let i = all.length - 1; i >= splitIdx; i--) ctx.lineTo(toX(i), toY(all[i].lower ?? all[i].balance));
      ctx.closePath();
      ctx.fillStyle = this._mono(0.06); ctx.fill();

      /* dashed projection line */
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.strokeStyle = this._mono(0.6); ctx.lineWidth = 2;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.moveTo(toX(lastHist), toY(values[lastHist]));
      for (let i = splitIdx; i < all.length; i++) ctx.lineTo(toX(i), toY(values[i]));
      ctx.stroke();
      ctx.restore();

      /* "now" divider */
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = this._mono(0.18); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(toX(lastHist), pad.top); ctx.lineTo(toX(lastHist), pad.top + ch); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    /* Hover */
    const hi = animT < 1 ? -1 : s.hoverIdx;
    if (hi >= 0 && hi < all.length) {
      const hx = toX(hi), hy = toY(values[hi]);

      ctx.strokeStyle = this._mono(0.25); ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(hx, pad.top); ctx.lineTo(hx, pad.top + ch); ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.fillStyle = this._lineColor(); ctx.fill();
      ctx.strokeStyle = this._surface(); ctx.lineWidth = 2; ctx.stroke();

      const projected = hi >= splitIdx;
      const t1 = all[hi].label + (projected ? ' · projected' : '');
      const t2 = this._fmtFull(values[hi]);
      ctx.font = 'bold 13px "Inter", sans-serif';
      const bw = Math.max(ctx.measureText(t1).width, ctx.measureText(t2).width) + 24;
      const bh = 46;
      let bx = hx + 12, by = hy - bh / 2;
      if (bx + bw > w - 4) bx = hx - bw - 12;
      if (by < pad.top)    by = pad.top;
      if (by + bh > h - 4) by = h - bh - 4;

      ctx.fillStyle = this._tooltipBg();
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 7); ctx.fill();
      ctx.strokeStyle = this._tooltipBorder(); ctx.lineWidth = 1; ctx.stroke();

      ctx.fillStyle = this._textLight();
      ctx.font = '11px "Inter", sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(t1, bx + 12, by + 9);
      ctx.fillStyle = this._textStrong();
      ctx.font = 'bold 13px "Inter", sans-serif';
      ctx.fillText(t2, bx + 12, by + 26);
    } else if (animT >= 1) {
      const lx = toX(all.length - 1), ly = toY(values[values.length - 1]);
      ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2);
      ctx.fillStyle = this._lineColor(); ctx.fill();
      ctx.strokeStyle = this._surface(); ctx.lineWidth = 2; ctx.stroke();
    }

    if (!_redraw) {
      /* Draw-in animation on first render */
      if (!this._reducedMotion() && all.length > 1 && !document.hidden) {
        s.animT = 0;
        const dur = 900, t0 = performance.now();
        const easeOut = t => 1 - Math.pow(1 - t, 3);
        const step = (now) => {
          if (this._state[canvasId] !== s) return; /* superseded by a newer draw */
          s.animT = Math.min((now - t0) / dur, 1);
          s.animT = s.animT >= 1 ? 1 : easeOut(s.animT);
          this.drawLineChart(canvasId, points, true);
          if (s.animT < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
      const canvas = s._canvas;
      canvas.style.cursor = 'crosshair';
      canvas.onmousemove = (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        let closest = 0, minDist = Infinity;
        all.forEach((_, i) => {
          const d = Math.abs(toX(i) - mx);
          if (d < minDist) { minDist = d; closest = i; }
        });
        if (s.hoverIdx !== closest) {
          s.hoverIdx = closest;
          this.drawLineChart(canvasId, points, true);
        }
      };
      canvas.onmouseleave = () => {
        if (s.hoverIdx !== -1) { s.hoverIdx = -1; this.drawLineChart(canvasId, points, true); }
      };
    }
  },

  /* ── DONUT CHART ─────────────────────────────────────────── */
  drawDonutChart(canvasId, slices, _redraw, centerLabel) {
    if (!_redraw) {
      const r = this._setup(canvasId);
      if (!r) return;
      this._state[canvasId] = { type: 'donut', data: slices, hoverIdx: -1,
        centerLabel: centerLabel || 'Total spent',
        _ctx: r.ctx, _w: r.w, _h: r.h, _canvas: r.canvas };
    }
    const s = this._state[canvasId];
    if (!s || !s._ctx) return;
    const { ctx, w, h } = _redraw ? this._clear(s) : { ctx: s._ctx, w: s._w, h: s._h };
    if (!_redraw) ctx.clearRect(0, 0, w, h);

    if (!slices.length) return;

    const cx = w / 2, cy = h / 2;
    const outerR = Math.min(w, h) / 2 - 10;
    const innerR = outerR * 0.60;
    const total  = slices.reduce((acc, sl) => acc + sl.value, 0);

    let angle = -Math.PI / 2;
    const segAngles = [];

    slices.forEach((sl, i) => {
      const sweep   = (sl.value / total) * Math.PI * 2;
      const hovered = s.hoverIdx === i;
      const r2      = hovered ? outerR + 7 : outerR;

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r2, angle, angle + sweep);
      ctx.closePath();
      ctx.fillStyle = this.COLORS[i % this.COLORS.length];
      ctx.fill();
      ctx.strokeStyle = this._surface(); ctx.lineWidth = 2; ctx.stroke();

      segAngles.push({ start: angle, end: angle + sweep });
      angle += sweep;
    });

    /* Hole */
    ctx.beginPath(); ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.fillStyle = this._surface(); ctx.fill();

    /* Center label */
    ctx.textAlign = 'center';
    if (s.hoverIdx >= 0 && s.hoverIdx < slices.length) {
      const sl  = slices[s.hoverIdx];
      const pct = Math.round((sl.value / total) * 100);
      ctx.fillStyle = this._textStrong();
      ctx.font = 'bold 15px "Inter", sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.fillText(this._fmtFull(sl.value), cx, cy + 2);
      ctx.fillStyle = this._textLight();
      ctx.font = '11px "Inter", sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(`${pct}% · ${sl.label}`, cx, cy + 6);
    } else {
      ctx.fillStyle = this._textColor();
      ctx.font = '11px "Inter", sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.fillText(s.centerLabel || 'Total spent', cx, cy + 1);
      ctx.fillStyle = this._textStrong();
      ctx.font = 'bold 16px "Inter", sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(this._fmt(total), cx, cy + 5);
    }

    if (!_redraw) {
      const canvas = s._canvas;
      canvas.style.cursor = 'pointer';
      canvas.onmousemove = (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left - cx;
        const my = e.clientY - rect.top  - cy;
        const dist = Math.sqrt(mx * mx + my * my);
        if (dist < innerR || dist > outerR + 12) {
          if (s.hoverIdx !== -1) { s.hoverIdx = -1; this.drawDonutChart(canvasId, slices, true); }
          return;
        }
        /* Normalize to [-PI/2, 3*PI/2] to match segment angle range */
        let a = Math.atan2(my, mx);
        if (a < -Math.PI / 2) a += Math.PI * 2;
        let found = -1;
        segAngles.forEach(({ start, end }, i) => { if (a >= start && a < end) found = i; });
        if (s.hoverIdx !== found) { s.hoverIdx = found; this.drawDonutChart(canvasId, slices, true); }
      };
      canvas.onmouseleave = () => {
        if (s.hoverIdx !== -1) { s.hoverIdx = -1; this.drawDonutChart(canvasId, slices, true); }
      };
    }
  },

  /* ── BAR CHART ───────────────────────────────────────────── */
  drawBarChart(canvasId, months, _redraw) {
    if (!_redraw) {
      const r = this._setup(canvasId);
      if (!r) return;
      this._state[canvasId] = { type: 'bar', data: months, hoverIdx: -1,
        _ctx: r.ctx, _w: r.w, _h: r.h, _canvas: r.canvas };
    }
    const s = this._state[canvasId];
    if (!s || !s._ctx) return;
    const { ctx, w, h } = _redraw ? this._clear(s) : { ctx: s._ctx, w: s._w, h: s._h };
    if (!_redraw) ctx.clearRect(0, 0, w, h);

    const pad = { top: 24, right: 16, bottom: 44, left: 68 };
    const cw  = w - pad.left - pad.right;
    const ch  = h - pad.top  - pad.bottom;

    const maxVal    = Math.max(...months.flatMap(m => [m.income, m.expense]), 1);
    const barGroupW = cw / months.length;
    const gap       = Math.max(6, barGroupW * 0.12);
    const barW      = Math.max(4, (barGroupW - gap * 3) / 2);

    /* Grid */
    for (let g = 0; g <= 4; g++) {
      const v = maxVal * (1 - g / 4);
      const y = pad.top + (g / 4) * ch;
      ctx.strokeStyle = this._gridColor(); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
      ctx.fillStyle = this._textColor();
      ctx.font = '11px "Inter", sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(this._fmt(v), pad.left - 8, y);
    }

    /* Store hit areas relative to w so hover detection stays consistent */
    const hitAreas = [];

    months.forEach((m, i) => {
      const groupX = pad.left + i * barGroupW + gap;
      const isCur  = !!m.highlight;
      const isHov  = s.hoverIdx === i;

      const ih = m.income  > 0 ? Math.max(3, (m.income  / maxVal) * ch) : 0;
      const eh = m.expense > 0 ? Math.max(3, (m.expense / maxVal) * ch) : 0;

      /* Income bar */
      ctx.fillStyle = isHov ? '#2ee8a5' : (isCur ? '#00d18f' : 'rgba(0,209,143,0.5)');
      if (ih > 0) {
        ctx.beginPath();
        ctx.roundRect(groupX, pad.top + ch - ih, barW, ih, [3, 3, 0, 0]);
        ctx.fill();
      }

      /* Expense bar */
      ctx.fillStyle = isHov ? '#ff7d95' : (isCur ? '#ff5c7a' : 'rgba(255,92,122,0.5)');
      if (eh > 0) {
        ctx.beginPath();
        ctx.roundRect(groupX + barW + gap, pad.top + ch - eh, barW, eh, [3, 3, 0, 0]);
        ctx.fill();
      }

      /* Month label — skip every other on narrow canvases */
      const barLabelStep = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor(cw / 28))));
      if (i % barLabelStep === 0) {
        ctx.fillStyle    = isCur ? this._textStrong() : this._textColor();
        ctx.font         = isCur ? 'bold 11px "Inter", sans-serif' : '11px "Inter", sans-serif';
        ctx.textAlign    = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(m.label, groupX + barW + gap / 2, pad.top + ch + 10);
      }

      hitAreas.push({ x: groupX - gap / 2, width: barGroupW });

      /* Tooltip */
      if (isHov) {
        const net   = m.income - m.expense;
        const lines = [
          { text: m.label,                                                       color: this._textLight(), bold: false },
          { text: `In   ${this._fmtFull(m.income)}`,                             color: '#00d18f',         bold: true  },
          { text: `Out  ${this._fmtFull(m.expense)}`,                            color: '#ff5c7a',         bold: true  },
          { text: `Net  ${net >= 0 ? '+' : ''}${this._fmtFull(net)}`,            color: net >= 0 ? '#00d18f' : '#ff5c7a', bold: true },
        ];

        ctx.font = '12px "Inter", sans-serif';
        const maxTW = Math.max(...lines.map(l => ctx.measureText(l.text).width));
        const bw = maxTW + 24;
        const bh = lines.length * 18 + 14;

        let bx = groupX + barW - bw / 2;
        let by = pad.top + ch - Math.max(ih, eh, 1) - bh - 10;
        if (bx < pad.left)     bx = pad.left;
        if (bx + bw > w - 4)  bx = w - bw - 4;
        if (by < pad.top + 2) by = pad.top + 2;

        ctx.fillStyle = this._tooltipBg();
        ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 7); ctx.fill();
        ctx.strokeStyle = this._tooltipBorder(); ctx.lineWidth = 1; ctx.stroke();

        lines.forEach((l, li) => {
          ctx.fillStyle = l.color;
          ctx.font = l.bold ? 'bold 12px "Inter", sans-serif' : '11px "Inter", sans-serif';
          ctx.textAlign = 'left'; ctx.textBaseline = 'top';
          ctx.fillText(l.text, bx + 12, by + 8 + li * 18);
        });
      }
    });

    /* Legend */
    ctx.textBaseline = 'bottom'; ctx.font = '11px "Inter", sans-serif';
    ctx.fillStyle = 'rgba(0,209,143,0.75)';
    ctx.fillRect(w - 110, h - 10 - 8, 8, 8);
    ctx.fillStyle = this._textColor(); ctx.textAlign = 'left';
    ctx.fillText('Income', w - 99, h - 10);
    ctx.fillStyle = 'rgba(255,92,122,0.75)';
    ctx.fillRect(w - 52, h - 10 - 8, 8, 8);
    ctx.fillStyle = this._textColor();
    ctx.fillText('Exp', w - 41, h - 10);

    if (!_redraw) {
      const canvas = s._canvas;
      canvas.onmousemove = (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        let found = -1;
        hitAreas.forEach((a, i) => { if (mx >= a.x && mx < a.x + a.width) found = i; });
        if (s.hoverIdx !== found) { s.hoverIdx = found; this.drawBarChart(canvasId, months, true); }
      };
      canvas.onmouseleave = () => {
        if (s.hoverIdx !== -1) { s.hoverIdx = -1; this.drawBarChart(canvasId, months, true); }
      };
    }
  },
};
