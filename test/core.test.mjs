import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nozzleLitres,
  readingIssues,
  shiftSummary,
  stockReconciliation,
  dayTotals,
  dayStock,
  freezeDay,
  lastClosedReading,
  dsrCsv,
  toPaise,
  formatPaise,
  r3,
} from '../app/core.mjs';

const nozzles = [
  { id: 'n1', label: 'DU1-N1', product: 'HSD', tankId: 't1' },
  { id: 'n2', label: 'DU1-N2', product: 'MS', tankId: 't2' },
];

const baseState = () => ({
  outlet: { name: 'Test Fuels', omc: 'IOCL' },
  settings: { evaporationPct: { MS: 0.75, HSD: 0 } },
  tanks: [
    { id: 't1', code: 'T1', product: 'HSD', capacityL: 20000 },
    { id: 't2', code: 'T2', product: 'MS', capacityL: 15000 },
  ],
  nozzles,
  rates: { '2026-01-15': { MS: 10450, HSD: 9000 } },
  days: {},
  shifts: [],
});

test('money and volume helpers round predictably', () => {
  assert.equal(toPaise('90.005'), 9001); // 0.5 paise rounds up, no float dust
  assert.equal(toPaise(90), 9000);
  assert.equal(formatPaise(8145000), '81450.00');
  assert.equal(formatPaise(-15050), '-150.50');
  assert.equal(r3(0.1 + 0.2), 0.3);
});

test('net litres subtract testing, which is never a sale', () => {
  const c = nozzleLitres({ opening: 124500, closing: 125410, testing: 5 });
  assert.equal(c.gross, 910);
  assert.equal(c.net, 905);
  assert.equal(c.valid, true);

  // Testing must not be added back to stock later: the book stock formula is
  // opening + receipts - net, and net already excludes the returned fuel.
  const rec = stockReconciliation({
    openingL: 12000, receiptsL: 8000, netSalesL: c.net, physicalL: 19095,
  });
  assert.equal(rec.bookClosing, 19095);
  assert.equal(rec.varianceL, 0);
});

test('reading validation catches the four ways a shift goes wrong', () => {
  assert.deepEqual(readingIssues({ opening: 100, closing: 200, testing: 5 }), []);

  const backwards = readingIssues({ opening: 200, closing: 100 });
  assert.match(backwards.join(' '), /greater than opening/);

  const carried = readingIssues({ opening: 999, closing: 1100 }, 1000);
  assert.match(carried.join(' '), /Carry-forward mismatch/);

  const tooMuchTesting = readingIssues({ opening: 0, closing: 3, testing: 5 });
  assert.match(tooMuchTesting.join(' '), /exceed gross litres/);

  const missing = readingIssues({});
  assert.match(missing.join(' '), /required/);
});

test('shift summary values litres, splits collections and signs short/excess', () => {
  const shift = {
    id: 's1', date: '2026-01-15', seq: 1, status: 'closed',
    readings: { n1: { opening: 124500, closing: 125410, testing: 5 } },
    tenders: { CASH: 4200000, UPI: 2145000, CARD: 800000, CREDIT: 1000000 },
    attendant: 'Ramesh', signedAt: '2026-01-15T14:05:00Z',
  };
  const s = shiftSummary(shift, { nozzles, rates: { HSD: 9000 } });
  assert.equal(s.lines.length, 1);
  assert.equal(s.lines[0].net, 905);
  assert.equal(s.salesValuePaise, 8145000); // 905 x 90.00
  assert.equal(s.collectedPaise, 8145000);
  assert.equal(s.differencePaise, 0);

  const shortShift = { ...shift, tenders: { CASH: 4185000, UPI: 2145000, CARD: 800000, CREDIT: 1000000 } };
  const short = shiftSummary(shortShift, { nozzles, rates: { HSD: 9000 } });
  assert.equal(short.differencePaise, 15000); // +150.00 = short, positive
  assert.equal(formatPaise(short.differencePaise), '150.00');
});

test('stock variance classifies against the MDG band and evaporation allowance', () => {
  const clean = stockReconciliation({
    openingL: 12000, receiptsL: 8000, netSalesL: 905, physicalL: 19095, evaporationPct: 0.75,
  });
  assert.equal(clean.status, 'within');
  assert.equal(clean.varianceL, 0);

  // 55 L loss: beyond the ~6.8 L evaporation allowance, well inside 4% (~761 L).
  const loss = stockReconciliation({
    openingL: 12000, receiptsL: 8000, netSalesL: 905, physicalL: 19040, evaporationPct: 0.75,
  });
  assert.equal(loss.varianceL, -55);
  assert.equal(loss.evaporationAllowL, 6.788); // 905 x 0.75%
  assert.equal(loss.unexplainedL, -48.212);
  assert.equal(loss.status, 'investigate');
  assert.ok(loss.toleranceBandL > 700 && loss.toleranceBandL < 800);

  // Loss beyond 4% of tank stock is what MDG calls beyond permissible limits.
  const big = stockReconciliation({
    openingL: 12000, receiptsL: 8000, netSalesL: 905, physicalL: 17000, evaporationPct: 0.75,
  });
  assert.equal(big.status, 'beyond-mdg');

  // Gain is not "within": a persistent gain means a meter or calibration fault.
  const gain = stockReconciliation({
    openingL: 12000, receiptsL: 8000, netSalesL: 905, physicalL: 19200, evaporationPct: 0.75,
  });
  assert.equal(gain.status, 'investigate');

  // No dip yet means no verdict, and no invented number.
  const pending = stockReconciliation({ openingL: 100, receiptsL: 0, netSalesL: 10 });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.varianceL, null);
});

test('day totals aggregate shifts, products and per-attendant drawers', () => {
  const state = baseState();
  state.shifts = [
    {
      id: 's1', date: '2026-01-15', seq: 1, status: 'closed',
      readings: { n1: { opening: 124500, closing: 125410, testing: 5 } },
      tenders: { CASH: 8145000 }, attendant: 'Ramesh',
    },
    {
      id: 's2', date: '2026-01-15', seq: 2, status: 'closed',
      readings: {
        n1: { opening: 125410, closing: 126410, testing: 5 },
        n2: { opening: 50000, closing: 50100, testing: 5 },
      },
      tenders: { CASH: 9000000, UPI: 1045000 - 45000 }, attendant: 'Suresh',
    },
  ];
  const totals = dayTotals(state, '2026-01-15');

  assert.equal(totals.shifts, 2);
  assert.equal(totals.openShifts, 0);
  assert.equal(totals.litresByProduct.HSD, 995 + 905); // 905 + 995
  assert.equal(totals.litresByProduct.MS, 95);
  assert.equal(totals.valueByProduct.MS, 95 * 104.5 * 100);
  assert.equal(totals.salesValuePaise, 8145000 + 8955000 + 992750);
  assert.equal(totals.drawers.length, 2);
  assert.deepEqual(totals.drawers.map((d) => d.attendant), ['Ramesh', 'Suresh']);
});

test('stock uses the day net sales by product, not per shift', () => {
  const state = baseState();
  state.shifts = [{
    id: 's1', date: '2026-01-15', seq: 1, status: 'closed',
    readings: { n2: { opening: 50000, closing: 50100, testing: 5 } },
    tenders: { CASH: 95 * 104.5 * 100 },
  }];
  state.days['2026-01-15'] = {
    tanks: {
      t1: { openingL: 12000, receiptsL: 0, physicalL: 12000 },
      t2: { openingL: 10000, receiptsL: 0, physicalL: 9900 },
    },
  };
  const [, msTank] = dayStock(state, '2026-01-15');
  assert.equal(msTank.netSalesL, 95);
  assert.equal(msTank.bookClosing, 9905);
  assert.equal(msTank.varianceL, -5);
  assert.equal(msTank.evaporationAllowL, 0.713); // 95 L x 0.75%
  // A 5 L loss is far inside the 4% band but above the evaporation allowance,
  // so it is "investigate", not "within" and not an MDG irregularity.
  assert.equal(msTank.status, 'investigate');
  assert.equal(msTank.unexplainedL, -4.287);
});

test('freezeDay refuses open shifts and missing dips, then freezes immutably', () => {
  const state = baseState();
  state.shifts = [{
    id: 's1', date: '2026-01-15', seq: 1, status: 'closed',
    readings: { n1: { opening: 124500, closing: 125410, testing: 5 } },
    tenders: { CASH: 8145000 }, attendant: 'Ramesh', signedAt: '2026-01-15T14:00:00Z',
  }];
  state.days['2026-01-15'] = {
    tanks: {
      t1: { openingL: 12000, receiptsL: 8000, physicalL: 19095 },
      t2: { openingL: 10000, receiptsL: 0, physicalL: 10000 },
    },
  };

  // Missing dip blocks the close.
  assert.throws(
    () => freezeDay({ ...state, days: { '2026-01-15': { tanks: { t1: state.days['2026-01-15'].tanks.t1 } } } }, '2026-01-15'),
    /Physical dip missing for: T2/,
  );

  // Open shift blocks the close.
  const openState = {
    ...state,
    shifts: [{ ...state.shifts[0], status: 'open' }],
  };
  assert.throws(() => freezeDay(openState, '2026-01-15'), /still open/);

  const snapshot = freezeDay(state, '2026-01-15', { closedAt: '2026-01-15T22:30:00Z', closedBy: 'Owner' });
  assert.equal(snapshot.totals.salesValuePaise, 8145000);
  assert.equal(snapshot.stock.length, 2);
  assert.equal(snapshot.totalVarianceL, 0);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.totals));

  // Mutating the working state afterwards cannot touch the frozen record.
  state.shifts[0].tenders.CASH = 1;
  assert.equal(snapshot.totals.collectedPaise, 8145000);
  assert.throws(() => { snapshot.totals.collectedPaise = 1; }, TypeError);
});

test('carry-forward finds the last closed reading before the shift', () => {
  const state = baseState();
  state.shifts = [
    { id: 'a', date: '2026-01-14', seq: 3, status: 'closed', readings: { n1: { opening: 1, closing: 124500 } } },
    { id: 'b', date: '2026-01-15', seq: 1, status: 'closed', readings: { n1: { opening: 124500, closing: 125410 } } },
    { id: 'c', date: '2026-01-15', seq: 2, status: 'open', readings: {} },
  ];
  assert.equal(lastClosedReading(state, 'n1', '2026-01-15', 2), 125410);
  assert.equal(lastClosedReading(state, 'n1'), 125410);
  assert.equal(lastClosedReading(state, 'n2'), null);
});

test('a half-entered reading stays out of the totals', () => {
  const shift = {
    id: 'draft', date: '2026-01-15', seq: 1, status: 'open',
    readings: { n1: { opening: '124500' }, n2: { opening: '50000', closing: '' } },
    tenders: {},
  };
  const s = shiftSummary(shift, { nozzles, rates: { HSD: 9000, MS: 10450 } });
  assert.equal(s.lines.length, 0);
  assert.equal(s.salesValuePaise, 0);
  assert.equal(s.differencePaise, 0);
});

test('DSR csv carries per-nozzle rows and the day totals block', () => {
  const state = baseState();
  state.shifts = [{
    id: 's1', date: '2026-01-15', seq: 1, status: 'closed',
    readings: { n1: { opening: 124500, closing: 125410, testing: 5 } },
    tenders: { CASH: 8145000 }, attendant: 'Ramesh',
  }];
  state.days['2026-01-15'] = {
    tanks: {
      t1: { openingL: 12000, receiptsL: 8000, physicalL: 19095 },
      t2: { openingL: 10000, receiptsL: 0, physicalL: 10000 },
    },
  };
  state.days['2026-01-15'].dsr = freezeDay(state, '2026-01-15');
  const csv = dsrCsv(state, '2026-01-15');
  const lines = csv.split('\n');
  assert.match(lines[0], /"nozzle"/);
  assert.match(csv, /"DU1-N1"/);
  assert.match(csv, /"81450\.00"/);
  assert.match(csv, /"day totals"/);
});
