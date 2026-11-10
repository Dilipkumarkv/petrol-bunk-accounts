// Pure reconciliation engine for an Indian petrol bunk.
// No DOM, no storage: everything here is a function of its inputs, so it can be
// unit-tested and reused by the UI, a CLI or a future server.
//
// Money is integer paise. Volumes are litres rounded to 3 decimals.

export const PRODUCTS = [
  { code: 'MS', label: 'Petrol (MS)' },
  { code: 'HSD', label: 'Diesel (HSD)' },
];

export const TENDERS = [
  { code: 'CASH', label: 'Cash' },
  { code: 'UPI', label: 'UPI' },
  { code: 'CARD', label: 'Card / POS' },
  { code: 'CREDIT', label: 'Credit (khata)' },
  { code: 'FLEET', label: 'Fleet card' },
];

// MDG 5.1.11: variation is treated as beyond normal operation only outside
// 4% of tank stock, after allowing evaporation/handling loss on quantity sold.
export const MDG_TOLERANCE_PCT = 4;

export function r3(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 1000) / 1000;
}

export function toPaise(rupees) {
  const v = Number(rupees);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100);
}

export function formatPaise(paise) {
  const v = Number(paise) || 0;
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  return sign + (abs / 100).toFixed(2);
}

export function formatLitres(n) {
  return (Number(n) || 0).toFixed(2);
}

/**
 * Litres dispensed by one nozzle for one shift.
 * Testing litres are drawn into the 5L measure and poured back, so they are
 * NOT a sale: net = gross - testing. They must never be added back to stock.
 */
export function nozzleLitres(reading = {}) {
  const opening = Number(reading.opening) || 0;
  const closing = Number(reading.closing) || 0;
  const testing = Number(reading.testing) || 0;
  const gross = r3(closing - opening);
  const net = r3(gross - testing);
  return {
    opening,
    closing,
    testing: r3(testing),
    gross,
    net,
    valid: gross >= 0 && testing >= 0 && net >= 0,
  };
}

/**
 * Problems worth blocking a shift close for.
 * `previousClosing` is the last closed reading for this nozzle, and is the
 * single most valuable check in the whole system: a wrong carry-forward
 * silently breaks every later day.
 */
export function readingIssues(reading = {}, previousClosing = null) {
  const issues = [];
  const has = (v) => v !== '' && v !== null && v !== undefined;

  if (!has(reading.opening) || !has(reading.closing)) {
    issues.push('Opening and closing readings are both required.');
    return issues;
  }

  const { opening, closing, testing, gross, net } = nozzleLitres(reading);
  if (closing <= opening) {
    issues.push(`Closing (${closing}) must be greater than opening (${opening}).`);
  }
  if (testing < 0) issues.push('Testing litres cannot be negative.');
  if (testing > gross) {
    issues.push(`Testing litres (${testing}) exceed gross litres (${gross}).`);
  }
  if (net <= 0 && gross > 0) {
    issues.push('Net litres are zero or negative after testing.');
  }
  if (previousClosing !== null && Math.abs(opening - previousClosing) > 0.001) {
    issues.push(
      `Carry-forward mismatch: opening ${opening} but the previous shift closed at ${previousClosing}.`,
    );
  }
  return issues;
}

/**
 * One shift: nozzle lines, product splits, collections and short/excess.
 * ctx = { nozzles: [{id,label,product}], rates: { MS: paisePerLitre, ... } }
 */
export function shiftSummary(shift = {}, ctx = {}) {
  const nozzles = ctx.nozzles || [];
  const rates = ctx.rates || {};
  const readings = shift.readings || {};

  const lines = [];
  const litresByProduct = {};
  const valueByProduct = {};

  for (const nozzle of nozzles) {
    const reading = readings[nozzle.id];
    if (!reading) continue;
    // Half-entered rows stay out of the totals: a typed opening with no closing
    // would otherwise value the shift as a large negative number.
    const filled = (v) => v !== '' && v !== null && v !== undefined;
    if (!filled(reading.opening) || !filled(reading.closing)) continue;
    const calc = nozzleLitres(reading);
    const ratePaise = Number(rates[nozzle.product]) || 0;
    const valuePaise = Math.round(calc.net * ratePaise);
    if (calc.gross === 0 && calc.net === 0 && !reading.closing) continue;

    lines.push({
      nozzleId: nozzle.id,
      label: nozzle.label,
      product: nozzle.product,
      gross: calc.gross,
      testing: calc.testing,
      net: calc.net,
      ratePaise,
      valuePaise,
      valid: calc.valid,
    });

    litresByProduct[nozzle.product] = r3((litresByProduct[nozzle.product] || 0) + calc.net);
    valueByProduct[nozzle.product] = (valueByProduct[nozzle.product] || 0) + valuePaise;
  }

  const salesValuePaise = Object.values(valueByProduct).reduce((a, b) => a + b, 0);

  const collections = {};
  let collectedPaise = 0;
  for (const tender of TENDERS) {
    const amount = Math.round(Number((shift.tenders || {})[tender.code]) || 0);
    collections[tender.code] = amount;
    collectedPaise += amount;
  }

  return {
    lines,
    litresByProduct,
    valueByProduct,
    salesValuePaise,
    collections,
    collectedPaise,
    // Positive = short (money missing), negative = excess. Signed convention
    // matters: every register in India writes "short" as a positive number.
    differencePaise: salesValuePaise - collectedPaise,
    creditPaise: collections.CREDIT + collections.FLEET,
  };
}

/**
 * Stock reconciliation for one tank for one day.
 *
 * Book closing = opening + receipts - net sales. Testing litres are already
 * excluded from net sales (the fuel went back into the tank), so they are not
 * added a second time.
 */
export function stockReconciliation(input = {}) {
  const opening = r3(input.openingL || 0);
  const receipts = r3(input.receiptsL || 0);
  const netSales = r3(input.netSalesL || 0);
  const physical = input.physicalL === '' || input.physicalL === undefined || input.physicalL === null
    ? null
    : r3(input.physicalL);

  const bookClosing = r3(opening + receipts - netSales);
  const evaporationPct = Number(input.evaporationPct) || 0;
  const evaporationAllowL = r3((netSales * evaporationPct) / 100);
  const toleranceBandL = r3((physical ?? bookClosing) * (MDG_TOLERANCE_PCT / 100));

  if (physical === null) {
    return {
      opening, receipts, netSales, bookClosing,
      physical: null, varianceL: null, variancePct: null,
      evaporationAllowL, toleranceBandL,
      unexplainedL: null, status: 'pending',
    };
  }

  const varianceL = r3(physical - bookClosing); // negative = loss
  const variancePct = physical === 0 ? 0 : (varianceL / physical) * 100;
  // Loss inside the evaporation/handling allowance is explainable; anything
  // beyond the 4% band is what MDG calls beyond permissible limits.
  const unexplainedL = r3(varianceL + evaporationAllowL); // negative = still lost
  const lossL = Math.abs(varianceL);

  let status = 'within';
  if (lossL > toleranceBandL) status = 'beyond-mdg';
  else if (lossL > evaporationAllowL) status = 'investigate';

  return {
    opening, receipts, netSales, bookClosing, physical,
    varianceL, variancePct: Math.round(variancePct * 1000) / 1000,
    evaporationAllowL, toleranceBandL, unexplainedL, status,
  };
}

/** Aggregate every shift of a date into the numbers a DSR is made of. */
export function dayTotals(state, date) {
  const nozzles = state.nozzles || [];
  const rates = (state.rates || {})[date] || {};
  const allShifts = (state.shifts || [])
    .filter((s) => s.date === date)
    .sort((a, b) => a.seq - b.seq);
  // Only closed shifts contribute sales: an open draft is provisional and must
  // not leak into the DSR, the stock variance or the day's collections.
  const shifts = allShifts.filter((s) => s.status === 'closed');

  const totals = {
    shifts: shifts.length,
    openShifts: allShifts.length - shifts.length,
    lines: [],
    litresByProduct: {},
    valueByProduct: {},
    collections: {},
    salesValuePaise: 0,
    collectedPaise: 0,
    differencePaise: 0,
    creditPaise: 0,
    drawers: [],
  };

  for (const shift of shifts) {
    const only = state.nozzles || [];
    const summary = shiftSummary(shift, {
      nozzles: only,
      rates: (state.rates || {})[shift.date] || rates,
    });
    for (const key of Object.keys(summary.litresByProduct)) {
      totals.litresByProduct[key] = r3((totals.litresByProduct[key] || 0) + summary.litresByProduct[key]);
    }
    for (const key of Object.keys(summary.valueByProduct)) {
      totals.valueByProduct[key] = (totals.valueByProduct[key] || 0) + summary.valueByProduct[key];
    }
    for (const key of Object.keys(summary.collections)) {
      totals.collections[key] = (totals.collections[key] || 0) + summary.collections[key];
    }
    totals.salesValuePaise += summary.salesValuePaise;
    totals.collectedPaise += summary.collectedPaise;
    totals.creditPaise += summary.creditPaise;
    totals.lines.push(...summary.lines);
    totals.drawers.push({
      shiftId: shift.id,
      seq: shift.seq,
      attendant: shift.attendant || '',
      expectedPaise: summary.salesValuePaise,
      collectedPaise: summary.collectedPaise,
      differencePaise: summary.differencePaise,
      signedAt: shift.signedAt || null,
    });
  }

  totals.differencePaise = totals.salesValuePaise - totals.collectedPaise;
  return totals;
}

/** Stock lines for every tank on a date, using that day's sales by product. */
export function dayStock(state, date) {
  const totals = dayTotals(state, date);
  const day = (state.days || {})[date] || {};
  const tanks = state.tanks || [];
  const tankInputs = day.tanks || {};

  return tanks.map((tank) => {
    const input = tankInputs[tank.id] || {};
    const netSalesL = totals.litresByProduct[tank.product] || 0;
    const evaporationPct = Number(
      (state.settings?.evaporationPct || {})[tank.product] ?? (tank.product === 'MS' ? 0.75 : 0),
    );
    const rec = stockReconciliation({
      openingL: input.openingL,
      receiptsL: input.receiptsL,
      netSalesL,
      physicalL: input.physicalL,
      evaporationPct,
    });
    return { tank, netSalesL, evaporationPct, ...rec };
  });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export { deepFreeze };

/**
 * Freeze a business day. Returns a deep-frozen snapshot: later edits to the
 * working state cannot rewrite a closed day, which is the whole point.
 */
export function freezeDay(state, date, meta = {}) {
  const totals = dayTotals(state, date);
  const stock = dayStock(state, date);
  const openShifts = totals.openShifts;

  if (openShifts > 0) {
    throw new Error(`${openShifts} shift(s) still open — close them before closing the day.`);
  }
  const pendingDips = stock.filter((s) => s.physical === null);
  if (pendingDips.length > 0) {
    throw new Error(`Physical dip missing for: ${pendingDips.map((s) => s.tank.code).join(', ')}.`);
  }

  const snapshot = {
    date,
    closedAt: meta.closedAt || new Date().toISOString(),
    closedBy: meta.closedBy || '',
    outlet: state.outlet?.name || '',
    omc: state.outlet?.omc || '',
    totals,
    stock: stock.map((s) => ({
      tankId: s.tank.id,
      code: s.tank.code,
      product: s.tank.product,
      opening: s.opening,
      receipts: s.receipts,
      netSales: s.netSales,
      bookClosing: s.bookClosing,
      physical: s.physical,
      varianceL: s.varianceL,
      variancePct: s.variancePct,
      evaporationAllowL: s.evaporationAllowL,
      toleranceBandL: s.toleranceBandL,
      status: s.status,
    })),
    totalVarianceL: r3(stock.reduce((a, s) => a + (s.varianceL || 0), 0)),
  };

  return deepFreeze(snapshot);
}

/** Last closed reading for a nozzle, used to carry the opening forward. */
export function lastClosedReading(state, nozzleId, beforeDate = null, beforeSeq = null) {
  const shifts = (state.shifts || []).filter((s) => s.status === 'closed');
  let best = null;
  for (const shift of shifts) {
    const reading = (shift.readings || {})[nozzleId];
    if (!reading || reading.closing === '' || reading.closing === undefined) continue;
    const order = [shift.date, shift.seq];
    if (beforeDate) {
      if (shift.date > beforeDate) continue;
      if (shift.date === beforeDate && beforeSeq !== null && shift.seq >= beforeSeq) continue;
    }
    if (!best || order[0] > best.date || (order[0] === best.date && order[1] > best.seq)) {
      best = { date: shift.date, seq: shift.seq, closing: Number(reading.closing) };
    }
  }
  return best ? best.closing : null;
}

/** CSV for the accountant: one row per nozzle per shift. */
export function dsrCsv(state, date) {
  const snapshot = state.days?.[date]?.dsr;
  const head = [
    'date', 'shift', 'nozzle', 'product', 'rate_inr_per_litre',
    'opening', 'closing', 'gross_litres', 'testing_litres', 'net_litres', 'value_inr',
    'cash', 'upi', 'card', 'credit', 'fleet', 'short_excess_inr', 'attendant',
  ];
  const rows = [head];
  const shifts = (state.shifts || []).filter((s) => s.date === date).sort((a, b) => a.seq - b.seq);
  for (const shift of shifts) {
    const summary = shiftSummary(shift, { nozzles: state.nozzles, rates: state.rates?.[date] || {} });
    for (const line of summary.lines) {
      const raw = shift.readings[line.nozzleId];
      rows.push([
        date, shift.seq, line.label, line.product, (line.ratePaise / 100).toFixed(2),
        line.gross + line.testing === 0 ? '' : raw.opening,
        raw.closing ?? '',
        line.gross.toFixed(3), line.testing.toFixed(3), line.net.toFixed(3),
        (line.valuePaise / 100).toFixed(2),
        ...TENDERS.map((t) => ((shift.tenders?.[t.code] || 0) / 100).toFixed(2)),
        (summary.differencePaise / 100).toFixed(2),
        shift.attendant || '',
      ]);
    }
  }
  if (snapshot) {
    rows.push([]);
    rows.push(['day totals']);
    rows.push(['date', 'sales_inr', 'collected_inr', 'short_excess_inr']);
    rows.push([
      date,
      (snapshot.totals.salesValuePaise / 100).toFixed(2),
      (snapshot.totals.collectedPaise / 100).toFixed(2),
      (snapshot.totals.differencePaise / 100).toFixed(2),
    ]);
  }
  return rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}
