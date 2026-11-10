import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readingIssues,
  missingNozzleReadings,
  shiftSummary,
  dayTotals,
  dayStock,
  daySalesByTank,
  freezeDay,
  lastClosedReading,
  dsrCsv,
  formatPaise,
} from '../app/core.mjs';

// A whole-outlet fixture: three tanks (two of them HSD), three nozzles, two
// products. This is the shape the unit tests did not cover before the review.
function outlet(overrides = {}) {
  return {
    version: 1,
    outlet: { name: 'Flow Fuels', omc: 'IOCL' },
    settings: { evaporationPct: { MS: 0.75, HSD: 0 } },
    tanks: [
      { id: 't1', code: 'T1', product: 'HSD', capacityL: 20000 },
      { id: 't2', code: 'T2', product: 'MS', capacityL: 15000 },
      { id: 't3', code: 'T3', product: 'HSD', capacityL: 20000 },
    ],
    nozzles: [
      { id: 'n1', label: 'DU1-N1', tankId: 't1', product: 'HSD' },
      { id: 'n2', label: 'DU1-N2', tankId: 't2', product: 'MS' },
      { id: 'n3', label: 'DU2-N3', tankId: 't3', product: 'HSD' },
    ],
    rates: { '2026-02-01': { MS: 10450, HSD: 9000 } },
    days: {},
    shifts: [],
    ...overrides,
  };
}

function closedShift(state, id, seq, readings, attendant = 'Ramesh') {
  const shift = {
    id, date: '2026-02-01', seq, status: 'closed', readings,
    tenders: {}, attendant, confirmed: true, signedAt: '2026-02-01T14:00:00Z', remark: '',
  };
  const summary = shiftSummary(shift, {
    nozzles: state.nozzles,
    rates: state.rates[shift.date] || {},
  });
  shift.tenders = { CASH: summary.salesValuePaise };
  return shift;
}

test('a full day across two HSD tanks, two products and two shifts stays consistent', () => {
  const state = outlet();

  // Shift 1: N1 sells 195 L, N2 sells 55 L, N3 is idle (same reading, no testing).
  const s1 = closedShift(state, 's1', 1, {
    n1: { opening: 1000, closing: 1200, testing: 5 },
    n2: { opening: 500, closing: 560, testing: 5 },
    n3: { opening: 800, closing: 800, testing: 0 },
  });
  // Shift 2: N1 +95, N2 +40, N3 +95.
  const s2 = closedShift(state, 's2', 2, {
    n1: { opening: 1200, closing: 1300, testing: 5 },
    n2: { opening: 560, closing: 600, testing: 0 },
    n3: { opening: 800, closing: 900, testing: 5 },
  });
  state.shifts = [s1, s2];

  // Idle nozzle is legitimate; nothing else is flagged.
  assert.deepEqual(readingIssues({ opening: 800, closing: 800, testing: 0 }), []);
  assert.deepEqual(missingNozzleReadings(s1, state.nozzles), []);

  const totals = dayTotals(state, '2026-02-01');
  assert.equal(totals.shifts, 2);
  assert.equal(totals.openShifts, 0);
  assert.equal(totals.litresByProduct.HSD, 385); // 195 + 95 + 95
  assert.equal(totals.litresByProduct.MS, 95); // 55 + 40
  assert.equal(totals.valueByProduct.HSD, 385 * 9000);
  assert.equal(totals.valueByProduct.MS, 95 * 10450);
  assert.equal(totals.salesValuePaise, 385 * 9000 + 95 * 10450);
  assert.equal(totals.differencePaise, 0); // every shift was tendered exactly
  assert.deepEqual(totals.missingRateProducts, []);

  // Sales follow the nozzle, not the product: T1 and T3 split 290 and 95 L.
  const byTank = daySalesByTank(state, '2026-02-01');
  assert.deepEqual(byTank, { t1: 290, t3: 95, t2: 95 });

  state.days['2026-02-01'] = {
    tanks: {
      t1: { openingL: 5000, receiptsL: 8000, physicalL: 12710 },
      t2: { openingL: 10000, receiptsL: 0, physicalL: 9905 },
      t3: { openingL: 2000, receiptsL: 0, physicalL: 1905 },
    },
  };

  const stock = dayStock(state, '2026-02-01');
  const byCode = Object.fromEntries(stock.map((s) => [s.tank.code, s]));
  assert.equal(byCode.T1.bookClosing, 12710);
  assert.equal(byCode.T2.bookClosing, 9905);
  assert.equal(byCode.T3.bookClosing, 1905);
  for (const line of stock) {
    assert.equal(line.varianceL, 0, `${line.tank.code} should reconcile exactly`);
  }

  // Day close produces a snapshot with per-shift detail.
  const snapshot = freezeDay(state, '2026-02-01', { closedAt: '2026-02-01T22:30:00Z' });
  assert.equal(snapshot.shifts.length, 2);
  assert.equal(snapshot.shifts[0].lines.length, 3);
  assert.equal(snapshot.shifts[0].lines.find((l) => l.label === 'DU2-N3').net, 0);
  assert.equal(snapshot.shifts[0].lines.find((l) => l.label === 'DU1-N1').opening, 1000);
  assert.equal(snapshot.totalVarianceL, 0);

  state.days['2026-02-01'].dsr = snapshot;
  state.days['2026-02-01'].status = 'closed';

  // CSV: header + 3 lines x 2 shifts, then the totals block.
  const csv = dsrCsv(snapshot);
  const rows = csv.split('\n');
  assert.equal(rows.length, 1 + 6 + 1 + 3);
  assert.match(csv, /"DU2-N3"/);
  assert.match(csv, /"0\.000"/); // the idle nozzle is still recorded, at 0.000 net
  assert.match(csv, /"44577\.50"/); // 385 L HSD x 90 + 95 L MS x 104.50
  assert.equal(formatPaise(totals.salesValuePaise), '44577.50');
  assert.equal(rows[rows.length - 1], '"2026-02-01","44577.50","44577.50","0.00"');
});

test('day two carries openings forward and revalues at the new rate', () => {
  const state = outlet();
  const s1 = closedShift(state, 's1', 1, {
    n1: { opening: 1000, closing: 1300, testing: 5 },
    n2: { opening: 500, closing: 600, testing: 5 },
    n3: { opening: 800, closing: 900, testing: 5 },
  });
  state.shifts = [s1];

  // Next day's openings must be the previous closings, per nozzle.
  assert.equal(lastClosedReading(state, 'n1', '2026-02-02', 1), 1300);
  assert.equal(lastClosedReading(state, 'n2', '2026-02-02', 1), 600);
  assert.equal(lastClosedReading(state, 'n3', '2026-02-02', 1), 900);

  // A price revision applies to the new day only.
  state.rates['2026-02-02'] = { MS: 10600, HSD: 9100 };
  const s2 = {
    id: 's2', date: '2026-02-02', seq: 1, status: 'closed',
    readings: { n1: { opening: 1300, closing: 1350, testing: 0 } },
    tenders: {}, attendant: 'Suresh', signedAt: '2026-02-02T14:00:00Z',
  };
  state.shifts.push(s2);

  const summary = shiftSummary(s2, { nozzles: state.nozzles, rates: state.rates['2026-02-02'] });
  assert.equal(summary.lines[0].net, 50);
  assert.equal(summary.lines[0].ratePaise, 9100);
  assert.equal(summary.lines[0].valuePaise, 50 * 9100);
  assert.deepEqual(summary.missingRateProducts, []);
});

test('the day cannot be frozen while a product with sales has no rate', () => {
  const state = outlet({ rates: {} });
  const s1 = closedShift(state, 's1', 1, {
    n1: { opening: 1000, closing: 1200, testing: 0 },
    n2: { opening: 500, closing: 560, testing: 0 },
    n3: { opening: 800, closing: 800, testing: 0 },
  });
  state.shifts = [s1];
  state.days['2026-02-01'] = {
    tanks: {
      t1: { openingL: 5000, receiptsL: 0, physicalL: 4800 },
      t2: { openingL: 10000, receiptsL: 0, physicalL: 9940 },
      t3: { openingL: 2000, receiptsL: 0, physicalL: 2000 },
    },
  };

  assert.deepEqual(dayTotals(state, '2026-02-01').missingRateProducts.sort(), ['HSD', 'MS']);
  assert.throws(() => freezeDay(state, '2026-02-01'), /Rate missing for/);
});

test('a closed shift keeps the rates stamped at close', () => {
  const state = outlet();
  const s1 = closedShift(state, 's1', 1, {
    n1: { opening: 1000, closing: 1200, testing: 0 }, // 200 L HSD
    n2: { opening: 500, closing: 560, testing: 0 }, // 60 L MS
    n3: { opening: 800, closing: 800, testing: 0 }, // idle
  });
  s1.ratesPaise = { HSD: 9000, MS: 10450 };
  state.shifts = [s1];

  const before = shiftSummary(s1, { nozzles: state.nozzles, rates: state.rates['2026-02-01'] });
  assert.equal(before.salesValuePaise, 200 * 9000 + 60 * 10450);
  assert.equal(before.differencePaise, 0); // tendered exactly at close

  // A later rate edit must not revalue a signed settlement.
  state.rates['2026-02-01'].HSD = 12000;
  state.rates['2026-02-01'].MS = 15000;
  const after = shiftSummary(s1, { nozzles: state.nozzles, rates: state.rates['2026-02-01'] });
  assert.equal(after.salesValuePaise, before.salesValuePaise);
  assert.equal(after.differencePaise, 0);
  assert.deepEqual(after.missingRateProducts, []);

  // A shift that was never stamped (older data) still uses the day rates.
  const openShift = {
    id: 's2', date: '2026-02-01', seq: 2, status: 'open',
    readings: { n1: { opening: 1200, closing: 1210, testing: 0 } },
    tenders: {},
  };
  const live = shiftSummary(openShift, { nozzles: state.nozzles, rates: { HSD: 12000, MS: 15000 } });
  assert.equal(live.lines[0].ratePaise, 12000);
});

test('a frozen day cannot be re-frozen by editing the working state', () => {
  const state = outlet();
  const s1 = closedShift(state, 's1', 1, {
    n1: { opening: 1000, closing: 1200, testing: 0 },
    n2: { opening: 500, closing: 560, testing: 0 },
    n3: { opening: 800, closing: 800, testing: 0 },
  });
  state.shifts = [s1];
  state.days['2026-02-01'] = {
    tanks: {
      t1: { openingL: 5000, receiptsL: 0, physicalL: 5000 + 8000 - 200 },
      t2: { openingL: 10000, receiptsL: 0, physicalL: 10000 - 60 },
      t3: { openingL: 2000, receiptsL: 0, physicalL: 2000 },
    },
  };
  const snapshot = freezeDay(state, '2026-02-01');

  // A later correction to a shift changes the live state, never the snapshot.
  state.shifts[0].readings.n1.closing = 9999;
  state.rates['2026-02-01'].HSD = 12000;
  state.nozzles[0].label = 'DU9-N9';

  assert.equal(snapshot.totals.salesValuePaise, 200 * 9000 + 60 * 10450);
  assert.equal(snapshot.shifts[0].lines[0].closing, 1200);
  assert.equal(snapshot.shifts[0].lines[0].ratePaise, 9000);
  assert.equal(snapshot.shifts[0].lines[0].label, 'DU1-N1');
  assert.throws(() => { snapshot.totals.salesValuePaise = 1; }, TypeError);
});
