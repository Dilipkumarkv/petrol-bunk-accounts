import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nozzleLitres,
  readingIssues,
  missingNozzleReadings,
  shiftSummary,
  stockReconciliation,
  dayTotals,
  dayStock,
  daySalesByTank,
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
  // Cloned per state: tests that mutate configuration must not leak into others.
  nozzles: nozzles.map((n) => ({ ...n })),
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
  assert.match(backwards.join(' '), /less than opening/);

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
  assert.equal(gain.status, 'gain');

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

test('DSR csv is generated from the frozen snapshot, not live configuration', () => {
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
  const snapshot = freezeDay(state, '2026-01-15');
  state.days['2026-01-15'].dsr = snapshot;

  const csv = dsrCsv(snapshot);
  assert.match(csv.split('\n')[0], /"nozzle"/);
  assert.match(csv, /"DU1-N1"/);
  assert.match(csv, /"81450\.00"/);
  assert.match(csv, /"day totals"/);

  // Changing rates, nozzle labels or readings after the close must not rewrite
  // the historical export.
  state.rates['2026-01-15'].HSD = 12000;
  state.nozzles[0].label = 'RENAMED-N1';
  state.shifts[0].readings.n1.closing = 999999;
  const again = dsrCsv(snapshot);
  assert.equal(again, csv);
  assert.doesNotMatch(again, /RENAMED/);
});

test('sales are allocated to the tank the nozzle draws from, not to every tank of that product', () => {
  const state = {
    outlet: { name: 'Two Tank Fuels', omc: 'IOCL' },
    settings: { evaporationPct: { MS: 0.75, HSD: 0 } },
    tanks: [
      { id: 't1', code: 'T1', product: 'HSD', capacityL: 20000 },
      { id: 't2', code: 'T2', product: 'HSD', capacityL: 20000 },
    ],
    nozzles: [{ id: 'n1', label: 'DU1-N1', product: 'HSD', tankId: 't1' }],
    rates: { '2026-01-15': { HSD: 9000 } },
    days: {
      '2026-01-15': {
        tanks: {
          t1: { openingL: 5000, receiptsL: 0, physicalL: 4900 }, // sold 100 L
          t2: { openingL: 8000, receiptsL: 0, physicalL: 8000 }, // untouched
        },
      },
    },
    shifts: [{
      id: 's1', date: '2026-01-15', seq: 1, status: 'closed',
      readings: { n1: { opening: 1000, closing: 1100, testing: 0 } },
      tenders: { CASH: 900000 }, attendant: 'Ramesh',
    }],
  };

  const byTank = daySalesByTank(state, '2026-01-15');
  assert.equal(byTank.t1, 100);
  assert.equal(byTank.t2, undefined);

  const [t1, t2] = dayStock(state, '2026-01-15');
  assert.equal(t1.netSalesL, 100);
  assert.equal(t1.bookClosing, 4900);
  assert.equal(t1.varianceL, 0);
  assert.equal(t1.status, 'within');
  assert.equal(t2.netSalesL, 0);
  assert.equal(t2.bookClosing, 8000);
  assert.equal(t2.varianceL, 0);
});

test('a missing rate is a blocking error, not a zero-value sale', () => {
  const shift = {
    id: 's1', date: '2026-01-15', seq: 1, status: 'open',
    readings: { n1: { opening: 0, closing: 100, testing: 0 } },
    tenders: {},
  };
  const summary = shiftSummary(shift, { nozzles, rates: {} });
  assert.equal(summary.salesValuePaise, 0);
  assert.deepEqual(summary.missingRateProducts, ['HSD']);

  const withRate = shiftSummary(shift, { nozzles, rates: { HSD: 9000 } });
  assert.deepEqual(withRate.missingRateProducts, []);
});

test('freezeDay refuses a day whose sales have no rate', () => {
  const state = baseState();
  state.rates = {}; // rates never entered
  state.shifts = [{
    id: 's1', date: '2026-01-15', seq: 1, status: 'closed',
    readings: { n1: { opening: 124500, closing: 125410, testing: 5 } },
    tenders: {}, attendant: 'Ramesh', signedAt: '2026-01-15T14:00:00Z',
  }];
  state.days['2026-01-15'] = {
    tanks: {
      t1: { openingL: 12000, receiptsL: 8000, physicalL: 19095 },
      t2: { openingL: 10000, receiptsL: 0, physicalL: 10000 },
    },
  };
  assert.throws(() => freezeDay(state, '2026-01-15'), /rate/i);
});

test('an idle nozzle may close with identical readings', () => {
  // No sale, no testing: opening === closing is legitimate.
  assert.deepEqual(readingIssues({ opening: 1000, closing: 1000, testing: 0 }), []);
  assert.deepEqual(readingIssues({ opening: 1000, closing: 1000 }), []);

  // Testing litres without dispensed fuel is contradictory.
  assert.match(
    readingIssues({ opening: 1000, closing: 1000, testing: 5 }).join(' '),
    /testing|no fuel/i,
  );

  // A meter cannot run backwards.
  assert.match(readingIssues({ opening: 1000, closing: 900 }).join(' '), /less than opening/);
});

test('every active nozzle must be read before a shift can close', () => {
  const shift = {
    id: 's1', date: '2026-01-15', seq: 1, status: 'open',
    readings: { n1: { opening: 0, closing: 100, testing: 0 } },
  };
  assert.deepEqual(missingNozzleReadings(shift, nozzles), ['DU1-N2']);
  assert.deepEqual(missingNozzleReadings({ readings: {} }, nozzles), ['DU1-N1', 'DU1-N2']);
  assert.deepEqual(missingNozzleReadings(shift, [nozzles[0]]), []);
});

test('a small stock gain is flagged, not absorbed as evaporation', () => {
  const gain = stockReconciliation({
    openingL: 12000, receiptsL: 8000, netSalesL: 905, physicalL: 19098, evaporationPct: 0.75,
  });
  assert.equal(gain.varianceL, 3);
  assert.equal(gain.status, 'gain');
  assert.equal(gain.unexplainedL, 3); // a gain is not "explained" by an evaporation allowance

  const exact = stockReconciliation({
    openingL: 12000, receiptsL: 8000, netSalesL: 905, physicalL: 19095, evaporationPct: 0.75,
  });
  assert.equal(exact.status, 'within');

  const hugeGain = stockReconciliation({
    openingL: 12000, receiptsL: 8000, netSalesL: 905, physicalL: 19895, evaporationPct: 0.75,
  });
  assert.equal(hugeGain.status, 'beyond-mdg');
});
