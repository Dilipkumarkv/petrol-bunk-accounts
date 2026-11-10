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

// How a khata customer can settle an outstanding balance. A receipt is a
// collection against an existing due, never a new fuel sale.
export const RECEIPT_MODES = [
  { code: 'CASH', label: 'Cash' },
  { code: 'UPI', label: 'UPI' },
  { code: 'CARD', label: 'Card / POS' },
  { code: 'BANK', label: 'Bank / NEFT' },
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

/** A rate is usable only if it is a finite number above zero. */
export function isValidRate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

/**
 * The nozzle list in force for a shift. Closed shifts carry their own copy so
 * later setup edits (label, product, tank) cannot rewrite a signed settlement.
 */
export function nozzlesForShift(shift, fallback = []) {
  return Array.isArray(shift?.nozzlesSnapshot) && shift.nozzlesSnapshot.length
    ? shift.nozzlesSnapshot
    : fallback;
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
  const num = (v) => Number(v);

  if (!has(reading.opening) || !has(reading.closing)) {
    issues.push('Opening and closing readings are both required.');
    return issues;
  }
  if (!Number.isFinite(num(reading.opening)) || !Number.isFinite(num(reading.closing))) {
    issues.push('Readings must be numbers.');
    return issues;
  }
  if (num(reading.opening) < 0 || num(reading.closing) < 0) {
    issues.push('Readings cannot be negative.');
    return issues;
  }
  if (has(reading.testing) && (!Number.isFinite(num(reading.testing)) || num(reading.testing) < 0)) {
    issues.push('Testing litres must be a number of zero or more.');
    return issues;
  }

  const { opening, closing, testing, gross } = nozzleLitres(reading);
  // An idle nozzle legitimately closes at the same reading: no sale, no testing.
  if (closing < opening) {
    issues.push(`Closing (${closing}) cannot be less than opening (${opening}).`);
  }
  if (testing > gross) {
    issues.push(`Testing litres (${testing}) exceed gross litres (${gross}).`);
  }
  if (testing > 0 && gross === 0) {
    issues.push('Testing litres recorded with no fuel dispensed.');
  }
  if (previousClosing !== null && Math.abs(opening - previousClosing) > 0.001) {
    issues.push(
      `Carry-forward mismatch: opening ${opening} but the previous shift closed at ${previousClosing}.`,
    );
  }
  return issues;
}

/**
 * Nozzles that still have no reading for this shift. Closing a shift without
 * every active nozzle means the day's stock quietly under-counts sales.
 */
export function missingNozzleReadings(shift = {}, nozzles = []) {
  const readings = shift.readings || {};
  const has = (v) => v !== '' && v !== null && v !== undefined;
  return nozzles
    .filter((nozzle) => {
      const reading = readings[nozzle.id];
      return !reading || !has(reading.opening) || !has(reading.closing);
    })
    .map((nozzle) => nozzle.label);
}

/**
 * The single validation path for finalising a shift.
 *
 * Used by the UI button, by `freezeDay()` and by backup import, so a hand-edited
 * JSON document cannot slip past rules the button enforces.
 * Returns a list of problems; empty means the shift is closable.
 */
export function validateShiftForClose(shift = {}, ctx = {}) {
  const nozzles = nozzlesForShift(shift, ctx.nozzles || []);
  const rates = shift.ratesPaise || ctx.rates || {};
  const issues = [];

  const missing = missingNozzleReadings(shift, nozzles);
  if (missing.length) issues.push(`No reading for: ${missing.join(', ')}`);

  for (const nozzle of nozzles) {
    const reading = (shift.readings || {})[nozzle.id];
    if (!reading) continue;
    const previous = ctx.previousClosings ? ctx.previousClosings[nozzle.id] : null;
    for (const issue of readingIssues(reading, previous ?? null)) {
      issues.push(`${nozzle.label}: ${issue}`);
    }
  }

  const summary = shiftSummary(shift, { nozzles, rates });
  if (summary.missingRateProducts.length) {
    issues.push(`Rate missing for ${summary.missingRateProducts.join(', ')}`);
  }

  // Khata: when a shift records credit allocations, they must name known
  // customers, be whole paise above zero, and sum exactly to the CREDIT tender.
  // Shifts closed before khata existed carry no `creditAllocations` key and are
  // grandfathered; the UI stamps the key on every shift it closes from now on.
  if (Array.isArray(shift.creditAllocations)) {
    const creditTender = summary.collections.CREDIT || 0;
    const known = Array.isArray(ctx.customers) ? new Set(ctx.customers.map((c) => c.id)) : null;
    let allocated = 0;
    for (const allocation of shift.creditAllocations) {
      const amount = allocation?.amountPaise;
      if (!Number.isInteger(amount) || amount <= 0) {
        issues.push('Credit allocation amounts must be whole paise above zero.');
      } else {
        allocated += amount;
      }
      if (known && !known.has(allocation?.customerId)) {
        issues.push(`Credit allocation references unknown customer ${allocation?.customerId}.`);
      }
    }
    if (allocated !== creditTender) {
      issues.push(
        `Credit tender ₹${formatPaise(creditTender)} is not fully allocated to customers (allocated ₹${formatPaise(allocated)}).`,
      );
    }
  }

  if (ctx.requireSignoff) {
    if (!String(shift.attendant || '').trim()) issues.push('Attendant name is required');
    if (!shift.confirmed && !shift.signedAt) issues.push('Attendant sign-off is missing');
    if (summary.differencePaise !== 0 && !String(shift.remark || '').trim()) {
      issues.push('A short/excess needs a remark');
    }
  }

  return issues;
}

/**
 * One shift: nozzle lines, product splits, collections and short/excess.
 * ctx = { nozzles: [{id,label,product}], rates: { MS: paisePerLitre, ... } }
 */
export function shiftSummary(shift = {}, ctx = {}) {
  const nozzles = nozzlesForShift(shift, ctx.nozzles || []);
  // A closed shift is valued at the rates stamped on it when it closed, so a
  // later rate edit (or a price revision) cannot revalue a signed settlement.
  const rates = shift.ratesPaise || ctx.rates || {};
  const readings = shift.readings || {};

  const lines = [];
  const litresByProduct = {};
  const valueByProduct = {};
  const missingRateSet = new Set();

  for (const nozzle of nozzles) {
    const reading = readings[nozzle.id];
    if (!reading) continue;
    // Half-entered rows stay out of the totals: a typed opening with no closing
    // would otherwise value the shift as a large negative number.
    const filled = (v) => v !== '' && v !== null && v !== undefined;
    if (!filled(reading.opening) || !filled(reading.closing)) continue;
    const calc = nozzleLitres(reading);
    const ratePaise = isValidRate(rates[nozzle.product]) ? Math.round(Number(rates[nozzle.product])) : 0;
    const valuePaise = Math.round(calc.net * ratePaise);
    // A zero, negative or missing rate is never a real fuel price.
    if (calc.net > 0 && !ratePaise) missingRateSet.add(nozzle.product);

    lines.push({
      nozzleId: nozzle.id,
      label: nozzle.label,
      product: nozzle.product,
      opening: calc.opening,
      closing: calc.closing,
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
    // Non-empty means the shift cannot be closed: a sale with no rate would be
    // frozen into the DSR at zero value.
    missingRateProducts: [...missingRateSet],
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

  const varianceL = r3(physical - bookClosing); // negative = loss, positive = gain
  const variancePct = physical === 0 ? 0 : (varianceL / physical) * 100;
  const lossL = varianceL < 0 ? -varianceL : 0;
  const gainL = varianceL > 0 ? varianceL : 0;
  // The evaporation/handling allowance can only ever offset a LOSS. Fuel that
  // appears in the tank is never explained by evaporation: it points at a
  // meter, calibration or dip error, so it gets its own status instead of
  // being absorbed as "within allowance".
  const unexplainedL = varianceL < 0 ? r3(varianceL + evaporationAllowL) : varianceL;

  let status = 'within';
  if (Math.abs(varianceL) > toleranceBandL) status = 'beyond-mdg';
  else if (gainL > 0) status = 'gain';
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
    missingRateProducts: [],
  };

  const missingRates = new Set();

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
    for (const product of summary.missingRateProducts) missingRates.add(product);
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
  totals.missingRateProducts = [...missingRates];
  return totals;
}

/**
 * Litres sold per tank, from the nozzles that actually draw from it.
 *
 * A product can sit in several tanks; allocating the product total to every one
 * of them would subtract the same litres more than once and make every tank's
 * book stock (and variance) wrong.
 */
export function daySalesByTank(state, date) {
  const has = (v) => v !== '' && v !== null && v !== undefined;
  const byTank = {};

  const shifts = (state.shifts || []).filter((s) => s.date === date && s.status === 'closed');
  for (const shift of shifts) {
    // Closed shifts carry the nozzle-to-tank mapping they were signed with.
    const nozzleIndex = new Map(nozzlesForShift(shift, state.nozzles || []).map((n) => [n.id, n]));
    for (const [nozzleId, reading] of Object.entries(shift.readings || {})) {
      const nozzle = nozzleIndex.get(nozzleId);
      if (!nozzle || !reading) continue;
      if (!has(reading.opening) || !has(reading.closing)) continue;
      const { net } = nozzleLitres(reading);
      if (!net) continue;
      byTank[nozzle.tankId] = r3((byTank[nozzle.tankId] || 0) + net);
    }
  }
  return byTank;
}

/** Stock lines for every tank on a date, using sales from that tank's nozzles. */
export function dayStock(state, date) {
  const salesByTank = daySalesByTank(state, date);
  const day = (state.days || {})[date] || {};
  const tanks = state.tanks || [];
  const tankInputs = day.tanks || {};

  return tanks.map((tank) => {
    const input = tankInputs[tank.id] || {};
    const netSalesL = salesByTank[tank.id] || 0;
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
  const day = (state.days || {})[date] || {};
  const tankInputs = day.tanks || {};
  const has = (v) => v !== '' && v !== null && v !== undefined;

  if (openShifts > 0) {
    throw new Error(`${openShifts} shift(s) still open — close them before closing the day.`);
  }
  if (totals.missingRateProducts.length > 0) {
    throw new Error(
      `Rate missing for ${totals.missingRateProducts.join(', ')} — set the day's rates before closing.`,
    );
  }
  const pendingDips = stock.filter((s) => s.physical === null);
  if (pendingDips.length > 0) {
    throw new Error(`Physical dip missing for: ${pendingDips.map((s) => s.tank.code).join(', ')}.`);
  }
  const missingOpening = (state.tanks || [])
    .filter((tank) => !has(tankInputs[tank.id]?.openingL))
    .map((tank) => tank.code);
  if (missingOpening.length > 0) {
    throw new Error(`Opening stock missing for: ${missingOpening.join(', ')}.`);
  }
  const fieldLabels = { openingL: 'opening stock', receiptsL: 'receipts', physicalL: 'physical dip' };
  for (const tank of state.tanks || []) {
    const input = tankInputs[tank.id] || {};
    for (const field of ['openingL', 'receiptsL', 'physicalL']) {
      if (!has(input[field])) continue;
      const value = Number(input[field]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${tank.code}: ${fieldLabels[field]} must be a number of zero or more.`);
      }
    }
  }

  // Every closed shift is re-checked through the same rules the UI uses, so a
  // hand-edited backup cannot freeze a shift the button would have rejected.
  const closedShifts = (state.shifts || [])
    .filter((s) => s.date === date && s.status === 'closed')
    .sort((a, b) => a.seq - b.seq);
  for (const shift of closedShifts) {
    const previousClosings = {};
    for (const nozzle of nozzlesForShift(shift, state.nozzles || [])) {
      previousClosings[nozzle.id] = lastClosedReading(state, nozzle.id, date, shift.seq);
    }
    const issues = validateShiftForClose(shift, {
      nozzles: state.nozzles,
      rates: (state.rates || {})[date] || {},
      previousClosings,
      customers: state.customers || [],
      requireSignoff: true,
    });
    if (issues.length > 0) {
      throw new Error(`Shift ${shift.seq}: ${issues[0]}`);
    }
  }

  // Per-shift detail is part of the frozen record: the CSV and any later export
  // must be reproducible from the snapshot alone, never from live configuration.
  const frozenShifts = closedShifts
    .map((s) => {
      const summary = shiftSummary(s, {
        nozzles: state.nozzles,
        rates: (state.rates || {})[date] || {},
      });
      return {
        seq: s.seq,
        attendant: s.attendant || '',
        signedAt: s.signedAt || null,
        tenders: summary.collections,
        differencePaise: summary.differencePaise,
        // The khata attribution is part of the signed settlement: copy it so a
        // later working-state edit cannot rewrite who owed what at close.
        creditAllocations: (s.creditAllocations || []).map((a) => ({ ...a })),
        lines: summary.lines.map((line) => ({ ...line })),
      };
    });

  const snapshot = {
    date,
    closedAt: meta.closedAt || new Date().toISOString(),
    closedBy: meta.closedBy || '',
    outlet: state.outlet?.name || '',
    omc: state.outlet?.omc || '',
    totals,
    shifts: frozenShifts,
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

/** CSV for the accountant, built only from a frozen DSR snapshot. */
export function dsrCsv(snapshot) {
  if (!snapshot) throw new Error('No frozen DSR for this date.');

  const head = [
    'date', 'shift', 'nozzle', 'product', 'rate_inr_per_litre',
    'opening', 'closing', 'gross_litres', 'testing_litres', 'net_litres', 'value_inr',
    'cash', 'upi', 'card', 'credit', 'fleet', 'short_excess_inr', 'attendant',
  ];
  const rows = [head];

  if (Array.isArray(snapshot.shifts)) {
    for (const shift of snapshot.shifts) {
      for (const line of shift.lines || []) {
        rows.push([
          snapshot.date, shift.seq, line.label, line.product, (line.ratePaise / 100).toFixed(2),
          line.opening ?? '', line.closing ?? '',
          line.gross.toFixed(3), line.testing.toFixed(3), line.net.toFixed(3),
          (line.valuePaise / 100).toFixed(2),
          ...TENDERS.map((t) => ((shift.tenders?.[t.code] || 0) / 100).toFixed(2)),
          (shift.differencePaise / 100).toFixed(2),
          shift.attendant || '',
        ]);
      }
    }
  } else {
    // Snapshots frozen before per-shift detail existed: totals block only.
    rows.push(['note', 'snapshot has no per-shift detail (older app version)']);
  }

  rows.push([]);
  rows.push(['day totals']);
  rows.push(['date', 'sales_inr', 'collected_inr', 'short_excess_inr']);
  rows.push([
    snapshot.date,
    (snapshot.totals.salesValuePaise / 100).toFixed(2),
    (snapshot.totals.collectedPaise / 100).toFixed(2),
    (snapshot.totals.differencePaise / 100).toFixed(2),
  ]);

  return rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

/* ────────────────────────── khata (customer credit) ────────────────────────── */

/**
 * Outstanding balance for one customer, in paise. Positive = the customer owes
 * the outlet. Derived, never stored: opening balance + credit sales from CLOSED
 * shifts - receipts. Open drafts are provisional and stay out, exactly like the
 * DSR. A credit sale is revenue at delivery; a later receipt only settles the
 * receivable and is never counted as revenue again.
 */
export function customerBalancePaise(state, customerId) {
  const customer = (state.customers || []).find((c) => c.id === customerId);
  if (!customer) return 0;
  let balance = Math.round(Number(customer.openingBalancePaise) || 0);
  for (const shift of state.shifts || []) {
    if (shift.status !== 'closed') continue;
    for (const allocation of shift.creditAllocations || []) {
      if (allocation && allocation.customerId === customerId) {
        balance += Math.round(Number(allocation.amountPaise) || 0);
      }
    }
  }
  for (const receipt of state.creditReceipts || []) {
    if (receipt && receipt.customerId === customerId) {
      balance -= Math.round(Number(receipt.amountPaise) || 0);
    }
  }
  return balance;
}

/**
 * Problems worth blocking a khata receipt for. The single entry-time validation
 * path used by the UI. Overpayment is rejected explicitly rather than silently
 * pushing the customer into a negative (advance) balance.
 */
export function receiptIssues(state, receipt = {}) {
  const issues = [];
  const customer = (state.customers || []).find((c) => c.id === receipt.customerId);
  if (!customer) issues.push('Choose a known customer for the receipt.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(receipt.date || ''))) issues.push('Receipt date is invalid.');
  if (!Number.isInteger(receipt.amountPaise) || receipt.amountPaise <= 0) {
    issues.push('Receipt amount must be whole paise above zero.');
  }
  if (!RECEIPT_MODES.some((m) => m.code === receipt.mode)) issues.push('Receipt mode is invalid.');
  if (customer && Number.isInteger(receipt.amountPaise) && receipt.amountPaise > 0) {
    const balance = customerBalancePaise(state, customer.id);
    if (receipt.amountPaise > balance) {
      issues.push(
        `Receipt ₹${formatPaise(receipt.amountPaise)} exceeds ${customer.name}'s outstanding balance of ₹${formatPaise(balance)}.`,
      );
    }
  }
  return issues;
}

/**
 * A chronological statement for one customer: opening balance, then credit
 * sales and receipts ordered by date (sales before receipts on the same day),
 * with a running balance. Built only from closed shifts and recorded receipts.
 */
export function customerStatement(state, customerId) {
  const customer = (state.customers || []).find((c) => c.id === customerId);
  if (!customer) return { customer: null, entries: [], balancePaise: 0 };

  const entries = [{
    date: '', kind: 'opening', reference: 'Opening balance',
    debitPaise: Math.round(Number(customer.openingBalancePaise) || 0), creditPaise: 0, order: 0,
  }];
  for (const shift of state.shifts || []) {
    if (shift.status !== 'closed') continue;
    for (const allocation of shift.creditAllocations || []) {
      if (allocation && allocation.customerId === customerId) {
        entries.push({
          date: shift.date, kind: 'sale', reference: `Shift ${shift.seq}`,
          debitPaise: Math.round(Number(allocation.amountPaise) || 0), creditPaise: 0, order: 1,
        });
      }
    }
  }
  for (const receipt of state.creditReceipts || []) {
    if (receipt && receipt.customerId === customerId) {
      entries.push({
        date: receipt.date, kind: 'receipt', reference: receipt.reference || receipt.mode,
        debitPaise: 0, creditPaise: Math.round(Number(receipt.amountPaise) || 0), order: 2,
      });
    }
  }
  entries.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.order - b.order);

  let balance = 0;
  for (const entry of entries) {
    balance += entry.debitPaise - entry.creditPaise;
    entry.balancePaise = balance;
    delete entry.order;
  }
  return { customer, entries, balancePaise: balance };
}

/** CSV statement for the accountant, derived from the same entries the UI shows. */
export function customerStatementCsv(state, customerId) {
  const { customer, entries, balancePaise } = customerStatement(state, customerId);
  if (!customer) throw new Error('Unknown customer.');
  const rows = [
    ['customer', customer.name],
    ['date', 'type', 'reference', 'debit_inr', 'credit_inr', 'balance_inr'],
    ...entries.map((e) => [
      e.date, e.kind, e.reference,
      (e.debitPaise / 100).toFixed(2), (e.creditPaise / 100).toFixed(2), (e.balancePaise / 100).toFixed(2),
    ]),
    [],
    ['balance_due_inr', (balancePaise / 100).toFixed(2)],
  ];
  return rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

/**
 * Customers who currently owe the outlet, largest balance first, each flagged
 * when over their credit limit. Settled (zero) and advance (negative) balances
 * are not "due" and stay out of this list.
 */
export function dueCustomers(state) {
  return (state.customers || [])
    .map((customer) => {
      const balancePaise = customerBalancePaise(state, customer.id);
      const limit = Number(customer.creditLimitPaise) || 0;
      return { customer, balancePaise, overLimit: limit > 0 && balancePaise > limit };
    })
    .filter((d) => d.balancePaise > 0)
    .sort((a, b) => b.balancePaise - a.balancePaise);
}

/**
 * Validate an imported backup document: structure first, then the same
 * accounting invariants the close button enforces, walked chronologically so
 * carry-forward mismatches are caught too.
 * Returns a problem string, or null when the document is usable.
 */
export function validateBackup(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'not a JSON object';
  if (data.version !== undefined && data.version !== 1) {
    return `unsupported backup version ${data.version}`;
  }
  if (!data.outlet || typeof data.outlet !== 'object') return 'missing outlet details';
  if (!Array.isArray(data.tanks) || data.tanks.length === 0) return 'missing tanks';

  const tankIds = new Set();
  for (const tank of data.tanks) {
    if (!tank || typeof tank.id !== 'string' || !tank.id) return 'a tank has no id';
    if (tankIds.has(tank.id)) return `duplicate tank id ${tank.id}`;
    if (tank.product !== 'MS' && tank.product !== 'HSD') {
      return `tank ${tank.code || tank.id} has an unknown product`;
    }
    tankIds.add(tank.id);
  }

  if (!Array.isArray(data.nozzles)) return 'missing nozzles';
  const nozzleIds = new Set();
  for (const nozzle of data.nozzles) {
    if (!nozzle || typeof nozzle.id !== 'string' || !nozzle.id) return 'a nozzle has no id';
    if (nozzleIds.has(nozzle.id)) return `duplicate nozzle id ${nozzle.id}`;
    if (!tankIds.has(nozzle.tankId)) {
      return `nozzle ${nozzle.label || nozzle.id} points at a tank that does not exist`;
    }
    nozzleIds.add(nozzle.id);
  }

  if (data.shifts !== undefined && !Array.isArray(data.shifts)) return 'shifts must be a list';
  if (data.days !== undefined && (typeof data.days !== 'object' || data.days === null || Array.isArray(data.days))) {
    return 'days must be an object';
  }
  if (data.rates !== undefined && (typeof data.rates !== 'object' || data.rates === null || Array.isArray(data.rates))) {
    return 'rates must be an object';
  }
  if (data.settings != null && (typeof data.settings !== 'object' || Array.isArray(data.settings))) {
    return 'settings must be an object';
  }
  const evaporationPct = data.settings?.evaporationPct;
  if (evaporationPct != null) {
    if (typeof evaporationPct !== 'object' || Array.isArray(evaporationPct)) {
      return 'evaporation allowance must be an object';
    }
    for (const product of ['MS', 'HSD']) {
      const value = evaporationPct[product];
      if (value === undefined || value === null) continue;
      if (value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) {
        return `${product} evaporation allowance must be a number of zero or more`;
      }
    }
  }

  if (data.customers !== undefined && !Array.isArray(data.customers)) return 'customers must be a list';
  const customerIds = new Set();
  for (const customer of data.customers || []) {
    if (!customer || typeof customer.id !== 'string' || !customer.id) return 'a customer has no id';
    if (customerIds.has(customer.id)) return `duplicate customer id ${customer.id}`;
    if (typeof customer.name !== 'string' || !customer.name.trim()) return `customer ${customer.id} has no name`;
    if (customer.openingBalancePaise !== undefined && customer.openingBalancePaise !== null
      && !Number.isInteger(customer.openingBalancePaise)) {
      return `customer ${customer.name} opening balance must be whole paise`;
    }
    if (customer.creditLimitPaise !== undefined && customer.creditLimitPaise !== null
      && (!Number.isInteger(customer.creditLimitPaise) || customer.creditLimitPaise < 0)) {
      return `customer ${customer.name} credit limit must be whole paise of zero or more`;
    }
    customerIds.add(customer.id);
  }

  if (data.creditReceipts !== undefined && !Array.isArray(data.creditReceipts)) return 'credit receipts must be a list';
  const receiptIds = new Set();
  for (const receipt of data.creditReceipts || []) {
    if (!receipt || typeof receipt.id !== 'string' || !receipt.id) return 'a credit receipt has no id';
    if (receiptIds.has(receipt.id)) return `duplicate receipt id ${receipt.id}`;
    if (!customerIds.has(receipt.customerId)) return `receipt ${receipt.id} references unknown customer ${receipt.customerId}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(receipt.date || ''))) return `receipt ${receipt.id} has an invalid date`;
    if (!Number.isInteger(receipt.amountPaise) || receipt.amountPaise <= 0) {
      return `receipt ${receipt.id} amount must be whole paise above zero`;
    }
    if (!RECEIPT_MODES.some((m) => m.code === receipt.mode)) return `receipt ${receipt.id} has an invalid mode`;
    receiptIds.add(receipt.id);
  }

  const shifts = [...(data.shifts || [])].sort(
    (a, b) => String(a?.date || '').localeCompare(String(b?.date || '')) || (a?.seq || 0) - (b?.seq || 0),
  );
  const lastClosing = new Map();

  for (const shift of shifts) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(shift?.date || ''))) return 'a shift has an invalid date';
    if (!Number.isInteger(shift.seq) || shift.seq < 1 || shift.seq > 3) {
      return 'a shift has an invalid sequence';
    }
    if (shift.status !== 'open' && shift.status !== 'closed') return 'a shift has an invalid status';
    if (shift.creditAllocations !== undefined && !Array.isArray(shift.creditAllocations)) {
      return `${shift.date} shift ${shift.seq}: credit allocations must be a list`;
    }

    if (shift.status === 'closed') {
      const issues = validateShiftForClose(shift, {
        nozzles: data.nozzles,
        rates: (data.rates || {})[shift.date] || {},
        previousClosings: Object.fromEntries(lastClosing),
        customers: data.customers || [],
      });
      if (issues.length > 0) {
        return `${shift.date} shift ${shift.seq}: ${issues[0]}`;
      }

      // Draft closings are provisional: only a closed shift establishes the
      // opening expected by the next closed shift, matching lastClosedReading.
      for (const [nozzleId, reading] of Object.entries(shift.readings || {})) {
        if (reading && reading.closing !== '' && reading.closing !== null && reading.closing !== undefined) {
          lastClosing.set(nozzleId, Number(reading.closing));
        }
      }
    }
  }

  return null;
}

/**
 * Fill optional containers after a backup or saved state passes validation.
 * Nested settings need defaults too: an empty settings object is valid input.
 */
export function normalizeState(data) {
  const settings = data.settings || {};
  const evaporationPct = settings.evaporationPct || {};
  return {
    ...data,
    days: data.days || {},
    shifts: data.shifts || [],
    rates: data.rates || {},
    customers: (data.customers || []).map((c) => ({
      ...c,
      openingBalancePaise: c.openingBalancePaise ?? 0,
      active: c.active ?? true,
    })),
    creditReceipts: data.creditReceipts || [],
    settings: {
      ...settings,
      evaporationPct: {
        MS: Number(evaporationPct.MS ?? 0.75),
        HSD: Number(evaporationPct.HSD ?? 0),
      },
    },
  };
}
