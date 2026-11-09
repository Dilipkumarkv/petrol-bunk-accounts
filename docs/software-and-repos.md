# Software landscape and open-source repos

## 1. Commercial SaaS (India-specific, mature)

These all sell the same core promise: shift settlement → DSR → dip variance → khata, with density register and Tally export.

| Product | Positioning / notable detail |
| --- | --- |
| **PetroPulse360** — petropulse360.com | DSR register format, cash/UPI reconciliation, stock variance. Documented pricing around ₹999/month or ₹9,999/year after a trial. Excellent public documentation of the workflow itself. |
| **PumpOS** — pumpos.app | "Day close and DSR for any OMC dealership"; emphasises an immutable DSR saved at close and per-DU attendant drawers. Works across IOCL/BPCL/HPCL/Nayara/Jio-bp/Shell agreements. |
| **TruFuelPro** — trufuelpro.com | Registers-first framing: shift settlement, DSR, density register at 15 °C, fuel receipts, khata, GST inventory. |
| **FuelSetu** — fuelsetu.com | Daily closing checklists, SOP checklists, shift reconciliation guides. |
| **PumpDesk** — pumpdesk.in | Reconciliation guides plus free calculators (profit, tanker short delivery, density, stock). |
| **OilMart India** — oilmartindia.com | Claims to read totalisers and file the statutory Daily Stock Register; multi-pump, phone-first. |
| **FuelFlow** — fuelflow.in | Nozzle readings, reconciliation, billing. |
| **PumpSoftware** — pumpsoftware.in | Cloud platform: nozzle readings, shift reconciliation, khata, attendance, accounting. |
| **MaxifyFuels / keshavsolutions (petroMunim)** | Vendor guides that also document the DSR format and daily account cycle in detail. |

**Takeaway:** the *workflow* is well documented publicly by these vendors, which means the domain is easy to specify and therefore competitive. Differentiation cannot be "we have a DSR".

## 2. Open source: available, but thin

Verified on GitHub (checked directly; star counts are near-zero because these are portfolio/student projects, not products):

| Repo | Stack | What it does | Assessment |
| --- | --- | --- | --- |
| [Prathamesh8927/petrol-pump-management-system-](https://github.com/Prathamesh8927/petrol-pump-management-system-) | MERN (React/Vite + Node) | The most complete of the set: fuel inventory, nozzle readings, sales, customer ledger, expenses, employees, payments, PDF reports, roles. Built for a client ("Shivshambho"). | Closest to a usable base. Still no density/temperature correction, no MDG tolerance logic, no price-change revaluation. Good reference for data model and UI. |
| [surajhiremath23/PetrolBunkSystem](https://github.com/surajhiremath23/PetrolBunkSystem) | Python desktop | "Petrol Pump Accounting System": fuel sales, daily reconciliation, billing, inventory. | Small, single commit. Useful as a reading of the accounting logic, not as a dependency. |
| [ambroz72/Petrol-pump-management-system-](https://github.com/ambroz72/Petrol-pump-management-system-) | Web (admin + user roles) | Sales reporting, leave management, attendance, feedback. | Broad but shallow; attendance/HR weighted rather than accounting. |
| [gagangkrishna/Petrol-pump-management-system](https://github.com/gagangkrishna/Petrol-pump-management-system) | Modular app | Fuel sales tracking, real-time inventory, reports, notifications. | Student project; no reconciliation maths. |
| [Adarsh275/PetrolPump-Management-System](https://github.com/Adarsh275/PetrolPump-Management-System) | DB-centric (triggers/procedures) | CRUD on core entities with DB triggers. | Good for schema ideas (triggers for stock), no operational logic. |
| [MubashirNoor7/fuel-station-manager](https://github.com/MubashirNoor7/fuel-station-manager) | Electron + React + SQLite | Nozzle readings, fuel stock, customer credit, expenses. | The only one tagged `petrol-pump` on GitHub topics; Pakistan-oriented, desktop-local. Closest thing to an offline-first offline desk app. |

Typical gaps in **all** of them:

- No **density-at-15 °C** correction — the single most India-specific requirement.
- No **MDG §5.1.11** variance allowance logic (4% band + evaporation slabs).
- No **testing-litres** handling, or it is handled by simply not modelling it.
- No **price-change revaluation** with debit/credit notes.
- No per-attendant **short/excess ledger** with signatures.
- No VAT (fuel) vs GST (lubes) split, no Tally export.
- No immutable day-close.

Related general-purpose tools worth knowing: **Tally Prime** (what the accountant will actually want an export for), **GnuCash/hledger** (double-entry, no fuel concepts — you would model fuel as inventory items), **ERPNext** (no fuel-retail module; would need customisation), **Odoo** (community POS, not forecourt-aware).

## 3. Spreadsheet route

Every dealer starts here and many stay here. The pumpiq-style "petrol pump Excel sheet" templates cover daily sales, lubes, stock register, credit ledger and DSR. It works, and it fails in predictable ways:

- no auto carry-forward of totalisers, so a typo propagates;
- testing litres deducted twice or not at all;
- formulas edited weeks later, silently rewriting history;
- no per-attendant accountability at the moment of counting.

If you go the spreadsheet route, the one rule that saves you: **one sheet per shift, frozen as values at close, signed.**

## 4. What an OSS project here would need to beat the status quo

1. A **reconciliation engine** as a pure, tested module (litres, cash, stock, variance classification) — independent of UI.
2. **Temperature/density correction** with a real dip→volume calibration table per tank.
3. **Immutable day close** with adjustment entries as separate, attributed records.
4. **Offline-first**: forecourts have flaky connectivity; sync later, never block a shift close.
5. **Attendant-signature short/excess** ledger, printable and WhatsApp-shareable.
6. **Exports**: Tally XML/CSV, VAT register, GST register, DSR PDF in an OMC-familiar layout.

Sources for every claim above: [sources.md](sources.md).
