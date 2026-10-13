/* ============================================================
   Unit tests for the bank-statement import helpers in
   scripts/data/store.js (CSVService.analyze / mapRows / parseOFX /
   markDuplicates / guessCategory and friends).

   The sample files mimic the shapes Canadian banks export; they are
   hand-written fixtures, not real statements.

   Run:  node --test tests/      (or: npm test)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

global.localStorage = { getItem: () => null };
const { CSVService } = require('../scripts/data/store.js');

/* analyze + mapRows with whatever was detected */
function importText(text, extra = {}) {
  const a = CSVService.analyze(text);
  const dateIdx = a.detect.dateIdx;
  const opts = {
    ...a.detect,
    dayFirst: CSVService.guessDayFirst(a.rows.map(r => r[dateIdx])),
    expensesPositive: a.detect.amountIdx >= 0
      && CSVService.guessExpensesPositive(a.rows.map(r => r[a.detect.amountIdx])),
    ...extra,
  };
  return { a, rows: CSVService.mapRows(a.rows, opts) };
}

test('CSVService.parseDate — compact dates', async (t) => {
  await t.test('YYYYMMDD (BMO)', () => {
    assert.equal(CSVService.parseDate('20260115'), '2026-01-15');
  });
  await t.test('OFX timestamp with timezone suffix', () => {
    assert.equal(CSVService.parseDate('20260115120000[-5:EST]'), '2026-01-15');
    assert.equal(CSVService.parseDate('20260115120000.000'), '2026-01-15');
  });
  await t.test('rejects impossible compact dates', () => {
    assert.equal(CSVService.parseDate('20261340'), '');
  });
});

test('CSVService.guessDayFirst', async (t) => {
  await t.test('a day > 12 in the first slot proves day-first', () => {
    assert.equal(CSVService.guessDayFirst(['03/04/2026', '25/04/2026']), true);
  });
  await t.test('a day > 12 in the second slot proves month-first', () => {
    assert.equal(CSVService.guessDayFirst(['03/04/2026', '04/25/2026']), false);
  });
  await t.test('all ambiguous → month-first', () => {
    assert.equal(CSVService.guessDayFirst(['01/02/2026']), false);
  });
});

test('CSVService.detectDelimiter', async (t) => {
  await t.test('semicolon (French-locale exports)', () => {
    assert.equal(CSVService.detectDelimiter('Date;Description;Montant\n2026-01-02;Café;-4,50'), ';');
  });
  await t.test('defaults to comma', () => {
    assert.equal(CSVService.detectDelimiter('Date,Amount\n'), ',');
  });
});

test('CSVService.analyze — header-less exports', async (t) => {
  await t.test('debit / credit / balance (TD-style)', () => {
    const csv = [
      '01/05/2026,STARBUCKS #1234,5.25,,1994.75',
      '01/06/2026,PAYROLL DEPOSIT,,1200.00,3194.75',
      '01/07/2026,LOBLAWS 1029,84.10,,3110.65',
      '01/13/2026,NETFLIX.COM,16.99,,3093.66',
    ].join('\n');
    const { a, rows } = importText(csv);
    assert.equal(a.headerless, true);
    assert.equal(a.detect.mode, 'debitcredit');
    assert.equal(a.detect.debitIdx, 2);
    assert.equal(a.detect.creditIdx, 3);
    assert.equal(a.detect.descIdx, 1);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], { date: '2026-01-05', note: 'STARBUCKS #1234', amount: 5.25, type: 'expense', ok: true });
    assert.equal(rows[1].type, 'income');
    assert.equal(rows[1].amount, 1200);
  });

  await t.test('card statement: full debit column + sparse payments still pairs', () => {
    const csv = [
      '2026-01-05,TIM HORTONS #22,3.10,,4500********1234',
      '2026-01-06,SHELL C01234,60.00,,4500********1234',
      '2026-01-08,UBER EATS,22.40,,4500********1234',
      '2026-01-09,AMAZON.CA,40.00,,4500********1234',
      '2026-01-10,AIR CANADA,410.00,,4500********1234',
      '2026-01-11,PAYMENT THANK YOU,,500.00,4500********1234',
    ].join('\n');
    const { a, rows } = importText(csv);
    assert.equal(a.detect.mode, 'debitcredit');
    assert.equal(rows.filter(r => r.type === 'income').length, 1);
  });

  await t.test('one signed amount column (Scotiabank-style)', () => {
    const csv = [
      '1/5/2026,-5.25,-,POS PURCHASE,STARBUCKS',
      '1/6/2026,1200,-,DEPOSIT,PAYROLL',
      '1/7/2026,-84.1,-,POS PURCHASE,LOBLAWS',
    ].join('\n');
    const { a, rows } = importText(csv);
    assert.equal(a.detect.mode, 'signed');
    assert.equal(a.detect.amountIdx, 1);
    assert.equal(rows[0].type, 'expense');
    assert.equal(rows[1].type, 'income');
  });
});

test('CSVService.analyze — known bank headers', async (t) => {
  await t.test('RBC: CAD$ amount + two description columns', () => {
    const csv = [
      '"Account Type","Account Number","Transaction Date","Cheque Number","Description 1","Description 2","CAD$","USD$"',
      'Chequing,01234-5678901,1/5/2026,,"STARBUCKS","TORONTO ON",-5.25,',
      'Chequing,01234-5678901,1/6/2026,,"PAYROLL","ACME INC",1200.00,',
    ].join('\n');
    const { a, rows } = importText(csv);
    assert.equal(a.bank, 'RBC');
    assert.equal(rows[0].note, 'STARBUCKS · TORONTO ON');
    assert.equal(rows[0].type, 'expense');
    assert.equal(rows[1].type, 'income');
  });

  await t.test('BMO: preamble lines skipped, compact dates', () => {
    const csv = [
      'Following data is valid as of 20260115120000 (Year/Month/Day/Hour/Minute/Second)',
      '',
      'First Bank Card,Transaction Type,Date Posted, Transaction Amount,Description',
      "'5555000011112222',DEBIT,20260105,-5.25,[DN]STARBUCKS",
      "'5555000011112222',CREDIT,20260106,1200.00,[DD]PAYROLL",
    ].join('\n');
    const { a, rows } = importText(csv);
    assert.equal(a.bank, 'BMO');
    assert.equal(a.rows.length, 2);
    assert.equal(rows[0].date, '2026-01-05');
    assert.equal(rows[0].type, 'expense');
    assert.equal(rows[1].type, 'income');
  });

  await t.test('Tangerine: Name (merchant) is the description, not Memo', () => {
    const csv = [
      'Transaction date,Transaction,Name,Memo,Amount',
      '1/5/2026,DEBIT,STARBUCKS,Rewards earned: 0.05,-5.25',
    ].join('\n');
    const { a, rows } = importText(csv);
    assert.equal(a.bank, 'Tangerine');
    assert.equal(rows[0].note, 'STARBUCKS');
  });

  await t.test('generic headers still use autoDetect', () => {
    const { a } = importText('Date,Description,Amount\n2026-01-05,Coffee,-4.50');
    assert.equal(a.bank, null);
    assert.equal(a.headerless, false);
    assert.equal(a.detect.amountIdx, 2);
  });

  await t.test('"Account Type" is not mistaken for a direction column', () => {
    const m = CSVService.autoDetect(['Account Type', 'Date', 'Description', 'Amount']);
    assert.equal(m.typeIdx, -1);
    assert.equal(m.mode, 'signed');
  });
});

test('CSVService.mapRows — sign conventions', async (t) => {
  const rows = [['2026-01-05', 'Coffee', '5.25'], ['2026-01-06', 'Payment', '-100']];
  const base = { dateIdx: 0, descIdx: 1, desc2Idx: -1, amountIdx: 2, typeIdx: -1, mode: 'signed' };
  await t.test('credit-card style: expenses positive', () => {
    const out = CSVService.mapRows(rows, { ...base, expensesPositive: true });
    assert.equal(out[0].type, 'expense');
    assert.equal(out[1].type, 'income');
  });
  await t.test('bank style: expenses negative', () => {
    const out = CSVService.mapRows(rows, { ...base, expensesPositive: false });
    assert.equal(out[0].type, 'income');
    assert.equal(out[1].type, 'expense');
  });
  await t.test('guessExpensesPositive picks the dominant sign', () => {
    assert.equal(CSVService.guessExpensesPositive(['5', '6', '7', '-100']), true);
    assert.equal(CSVService.guessExpensesPositive(['-5', '-6', '-7', '100']), false);
  });
  await t.test('DEBIT / CREDIT type column is honoured', () => {
    const out = CSVService.mapRows([['2026-01-05', 'x', '5', 'CREDIT']],
      { ...base, typeIdx: 3, expensesPositive: true });
    assert.equal(out[0].type, 'income');
  });
  await t.test('unreadable rows are flagged, not dropped', () => {
    const out = CSVService.mapRows([['not a date', 'x', '5']], { ...base });
    assert.equal(out[0].ok, false);
  });
});

test('CSVService.parseOFX', async (t) => {
  await t.test('SGML OFX 1.x (unclosed tags, as QFX downloads ship)', () => {
    const ofx = `OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260105120000[-5:EST]
<TRNAMT>-5.25
<FITID>90000001
<NAME>STARBUCKS #1234
<MEMO>TORONTO ON
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260106
<TRNAMT>1200.00
<FITID>90000002
<NAME>PAYROLL &amp; BENEFITS
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const out = CSVService.parseOFX(ofx);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { date: '2026-01-05', note: 'STARBUCKS #1234 · TORONTO ON', amount: -5.25, fitid: '90000001' });
    assert.equal(out[1].note, 'PAYROLL & BENEFITS');
    assert.equal(out[1].amount, 1200);
  });

  await t.test('XML OFX 2.x (closed tags)', () => {
    const ofx = '<?xml version="1.0"?><OFX><BANKTRANLIST>'
      + '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260105</DTPOSTED><TRNAMT>-5.25</TRNAMT>'
      + '<FITID>1</FITID><NAME>STARBUCKS</NAME><MEMO>STARBUCKS</MEMO></STMTTRN>'
      + '</BANKTRANLIST></OFX>';
    const out = CSVService.parseOFX(ofx);
    assert.equal(out.length, 1);
    assert.equal(out[0].note, 'STARBUCKS');   /* memo repeating the name isn't doubled */
  });

  await t.test('no transactions → empty list', () => {
    assert.deepEqual(CSVService.parseOFX('<OFX></OFX>'), []);
  });
});

test('CSVService.markDuplicates', async (t) => {
  const row = (date, amount, note, type = 'expense') => ({ date, amount, note, type, ok: true });

  await t.test('exact re-import is flagged', () => {
    const existing = [{ accountId: 'a', date: '2026-01-05', amount: 5.25, note: 'STARBUCKS', type: 'expense' }];
    const rows = CSVService.markDuplicates([row('2026-01-05', 5.25, 'starbucks')], existing, 'a');
    assert.equal(rows[0].dup, 'exact');
  });

  await t.test('a hand-logged entry a day apart is "likely"', () => {
    const existing = [{ accountId: 'a', date: '2026-01-04', amount: 5.25, note: 'coffee', type: 'expense' }];
    const rows = CSVService.markDuplicates([row('2026-01-05', 5.25, 'STARBUCKS #12')], existing, 'a');
    assert.equal(rows[0].dup, 'likely');
    assert.equal(rows[0].match.note, 'coffee');
  });

  await t.test('outside the window, other account, or other direction → not a dup', () => {
    const existing = [
      { accountId: 'a', date: '2026-01-01', amount: 5.25, note: 'x', type: 'expense' },
      { accountId: 'b', date: '2026-01-05', amount: 5.25, note: 'x', type: 'expense' },
      { accountId: 'a', date: '2026-01-05', amount: 5.25, note: 'x', type: 'income' },
    ];
    const rows = CSVService.markDuplicates([row('2026-01-05', 5.25, 'y')], existing, 'a');
    assert.equal(rows[0].dup, null);
  });

  await t.test('one existing tx absorbs only one imported row', () => {
    const existing = [{ accountId: 'a', date: '2026-01-05', amount: 2, note: 'TIM HORTONS', type: 'expense' }];
    const rows = CSVService.markDuplicates(
      [row('2026-01-05', 2, 'TIM HORTONS'), row('2026-01-05', 2, 'TIM HORTONS')], existing, 'a');
    assert.deepEqual(rows.map(r => r.dup), ['exact', null]);
  });

  await t.test('transfers match money out of the source / into the destination', () => {
    const existing = [{ accountId: 'chq', toAccountId: 'card', date: '2026-01-10', amount: 500, note: 'card payment', type: 'transfer' }];
    const out = CSVService.markDuplicates([row('2026-01-10', 500, 'PAYMENT', 'expense')], existing, 'chq');
    const into = CSVService.markDuplicates([row('2026-01-11', 500, 'PAYMENT THANK YOU', 'income')], existing, 'card');
    assert.equal(out[0].dup, 'likely');
    assert.equal(into[0].dup, 'likely');
  });

  await t.test('unreadable rows are never matched', () => {
    const existing = [{ accountId: 'a', date: '2026-01-05', amount: 5, note: '', type: 'expense' }];
    const rows = CSVService.markDuplicates([{ date: '', amount: NaN, note: '', type: 'expense', ok: false }], existing, 'a');
    assert.equal(rows[0].dup, null);
  });
});

test('CSVService.guessCategory', async (t) => {
  await t.test('common Canadian merchants', () => {
    assert.equal(CSVService.guessCategory('TIM HORTONS #2231 MONTREAL', 'expense'), 'cat-food');
    assert.equal(CSVService.guessCategory('POS PURCHASE LOBLAWS 1029', 'expense'), 'cat-groceries');
    assert.equal(CSVService.guessCategory('PETRO-CANADA 4410', 'expense'), 'cat-transport');
    assert.equal(CSVService.guessCategory('NETFLIX.COM', 'expense'), 'cat-subs');
    assert.equal(CSVService.guessCategory('HYDRO-QUEBEC', 'expense'), 'cat-bills');
    assert.equal(CSVService.guessCategory('PHARMAPRIX #123', 'expense'), 'cat-health');
  });
  await t.test('"uber eats" is food, plain "uber" is transport', () => {
    assert.equal(CSVService.guessCategory('UBER EATS TORONTO', 'expense'), 'cat-food');
    assert.equal(CSVService.guessCategory('UBER *TRIP', 'expense'), 'cat-transport');
  });
  await t.test('whole words only', () => {
    assert.equal(CSVService.guessCategory('SHELLFISH MARKET', 'expense'), null);
    assert.equal(CSVService.guessCategory('TACO BELL #44', 'expense'), 'cat-food');
  });
  await t.test('income rules only fire for income and vice versa', () => {
    assert.equal(CSVService.guessCategory('ACME PAYROLL', 'income'), 'cat-salary');
    assert.equal(CSVService.guessCategory('ACME PAYROLL', 'expense'), null);
    assert.equal(CSVService.guessCategory('STARBUCKS', 'income'), null);
  });
  await t.test('unknown → null', () => {
    assert.equal(CSVService.guessCategory('XYZ CORP 1234', 'expense'), null);
    assert.equal(CSVService.guessCategory('', 'expense'), null);
  });
});
