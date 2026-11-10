import {
  PRODUCTS,
  TENDERS,
  toPaise,
  formatPaise,
  formatLitres,
  nozzleLitres,
  readingIssues,
  shiftSummary,
  dayTotals,
  dayStock,
  freezeDay,
  lastClosedReading,
  dsrCsv,
} from './core.mjs';

const STORE_KEY = 'petrolbunk.v1';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function demoState() {
  const date = todayISO();
  return {
    version: 1,
    outlet: { name: 'Demo Fuels', omc: 'IOCL' },
    settings: { evaporationPct: { MS: 0.75, HSD: 0 } },
    tanks: [
      { id: 't1', code: 'T1', product: 'HSD', capacityL: 20000 },
      { id: 't2', code: 'T2', product: 'MS', capacityL: 15000 },
    ],
    nozzles: [
      { id: 'n1', label: 'DU1-N1', tankId: 't1', product: 'HSD' },
      { id: 'n2', label: 'DU1-N2', tankId: 't2', product: 'MS' },
      { id: 'n3', label: 'DU2-N3', tankId: 't1', product: 'HSD' },
      { id: 'n4', label: 'DU2-N4', tankId: 't2', product: 'MS' },
    ],
    rates: { [date]: { MS: 10450, HSD: 9000 } },
    days: {},
    shifts: [],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tanks) || !Array.isArray(parsed.nozzles)) return null;
    return parsed;
  } catch {
    return null;
  }
}

let state = load() || demoState();
let cur = { date: todayISO(), seq: 1, day: todayISO(), dsr: todayISO() };

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (err) {
    toast('Could not save: browser storage is full or blocked.', true);
  }
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', Boolean(isError));
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), isError ? 4200 : 2600);
}

const nozzleById = (id) => state.nozzles.find((n) => n.id === id);
const tankById = (id) => state.tanks.find((t) => t.id === id);
const ratesFor = (date) => state.rates?.[date] || {};

function dayFor(date) {
  state.days[date] = state.days[date] || { tanks: {} };
  state.days[date].tanks = state.days[date].tanks || {};
  return state.days[date];
}

function shiftFor(date, seq, create = true) {
  let shift = state.shifts.find((s) => s.date === date && s.seq === Number(seq));
  if (!shift && create) {
    shift = {
      id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      date,
      seq: Number(seq),
      status: 'open',
      readings: {},
      tenders: {},
      attendant: '',
      remark: '',
      signedAt: null,
    };
    state.shifts.push(shift);
  }
  return shift;
}

function blankShift(date, seq) {
  return {
    id: null,
    date,
    seq: Number(seq),
    status: 'open',
    readings: {},
    tenders: {},
    attendant: '',
    remark: '',
    signedAt: null,
  };
}

// Reading the UI must not create a draft: an empty shift would block day close.
const getShift = (date, seq) => shiftFor(date, seq, false) || blankShift(date, seq);

const isDayClosed = (date) => state.days?.[date]?.status === 'closed';

/* ────────────────────────── header ────────────────────────── */

function renderHeader() {
  $('#outlet-line').textContent = `${state.outlet?.name || 'Unnamed outlet'} · ${state.outlet?.omc || ''}`;
  const closed = isDayClosed(cur.date);
  const day = state.days?.[cur.date];
  const pill = $('#day-pill');
  pill.textContent = closed ? `Closed ${cur.date}` : `Open · ${cur.date}`;
  pill.className = `pill ${closed ? 'closed' : 'open'}`;
  pill.title = closed ? `Frozen at ${day?.dsr?.closedAt || ''}` : 'Day not yet closed';
}

/* ────────────────────────── shift view ────────────────────────── */

function refreshOpenings(shift) {
  for (const nozzle of state.nozzles) {
    const reading = shift.readings[nozzle.id];
    if (!reading) continue;
    const hasClosing = reading.closing !== '' && reading.closing !== undefined;
    if (hasClosing) continue;
    const prev = lastClosedReading(state, nozzle.id, shift.date, shift.seq);
    if (prev !== null) reading.opening = String(prev);
  }
}

function renderShift() {
  const existing = shiftFor(cur.date, cur.seq, false);
  const shift = existing || blankShift(cur.date, cur.seq);
  if (existing) {
    refreshOpenings(shift);
    save();
  }

  $('#shift-date').value = cur.date;
  $('#shift-seq').value = String(cur.seq);

  const rates = ratesFor(cur.date);
  $('#shift-rates').innerHTML = PRODUCTS.map((p) => {
    const rate = rates[p.code];
    return `<span>${esc(p.label)}: ${rate ? `₹${formatPaise(rate)}` : 'rate not set'}</span>`;
  }).join('');

  const locked = shift.status === 'closed' || isDayClosed(cur.date);
  const tbody = $('#nozzle-table tbody');
  tbody.innerHTML = state.nozzles.map((nozzle) => {
    const reading = shift.readings[nozzle.id] || {};
    const disabled = locked ? 'disabled' : '';
    return `<tr data-nozzle="${nozzle.id}">
      <td class="nozzle-name">${esc(nozzle.label)}<small>${esc(nozzle.product)}</small></td>
      <td><input type="number" inputmode="decimal" step="0.01" data-field="opening" value="${esc(reading.opening ?? '')}" ${disabled} aria-label="${esc(nozzle.label)} opening reading" /></td>
      <td><input type="number" inputmode="decimal" step="0.01" data-field="closing" value="${esc(reading.closing ?? '')}" ${disabled} aria-label="${esc(nozzle.label)} closing reading" /></td>
      <td><input type="number" inputmode="decimal" step="0.01" data-field="testing" value="${esc(reading.testing ?? '')}" ${disabled} aria-label="${esc(nozzle.label)} testing litres" /></td>
      <td class="num" data-calc="gross">—</td>
      <td class="num" data-calc="net">—</td>
      <td class="num" data-calc="value">—</td>
    </tr>`;
  }).join('');

  $('#tenders').innerHTML = TENDERS.map((t) => `
    <label class="field">
      <span>${esc(t.label)} ₹</span>
      <input type="number" inputmode="decimal" step="0.01" data-tender="${t.code}"
        value="${shift.tenders?.[t.code] ? formatPaise(shift.tenders[t.code]) : ''}"
        ${locked ? 'disabled' : ''} placeholder="0.00" />
    </label>`).join('');

  $('#attendant').value = shift.attendant || '';
  $('#attendant').disabled = locked;
  $('#remark').value = shift.remark || '';
  $('#remark').disabled = locked;
  $('#signed').checked = Boolean(shift.confirmed || shift.signedAt);
  $('#signed').disabled = locked;
  $('#close-shift').disabled = locked;
  $('#reset-shift').disabled = locked;

  updateShiftCalc();
  renderShiftList();
}

function updateShiftCalc() {
  const shift = getShift(cur.date, cur.seq);
  const summary = shiftSummary(shift, { nozzles: state.nozzles, rates: ratesFor(cur.date) });

  for (const nozzle of state.nozzles) {
    const row = $(`#nozzle-table tr[data-nozzle="${nozzle.id}"]`);
    if (!row) continue;
    const line = summary.lines.find((l) => l.nozzleId === nozzle.id);
    row.querySelector('[data-calc="gross"]').textContent = line ? formatLitres(line.gross) : '—';
    row.querySelector('[data-calc="net"]').textContent = line ? formatLitres(line.net) : '—';
    row.querySelector('[data-calc="value"]').textContent = line ? formatPaise(line.valuePaise) : '—';
  }

  const diff = summary.differencePaise;
  const diffClass = diff > 0 ? 'short' : diff < 0 ? 'excess' : '';
  const diffLabel = diff > 0 ? 'Short' : diff < 0 ? 'Excess' : 'Balanced';
  $('#settlement').innerHTML = `
    <div><span>Sales value</span><strong>₹${formatPaise(summary.salesValuePaise)}</strong></div>
    <div><span>Collected</span><strong>₹${formatPaise(summary.collectedPaise)}</strong></div>
    <div class="${diffClass}"><span>${diffLabel}</span><strong>₹${formatPaise(Math.abs(diff))}</strong></div>`;

  renderIssues(shift, summary);
}

function renderIssues(shift, summary) {
  const list = $('#shift-issues');
  const issues = [];
  let anyReading = false;

  for (const nozzle of state.nozzles) {
    const reading = shift.readings[nozzle.id];
    if (!reading) continue;
    const touched = ['opening', 'closing', 'testing'].some(
      (f) => reading[f] !== '' && reading[f] !== undefined && reading[f] !== null,
    );
    if (!touched) continue;
    anyReading = true;
    const prev = lastClosedReading(state, nozzle.id, shift.date, shift.seq);
    for (const issue of readingIssues(reading, prev)) {
      issues.push(`${nozzle.label}: ${issue}`);
    }
  }

  if (!anyReading && shift.status !== 'closed') {
    issues.push('Enter closing readings to begin — opening fills in from the last closed shift.');
  }
  if (summary.lines.length > 0) {
    const missingRate = Object.keys(summary.litresByProduct).filter((code) => !ratesFor(cur.date)[code]);
    if (missingRate.length) {
      issues.push(`Rate missing for ${missingRate.join(', ')} — set it in Setup → Rates.`);
    }
  }
  if (shift.status === 'closed') issues.length = 0;

  list.classList.toggle('ok', issues.length === 0 && anyReading);
  list.innerHTML = issues.map((i) => `<li>${esc(i)}</li>`).join('');
}

function renderShiftList() {
  const list = $('#shift-list');
  const shifts = state.shifts.filter((s) => s.date === cur.date).sort((a, b) => a.seq - b.seq);
  if (shifts.length === 0) {
    list.innerHTML = '<li><span class="who">No shifts entered for this date.</span></li>';
    return;
  }
  list.innerHTML = shifts.map((s) => {
    const summary = shiftSummary(s, { nozzles: state.nozzles, rates: ratesFor(s.date) });
    const litres = Object.values(summary.litresByProduct).reduce((a, b) => a + b, 0);
    const diff = summary.differencePaise;
    const diffText = diff === 0 ? 'balanced' : `${diff > 0 ? 'short' : 'excess'} ₹${formatPaise(Math.abs(diff))}`;
    return `<li>
      <div>
        <strong>Shift ${s.seq}</strong> · ${formatLitres(litres)} L · ₹${formatPaise(summary.salesValuePaise)}
        <div class="who">${esc(s.attendant || 'no attendant')} · ${esc(diffText)}</div>
      </div>
      <span class="chip ${s.status === 'closed' ? 'closed' : 'open'}">${s.status}</span>
    </li>`;
  }).join('');
}

function closeShift() {
  const shift = shiftFor(cur.date, cur.seq, false);
  if (!shift) return toast('No nozzle readings entered.', true);
  if (shift.status === 'closed') return toast('This shift is already closed.', true);

  const issues = [];
  let counted = 0;
  for (const nozzle of state.nozzles) {
    const reading = shift.readings[nozzle.id];
    if (!reading) continue;
    const touched = ['opening', 'closing', 'testing'].some(
      (f) => reading[f] !== '' && reading[f] !== undefined && reading[f] !== null,
    );
    if (!touched) continue;
    counted += 1;
    const prev = lastClosedReading(state, nozzle.id, shift.date, shift.seq);
    issues.push(...readingIssues(reading, prev).map((i) => `${nozzle.label}: ${i}`));
  }
  if (counted === 0) return toast('No nozzle readings entered.', true);
  if (issues.length) {
    renderIssues(shift, shiftSummary(shift, { nozzles: state.nozzles, rates: ratesFor(cur.date) }));
    return toast(issues[0], true);
  }
  if (!shift.attendant.trim()) return toast('Attendant name is required.', true);
  if (!shift.confirmed) return toast('The attendant must confirm and sign the drawer first.', true);
  const summary = shiftSummary(shift, { nozzles: state.nozzles, rates: ratesFor(cur.date) });
  if (summary.differencePaise !== 0 && !shift.remark.trim()) {
    return toast('A short/excess needs a remark before the shift can close.', true);
  }

  shift.status = 'closed';
  shift.signedAt = new Date().toISOString();
  save();
  toast(`Shift ${shift.seq} closed · ${summary.differencePaise === 0 ? 'balanced' : `₹${formatPaise(Math.abs(summary.differencePaise))} ${summary.differencePaise > 0 ? 'short' : 'excess'}`}`);
  renderShift();
  renderHeader();
}

function discardDraft() {
  const shift = shiftFor(cur.date, cur.seq, false);
  if (!shift || shift.status === 'closed') return toast('Nothing to discard.', true);  state.shifts = state.shifts.filter((s) => s.id !== shift.id);
  save();
  toast('Draft discarded.');
  renderShift();
}

/* ────────────────────────── day close ────────────────────────── */

function previousPhysical(date, tankId) {
  const dates = Object.keys(state.days || {})
    .filter((d) => d < date && state.days[d]?.dsr)
    .sort();
  for (let i = dates.length - 1; i >= 0; i -= 1) {
    const stock = state.days[dates[i]].dsr.stock.find((s) => s.tankId === tankId);
    if (stock && stock.physical !== null) return stock.physical;
  }
  return null;
}

function ensureDayInputs(date) {
  const day = dayFor(date);
  for (const tank of state.tanks) {
    const input = day.tanks[tank.id] || (day.tanks[tank.id] = {});
    if (input.openingL === undefined || input.openingL === '') {
      const prev = previousPhysical(date, tank.id);
      if (prev !== null) input.openingL = String(prev);
    }
  }
  save();
}

function renderDay() {
  $('#day-date').value = cur.day;
  ensureDayInputs(cur.day);
  const closed = isDayClosed(cur.day);
  const day = dayFor(cur.day);

  const tbody = $('#tank-table tbody');
  tbody.innerHTML = state.tanks.map((tank) => {
    const input = day.tanks[tank.id] || {};
    const disabled = closed ? 'disabled' : '';
    return `<tr data-tank="${tank.id}">
      <td class="nozzle-name">${esc(tank.code)}<small>${esc(tank.product)}</small></td>
      <td><input type="number" inputmode="decimal" step="0.01" data-tank-field="openingL" value="${esc(input.openingL ?? '')}" ${disabled} aria-label="${esc(tank.code)} opening stock" /></td>
      <td><input type="number" inputmode="decimal" step="0.01" data-tank-field="receiptsL" value="${esc(input.receiptsL ?? '')}" ${disabled} aria-label="${esc(tank.code)} receipts" /></td>
      <td><input type="number" inputmode="decimal" step="0.01" data-tank-field="physicalL" value="${esc(input.physicalL ?? '')}" ${disabled} aria-label="${esc(tank.code)} physical dip" /></td>
      <td class="num" data-calc="book">—</td>
      <td class="num" data-calc="variance">—</td>
      <td class="num" data-calc="pct">—</td>
      <td data-calc="status"></td>
    </tr>`;
  }).join('');

  const totals = dayTotals(state, cur.day);
  $('#day-open-hint').textContent = totals.openShifts
    ? `${totals.openShifts} shift(s) still open — sales figures are provisional.`
    : `${totals.shifts} closed shift(s) on this date.`;
  $('#close-day').disabled = closed;
  $('#close-day').textContent = closed ? 'Day closed' : 'Close day & freeze DSR';

  updateDayCalc();
}

function updateDayCalc() {
  const stock = dayStock(state, cur.day);
  const totals = dayTotals(state, cur.day);

  for (const line of stock) {
    const row = $(`#tank-table tr[data-tank="${line.tank.id}"]`);
    if (!row) continue;
    row.querySelector('[data-calc="book"]').textContent = formatLitres(line.bookClosing);
    row.querySelector('[data-calc="variance"]').textContent =
      line.varianceL === null ? '—' : formatLitres(line.varianceL);
    row.querySelector('[data-calc="pct"]').textContent =
      line.variancePct === null ? '—' : `${line.variancePct.toFixed(2)}%`;
    const labels = {
      within: 'within allowance',
      investigate: 'investigate',
      'beyond-mdg': 'beyond MDG band',
      pending: 'dip pending',
    };
    row.querySelector('[data-calc="status"]').innerHTML =
      `<span class="chip ${line.status}">${labels[line.status]}</span>`;
  }

  const varianceTotal = stock.reduce((a, s) => a + (s.varianceL || 0), 0);
  const diff = totals.differencePaise;
  const litres = Object.values(totals.litresByProduct).reduce((a, b) => a + b, 0);
  const missingRates = PRODUCTS.filter((p) => totals.litresByProduct[p.code] > 0 && !ratesFor(cur.day)[p.code]);

  $('#day-summary').innerHTML = `
    <div class="card-head"><h2>Day summary</h2><span class="hint">${esc(cur.day)}</span></div>
    <div class="metrics">
      <div class="metric"><span>Litres sold</span><strong>${formatLitres(litres)}</strong></div>
      <div class="metric"><span>Sales value</span><strong>₹${formatPaise(totals.salesValuePaise)}</strong></div>
      <div class="metric"><span>Collected</span><strong>₹${formatPaise(totals.collectedPaise)}</strong></div>
      <div class="metric ${diff > 0 ? 'bad' : diff < 0 ? 'good' : ''}">
        <span>${diff > 0 ? 'Short' : diff < 0 ? 'Excess' : 'Cash'}</span>
        <strong>₹${formatPaise(Math.abs(diff))}</strong>
      </div>
      <div class="metric ${varianceTotal < 0 ? 'bad' : ''}">
        <span>Stock variance</span><strong>${formatLitres(varianceTotal)} L</strong>
      </div>
    </div>
    ${PRODUCTS.filter((p) => totals.litresByProduct[p.code]).map((p) =>
      `<div class="hint">${esc(p.label)}: ${formatLitres(totals.litresByProduct[p.code])} L · ₹${formatPaise(totals.valueByProduct[p.code] || 0)}</div>`).join('')}
    ${missingRates.length ? `<div class="hint">Rate missing for ${missingRates.map((p) => p.code).join(', ')} — set it in Setup → Rates.</div>` : ''}`;

  $('#variance-note').textContent =
    'Book = opening + receipts − net sales (testing litres already excluded). ' +
    'Status compares the loss with the 0.75% MS evaporation allowance and the MDG 4% tank-stock band.';
}

function closeDay() {
  if (isDayClosed(cur.day)) return toast('This day is already closed.', true);
  const totals = dayTotals(state, cur.day);
  if (totals.shifts === 0) return toast('No closed shifts on this date.', true);

  try {
    const snapshot = freezeDay(state, cur.day, { closedBy: state.outlet?.name || 'Owner' });
    const day = dayFor(cur.day);
    day.dsr = snapshot;
    day.status = 'closed';
    save();
    cur.dsr = cur.day;
    toast(`DSR frozen for ${cur.day}.`);
    switchView('dsr');
    renderAll();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ────────────────────────── DSR view ────────────────────────── */

function renderDsr() {
  $('#dsr-date').value = cur.dsr;
  const snapshot = state.days?.[cur.dsr]?.dsr;
  const body = $('#dsr-body');

  if (!snapshot) {
    body.innerHTML = `<div class="empty-state">No frozen DSR for ${esc(cur.dsr)}.<br />Close the shifts, take the evening dip, then close the day.</div>`;
    return;
  }

  const t = snapshot.totals;
  const lines = t.lines.map((l) => `
    <tr>
      <td>${esc(l.label)}</td><td>${esc(l.product)}</td>
      <td class="num">${formatLitres(l.gross)}</td>
      <td class="num">${formatLitres(l.testing)}</td>
      <td class="num">${formatLitres(l.net)}</td>
      <td class="num">${formatPaise(l.ratePaise)}</td>
      <td class="num">${formatPaise(l.valuePaise)}</td>
    </tr>`).join('');

  const stock = snapshot.stock.map((s) => `
    <tr>
      <td>${esc(s.code)} (${esc(s.product)})</td>
      <td class="num">${formatLitres(s.opening)}</td>
      <td class="num">${formatLitres(s.receipts)}</td>
      <td class="num">${formatLitres(s.netSales)}</td>
      <td class="num">${formatLitres(s.bookClosing)}</td>
      <td class="num">${formatLitres(s.physical)}</td>
      <td class="num">${formatLitres(s.varianceL)}</td>
      <td class="num">${s.variancePct.toFixed(2)}%</td>
    </tr>`).join('');

  const drawers = t.drawers.map((d) => `
    <tr>
      <td>Shift ${d.seq}</td><td>${esc(d.attendant || '—')}</td>
      <td class="num">${formatPaise(d.expectedPaise)}</td>
      <td class="num">${formatPaise(d.collectedPaise)}</td>
      <td class="num">${d.differencePaise === 0 ? '0.00' : formatPaise(d.differencePaise)}</td>
      <td>${d.signedAt ? 'signed' : 'not signed'}</td>
    </tr>`).join('');

  const collections = TENDERS.map((tender) => `
    <tr><td>${esc(tender.label)}</td><td class="num">${formatPaise(t.collections[tender.code] || 0)}</td></tr>`).join('');

  body.innerHTML = `
    <article class="dsr-doc">
      <header>
        <h2>${esc(snapshot.outlet)} · ${esc(snapshot.omc)}</h2>
        <div class="meta">Daily Sales Report · ${esc(snapshot.date)} · frozen ${esc(snapshot.closedAt)} · ${esc(snapshot.closedBy)}</div>
      </header>

      <div class="metrics" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px">
        <div class="metric"><span>Litres</span><strong>${formatLitres(Object.values(t.litresByProduct).reduce((a, b) => a + b, 0))}</strong></div>
        <div class="metric"><span>Sales</span><strong>₹${formatPaise(t.salesValuePaise)}</strong></div>
        <div class="metric"><span>Collected</span><strong>₹${formatPaise(t.collectedPaise)}</strong></div>
        <div class="metric ${t.differencePaise > 0 ? 'bad' : ''}"><span>Short / excess</span><strong>₹${formatPaise(Math.abs(t.differencePaise))}</strong></div>
        <div class="metric"><span>Stock variance</span><strong>${formatLitres(snapshot.totalVarianceL)} L</strong></div>
      </div>

      <h3>Nozzle sales</h3>
      <table><thead><tr><th>Nozzle</th><th>Product</th><th class="num">Gross</th><th class="num">Test</th><th class="num">Net</th><th class="num">Rate ₹</th><th class="num">Value ₹</th></tr></thead>
      <tbody>${lines}</tbody></table>

      <h3>Collections</h3>
      <table><tbody>${collections}
        <tr><th>Total</th><th class="num">${formatPaise(t.collectedPaise)}</th></tr>
      </tbody></table>

      <h3>Shift handover</h3>
      <table><thead><tr><th>Shift</th><th>Attendant</th><th class="num">Expected ₹</th><th class="num">Collected ₹</th><th class="num">Short/Excess ₹</th><th>Sign</th></tr></thead>
      <tbody>${drawers}</tbody></table>

      <h3>Stock &amp; variance</h3>
      <table><thead><tr><th>Tank</th><th class="num">Opening</th><th class="num">Receipts</th><th class="num">Net sales</th><th class="num">Book</th><th class="num">Physical</th><th class="num">Variance L</th><th class="num">%</th></tr></thead>
      <tbody>${stock}</tbody></table>

      <div class="sign"><div>Prepared by</div><div>Attendant</div><div>Dealer</div></div>
    </article>`;
}

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ────────────────────────── setup ────────────────────────── */

function renderSetup() {
  $('#outlet-name').value = state.outlet?.name || '';
  $('#outlet-omc').value = state.outlet?.omc || 'IOCL';
  $('#evap-ms').value = state.settings?.evaporationPct?.MS ?? 0.75;
  $('#evap-hsd').value = state.settings?.evaporationPct?.HSD ?? 0;

  $('#rate-date').value = $('#rate-date').value || cur.date;
  const rates = ratesFor($('#rate-date').value);
  $('#rate-ms').value = rates.MS ? formatPaise(rates.MS) : '';
  $('#rate-hsd').value = rates.HSD ? formatPaise(rates.HSD) : '';

  $('#tank-editor').innerHTML = state.tanks.map((tank) => `
    <div class="bar" data-tank-row="${tank.id}" style="margin-bottom:8px">
      <label class="field"><span>Code</span>
        <input type="text" data-tank-edit="code" value="${esc(tank.code)}" /></label>
      <label class="field"><span>Product</span>
        <select data-tank-edit="product">
          ${PRODUCTS.map((p) => `<option value="${p.code}" ${p.code === tank.product ? 'selected' : ''}>${esc(p.code)}</option>`).join('')}
        </select></label>
      <label class="field"><span>Capacity L</span>
        <input type="number" step="1" data-tank-edit="capacityL" value="${esc(tank.capacityL)}" /></label>
      <button class="btn ghost" data-remove-tank="${tank.id}" type="button">Remove</button>
    </div>`).join('');

  $('#nozzle-editor').innerHTML = state.nozzles.map((nozzle) => `
    <div class="bar" data-nozzle-row="${nozzle.id}" style="margin-bottom:8px">
      <label class="field"><span>Label</span>
        <input type="text" data-nozzle-edit="label" value="${esc(nozzle.label)}" /></label>
      <label class="field"><span>Tank</span>
        <select data-nozzle-edit="tankId">
          ${state.tanks.map((t) => `<option value="${t.id}" ${t.id === nozzle.tankId ? 'selected' : ''}>${esc(t.code)} · ${esc(t.product)}</option>`).join('')}
        </select></label>
      <button class="btn ghost" data-remove-nozzle="${nozzle.id}" type="button">Remove</button>
    </div>`).join('');
}

/* ────────────────────────── wiring ────────────────────────── */

function switchView(name) {
  $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.view === name));
  $$('.view').forEach((view) => view.classList.toggle('is-active', view.id === `view-${name}`));
  if (name === 'shift') renderShift();
  if (name === 'day') renderDay();
  if (name === 'dsr') renderDsr();
  if (name === 'setup') renderSetup();
}

function renderAll() {
  renderHeader();
  renderShift();
  renderDay();
  renderDsr();
  renderSetup();
}

function wire() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));

  // shift
  $('#shift-date').addEventListener('change', (e) => {
    cur.date = e.target.value;
    renderHeader();
    renderShift();
  });
  $('#shift-seq').addEventListener('change', (e) => {
    cur.seq = Number(e.target.value);
    renderShift();
  });

  $('#nozzle-table').addEventListener('input', (e) => {
    const input = e.target.closest('input[data-field]');
    if (!input) return;
    const shift = shiftFor(cur.date, cur.seq);
    const nozzleId = input.closest('tr').dataset.nozzle;
    shift.readings[nozzleId] = shift.readings[nozzleId] || {};
    shift.readings[nozzleId][input.dataset.field] = input.value;
    save();
    updateShiftCalc();
  });

  $('#tenders').addEventListener('input', (e) => {
    const input = e.target.closest('input[data-tender]');
    if (!input) return;
    const shift = shiftFor(cur.date, cur.seq);
    shift.tenders[input.dataset.tender] = toPaise(input.value);
    save();
    updateShiftCalc();
  });

  $('#attendant').addEventListener('input', (e) => {
    shiftFor(cur.date, cur.seq).attendant = e.target.value;
    save();
  });
  $('#remark').addEventListener('input', (e) => {
    shiftFor(cur.date, cur.seq).remark = e.target.value;
    save();
  });
  $('#signed').addEventListener('change', (e) => {
    const shift = shiftFor(cur.date, cur.seq);
    shift.confirmed = e.target.checked;
    if (!e.target.checked) shift.signedAt = null;
    save();
  });
  $('#close-shift').addEventListener('click', closeShift);
  $('#reset-shift').addEventListener('click', discardDraft);
  $('#refresh-openings').addEventListener('click', () => {
    const shift = shiftFor(cur.date, cur.seq);
    for (const nozzle of state.nozzles) {
      const reading = shift.readings[nozzle.id] || (shift.readings[nozzle.id] = {});
      const prev = lastClosedReading(state, nozzle.id, shift.date, shift.seq);
      if (prev !== null) reading.opening = String(prev);
    }
    save();
    renderShift();
    toast('Openings re-read from the last closed shift.');
  });

  // day
  $('#day-date').addEventListener('change', (e) => {
    cur.day = e.target.value;
    renderDay();
  });
  $('#tank-table').addEventListener('input', (e) => {
    const input = e.target.closest('input[data-tank-field]');
    if (!input) return;
    const tankId = input.closest('tr').dataset.tank;
    const day = dayFor(cur.day);
    day.tanks[tankId] = day.tanks[tankId] || {};
    day.tanks[tankId][input.dataset.tankField] = input.value;
    save();
    updateDayCalc();
  });
  $('#close-day').addEventListener('click', closeDay);

  // dsr
  $('#dsr-date').addEventListener('change', (e) => {
    cur.dsr = e.target.value;
    renderDsr();
  });
  $('#print-dsr').addEventListener('click', () => window.print());
  $('#csv-dsr').addEventListener('click', () => {
    downloadFile(`dsr-${cur.dsr}.csv`, dsrCsv(state, cur.dsr), 'text/csv;charset=utf-8');
  });

  // setup
  $('#outlet-name').addEventListener('input', (e) => {
    state.outlet.name = e.target.value;
    save();
    renderHeader();
  });
  $('#outlet-omc').addEventListener('change', (e) => {
    state.outlet.omc = e.target.value;
    save();
    renderHeader();
  });
  $('#evap-ms').addEventListener('change', (e) => {
    state.settings.evaporationPct.MS = Number(e.target.value) || 0;
    save();
    updateDayCalc();
  });
  $('#evap-hsd').addEventListener('change', (e) => {
    state.settings.evaporationPct.HSD = Number(e.target.value) || 0;
    save();
    updateDayCalc();
  });
  $('#rate-date').addEventListener('change', renderSetup);
  $('#save-rates').addEventListener('click', () => {
    const date = $('#rate-date').value;
    state.rates[date] = {
      MS: toPaise($('#rate-ms').value),
      HSD: toPaise($('#rate-hsd').value),
    };
    save();
    toast(`Rates saved for ${date}.`);
    renderShift();
    renderDay();
  });

  $('#tank-editor').addEventListener('input', (e) => {
    const row = e.target.closest('[data-tank-row]');
    if (!row) return;
    const tank = tankById(row.dataset.tankRow);
    if (!tank) return;
    tank[e.target.dataset.tankEdit] = e.target.dataset.tankEdit === 'capacityL'
      ? Number(e.target.value) || 0
      : e.target.value;
    save();
  });
  $('#tank-editor').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-tank]');
    if (!btn) return;
    const id = btn.dataset.removeTank;
    if (state.nozzles.some((n) => n.tankId === id)) return toast('Remove its nozzles first.', true);
    state.tanks = state.tanks.filter((t) => t.id !== id);
    save();
    renderSetup();
    renderShift();
    renderDay();
  });
  $('#add-tank').addEventListener('click', () => {
    state.tanks.push({
      id: `t${Date.now().toString(36)}`,
      code: `T${state.tanks.length + 1}`,
      product: 'HSD',
      capacityL: 20000,
    });
    save();
    renderSetup();
    renderDay();
  });

  $('#nozzle-editor').addEventListener('input', (e) => {
    const row = e.target.closest('[data-nozzle-row]');
    if (!row) return;
    const nozzle = nozzleById(row.dataset.nozzleRow);
    if (!nozzle) return;
    nozzle[e.target.dataset.nozzleEdit] = e.target.value;
    if (e.target.dataset.nozzleEdit === 'tankId') {
      const tank = tankById(e.target.value);
      if (tank) nozzle.product = tank.product;
    }
    save();
  });
  $('#nozzle-editor').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-nozzle]');
    if (!btn) return;
    state.nozzles = state.nozzles.filter((n) => n.id !== btn.dataset.removeNozzle);
    save();
    renderSetup();
    renderShift();
    renderDay();
  });
  $('#add-nozzle').addEventListener('click', () => {
    const tank = state.tanks[0];
    if (!tank) return toast('Add a tank first.', true);
    state.nozzles.push({
      id: `n${Date.now().toString(36)}`,
      label: `DU${state.nozzles.length + 1}-N${state.nozzles.length + 1}`,
      tankId: tank.id,
      product: tank.product,
    });
    save();
    renderSetup();
    renderShift();
    renderDay();
  });

  // data
  $('#export-json').addEventListener('click', () => {
    downloadFile(`petrol-bunk-${todayISO()}.json`, JSON.stringify(state, null, 2), 'application/json');
  });
  $('#import-json').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!parsed || !Array.isArray(parsed.tanks) || !Array.isArray(parsed.nozzles)) {
          throw new Error('Not a petrol bunk backup.');
        }
        state = parsed;
        state.days = state.days || {};
        state.shifts = state.shifts || [];
        state.rates = state.rates || {};
        state.settings = state.settings || { evaporationPct: { MS: 0.75, HSD: 0 } };
        save();
        renderAll();
        toast('Backup imported.');
      } catch (err) {
        toast(`Import failed: ${err.message}`, true);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });
  $('#load-demo').addEventListener('click', () => {
    state = demoState();
    save();
    renderAll();
    toast('Demo data loaded.');
  });
  $('#reset-all').addEventListener('click', () => {
    if (!window.confirm('Erase all saved shifts, days and DSRs on this device?')) return;
    localStorage.removeItem(STORE_KEY);
    state = demoState();
    save();
    renderAll();
    toast('All data erased; demo tanks and rates restored.');
  });
}

wire();
renderAll();
switchView('shift');
