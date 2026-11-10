# Petrol Bunk Accounts — Implementation Workflow and Feature Roadmap

**Date:** 2026-11-10  
**Reviewed upstream baseline:** `24b6d53`  
**Current status:** local, uncommitted changes on top of that baseline: the hardening patch (§1–2) plus the first khata (credit) slice (§6). Nothing has been pushed, published, or opened as a pull request.

## 1. What this local patch implements

The latest upstream commits had already fixed the Node 24 CI command, centralized shift/day/import validation, preserved closed-shift rates and nozzle/tank mappings, added whole-day flow tests, and updated the main documentation. This patch addresses the remaining gaps found after re-checking that work.

| Area | Implemented change | Main files |
| --- | --- | --- |
| Saved-state validation | Browser startup now uses the same backup validator as JSON import instead of accepting any object with tank and nozzle arrays. | `app/app.js`, `app/core.mjs` |
| State normalization | Missing `days`, `shifts`, `rates`, `settings`, and nested evaporation defaults are restored after validation. A backup with `settings: {}` no longer leaves a crash-prone partial settings object. | `app/core.mjs`, `app/app.js` |
| Unique configuration IDs | Duplicate tank IDs and duplicate nozzle IDs are rejected during startup/import validation. | `app/core.mjs` |
| Carry-forward consistency | Open drafts no longer influence the previous closing used to validate a later closed shift. Only closed shifts establish carry-forward, matching the app engine. | `app/core.mjs` |
| Evaporation input | Blank, non-numeric, and negative allowances are rejected. Existing valid values are preserved, the previous value is restored after an invalid edit, and the inputs declare `min="0"`. | `app/app.js`, `app/index.html`, `app/core.mjs` |
| Demo overwrite protection | Loading demo data now always asks for confirmation because it replaces outlet configuration and rates as well as shifts and frozen reports. Cancelling preserves the current outlet. | `app/app.js` |
| Regression coverage | Five backup/settings tests were added before the fixes and observed failing against the old code. | `test/backup.test.mjs` |
| Documentation | Test counts, validation rules, the test command shown in the app, and contributor invariants were synchronized. | `README.md`, `AGENTS.md`, `app/index.html`, `workflow.md` |

No dependency, backend, authentication, analytics, build step, or unrelated refactor was introduced.

## 2. Verification evidence

### Automated checks

- The five new regression tests were run against the untouched code first: **0 passed, 5 failed**, each for the intended defect.
- After the engine fixes, the new file passed **5/5**.
- Final full suite on **Node 24.16.0**: **27 passed, 0 failed**.
- `node --check app/app.js` and `node --check app/core.mjs` both completed successfully.
- The reviewed upstream baseline has green GitHub Actions jobs for Node 24 and Node 26. The local patch has not been pushed, so no remote CI run is claimed for this uncommitted diff.

### Real browser checks

The app was served locally and driven through its actual DOM and storage:

1. A valid JSON backup containing `settings: {}` imported successfully as **Import Fuels**, with defaults restored to **MS 0.75%** and **HSD 0%**.
2. Entering **−1%** MS evaporation restored the previous **0.75%**, left storage unchanged, and displayed an error. A subsequent **0.80%** edit saved correctly.
3. Loading demo data with the confirmation cancelled produced **one confirmation prompt** and preserved the custom outlet.
4. A saved state with a duplicate tank ID was rejected on reload; the app fell back to its demo state without console errors.
5. A complete accounting flow was entered through the UI:
   - HSD: 195 net litres across the active HSD nozzle; the second HSD nozzle was idle.
   - MS: 55 net litres across the active MS nozzle; the second MS nozzle was idle.
   - Sales value and cash collection both balanced at **₹23,297.50**.
   - Shift 1 closed as balanced with attendant sign-off, stamped rates, and a four-nozzle configuration snapshot.
   - Tank book closing values were **4,805 L** and **9,945 L**, both with **0.00 L variance**.
   - Day close created a frozen DSR with one shift, **₹23,297.50** sales, and **0 L** total variance.
   - A later rate edit changed live rates but left the closed shift at its original **₹23,297.50** settlement and left the frozen DSR unchanged.
6. All five views—Shift, Day close, DSR, Setup, and Data—were checked at a true emulated **375 × 812** mobile viewport. None had horizontal document overflow.
7. The browser console reported no errors during the checks.

Browser verification was performed with the available browser tooling; no new automated browser framework or dependency was added to the repository.

## 3. Recommended feature roadmap

### Priority 1 — Customer credit / khata ledger

This is the most important next module because the app already accepts a **Credit (khata)** tender but does not record who received the credit, when it is due, or how much remains outstanding.

**First usable scope**

- Customer master: name, optional phone, vehicle numbers, opening balance, credit limit, and active/inactive status.
- Customer-wise allocation of each shift's credit tender. One shift may serve several customers, but allocations must sum exactly to its CREDIT amount.
- Credit receipts: full or partial payments by cash, UPI, card, or bank, with date and reference.
- Reason-coded adjustments for corrections, write-offs, or opening balances; never silently edit a closed shift.
- Derived running balance, due/overdue list, credit-limit warning, customer statement, and CSV export.

**Accounting rules**

- A credit sale is revenue when fuel is dispensed. A later customer payment settles receivables and must not be counted as revenue again.
- Store money as integer paise. A positive customer balance means the customer owes the outlet.
- Derive balances from opening entries plus credit sales minus receipts and approved adjustments; do not maintain an independently editable balance field.
- Preserve closed shifts and frozen DSRs. Corrections are new attributed entries.
- Validate overpayments and credit-limit overrides explicitly rather than hiding them.

**Essential tests:** allocations equal the shift tender, partial and excess payments, opening balances, customer statements, closed-shift immutability, backup migration, and invalid/duplicate customer entries.

### Priority 2 — Expenditure vouchers and daily cashbook

**First usable scope**

- Dated expense vouchers with category, vendor/payee, description, amount, payment source, optional shift link, and remark.
- Categories such as repairs, electricity, water, maintenance, stationery, bank/MDR charges, transport, and miscellaneous.
- Distinguish drawer cash, bank, UPI, card, and owner-paid expenses.
- Daily expense total and a cashbook showing opening cash, cash sales, credit recoveries, expenses, bank deposits, and expected physical cash.
- Expense register CSV with date/category/vendor filters.

**Accounting rules**

- Only expenses actually paid from the drawer reduce expected drawer cash. Owner-paid or bank-paid expenses must not create an artificial cash shortage.
- Expenses do not reduce fuel sales or rewrite a frozen DSR; use a supplemental daily cash report.
- Salary paid in cash appears in the cashbook once. Recording both a salary voucher and a duplicate generic expense would double-count it.
- After day close, corrections use reversal or adjustment entries rather than deleting history.

**Essential tests:** payment-source handling, zero/negative/non-finite amounts, the cash equation, post-close adjustments, salary non-duplication, and import validation.

### Priority 3 — Tanker receipts and short-delivery tracking

The current day close accepts a manual receipts quantity, but not the document trail behind it.

- Record tank, tanker/invoice number, supplier, invoice quantity, measured receipt, arrival/decant times, and before/after dips.
- Derive short/excess delivery and require a remark beyond an agreed tolerance.
- Feed only confirmed receipts into the relevant tank's day stock calculation.
- Preserve the original receipt when a day is frozen; later corrections need separate attributed records.
- Add a printable short-delivery note and receipt register.

This closes the gap between stock purchases and the existing book-stock formula without introducing temperature correction prematurely.

### Priority 4 — Salary, advances, and monthly payroll

Start with a monthly salary register rather than building a full attendance system immediately.

- Staff master: name, role, joining date, monthly base salary, and active status.
- Monthly payroll: base, allowances, approved deductions, advance recovery, net payable, amount paid, payment date/source, and balance.
- Staff advance ledger with issue and recovery entries.
- Cash/bank salary payments flow into the cashbook exactly once.
- Do not automatically deduct attendant short/excess from salary; require an explicit approved payroll adjustment.
- Add attendance, leave, overtime, and payslip PDF/print layouts only after the basic register reconciles.

**Core formula:** `net payable = base + allowances − approved deductions − advance recovery`. Outstanding payroll is derived from net payable minus recorded payments, not entered independently.

### Priority 5 — Reporting and operational completeness

- **Owner dashboard:** daily/monthly fuel sales, expenses, credit outstanding, stock variance, cash position, and salary payable.
- **Accountant exports:** expense register, khata statements, ageing, payroll, receipts, and Tally-compatible CSV.
- **Bank/UPI/card reconciliation:** match settlement references and fees against tender totals; book MDR as an expense rather than netting revenue.
- **Lubricants and non-fuel sales:** separate inventory and GST-aware billing from petrol/diesel accounting.
- **06:00 price revisions:** effective-dated rates and price-change stock debit/credit notes instead of only per-date prices.
- **Density/temperature registers:** add only with a clearly specified correction standard and source references.
- **Backup discipline:** backup reminders and restore verification. Multi-device sync, real roles, and secure multi-user audit require an explicit backend/authentication design decision; they should not be added silently to this local-only app.

## 4. Suggested delivery sequence

1. **Khata ledger and customer-wise credit allocation** — closes an existing accounting gap. *(first slice implemented; see §6)*
2. **Expense vouchers and daily cashbook** — makes the physical cash position explainable.
3. **Tanker receipts** — completes opening + receipts − sales stock reconciliation.
4. **Salary and advances** — reuses the payment/cashbook rules without double-counting.
5. **Dashboard, Tally export, bank reconciliation, and non-fuel modules** — builds on stable ledgers.

Each milestone should ship as a small, independently usable vertical slice rather than one large rewrite.

## 5. Implementation workflow for every milestone

1. Write the accounting rules and acceptance examples first; get the design approved before implementation.
2. Add failing tests to the pure engine for the money formula, boundary cases, and closed-day behavior.
3. Implement the smallest pure calculation/validation functions needed to pass those tests.
4. Add optional storage arrays/objects with backward-compatible normalization and backup validation for existing version-1 backups.
5. Wire the UI without duplicating accounting rules in DOM handlers.
6. Verify the full flow in a real browser, including import/export, corrupt-input handling, a 375px mobile viewport, and the console.
7. Update README, AGENTS, this report, and the relevant research/specification documents.
8. Review the local diff. Commit, push, publish, or open a PR only with separate authorization.

## 6. First next slice — khata (implemented)

**Customer-wise khata tracking** was implemented against this acceptance boundary:

- Add a customer and an opening balance.
- Allocate a shift's CREDIT tender to one or more customers at close.
- Record full and partial receipts and derive the outstanding balance.
- Show due customers and export a customer statement.
- Keep closed shifts and frozen DSRs unchanged.
- Validate the new records during both startup and JSON import.

That slice delivers immediate owner value and creates the receivables foundation needed by the later cashbook and dashboard.

### What was built

| Area | Implemented change | Main files |
| --- | --- | --- |
| Customer master | Name, optional phone/vehicle, whole-paise opening balance, non-negative credit limit, active/inactive toggle. | `app/core.mjs`, `app/app.js`, `app/index.html` |
| Shift credit allocation | A credit-allocation card appears whenever a shift has a CREDIT tender; rows pick a customer and a whole-paise amount. `validateShiftForClose()` requires the allocations to sum exactly to the CREDIT tender and reference known customers. | `app/core.mjs`, `app/app.js`, `app/index.html` |
| Receipts | Full/partial payments by cash/UPI/card/bank with date and reference. `receiptIssues()` is the single entry-time gate; a receipt above the derived outstanding balance is rejected. | `app/core.mjs`, `app/app.js` |
| Derived balances & due list | `customerBalancePaise()` = opening + closed-shift allocations − receipts. `dueCustomers()` lists balances > 0 with an over-limit flag. No editable balance field. | `app/core.mjs`, `app/app.js` |
| Statement & CSV | `customerStatement()` builds a running-balance ledger (opening, sales, receipts); `customerStatementCsv()` exports it. | `app/core.mjs`, `app/app.js` |
| Frozen DSR | `freezeDay()` stamps each shift's `creditAllocations` into the snapshot and refuses a day whose credit is not fully allocated. | `app/core.mjs` |
| Backup & startup | `validateBackup()` checks customer/receipt/allocation integrity; `normalizeState()` defaults `customers` and `creditReceipts`. Legacy closed shifts without a `creditAllocations` key are grandfathered. | `app/core.mjs` |
| Regression coverage | 15 khata tests written first and observed failing (14/15) against the old engine, then passing. | `test/khata.test.mjs` |

Accounting rules honoured: a credit sale is revenue at delivery; a later receipt settles receivables and is never counted as revenue again; money is integer paise; a positive balance means the customer owes the outlet; closed shifts and frozen DSRs are unchanged. Reason-coded adjustments/write-offs and ageing are deferred to a later slice.

### Verification evidence

- Full suite on Node 24: **42 passed, 0 failed** (17 core + 5 flow + 5 backup + 15 khata). `node --check app/app.js` and `node --check app/core.mjs` both pass.
- Real browser flow at a true emulated **375 × 812** mobile viewport: added a customer (opening ₹1000, limit ₹10000); an unallocated ₹900 CREDIT close was **blocked**; allocating it to the customer closed the shift **balanced** and stamped rates; the derived balance moved **₹1000 → ₹1900**; a ₹500 partial receipt brought it to **₹1400**; an overpayment was **rejected** (receipt count unchanged); the statement rendered opening/sale/receipt with a running balance and the CSV exported correctly.
- A day close containing that credit shift froze a DSR whose snapshot stamps the allocation, shows **Credit (khata) ₹900.00** in collections, balanced totals (sales = collected = ₹900, difference ₹0) and **0 L** stock variance. The closed shift's readings, close button and credit allocations are all locked afterwards.
- All six views (Shift, Day close, DSR, Khata, Setup, Data) had **zero horizontal document overflow** at 375px; wide tables scroll inside their `.table-wrap` container. The browser console reported **no errors or warnings**.

No dependency, backend, build step, or browser-test framework was introduced; the browser evidence comes from executed interactive checks.

## 7. Current boundaries

- The first khata slice (customers, credit allocation, receipts, derived balances, due list, statement + CSV) **is implemented** (§6). Khata ageing, reason-coded adjustments/write-offs, and the expenditure, salary, tanker, dashboard, and Tally modules remain roadmap items, **not implemented in this patch**.
- The app remains single-browser and local-only; exported JSON is the real backup.
- No remote CI result exists for the local uncommitted changes.
- No browser-test dependency was introduced, so the browser evidence above comes from executed interactive checks rather than a checked-in browser automation suite.
