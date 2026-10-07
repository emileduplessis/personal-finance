/* ============================================================
   Unit tests for InsightsEngine (scripts/engine/insights.js).
   Pure forecasting math. Node's built-in runner.

   Run:  node --test tests/      (or: npm test)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const { InsightsEngine } = require('../scripts/engine/insights.js');

/* Fixed "now" so date math is deterministic. */
const ASOF = new Date('2026-06-16T12:00:00');
const DAY = 86400000;
const daysBefore = n => new Date(ASOF.getTime() - n * DAY).toISOString().slice(0, 10);
const daysAfter  = n => new Date(ASOF.getTime() + n * DAY).toISOString().slice(0, 10);

const ACCT = [{ id: 'a', initialBalance: 1000 }];

test('forecastBalance — shape & horizon', async (t) => {
  await t.test('returns horizon+1 points, day 0 is today at current balance', () => {
    const fc = InsightsEngine.forecastBalance([], ACCT, { horizonDays: 30, asOf: ASOF });
    assert.equal(fc.points.length, 31);
    assert.equal(fc.points[0].balance, 1000);
    assert.equal(fc.current, 1000);
    assert.equal(fc.endDate, daysAfter(30));
  });

  await t.test('no history and no bills → flat projection at current balance', () => {
    const fc = InsightsEngine.forecastBalance([], ACCT, { horizonDays: 30, asOf: ASOF });
    assert.ok(fc.points.every(p => p.balance === 1000));
    assert.equal(fc.projectedNet, 0);
    assert.equal(fc.belowZero, false);
    assert.equal(fc.basis.sampleCount, 0);
  });
});

test('forecastBalance — run-rate trend', async (t) => {
  await t.test('a steady daily surplus projects upward', () => {
    // +30/day income across the last 30 days → runRate ≈ +30/day
    const txns = [];
    for (let i = 1; i <= 30; i++) txns.push({ type: 'income', amount: 30, date: daysBefore(i), accountId: 'a' });
    const fc = InsightsEngine.forecastBalance(txns, ACCT, { horizonDays: 30, lookbackDays: 90, asOf: ASOF });
    assert.ok(fc.runRate > 25 && fc.runRate < 35, `runRate ~30, got ${fc.runRate}`);
    assert.ok(fc.endBalance > fc.current, 'ends higher than current');
    assert.ok(fc.projectedNet > 0);
  });

  await t.test('a steady daily deficit projects below zero and flags it', () => {
    // start at 4000, spend 100/day for 30 days → current = 1000 (still positive),
    // runRate ≈ -100/day, so the trend crosses zero ~11 days out (in the future)
    const acct = [{ id: 'a', initialBalance: 4000 }];
    const txns = [];
    for (let i = 1; i <= 30; i++) txns.push({ type: 'expense', amount: 100, date: daysBefore(i), accountId: 'a' });
    const fc = InsightsEngine.forecastBalance(txns, acct, { horizonDays: 30, lookbackDays: 90, asOf: ASOF });
    assert.equal(fc.current, 1000);
    assert.ok(fc.runRate < -90, `runRate strongly negative, got ${fc.runRate}`);
    assert.equal(fc.belowZero, true);
    assert.ok(fc.belowZeroDate > daysBefore(0), 'below-zero date is in the future');
    assert.ok(fc.low.balance < 0);
  });
});

test('forecastBalance — needs history before trending', async (t) => {
  await t.test('one expense today does not extrapolate into a 30-day slide', () => {
    const txns = [{ type: 'expense', amount: 14.75, date: daysBefore(0), accountId: 'a' }];
    const fc = InsightsEngine.forecastBalance(txns, ACCT, { horizonDays: 30, asOf: ASOF });
    assert.equal(fc.basis.trendReady, false);
    assert.equal(fc.runRate, 0);
    assert.equal(fc.projectedNet, 0);
    assert.equal(fc.endBalance, fc.current);
  });

  await t.test('trend kicks in once history reaches minHistoryDays', () => {
    const txns = [];
    for (let i = 0; i <= 14; i++) txns.push({ type: 'expense', amount: 10, date: daysBefore(i), accountId: 'a' });
    const fc = InsightsEngine.forecastBalance(txns, ACCT, { horizonDays: 30, asOf: ASOF });
    assert.equal(fc.basis.trendReady, true);
    assert.ok(fc.runRate < 0);
  });

  await t.test('young history still projects scheduled bills', () => {
    const recurring = [{ amount: 50, frequency: 'monthly', nextDue: daysAfter(5) }];
    const txns = [{ type: 'expense', amount: 14.75, date: daysBefore(0), accountId: 'a' }];
    const fc = InsightsEngine.forecastBalance(txns, ACCT, { horizonDays: 30, asOf: ASOF, recurring });
    assert.equal(fc.basis.trendReady, false);
    assert.equal(fc.projectedNet, -50);
  });
});

test('forecastBalance — scheduled recurring bills', async (t) => {
  await t.test('a bill due inside the horizon reduces the projected balance', () => {
    const recurring = [{ amount: 200, frequency: 'monthly', nextDue: daysAfter(10), name: 'Rent' }];
    const flat = InsightsEngine.forecastBalance([], ACCT, { horizonDays: 30, asOf: ASOF });
    const withBill = InsightsEngine.forecastBalance([], ACCT, { horizonDays: 30, asOf: ASOF, recurring });
    assert.equal(withBill.scheduled.length, 1);
    assert.equal(withBill.endBalance, flat.endBalance - 200);
    // balance is unchanged before the due date, dropped on/after it
    assert.equal(withBill.points[9].balance, 1000);
    assert.equal(withBill.points[10].balance, 800);
  });

  await t.test('weekly bills recur multiple times within the horizon', () => {
    const recurring = [{ amount: 10, frequency: 'weekly', nextDue: daysAfter(1), name: 'Weekly' }];
    const fc = InsightsEngine.forecastBalance([], ACCT, { horizonDays: 30, asOf: ASOF, recurring });
    assert.ok(fc.scheduled.length >= 4, `expected >=4 weekly occurrences, got ${fc.scheduled.length}`);
  });

  await t.test('subscription-tagged history is excluded from the run-rate (no double count)', () => {
    const txns = [];
    for (let i = 1; i <= 30; i++) txns.push({ type: 'expense', amount: 50, date: daysBefore(i), accountId: 'a', tags: ['subscription'] });
    const fc = InsightsEngine.forecastBalance(txns, ACCT, { horizonDays: 30, lookbackDays: 90, asOf: ASOF });
    assert.equal(fc.runRate, 0, 'tagged subscription spend does not move the trend');
    assert.equal(fc.basis.sampleCount, 0);
  });
});

test('recommendBudgets', async (t) => {
  // ASOF = 2026-06-16 → trailing 3 full months = Mar, Apr, May 2026
  const mk = (mo, day, amount, categoryId, type = 'expense') =>
    ({ type, amount, categoryId, date: `2026-${String(mo).padStart(2,'0')}-${String(day).padStart(2,'0')}` });

  await t.test('averages spend over the trailing 3 months and rounds up to $5', () => {
    const txns = [
      mk(3, 10, 200, 'food'), mk(4, 10, 220, 'food'), mk(5, 10, 210, 'food'), // avg 210 → 210
      mk(5, 12, 12,  'coffee'),                                                // 12/3 = 4 → 4 (<10, ceil to 1s)
    ];
    const recs = InsightsEngine.recommendBudgets(txns, { months: 3, asOf: ASOF });
    const food = recs.find(r => r.categoryId === 'food');
    assert.equal(food.amount, 210);
    assert.equal(food.monthsWithData, 3);
    const coffee = recs.find(r => r.categoryId === 'coffee');
    assert.equal(coffee.amount, 4);
  });

  await t.test('excludes the current (partial) month and ignores income/transfers/uncategorized', () => {
    const txns = [
      mk(6, 5, 999, 'food'),                 // current month — excluded
      mk(4, 5, 90,  'food'),                 // counted (90/3 = 30)
      mk(4, 6, 5000, 'salary', 'income'),    // income — ignored
      mk(4, 7, 100, null),                   // uncategorized — ignored
      { type: 'transfer', amount: 500, categoryId: 'x', date: '2026-04-08' }, // ignored
    ];
    const recs = InsightsEngine.recommendBudgets(txns, { months: 3, asOf: ASOF });
    assert.equal(recs.length, 1);
    assert.equal(recs[0].categoryId, 'food');
    assert.equal(recs[0].amount, 30);
  });

  await t.test('returns results sorted by amount desc; empty input → []', () => {
    const txns = [mk(4, 1, 60, 'small'), mk(4, 2, 600, 'big')];
    const recs = InsightsEngine.recommendBudgets(txns, { months: 3, asOf: ASOF });
    assert.deepEqual(recs.map(r => r.categoryId), ['big', 'small']);
    assert.deepEqual(InsightsEngine.recommendBudgets([], { asOf: ASOF }), []);
  });
});

test('generateInsights', async (t) => {
  // ASOF = 2026-06-16 → current month 2026-06, last 2026-05, trailing 05/04/03
  const ex = (mo, day, amount, categoryId, note, tags) =>
    ({ type: 'expense', amount, categoryId, note, tags, date: `2026-${String(mo).padStart(2,'0')}-${String(day).padStart(2,'0')}` });
  const income = (mo, day, amount) => ({ type: 'income', amount, date: `2026-${String(mo).padStart(2,'0')}-${String(day).padStart(2,'0')}` });

  await t.test('flags overall spending up vs last month', () => {
    const txns = [ ex(6,10,600,'food','x'), ex(5,10,400,'food','x') ];
    const ins = InsightsEngine.generateInsights(txns, { asOf: ASOF });
    const trend = ins.find(i => i.kind === 'spendTrend');
    assert.ok(trend, 'has spendTrend');
    assert.equal(trend.tone, 'down');         // spending up = bad
    assert.equal(trend.pct, 50);
    assert.equal(trend.diff, 200);
  });

  await t.test('flags a category spike vs its trailing average', () => {
    const txns = [
      ex(6,8,200,'food','groceries'),  // current
      ex(5,8,50,'food','groceries'), ex(4,8,50,'food','groceries'), ex(3,8,50,'food','groceries'), // avg 50
    ];
    const spike = InsightsEngine.generateInsights(txns, { asOf: ASOF }).find(i => i.kind === 'categorySpike');
    assert.ok(spike, 'has categorySpike');
    assert.equal(spike.categoryId, 'food');
    assert.equal(spike.pct, 300);             // 200 vs avg 50 = +300%
  });

  await t.test('only compares the same days of last month', () => {
    // ASOF is the 16th: last month's spending after the 16th doesn't count
    const txns = [ ex(6,10,300,'food','x'), ex(5,10,300,'food','x'), ex(5,25,900,'food','x') ];
    const trend = InsightsEngine.generateInsights(txns, { asOf: ASOF }).find(i => i.kind === 'spendTrend');
    assert.equal(trend, undefined, 'same pace → no "spending is down" alarm');
  });

  await t.test('flags a change in savings rate between complete months', () => {
    const txns = [
      income(5,1,1000), ex(5,2,200,'food','x'),   // May (last complete month): rate 0.8
      income(4,1,1000), ex(4,2,600,'food','x'),   // April: rate 0.4
      income(6,1,1000), ex(6,2,990,'food','x'),   // June is in progress — ignored
    ];
    const sr = InsightsEngine.generateInsights(txns, { asOf: ASOF }).find(i => i.kind === 'savingsRate');
    assert.ok(sr, 'has savingsRate');
    assert.equal(sr.tone, 'up');              // saving more = good
    assert.ok(Math.abs(sr.delta - 0.4) < 1e-9);
    assert.equal(sr.month, '2026-05');
  });

  await t.test('caps untracked recurring charges at two, biggest first', () => {
    const rec = (note, amt) => [3,4,5].map(m => ex(m,5,amt,'bills',note));
    const txns = [...rec('Rent', 1200), ...rec('Phone', 55), ...rec('Internet', 65), ...rec('Gym', 40)];
    const r = InsightsEngine.generateInsights(txns, { asOf: ASOF }).filter(i => i.kind === 'untrackedRecurring');
    assert.deepEqual(r.map(x => x.name), ['Rent', 'Internet']);
    assert.equal(r[0].more, 2);
  });

  await t.test('detects an untracked, roughly-monthly recurring charge', () => {
    const txns = [
      ex(3,5,40,'fun','Gym'), ex(4,5,40,'fun','Gym'), ex(5,5,40,'fun','Gym'),
    ];
    const rec = InsightsEngine.generateInsights(txns, { asOf: ASOF }).find(i => i.kind === 'untrackedRecurring');
    assert.ok(rec, 'has untrackedRecurring');
    assert.equal(rec.name, 'Gym');
    assert.equal(rec.count, 3);
    assert.ok(rec.cadenceDays >= 28 && rec.cadenceDays <= 32);
  });

  await t.test('does NOT flag charges already tracked as subscriptions', () => {
    const txns = [
      ex(3,5,18,'fun','Netflix'), ex(4,5,18,'fun','Netflix'), ex(5,5,18,'fun','Netflix'),
    ];
    const subs = [{ name: 'Netflix' }];
    const rec = InsightsEngine.generateInsights(txns, { asOf: ASOF, subscriptions: subs }).find(i => i.kind === 'untrackedRecurring');
    assert.equal(rec, undefined);
    // tagged 'subscription' is likewise excluded
    const tagged = [ ex(3,5,18,'fun','HBO',['subscription']), ex(4,5,18,'fun','HBO',['subscription']), ex(5,5,18,'fun','HBO',['subscription']) ];
    assert.equal(InsightsEngine.generateInsights(tagged, { asOf: ASOF }).find(i => i.kind === 'untrackedRecurring'), undefined);
  });

  await t.test('quiet history yields no insights, capped at max', () => {
    assert.deepEqual(InsightsEngine.generateInsights([], { asOf: ASOF }), []);
  });
});

test('suggestCategory', async (t) => {
  const tx = (note, categoryId, type = 'expense', date = '2026-05-01') => ({ note, categoryId, type, date });
  const history = [
    tx('Loblaws', 'groceries', 'expense', '2026-04-01'),
    tx('Loblaws #4821', 'groceries', 'expense', '2026-05-01'),
    tx('Starbucks Coffee', 'coffee', 'expense', '2026-05-02'),
    tx('Payroll deposit', 'salary', 'income', '2026-05-03'),
  ];

  await t.test('accents do not split a merchant', () => {
    const h = [tx('Café Myriade', 'coffee'), tx('Cafe Myriade', 'coffee')];
    const r = InsightsEngine.suggestCategory('café myriade', h, { type: 'expense' });
    assert.equal(r.confidence, 'exact');
    assert.equal(r.count, 2);
  });

  await t.test('exact normalized match (ignores digits/punctuation)', () => {
    const r = InsightsEngine.suggestCategory('loblaws #99', history, { type: 'expense' });
    assert.equal(r.categoryId, 'groceries');
    assert.equal(r.confidence, 'exact');
    assert.equal(r.count, 2);
  });

  await t.test('token-overlap fallback when no exact match', () => {
    const r = InsightsEngine.suggestCategory('Starbucks downtown', history, { type: 'expense' });
    assert.equal(r.categoryId, 'coffee');
    assert.equal(r.confidence, 'similar');
  });

  await t.test('respects type — an income note does not borrow expense categories', () => {
    const r = InsightsEngine.suggestCategory('Payroll', history, { type: 'income' });
    assert.equal(r.categoryId, 'salary');
    // and an expense lookup never returns the income category
    const e = InsightsEngine.suggestCategory('Payroll', history, { type: 'expense' });
    assert.equal(e, null);
  });

  await t.test('most-used category wins among matches', () => {
    const h = [
      tx('Uber', 'transport', 'expense', '2026-04-01'),
      tx('Uber', 'transport', 'expense', '2026-04-15'),
      tx('Uber', 'fun', 'expense', '2026-05-01'),
    ];
    assert.equal(InsightsEngine.suggestCategory('uber', h, { type: 'expense' }).categoryId, 'transport');
  });

  await t.test('no history, empty note, or no match → null', () => {
    assert.equal(InsightsEngine.suggestCategory('Loblaws', [], { type: 'expense' }), null);
    assert.equal(InsightsEngine.suggestCategory('', history, { type: 'expense' }), null);
    assert.equal(InsightsEngine.suggestCategory('xyzzy zzz', history, { type: 'expense' }), null);
  });
});

test('forecastBalance — variance band & transfers', async (t) => {
  await t.test('the confidence band widens further into the future', () => {
    // alternating swings create volatility
    const txns = [];
    for (let i = 1; i <= 30; i++) txns.push({ type: i % 2 ? 'income' : 'expense', amount: 100, date: daysBefore(i), accountId: 'a' });
    const fc = InsightsEngine.forecastBalance(txns, ACCT, { horizonDays: 30, lookbackDays: 90, asOf: ASOF });
    assert.ok(fc.volatility > 0, 'has volatility');
    const w1  = fc.points[1].upper  - fc.points[1].lower;
    const w30 = fc.points[30].upper - fc.points[30].lower;
    assert.ok(w30 > w1, 'band at day 30 wider than at day 1');
  });

  await t.test('transfers do not affect the trend', () => {
    const txns = [{ type: 'transfer', amount: 500, date: daysBefore(5), accountId: 'a', toAccountId: 'b' }];
    const fc = InsightsEngine.forecastBalance(txns, [{ id: 'a', initialBalance: 1000 }, { id: 'b', initialBalance: 0 }], { horizonDays: 30, asOf: ASOF });
    assert.equal(fc.runRate, 0);
    assert.ok(fc.points.every(p => p.balance === 1000));
  });
});

test('upcomingBills', async (t) => {
  await t.test('lists the next bills in date order with daysUntil', () => {
    const subs = [
      { id: 'r', name: 'Rent',    amount: 1200, frequency: 'monthly', nextDue: daysAfter(12) },
      { id: 'n', name: 'Netflix', amount: 18,   frequency: 'monthly', nextDue: daysAfter(3)  },
    ];
    const u = InsightsEngine.upcomingBills(subs, { asOf: ASOF, withinDays: 30 });
    assert.deepEqual(u.bills.map(b => b.name), ['Netflix', 'Rent']);
    assert.equal(u.bills[0].daysUntil, 3);
    assert.equal(u.bills[1].daysUntil, 12);
    assert.equal(u.count, 2);
  });

  await t.test('normalizes cost to monthly + annual across all active subs', () => {
    const subs = [
      { id: 'm', name: 'Monthly', amount: 10, frequency: 'monthly', nextDue: daysAfter(5) },
      { id: 'y', name: 'Yearly',  amount: 120, frequency: 'yearly', nextDue: daysAfter(40) },
      { id: 'w', name: 'Weekly',  amount: 5,  frequency: 'weekly',  nextDue: daysAfter(1) },
    ];
    const u = InsightsEngine.upcomingBills(subs, { asOf: ASOF, withinDays: 30 });
    // 10 (monthly) + 10 (120/yr) + 5*52/12≈21.67 ≈ 41.67/mo
    assert.ok(Math.abs(u.monthlyTotal - 41.67) < 0.05, `monthly ~41.67, got ${u.monthlyTotal}`);
    assert.ok(Math.abs(u.annualTotal - 500) < 0.6, `annual ~500, got ${u.annualTotal}`);
  });

  await t.test('a weekly bill recurs several times within the window', () => {
    const subs = [{ id: 'w', name: 'Weekly', amount: 5, frequency: 'weekly', nextDue: daysAfter(1) }];
    const u = InsightsEngine.upcomingBills(subs, { asOf: ASOF, withinDays: 30, max: 10 });
    assert.ok(u.bills.length >= 4, `expected >=4 weekly occurrences, got ${u.bills.length}`);
    assert.ok(u.bills.every(b => b.name === 'Weekly'));
  });

  await t.test('overdue bills surface with a negative daysUntil; inactive/zero are skipped', () => {
    const subs = [
      { id: 'o', name: 'Overdue', amount: 9,  frequency: 'monthly', nextDue: daysBefore(2) },
      { id: 'x', name: 'Paused',  amount: 9,  frequency: 'monthly', nextDue: daysAfter(2), active: false },
      { id: 'z', name: 'Free',    amount: 0,  frequency: 'monthly', nextDue: daysAfter(2) },
    ];
    const u = InsightsEngine.upcomingBills(subs, { asOf: ASOF, withinDays: 30 });
    assert.equal(u.count, 1);
    assert.equal(u.bills[0].name, 'Overdue');
    assert.equal(u.bills[0].daysUntil, -2);
  });

  await t.test('caps the list at max and empty input → no bills', () => {
    const subs = Array.from({ length: 8 }, (_, i) => ({ id: 'b' + i, name: 'B' + i, amount: 5, frequency: 'monthly', nextDue: daysAfter(i + 1) }));
    assert.equal(InsightsEngine.upcomingBills(subs, { asOf: ASOF, max: 3 }).bills.length, 3);
    const none = InsightsEngine.upcomingBills([], { asOf: ASOF });
    assert.deepEqual(none.bills, []);
    assert.equal(none.monthlyTotal, 0);
    assert.equal(none.count, 0);
  });
});
