/* ============================================================
   Unit tests for the pure helpers in scripts/data/store.js:
   the CSV tokenizer (CSVService._parse) and the date/currency
   formatters. The store methods (TransactionStore, etc.) need a
   live Supabase client and are not unit-tested here.

   Run:  node --test tests/      (or: npm test)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

/* formatCurrency reads the chosen currency from localStorage; stub it
   before requiring the module so the formatter has something to read. */
let CURRENCY = 'CAD';
global.localStorage = { getItem: (k) => (k === 'pf_currency' ? CURRENCY : null) };

const { CSVService, isoLocal, formatCurrency, formatBalance, formatSigned, signColor, formatDate, formatDateShort, resolveBudgetMonth } = require('../scripts/data/store.js');

/* ---- CSV tokenizer (the RFC-4180-ish parser) ---- */
test('CSVService._parse', async (t) => {
  await t.test('splits a simple grid of rows and cells', () => {
    assert.deepEqual(
      CSVService._parse('a,b,c\n1,2,3'),
      [['a', 'b', 'c'], ['1', '2', '3']],
    );
  });

  await t.test('keeps commas that live inside a quoted field', () => {
    assert.deepEqual(
      CSVService._parse('note,amount\n"Coffee, milk and sugar",4'),
      [['note', 'amount'], ['Coffee, milk and sugar', '4']],
    );
  });

  await t.test('unescapes a doubled quote ("") to a single quote', () => {
    assert.deepEqual(
      CSVService._parse('note\n"She said ""hi"""'),
      [['note'], ['She said "hi"']],
    );
  });

  await t.test('keeps a newline embedded in a quoted field', () => {
    assert.deepEqual(
      CSVService._parse('note\n"line one\nline two"'),
      [['note'], ['line one\nline two']],
    );
  });

  await t.test('handles CRLF line endings', () => {
    assert.deepEqual(
      CSVService._parse('a,b\r\n1,2\r\n'),
      [['a', 'b'], ['1', '2']],
    );
  });

  await t.test('a trailing newline does not create a spurious empty row', () => {
    assert.equal(CSVService._parse('a,b\n1,2\n').length, 2);
  });

  await t.test('preserves an empty cell between two commas', () => {
    assert.deepEqual(CSVService._parse('1,,3'), [['1', '', '3']]);
  });

  await t.test('empty input yields no rows', () => {
    assert.deepEqual(CSVService._parse(''), []);
  });

  await t.test('round-trips an export-shaped row with a quoted note + tags', () => {
    const csv =
      'date,type,amount,note,category,account,to_account,tags\n' +
      '2026-06-01,expense,12.50,"Lunch, downtown","Food","Main","","work;lunch"';
    const [header, row] = CSVService._parse(csv);
    assert.deepEqual(header, CSVService.HEADERS);
    assert.deepEqual(row, ['2026-06-01', 'expense', '12.50', 'Lunch, downtown', 'Food', 'Main', '', 'work;lunch']);
  });
});

/* ---- bank-import helpers: splitRows / parseAmount / parseDate / autoDetect ---- */
test('CSVService.splitRows', async (t) => {
  await t.test('separates the header from the data rows', () => {
    const { header, rows } = CSVService.splitRows('Date,Amount\n2026-06-01,-4.50');
    assert.deepEqual(header, ['Date', 'Amount']);
    assert.deepEqual(rows, [['2026-06-01', '-4.50']]);
  });
  await t.test('empty text yields empty header and rows', () => {
    assert.deepEqual(CSVService.splitRows(''), { header: [], rows: [] });
  });
});

test('CSVService.parseAmount', async (t) => {
  await t.test('plain and signed decimals', () => {
    assert.equal(CSVService.parseAmount('4.50'), 4.5);
    assert.equal(CSVService.parseAmount('-4.50'), -4.5);
  });
  await t.test('strips currency symbols and thousands separators', () => {
    assert.equal(CSVService.parseAmount('$1,234.56'), 1234.56);
    assert.equal(CSVService.parseAmount('CA$ 2,000'), 2000);
  });
  await t.test('accounting parentheses mean negative', () => {
    assert.equal(CSVService.parseAmount('(4.50)'), -4.5);
  });
  await t.test('trailing minus means negative', () => {
    assert.equal(CSVService.parseAmount('4.50-'), -4.5);
  });
  await t.test('European 1.234,56 grouping', () => {
    assert.equal(CSVService.parseAmount('1.234,56'), 1234.56);
  });
  await t.test('comma as a decimal separator', () => {
    assert.equal(CSVService.parseAmount('12,50'), 12.5);
  });
  await t.test('blank / non-numeric yields NaN', () => {
    assert.ok(Number.isNaN(CSVService.parseAmount('')));
    assert.ok(Number.isNaN(CSVService.parseAmount('n/a')));
  });
});

test('CSVService.parseDate', async (t) => {
  await t.test('ISO passes through', () => {
    assert.equal(CSVService.parseDate('2026-06-09'), '2026-06-09');
    assert.equal(CSVService.parseDate('2026/6/9'), '2026-06-09');
  });
  await t.test('MM/DD/YYYY by default, DD/MM with dayFirst', () => {
    assert.equal(CSVService.parseDate('03/04/2026'), '2026-03-04');
    assert.equal(CSVService.parseDate('03/04/2026', true), '2026-04-03');
  });
  await t.test('a part over 12 disambiguates regardless of the hint', () => {
    assert.equal(CSVService.parseDate('25/12/2026'), '2026-12-25');
    assert.equal(CSVService.parseDate('12/25/2026', true), '2026-12-25');
  });
  await t.test('2-digit year expands into the 2000s', () => {
    assert.equal(CSVService.parseDate('01/02/26'), '2026-01-02');
  });
  await t.test('a named month parses', () => {
    assert.equal(CSVService.parseDate('Jan 5, 2026'), '2026-01-05');
  });
  await t.test('junk yields an empty string', () => {
    assert.equal(CSVService.parseDate('not a date'), '');
    assert.equal(CSVService.parseDate(''), '');
  });
});

test('CSVService.autoDetect', async (t) => {
  await t.test('detects a single signed-amount layout', () => {
    const m = CSVService.autoDetect(['Date', 'Description', 'Amount', 'Balance']);
    assert.equal(m.dateIdx, 0);
    assert.equal(m.descIdx, 1);
    assert.equal(m.amountIdx, 2);
    assert.equal(m.mode, 'signed');
  });
  await t.test('detects separate debit / credit columns', () => {
    const m = CSVService.autoDetect(['Posted Date', 'Details', 'Debit', 'Credit']);
    assert.equal(m.debitIdx, 2);
    assert.equal(m.creditIdx, 3);
    assert.equal(m.mode, 'debitcredit');
  });
  await t.test('our own export is recognised as typed', () => {
    const m = CSVService.autoDetect(CSVService.HEADERS);
    assert.equal(m.mode, 'typed');
    assert.ok(m.typeIdx >= 0 && m.amountIdx >= 0);
  });
});

/* ---- isoLocal: LOCAL calendar date (the UTC day-shift bug fix) ---- */
test('isoLocal', async (t) => {
  await t.test('reads the local calendar fields, never the UTC day', () => {
    // 23:30 local stays on the 9th — toISOString() would have rolled it to
    // the 10th for any timezone ahead of UTC. This is the bug isoLocal fixes.
    assert.equal(isoLocal(new Date(2026, 5, 9, 23, 30)), '2026-06-09');
    // ...and 00:30 local stays on the 9th for timezones behind UTC.
    assert.equal(isoLocal(new Date(2026, 5, 9, 0, 30)), '2026-06-09');
  });

  await t.test('zero-pads single-digit months and days', () => {
    assert.equal(isoLocal(new Date(2026, 0, 5)), '2026-01-05');
  });
});

/* ---- date formatters ---- */
test('formatDate / formatDateShort', async (t) => {
  await t.test('formats an ISO date with and without the year', () => {
    assert.equal(formatDate('2026-06-09'), 'Jun 9, 2026');
    const y = new Date().getFullYear();
    assert.equal(formatDateShort(`${y}-06-09`), 'Jun 9', 'this year: no year');
    assert.equal(formatDateShort(`${y - 2}-04-03`), `Apr 3, ${y - 2}`, 'other years: with year');
  });

  await t.test('blank input yields an empty string', () => {
    assert.equal(formatDate(''), '');
    assert.equal(formatDateShort(null), '');
  });

  await t.test('parses at local midnight so the day never shifts', () => {
    // The +T00:00:00 suffix keeps "the 1st" rendering as the 1st, not the
    // last day of the prior month (the UTC day-shift bug this guards against).
    assert.equal(formatDate('2026-03-01'), 'Mar 1, 2026');
  });
});

/* ---- formatCurrency: the CAD `$` vs `CA$` symbol bug ---- */
test('formatCurrency', async (t) => {
  t.after(() => { CURRENCY = 'CAD'; });

  await t.test('CAD renders a bare $ (en-CA), not CA$', () => {
    CURRENCY = 'CAD';
    const s = formatCurrency(1234.5);
    assert.ok(s.includes('$'), `has a dollar sign: ${s}`);
    assert.ok(!s.includes('CA$'), `no CA$ prefix: ${s}`);
    assert.ok(s.includes('1,234.50'), `two decimals + grouping: ${s}`);
  });

  await t.test('uses the absolute value (sign handled elsewhere)', () => {
    CURRENCY = 'USD';
    assert.equal(formatCurrency(-50), formatCurrency(50));
  });

  await t.test('JPY shows no decimal places', () => {
    CURRENCY = 'JPY';
    const s = formatCurrency(1000);
    assert.ok(!s.includes('.'), `no decimal point for yen: ${s}`);
  });
});

/* ---- signed variants: balances / nets must not lose their minus ---- */
test('formatBalance / formatSigned', async (t) => {
  t.after(() => { CURRENCY = 'CAD'; });
  CURRENCY = 'CAD';

  await t.test('formatBalance: minus only when negative', () => {
    assert.equal(formatBalance(-14.75), '−' + formatCurrency(14.75));
    assert.equal(formatBalance(14.75), formatCurrency(14.75));
    assert.equal(formatBalance(0), formatCurrency(0));
  });

  await t.test('formatSigned: always + or −', () => {
    assert.equal(formatSigned(-14.75), '−' + formatCurrency(14.75));
    assert.equal(formatSigned(14.75), '+' + formatCurrency(14.75));
    assert.equal(formatSigned(0), formatCurrency(0), 'zero carries no sign');
  });

  await t.test('signColor: neutral at zero', () => {
    assert.equal(signColor(5), 'var(--color-income)');
    assert.equal(signColor(-5), 'var(--color-expense)');
    assert.equal(signColor(0), '');
    assert.equal(signColor(0.001), '');
  });

  await t.test('amounts that round to zero carry no minus', () => {
    assert.equal(formatBalance(-0.001), formatCurrency(0));
    assert.equal(formatSigned(-0.001), formatCurrency(0));
  });
});

/* ---- budgets carry forward month to month ---- */
test('resolveBudgetMonth', async (t) => {
  const all = { '2025-01': { a: 100 }, '2025-03': { a: 150, b: 20 }, '2025-06': {} };
  await t.test('a month with its own entry uses it', () => {
    assert.deepEqual(resolveBudgetMonth(all, '2025-03'), { a: 150, b: 20 });
  });
  await t.test('a month without one inherits the latest earlier month', () => {
    assert.deepEqual(resolveBudgetMonth(all, '2025-02'), { a: 100 });
    assert.deepEqual(resolveBudgetMonth(all, '2025-05'), { a: 150, b: 20 });
  });
  await t.test('an explicit empty month stops the carry-over', () => {
    assert.deepEqual(resolveBudgetMonth(all, '2025-06'), {});
    assert.deepEqual(resolveBudgetMonth(all, '2025-09'), {});
  });
  await t.test('before the first budget there is nothing to inherit', () => {
    assert.deepEqual(resolveBudgetMonth(all, '2024-12'), {});
    assert.deepEqual(resolveBudgetMonth({}, '2025-01'), {});
  });
});
