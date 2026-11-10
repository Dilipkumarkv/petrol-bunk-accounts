import test from 'node:test';
import assert from 'node:assert/strict';

import { validateBackup } from '../app/core.mjs';

function validBackup() {
  return {
    version: 1,
    outlet: { name: 'Backup Fuels', omc: 'IOCL' },
    settings: { evaporationPct: { MS: 0.75, HSD: 0 } },
    tanks: [
      { id: 't1', code: 'T1', product: 'HSD', capacityL: 20000 },
      { id: 't2', code: 'T2', product: 'MS', capacityL: 15000 },
    ],
    nozzles: [
      { id: 'n1', label: 'DU1-N1', tankId: 't1', product: 'HSD' },
      { id: 'n2', label: 'DU1-N2', tankId: 't2', product: 'MS' },
    ],
    rates: {
      '2026-02-01': { MS: 10450, HSD: 9000 },
      '2026-02-02': { MS: 10450, HSD: 9000 },
    },
    days: {},
    shifts: [],
  };
}

function closedShift(id, date, seq, opening, closing) {
  return {
    id,
    date,
    seq,
    status: 'closed',
    readings: {
      n1: { opening, closing, testing: 0 },
      n2: { opening: 500, closing: 500, testing: 0 },
    },
    tenders: {},
    attendant: 'Ramesh',
    confirmed: true,
    signedAt: `${date}T14:00:00Z`,
    remark: '',
  };
}

test('backup validation rejects duplicate tank IDs', () => {
  const data = validBackup();
  data.tanks.push({ ...data.tanks[0], code: 'T3' });
  assert.match(validateBackup(data), /duplicate tank id/i);
});

test('backup validation rejects duplicate nozzle IDs', () => {
  const data = validBackup();
  data.nozzles.push({ ...data.nozzles[0], label: 'DU9-N9' });
  assert.match(validateBackup(data), /duplicate nozzle id/i);
});

test("an open draft does not affect the next closed shift's carry-forward", () => {
  const data = validBackup();
  data.shifts = [
    closedShift('s1', '2026-02-01', 1, 0, 100),
    {
      id: 'draft',
      date: '2026-02-02',
      seq: 1,
      status: 'open',
      readings: { n1: { opening: 100, closing: 999, testing: 0 } },
      tenders: {},
    },
    closedShift('s2', '2026-02-02', 2, 100, 150),
  ];

  assert.equal(validateBackup(data), null);
});

test('backup validation rejects invalid evaporation allowances', () => {
  const negative = validBackup();
  negative.settings.evaporationPct.MS = -0.1;
  assert.match(validateBackup(negative), /evaporation allowance/i);

  const nonNumeric = validBackup();
  nonNumeric.settings.evaporationPct.HSD = 'unknown';
  assert.match(validateBackup(nonNumeric), /evaporation allowance/i);
});

test('state normalization restores containers and nested evaporation defaults', async () => {
  const { normalizeState } = await import('../app/core.mjs');
  assert.equal(typeof normalizeState, 'function');

  const data = validBackup();
  data.settings = { evaporationPct: { HSD: 0.2 } };
  data.days = undefined;
  data.shifts = undefined;
  data.rates = undefined;

  const normalized = normalizeState(data);
  assert.deepEqual(normalized.settings.evaporationPct, { MS: 0.75, HSD: 0.2 });
  assert.deepEqual(normalized.days, {});
  assert.deepEqual(normalized.shifts, []);
  assert.deepEqual(normalized.rates, {});
});
