import test from 'node:test';
import assert from 'node:assert/strict';

// Namespace import so the RED run fails on assertions (typeof checks), not on
// a module-level SyntaxError for exports that do not exist yet.
const core = await import('../app/core.mjs');
const { validateShiftForClose, validateBackup, normalizeState, freezeDay } = core;

function khataState(overrides = {}) {
  return {
    version: 1,
    outlet: { name: 'Khata Fuels', omc: 'IOCL' },
    settings: { evaporationPct: { MS: 0.75, HSD: 0 } },
    tanks: [{ id: 't1', code: 'T1', product: 'HSD', capacityL: 20000 }],
    nozzles: [{ id: 'n1', label: 'DU1-N1', tankId: 't1', product: 'HSD' }],
    rates: {
      '2026-02-01': { MS: 10450, HSD: 9000 },
      '2026-02-02': { MS: 10450, HSD: 9000 },
    },
    days: {},
    shifts: [],
    customers: [
      { id: 'c1', name: 'Sharma Transport', openingBalancePaise: 100000, creditLimitPaise: 500000, active: true },
    ],
    creditReceipts: [],
    ...overrides,
  };
}

// One HSD nozzle, 10 L at ₹90 = 90000 paise, tendered fully on credit so the
// drawer balances and the only thing under test is the khata behaviour.
function creditShift(id, date, seq, allocations, status = 'closed') {
  const shift = {
    id, date, seq, status,
    readings: { n1: { opening: 1000, closing: 1010, testing: 0 } },
    tenders: { CREDIT: 90000 },
    attendant: 'Ramesh',
    confirmed: true,
    signedAt: `${date}T14:00:00Z`,
    remark: '',
  };
  if (allocations !== undefined) shift.creditAllocations = allocations;
  return shift;
}

function closeCtx(state, extra = {}) {
  return {
    nozzles: state.nozzles,
    rates: state.rates['2026-02-01'],
    customers: state.customers,
    requireSignoff: true,
    ...extra,
  };
}

test('customer balance derives from opening, closed-shift credit sales and receipts', () => {
  assert.equal(typeof core.customerBalancePaise, 'function');
  const state = khataState();
  state.shifts = [
    creditShift('s1', '2026-02-01', 1, [{ customerId: 'c1', amountPaise: 90000 }]),
    // An open draft is provisional: its allocations must not count yet.
    { ...creditShift('s2', '2026-02-01', 2, [{ customerId: 'c1', amountPaise: 50000 }], 'open'),
      readings: { n1: { opening: 1010, closing: 1020, testing: 0 } } },
  ];
  state.creditReceipts = [
    { id: 'r1', customerId: 'c1', date: '2026-02-02', amountPaise: 20000, mode: 'UPI', reference: 'UPI-1' },
  ];

  // 100000 opening + 90000 closed credit sale - 20000 receipt; the draft's 50000 stays out.
  assert.equal(core.customerBalancePaise(state, 'c1'), 170000);
});

test('a shift cannot close while its credit tender is not fully allocated', () => {
  const state = khataState();
  const partial = creditShift('s1', '2026-02-01', 1, [{ customerId: 'c1', amountPaise: 40000 }]);
  const issues = validateShiftForClose(partial, closeCtx(state));
  assert.ok(issues.some((i) => /allocat/i.test(i)), `expected an allocation issue, got: ${issues.join('; ')}`);

  const none = creditShift('s2', '2026-02-01', 1, []);
  assert.ok(validateShiftForClose(none, closeCtx(state)).some((i) => /allocat/i.test(i)));

  const exact = creditShift('s3', '2026-02-01', 1, [{ customerId: 'c1', amountPaise: 90000 }]);
  assert.deepEqual(validateShiftForClose(exact, closeCtx(state)), []);
});

test('legacy closed shifts without credit allocations remain valid', () => {
  const state = khataState();
  const legacy = creditShift('s1', '2026-02-01', 1, undefined); // no creditAllocations key at all
  assert.deepEqual(validateShiftForClose(legacy, closeCtx(state)), []);
  state.shifts = [legacy];
  assert.equal(validateBackup(state), null);
});

test('credit allocations must reference known customers', () => {
  const state = khataState();
  const shift = creditShift('s1', '2026-02-01', 1, [{ customerId: 'ghost', amountPaise: 90000 }]);
  const issues = validateShiftForClose(shift, closeCtx(state));
  assert.ok(issues.some((i) => /unknown customer/i.test(i)), `got: ${issues.join('; ')}`);
});

test('credit allocation amounts must be whole paise above zero', () => {
  const state = khataState();
  for (const amount of [0, -5, 10.5]) {
    const shift = creditShift('s1', '2026-02-01', 1, [{ customerId: 'c1', amountPaise: amount }]);
    const issues = validateShiftForClose(shift, closeCtx(state));
    assert.ok(issues.some((i) => /whole paise/i.test(i)), `amount ${amount} should be rejected, got: ${issues.join('; ')}`);
  }
});

test('allocations recorded against a zero credit tender are rejected', () => {
  const state = khataState();
  const shift = creditShift('s1', '2026-02-01', 1, [{ customerId: 'c1', amountPaise: 100 }]);
  shift.tenders = {}; // no credit tender at all
  const issues = validateShiftForClose(shift, closeCtx(state));
  assert.ok(issues.some((i) => /allocat/i.test(i)), `got: ${issues.join('; ')}`);
});

test('receipt validation blocks unknown customers, bad amounts, modes, dates and overpayment', () => {
  assert.equal(typeof core.receiptIssues, 'function');
  const state = khataState(); // c1 outstanding = 100000 opening only
  const base = { id: 'r1', customerId: 'c1', date: '2026-02-02', amountPaise: 20000, mode: 'UPI' };

  assert.deepEqual(core.receiptIssues(state, base), []);
  assert.deepEqual(core.receiptIssues(state, { ...base, amountPaise: 100000 }), []); // exact settlement is fine
  assert.ok(core.receiptIssues(state, { ...base, customerId: 'ghost' }).length > 0);
  assert.ok(core.receiptIssues(state, { ...base, amountPaise: 0 }).length > 0);
  assert.ok(core.receiptIssues(state, { ...base, amountPaise: -1 }).length > 0);
  assert.ok(core.receiptIssues(state, { ...base, amountPaise: 10.5 }).length > 0);
  assert.ok(core.receiptIssues(state, { ...base, mode: 'CRYPTO' }).length > 0);
  assert.ok(core.receiptIssues(state, { ...base, date: 'tomorrow' }).length > 0);
  const over = core.receiptIssues(state, { ...base, amountPaise: 150000 });
  assert.ok(over.some((i) => /exceeds/i.test(i)), `got: ${over.join('; ')}`);
});

test('backup validation rejects duplicate or malformed customers', () => {
  const dup = khataState();
  dup.customers.push({ ...dup.customers[0], name: 'Copy' });
  assert.match(validateBackup(dup), /duplicate customer id/i);

  const unnamed = khataState();
  unnamed.customers[0].name = '   ';
  assert.match(validateBackup(unnamed), /no name/i);

  const fractional = khataState();
  fractional.customers[0].openingBalancePaise = 10.5;
  assert.match(validateBackup(fractional), /whole paise/i);

  const badLimit = khataState();
  badLimit.customers[0].creditLimitPaise = -1;
  assert.match(validateBackup(badLimit), /credit limit/i);
});

test('backup validation rejects malformed credit receipts', () => {
  const receipt = { id: 'r1', customerId: 'c1', date: '2026-02-02', amountPaise: 20000, mode: 'UPI' };

  const unknown = khataState({ creditReceipts: [{ ...receipt, customerId: 'ghost' }] });
  assert.match(validateBackup(unknown), /unknown customer/i);

  const zero = khataState({ creditReceipts: [{ ...receipt, amountPaise: 0 }] });
  assert.match(validateBackup(zero), /whole paise/i);

  const mode = khataState({ creditReceipts: [{ ...receipt, mode: 'CRYPTO' }] });
  assert.match(validateBackup(mode), /invalid mode/i);

  const dup = khataState({ creditReceipts: [receipt, { ...receipt }] });
  assert.match(validateBackup(dup), /duplicate receipt id/i);

  const valid = khataState({ creditReceipts: [receipt] });
  assert.equal(validateBackup(valid), null);
});

test('backup validation rejects bad allocation structure and unknown allocation customers', () => {
  const notList = khataState();
  notList.shifts = [{ ...creditShift('s1', '2026-02-01', 1, undefined), creditAllocations: 'nope' }];
  assert.match(validateBackup(notList), /list/i);

  const ghost = khataState();
  ghost.shifts = [creditShift('s1', '2026-02-01', 1, [{ customerId: 'ghost', amountPaise: 90000 }])];
  assert.match(validateBackup(ghost), /unknown customer/i);
});

test('normalization restores khata containers and customer defaults', () => {
  const data = khataState();
  delete data.customers;
  delete data.creditReceipts;
  const empty = normalizeState(data);
  assert.deepEqual(empty.customers, []);
  assert.deepEqual(empty.creditReceipts, []);

  const partial = khataState();
  partial.customers = [{ id: 'c9', name: 'No Opening' }];
  const normalized = normalizeState(partial);
  assert.equal(normalized.customers[0].openingBalancePaise, 0);
  assert.equal(normalized.customers[0].active, true);
  // Existing explicit values survive.
  const full = normalizeState(khataState());
  assert.equal(full.customers[0].openingBalancePaise, 100000);
  assert.equal(full.customers[0].creditLimitPaise, 500000);
});

test('customer statement runs a chronological balance and exports CSV', () => {
  assert.equal(typeof core.customerStatement, 'function');
  assert.equal(typeof core.customerStatementCsv, 'function');
  const state = khataState();
  state.shifts = [creditShift('s1', '2026-02-01', 1, [{ customerId: 'c1', amountPaise: 90000 }])];
  state.creditReceipts = [
    { id: 'r1', customerId: 'c1', date: '2026-02-02', amountPaise: 20000, mode: 'UPI', reference: 'UPI-1' },
  ];

  const statement = core.customerStatement(state, 'c1');
  assert.equal(statement.entries.length, 3); // opening, credit sale, receipt
  assert.deepEqual(statement.entries.map((e) => e.balancePaise), [100000, 190000, 170000]);
  assert.equal(statement.balancePaise, core.customerBalancePaise(state, 'c1'));

  const csv = core.customerStatementCsv(state, 'c1');
  assert.match(csv, /"Sharma Transport"/);
  assert.match(csv, /"date","type","reference","debit_inr","credit_inr","balance_inr"/);
  assert.match(csv, /"1700\.00"/);
  assert.match(csv, /"UPI-1"/);
});

test('due customers are positive balances, largest first, with over-limit flagged', () => {
  assert.equal(typeof core.dueCustomers, 'function');
  const state = khataState();
  state.customers.push(
    { id: 'c2', name: 'Over Limit', openingBalancePaise: 300000, creditLimitPaise: 200000, active: true },
    { id: 'c3', name: 'Settled', openingBalancePaise: 0, creditLimitPaise: 0, active: true },
  );
  state.shifts = [creditShift('s1', '2026-02-01', 1, [{ customerId: 'c1', amountPaise: 90000 }])];

  const due = core.dueCustomers(state);
  assert.deepEqual(due.map((d) => d.customer.id), ['c2', 'c1']); // 300000 then 190000; c3 excluded
  assert.equal(due[0].overLimit, true);
  assert.equal(due[1].overLimit, false);
});

test('freezeDay stamps credit allocations into the frozen snapshot', () => {
  const state = khataState();
  const allocations = [{ customerId: 'c1', amountPaise: 90000 }];
  state.shifts = [creditShift('s1', '2026-02-01', 1, allocations)];
  state.days['2026-02-01'] = {
    tanks: { t1: { openingL: 5000, receiptsL: 0, physicalL: 4990 } },
  };

  const snapshot = freezeDay(state, '2026-02-01');
  assert.deepEqual(snapshot.shifts[0].creditAllocations, allocations);

  // A later working-state edit cannot rewrite the frozen attribution.
  state.shifts[0].creditAllocations[0].amountPaise = 1;
  assert.equal(snapshot.shifts[0].creditAllocations[0].amountPaise, 90000);
});

test('freezeDay refuses a closed shift with unallocated credit', () => {
  const state = khataState();
  state.shifts = [creditShift('s1', '2026-02-01', 1, [])];
  state.days['2026-02-01'] = {
    tanks: { t1: { openingL: 5000, receiptsL: 0, physicalL: 4990 } },
  };
  assert.throws(() => freezeDay(state, '2026-02-01'), /allocat/i);
});