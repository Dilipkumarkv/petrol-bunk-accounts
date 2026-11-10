# Petrol Bunk Accounts (India)

**Live app:** https://dilipkumarkv.github.io/petrol-bunk-accounts/app/ · **Landing page:** https://dilipkumarkv.github.io/petrol-bunk-accounts/ · **Repo:** https://github.com/Dilipkumarkv/petrol-bunk-accounts

A working reference for **day-to-day account keeping at an Indian retail fuel outlet (petrol pump / petrol bunk)** — the registers, the daily rhythm, the arithmetic, the compliance points, and the software/tooling landscape.

Built as a brief **and a working prototype**: the registers and the arithmetic are documented, and [app/](app/) implements shift settlement, day close and the frozen DSR. [data/schema.sql](data/schema.sql) is the fuller target model, and [AGENTS.md](AGENTS.md) records the conventions and invariants anyone (human or agent) should respect when changing the code.

> Everything here is sourced from OMC guidelines (IOCL/HPCL MDG), dealer-facing guides and software vendors' own docs. Full links in [docs/sources.md](docs/sources.md). Figures marked *illustrative* are examples, not market data.

## Contents

| File | What it covers |
| --- | --- |
| [docs/registers.md](docs/registers.md) | Every register you must keep, who fills it, when, and why |
| [docs/reconciliation.md](docs/reconciliation.md) | The arithmetic of shift close, DSR, dip variance — with a worked example |
| [docs/compliance-and-tax.md](docs/compliance-and-tax.md) | Legal metrology, MDG penalties, GST/VAT, TDS, audit, cash limits |
| [docs/software-and-repos.md](docs/software-and-repos.md) | Commercial SaaS, spreadsheets, and open-source repos with honest assessments |
| [docs/sources.md](docs/sources.md) | All sources, with what each one was used for |
| [data/schema.sql](data/schema.sql) | Starter SQLite schema (shift, nozzle, dip, receipt, credit, expense) |
| [templates/dsr-shift.csv](templates/dsr-shift.csv) | A blank shift-DSR sheet you can open in Excel/Sheets |
| [app/](app/) | Working offline app: shift settlement, day close, frozen DSR, CSV |
| [test/](test/) | 22 unit and flow tests for the reconciliation engine |
| [index.html](index.html) | GitHub Pages landing page |
| [AGENTS.md](AGENTS.md) | Conventions, invariants and commands for changing this repo |

## The mental model: three ledgers, one truth

A fuel outlet looks complicated but it is only three ledgers that must agree every single day:

1. **Litres** — what the nozzles dispensed. Nozzle totaliser delta is the *only* source of truth for fuel sales; never a lump-sum rupee figure.
2. **Rupees** — what you collected (cash, UPI, card, fleet/credit) plus what you owe (supplier, credit customers).
3. **Stock** — what is physically in the underground tanks, from dip readings, versus what the book says should be there.

Day-to-day accounting is the discipline of making those three agree **per shift**, not per month. The month-end "shortage" that nobody can explain is always a December of unclosed shifts.

## The daily rhythm

| When | What happens | Record produced |
| --- | --- | --- |
| Start of shift | Note opening totalisers for every nozzle; carry forward the previous shift's closing readings | Shift sheet (opening block) |
| Before sales | Density check at 15 °C, water dip, 5-litre measure test on each nozzle (MDG 1.4.2) | Density register, test record |
| On tanker arrival | Verify seals/invoice, dip the tank before and after decanting, draw and retain samples | Tank-lorry / decantation record, receipt entry |
| During shift | Credit (khata) sales on a named slip with vehicle number; expense vouchers | Credit slips, expense vouchers |
| Shift end | Closing totalisers, metre sales, testing litres deducted, cash counted, UPI/card slips tallied, short/excess signed by the attendant | Shift settlement |
| Day end | All shifts closed, evening dip on every tank, credit sales checked, day closed and DSR frozen | **DSR (Daily Sales Report)** |
| Next morning | Cash/cheque deposit to bank, price-change stock note if rates changed at 06:00 | Bank deposit slip, price-change debit/credit note |
| Weekly | Match UPI/card settlements to the acquirer statement; chase credit ledger | Settlement reconciliation |
| Monthly | Stock reconciliation, VAT/GST returns, expense posting, dealer-commission invoice, salary, TDS | Monthly accounts pack |

Fuel prices in India change at 06:00, so a **price change is an accounting event**: the stock on hand at the moment of revision has to be revalued, which is done with a debit/credit note to the OMC. If you skip it, your stock ledger and your margin both drift.

## The DSR, in six sections

Most Indian pump registers (and every vendor product) follow the same structure. Details and formulas are in [docs/reconciliation.md](docs/reconciliation.md).

1. **Nozzle meter readings** — opening, closing, gross litres, testing litres, net litres.
2. **Product-wise value** — net litres × that day's rate, per product (MS, HSD, premium/MS+, branded).
3. **Lubricants and shop** — packed oil, coolant, accessories; these carry GST and are recorded with proper tax invoices.
4. **Collection split** — cash, card/POS, UPI/QR, credit slips; must equal sales value.
5. **Tank dip stock** — opening + receipts − sales vs physical closing dip = gain/loss.
6. **Shift handover** — operator-wise short/excess and supervisor sign-off.

Two rules that cause most of the pain in practice:

- **Testing litres.** The 5-litre MDG check is poured back into the tank, so it is *deducted* from gross meter litres. Deducting twice, or not at all, silently creates a shortage or a phantom gain.
- **Settlement fees.** Log UPI/card collections at the amount charged to the customer and book the MDR/settlement fee as an expense. Netting it off makes the day "balance" while understating both revenue and cost.

## Where money actually leaks

In rough order of frequency at Indian outlets:

- **Cash short/excess per attendant drawer** — small and two-directional is normal (change-making). Persistently one-directional is a process problem, and the most common cause is credit sales being recorded late.
- **Dip variance** — short delivery at decantation, evaporation, temperature/density error, calibration drift, water ingress, or theft. The MDG tolerance framework (§5.1.11) is what an inspecting officer will apply: 4% of tank stock as the outer normal band, plus evaporation allowances on quantity sold (0.75% up to 600 KL annual average, then tapering slabs).
- **Credit (khata) ledger** — the single biggest write-off risk. Every credit sale needs a name, vehicle number and signature at the time of sale.
- **Late/never-recorded expenses** — a voucher written on the back of a meter slip and entered in the monthly books breaks the daily cash tie-out.
- **UPI that shows success and later fails** — only the acquirer/settlement statement reveals it. Weekly matching catches it; monthly matching usually does not.

## Compliance you cannot ignore

Condensed — details and citations in [docs/compliance-and-tax.md](docs/compliance-and-tax.md):

- **Legal Metrology**: dispensers stamped/verified; a Weights & Measures-verified 5-litre measure kept at the outlet; seals intact; zero must be shown to the customer before delivery.
- **MDG (Marketing Discipline Guidelines)**: the OMC rulebook an inspecting officer uses. Record-keeping duties, density register format (Annexure 1), 5-litre nozzle checks, daily water dip, stock display, and a penalty schedule.
- **PESO / explosive licence**, fire safety, and (for the shop) FSSAI/shop licence.
- **Tax**: petrol and diesel are **outside GST** (Section 9(2) CGST) and taxed via central excise + state VAT; lubricants and shop goods are GST-bearing. Fuel turnover counts toward GST aggregate turnover, so a pump selling lubes will normally be registered.
- **Income tax**: dealer margin is business income (ITR-3 for a proprietor). Section 44AD presumptive is rarely available because turnover exceeds the threshold; tax audit usually applies. Section 194Q TDS on purchases if prior-year turnover crossed ₹10 crore. Cash limits: §40A(3) (₹10,000 per person per day) and §269ST (₹2 lakh cash from one person).

## Software landscape (short version)

There is a mature commercial SaaS market for exactly this workflow (PetroPulse360, PumpOS, FuelSetu, TruFuelPro, PumpDesk, OilMart, FuelFlow, PumpSoftware, keshavsolutions' petroMunim), typically ₹999/month upward, covering shift settlement, DSR, density register, dip variance, khata and Tally export.

Open source is thin and mostly student/portfolio projects: no OSS project with real OMC-grade dip variance, density-at-15 °C, price-change notes and MDG register formats. Assessments, with links, in [docs/software-and-repos.md](docs/software-and-repos.md).

**Conclusion: this is a genuinely under-served niche for a well-built tool.** If you build it, the differentiator is the reconciliation maths (temperature-corrected stock, testing-litres handling, price-change revaluation), not the CRUD.

## The app

A working, offline-first implementation of steps 1–3 below. No build step, no dependencies.

**Hosted:** https://dilipkumarkv.github.io/petrol-bunk-accounts/app/

```bash
npm test     # 22 tests
npm start    # serves app/ at http://localhost:8123
```

No install and no build step — both scripts are thin wrappers over `node --test --test-isolation=none test/*.test.mjs` and `python3 -m http.server 8123 --directory app`. CI runs the same suite on Node 24 and 26 (`.github/workflows/tests.yml`).

### Validation rules (all enforced in the engine, used by both the UI and imports)

- Every active nozzle needs a reading; an idle nozzle closes at the same reading with zero testing.
- Carry-forward must match the previous shift's closing for that nozzle.
- Rates must be finite and above zero for any product with sales.
- A short/excess needs a remark, and the attendant must sign before a shift closes.
- A day close requires an explicit opening stock, a physical dip for every tank, and every shift closed and signed.
- A closed shift keeps the rates and nozzle/tank mapping stamped at close, so later setup edits cannot revalue it; the DSR and its CSV come only from the frozen snapshot.

What it does today:

- **Shift settlement** — nozzle readings with auto carry-forward from the last closed shift, testing litres, per-product value, tender split, live short/excess, attendant sign-off, and a remark requirement whenever the drawer does not balance.
- **Day close** — tank opening/receipts/physical dip, book stock, variance with % and status (`within allowance` / `investigate` / `beyond MDG band`), day summary, and a hard block on closing while any shift is open or any dip is missing.
- **Frozen DSR** — a deep-frozen snapshot saved at close, rendered read-only with per-nozzle lines, collections, handover signatures and stock variance. Printable, CSV-exportable.
- **Setup** — outlet, OMC, tanks, nozzles, per-date rates, evaporation allowances. **Data** — JSON backup/restore, demo, erase.

Deliberate limits: rates are per date (not per 06:00 revision inside a shift), no tanker/short-delivery module, no khata ledger, no temperature correction beyond the dip figure, storage is this browser only (export the JSON for a real backup). The schema in `data/schema.sql` is the fuller target model.

### Engine design

`app/core.mjs` is pure: no DOM, no storage, every function a function of its inputs. That is what makes the money maths testable — the 22 tests cover testing-litre subtraction, carry-forward mismatch, short/excess sign, half-entered rows, the MDG band and evaporation allowance, multi-shift aggregation, frozen-day immutability, CSV export, and a full two-shift day across two HSD tanks.

`validateShiftForClose()` is the single validation path: the close button, `freezeDay()` and backup import all call it, so a hand-edited export cannot bypass what the UI enforces. `test/flow.test.mjs` exercises whole days (both shifts, all tanks, next-day carry-forward) rather than single functions.

Conventions that keep it correct are in [AGENTS.md](AGENTS.md): integer paise, litres at 3 decimals, net = gross − testing, book stock = opening + receipts − net sales, positive short, immutable closed days, and closed shifts only.

## Proposed build

1. **Shift settlement first** — nozzle readings, testing litres, payment split, per-attendant short/excess. Nothing else matters if this is slow. *(done)*
2. **Day close → frozen DSR** — once the business day is closed, the record is immutable; later expenses/payments carry their own audit trail. *(done)*
3. **Dip stock + variance** — opening + receipts − sales vs closing dip, with temperature/density correction and the MDG allowance calculation shown explicitly. *(variance done; density/temperature correction pending)*
4. **Receipts (tanker)** — invoice quantity vs decanted quantity, before/after dips, samples, short-delivery note.
5. **Khata / credit ledger** — named, vehicle-linked, with ageing and reminders.
6. **Density register, price-change notes, monthly stock reconciliation**, Tally/CSV export for the accountant.

`data/schema.sql` is a starting point for 1–5.

## Status

Research, specification and a working prototype: shift settlement, day close and frozen DSR are implemented, tested (22 tests) and hosted on GitHub Pages ([app/](app/)). Next: tanker receipts with short-delivery notes, the khata ledger, and Tally export.
