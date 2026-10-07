/* ============================================================
   insights.js — Pure forward-looking calculations (no side effects).
   Phase 1: cash-flow forecasting. Companion to summary.js.
   ============================================================ */

const InsightsEngine = {

  /* Project total balance forward, day by day.

     Method (deliberately explainable, not a black box):
       projected(day d) = current
                        + runRate * d            // trailing discretionary trend
                        - scheduled bills due by d // known recurring (subscriptions)
     with a ±band·σ·√d confidence range from daily-net volatility.

     - `current` is the live total from computeAccountBalances.
     - `runRate` is trailing net (income − expense, EXCLUDING subscription-
       tagged tx so scheduled bills aren't double-counted) per elapsed day.
     - `recurring` is the known scheduled items (active subscriptions),
       expanded across the horizon by their frequency.

     - Below `minHistoryDays` of history there is no trend to speak of (one
       coffee on day one would extrapolate to −30 coffees), so the run-rate
       is held at 0 and only scheduled bills move the line; basis.trendReady
       says which case applies.

     opts: { horizonDays=30, lookbackDays=90, minHistoryDays=14, recurring=[],
             asOf=new Date(), band=1 }
     Returns points[0..horizon] plus a summary (end balance, low point,
     below-zero detection, basis). */
  forecastBalance(transactions, accounts, opts = {}) {
    const {
      horizonDays  = 30,
      lookbackDays = 90,
      minHistoryDays = 14,
      recurring    = [],
      asOf         = new Date(),
      band         = 1,
    } = opts;

    const SE = (typeof SummaryEngine !== 'undefined')
      ? SummaryEngine
      : require('./summary.js').SummaryEngine;

    const DAY = 86400000;
    const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
    const iso = d => { const x = startOfDay(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`; };

    const balances = SE.computeAccountBalances(accounts, transactions);
    const current  = Object.values(balances).reduce((s, b) => s + b, 0);

    const today        = startOfDay(asOf);
    const todayStr     = iso(today);
    const lookbackStart = iso(new Date(today.getTime() - lookbackDays * DAY));

    /* elapsed days of real history (so a young account doesn't overstate the
       per-day run-rate), capped at the lookback window */
    const firstDate = transactions.length ? transactions.map(t => t.date).sort()[0] : todayStr;
    const ageDays   = Math.round((today - startOfDay(new Date(firstDate + 'T00:00:00'))) / DAY);
    const elapsed   = Math.max(1, Math.min(lookbackDays, ageDays || 1));

    /* daily net over the lookback, excluding subscription-tagged tx and
       transfers (transfers net to zero on the total balance) */
    const isSub = t => (t.tags || []).includes('subscription');
    const dailyNet = {};
    let windowNet = 0, sampleCount = 0;
    transactions.forEach(t => {
      if (t.date < lookbackStart || t.date > todayStr || isSub(t)) return;
      let eff = 0;
      if (t.type === 'income')       eff =  t.amount;
      else if (t.type === 'expense') eff = -t.amount;
      else return;
      dailyNet[t.date] = (dailyNet[t.date] || 0) + eff;
      windowNet += eff; sampleCount++;
    });
    const trendReady = ageDays >= minHistoryDays;
    const runRate = trendReady ? windowNet / elapsed : 0;

    /* volatility: stddev of daily net across the elapsed days (zero-filled) */
    let vol = 0;
    if (trendReady && elapsed > 1) {
      const mean = windowNet / elapsed;
      let sumSq = 0;
      for (let i = 0; i < elapsed; i++) {
        const v = dailyNet[iso(new Date(today.getTime() - i * DAY))] || 0;
        sumSq += (v - mean) ** 2;
      }
      vol = Math.sqrt(sumSq / elapsed);
    }

    /* expand scheduled recurring items across the horizon */
    const horizonEnd = startOfDay(new Date(today.getTime() + horizonDays * DAY));
    const stepDate = (d, freq) => {
      const x = new Date(d);
      if (freq === 'weekly')      x.setDate(x.getDate() + 7);
      else if (freq === 'yearly') x.setFullYear(x.getFullYear() + 1);
      else                        x.setMonth(x.getMonth() + 1);
      return x;
    };
    const scheduled = [];
    recurring.forEach(r => {
      if (!r || !r.nextDue || !(r.amount > 0)) return;
      let due = startOfDay(new Date(r.nextDue + 'T00:00:00'));
      let guard = 0;
      while (due <= horizonEnd && guard++ < 500) {
        if (due >= today) scheduled.push({ date: iso(due), amount: r.amount, name: r.name || 'Recurring' });
        due = stepDate(due, r.frequency);
      }
    });
    const schedByDate = {};
    scheduled.forEach(s => { schedByDate[s.date] = (schedByDate[s.date] || 0) + s.amount; });

    /* day-by-day projection. The band is capped so a volatile history can't
       balloon it into a meaningless cone that dwarfs the actual balance. */
    const maxSpread = Math.abs(current) * 0.25 + 50;
    const points = [];
    let low = { balance: current, date: todayStr };
    let cumSched = 0;
    for (let d = 0; d <= horizonDays; d++) {
      const date = iso(new Date(today.getTime() + d * DAY));
      cumSched += (schedByDate[date] || 0);
      const balance = current + runRate * d - cumSched;
      const spread  = Math.min(band * vol * Math.sqrt(d), maxSpread);
      points.push({
        date,
        label:   new Date(date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        balance,
        lower:   balance - spread,
        upper:   balance + spread,
      });
      if (balance < low.balance) low = { balance, date };
    }

    const end          = points[points.length - 1];
    const belowZero    = points.find(p => p.balance < 0) || null;
    const riskBelow    = points.find(p => p.lower   < 0) || null;

    return {
      current,
      points,
      horizonDays,
      endBalance:    end.balance,
      endDate:       end.date,
      projectedNet:  end.balance - current,
      runRate,
      volatility:    vol,
      scheduled,
      scheduledTotal: scheduled.reduce((s, x) => s + x.amount, 0),
      low,
      belowZero:     !!belowZero,
      belowZeroDate: belowZero ? belowZero.date : null,
      riskBelowZero: !!riskBelow,
      basis:         { lookbackDays: elapsed, sampleCount, trendReady, minHistoryDays },
    };
  },
  /* Recommend a monthly budget per expense category from trailing history.
     Averages each category's spend over the `months` complete calendar
     months before `asOf` (the current, partial month is excluded so a
     half-finished month doesn't drag the average down), then rounds for
     tidiness with a little headroom. Months with no spend count as 0, so
     sporadic categories get a conservative figure.

     opts: { months=3, asOf=new Date() }
     Returns [{ categoryId, amount, monthlyAvg, monthsWithData }] desc. */
  recommendBudgets(transactions, opts = {}) {
    const { months = 3, asOf = new Date() } = opts;
    const ref = new Date(asOf); ref.setDate(1); ref.setHours(0, 0, 0, 0);

    const keySet = new Set();
    for (let i = 1; i <= months; i++) {
      const d = new Date(ref.getFullYear(), ref.getMonth() - i, 1);
      keySet.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    const byCat = {};
    transactions.forEach(t => {
      if (t.type !== 'expense' || !t.categoryId) return;
      if (!keySet.has(t.date.slice(0, 7))) return;
      const c = byCat[t.categoryId] || (byCat[t.categoryId] = { total: 0, monthsSeen: new Set() });
      c.total += t.amount;
      c.monthsSeen.add(t.date.slice(0, 7));
    });

    const round = v => v >= 10 ? Math.ceil(v / 5) * 5 : Math.max(1, Math.ceil(v));
    return Object.entries(byCat)
      .map(([categoryId, c]) => ({
        categoryId,
        amount:         round(c.total / months),
        monthlyAvg:     c.total / months,
        monthsWithData: c.monthsSeen.size,
      }))
      .filter(r => r.amount > 0)
      .sort((a, b) => b.amount - a.amount);
  },
  /* App-wide spending insights (Phase 3). Pure and structured — each insight
     is data only (a `kind` + numbers); the UI formats the copy. Detectors:
       spendTrend         — total spend this month vs last month
       categorySpike      — a category well above its trailing-3-month average
       savingsRate        — savings rate (income−expense)/income vs last month
       untrackedRecurring — a roughly-monthly, stable charge not tracked as a
                            subscription
     Returns the most notable first (by severity), capped at `max`.
     opts: { asOf=new Date(), subscriptions=[], max=6 } */
  generateInsights(transactions, opts = {}) {
    const { asOf = new Date(), subscriptions = [], max = 6 } = opts;

    const ref = new Date(asOf); ref.setDate(1); ref.setHours(0, 0, 0, 0);
    const ymOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const monthsBack = n => ymOf(new Date(ref.getFullYear(), ref.getMonth() - n, 1));
    const curKey   = ymOf(ref);
    const lastKey  = monthsBack(1);
    const trailing = [monthsBack(1), monthsBack(2), monthsBack(3)];

    const exp = transactions.filter(t => t.type === 'expense' && t.amount > 0);
    const inc = transactions.filter(t => t.type === 'income'  && t.amount > 0);
    const inMonth = (t, k) => t.date.slice(0, 7) === k;
    const sumIn = (arr, k) => arr.filter(t => inMonth(t, k)).reduce((s, t) => s + t.amount, 0);

    const out = [];

    /* 1) spending so far this month vs the SAME days of last month. Comparing
          a week-old month against a whole one always read "spending is down". */
    const dayOfMonth = new Date(asOf).getDate();
    const upToDay = (t, k) => inMonth(t, k) && Number(t.date.slice(8, 10)) <= dayOfMonth;
    const curExp  = exp.filter(t => upToDay(t, curKey)).reduce((s, t) => s + t.amount, 0);
    const lastExp = exp.filter(t => upToDay(t, lastKey)).reduce((s, t) => s + t.amount, 0);
    if (lastExp > 0 && curExp > 0) {
      const diff = curExp - lastExp, pct = Math.round(Math.abs(diff) / lastExp * 100);
      if (Math.abs(diff) >= 50 && pct >= 15) {
        out.push({ id: 'spend-trend', kind: 'spendTrend', tone: diff > 0 ? 'down' : 'up',
          severity: 0.5 + Math.min(0.49, pct / 200), current: curExp, previous: lastExp, diff, pct, day: dayOfMonth });
      }
    }

    /* 2) per-category spike vs trailing-3-month average */
    [...new Set(exp.map(t => t.categoryId).filter(Boolean))].forEach(catId => {
      const cur = exp.filter(t => t.categoryId === catId && inMonth(t, curKey)).reduce((s, t) => s + t.amount, 0);
      const avg = trailing.reduce((s, k) =>
        s + exp.filter(t => t.categoryId === catId && inMonth(t, k)).reduce((a, t) => a + t.amount, 0), 0) / 3;
      if (avg >= 20 && cur >= avg * 1.4 && (cur - avg) >= 30) {
        const pct = Math.round((cur / avg - 1) * 100);
        out.push({ id: 'spike:' + catId, kind: 'categorySpike', tone: 'down', categoryId: catId,
          severity: Math.min(0.95, 0.4 + pct / 200), current: cur, avg, pct });
      }
    });

    /* 3) savings rate: last complete month vs the one before. A month in
          progress (one paycheque in, rent already out) isn't a rate yet. */
    const rateFor = k => { const i = sumIn(inc, k); return i > 0 ? (i - sumIn(exp, k)) / i : null; };
    const prevKey = monthsBack(2);
    const curSR = rateFor(lastKey), lastSR = rateFor(prevKey);
    if (curSR != null && lastSR != null && Math.abs(curSR - lastSR) >= 0.12) {
      const delta = curSR - lastSR;
      out.push({ id: 'savings', kind: 'savingsRate', tone: delta >= 0 ? 'up' : 'down',
        severity: 0.45 + Math.min(0.4, Math.abs(delta)), rate: curSR, prevRate: lastSR, delta,
        month: lastKey, prevMonth: prevKey });
    }

    /* 4) untracked recurring charges — roughly monthly, stable amount, not a
          tagged/known subscription */
    const known = new Set(subscriptions.map(s => (s.name || '').toLowerCase().trim()).filter(Boolean));
    const groups = {};
    const recurring = [];
    exp.forEach(t => {
      const note = (t.note || '').toLowerCase().trim();
      if (!note || (t.tags || []).includes('subscription') || known.has(note)) return;
      (groups[note] = groups[note] || []).push(t);
    });
    Object.values(groups).forEach(txs => {
      if (txs.length < 3) return;
      const dates = txs.map(t => t.date).sort();
      if (new Set(dates.map(d => d.slice(0, 7))).size < 3) return;
      const gaps = [];
      for (let i = 1; i < dates.length; i++) gaps.push((new Date(dates[i]) - new Date(dates[i - 1])) / 86400000);
      gaps.sort((a, b) => a - b);
      const medGap = gaps[Math.floor(gaps.length / 2)];
      if (medGap < 24 || medGap > 38) return;
      const amts = txs.map(t => t.amount);
      const mean = amts.reduce((s, a) => s + a, 0) / amts.length;
      const sd   = Math.sqrt(amts.reduce((s, a) => s + (a - mean) ** 2, 0) / amts.length);
      if (mean <= 0 || sd / mean > 0.2) return;
      recurring.push({ id: 'recurring:' + (txs[0].note || '').toLowerCase().trim(), kind: 'untrackedRecurring', tone: 'info',
        severity: 0.35, name: txs[txs.length - 1].note, amount: mean, count: txs.length, cadenceDays: Math.round(medGap) });
    });
    /* rent, phone, internet… all qualify on a long history — show the two
       biggest so they don't crowd out the spending insights, and say how many
       more there are */
    recurring.sort((a, b) => b.amount - a.amount);
    recurring.slice(0, 2).forEach((r, i) => out.push(i === 0 ? { ...r, more: Math.max(0, recurring.length - 2) } : r));

    return out.sort((a, b) => b.severity - a.severity).slice(0, max);
  },

  /* Suggest a category for a new transaction from the user's OWN history — no
     AI, no network. First an exact normalized-note match, then a token-overlap
     fallback; among the matches the most-used category wins (ties broken by
     recency). Filtered by `type` so an expense never suggests an income
     category. Returns { categoryId, confidence: 'exact'|'similar', count } or
     null.  opts: { type } */
  suggestCategory(note, transactions, opts = {}) {
    const { type } = opts;
    const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ').replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
    const target = norm(note);
    if (!target) return null;

    const pool = transactions.filter(t => t.categoryId && t.note && (!type || t.type === type));
    if (!pool.length) return null;

    const pickBest = (rows) => {
      const count = {}, latest = {};
      rows.forEach(t => {
        count[t.categoryId] = (count[t.categoryId] || 0) + 1;
        if (!latest[t.categoryId] || t.date > latest[t.categoryId]) latest[t.categoryId] = t.date;
      });
      const best = Object.keys(count).sort((a, b) =>
        count[b] - count[a] || (latest[b] > latest[a] ? 1 : -1))[0];
      return best ? { categoryId: best, count: count[best] } : null;
    };

    const exact = pool.filter(t => norm(t.note) === target);
    if (exact.length) return { ...pickBest(exact), confidence: 'exact' };

    const tokens = new Set(target.split(' ').filter(w => w.length >= 3));
    if (!tokens.size) return null;
    const similar = pool.filter(t => norm(t.note).split(' ').some(w => w.length >= 3 && tokens.has(w)));
    if (!similar.length) return null;
    return { ...pickBest(similar), confidence: 'similar' };
  },

  /* Upcoming recurring bills + their normalized cost. Pure: no DOM, no store.
     Expands each active subscription forward from its nextDue across the next
     `withinDays`, so a weekly bill can appear several times. Overdue items
     (nextDue already in the past) surface with a negative daysUntil.

     opts: { asOf=new Date(), withinDays=30, max=5 }
     Returns { bills:[{ id,name,amount,date,daysUntil,frequency,color,
     categoryId,accountId }] (date asc, capped at max), monthlyTotal,
     annualTotal, count } where the totals span ALL active subscriptions, not
     just the ones inside the window. */
  upcomingBills(subscriptions, opts = {}) {
    const { asOf = new Date(), withinDays = 30, max = 5 } = opts;
    const DAY = 86400000;
    const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
    const iso = d => { const x = startOfDay(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; };

    const today      = startOfDay(asOf);
    const horizonEnd = startOfDay(new Date(today.getTime() + withinDays * DAY));
    /* monthly-equivalent factor per frequency (used for the cost totals) */
    const MONTHLY = { daily: 365 / 12, weekly: 52 / 12, monthly: 1, yearly: 1 / 12 };
    const step = (d, freq) => {
      const x = new Date(d);
      if (freq === 'daily')       x.setDate(x.getDate() + 1);
      else if (freq === 'weekly') x.setDate(x.getDate() + 7);
      else if (freq === 'yearly') x.setFullYear(x.getFullYear() + 1);
      else                        x.setMonth(x.getMonth() + 1);
      return x;
    };

    const active = (subscriptions || []).filter(s => s && s.active !== false && s.amount > 0 && s.nextDue);

    let monthlyTotal = 0;
    const bills = [];
    active.forEach(s => {
      monthlyTotal += s.amount * (MONTHLY[s.frequency] ?? 1);
      let due = startOfDay(new Date(s.nextDue + 'T00:00:00'));
      let guard = 0;
      while (due <= horizonEnd && guard++ < 500) {
        bills.push({
          id: s.id, name: s.name || 'Recurring', amount: s.amount,
          date: iso(due), daysUntil: Math.round((startOfDay(due) - today) / DAY),
          frequency: s.frequency, color: s.color || null,
          categoryId: s.categoryId || null, accountId: s.accountId || null,
        });
        due = step(due, s.frequency);
      }
    });

    bills.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return {
      bills: bills.slice(0, max),
      monthlyTotal: Math.round(monthlyTotal * 100) / 100,
      annualTotal:  Math.round(monthlyTotal * 12 * 100) / 100,
      count: active.length,
    };
  },
};

/* Export for Node-based unit tests. Harmless in the browser, where there is
   no `module` and `InsightsEngine` stays a global. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { InsightsEngine };
}
