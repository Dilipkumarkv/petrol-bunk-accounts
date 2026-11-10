# AGENTS.md

Working notes for AI coding agents — and for anyone picking this repo up cold. Read this before changing code or documentation.

## What this repo is

Two things in one tree:

1. **A research report** on how day-to-day accounting actually works at an Indian petrol bunk (registers, DSR, dip variance, MDG compliance, tax, software landscape).
2. **A working, offline prototype** of shift settlement → day close → frozen DSR, plus a customer-wise khata (credit) ledger, with the reconciliation maths isolated in a tested engine.

- Live: https://dilipkumarkv.github.io/petrol-bunk-accounts/ (app at `/app/`)
- Repo: https://github.com/Dilipkumarkv/petrol-bunk-accounts

## Commands

| Task | Command | Notes |
| --- | --- | --- |
| Run tests | `npm test` | 42 tests, must stay green |
| Serve locally | `npm start` | Serves `app/` at http://localhost:8123 |
| Deploy | `git push origin main` | GitHub Pages rebuilds automatically |

No `npm install`, no build step, no dependencies. If a change wants a dependency, that is a design decision to escalate, not a detail.

### Environment quirks (Android/Termux workspace)

- **Use the exact `npm test` command** (`node --test --test-isolation=none test/*.test.mjs`). Two separate traps: plain `node --test` spawns a child node with a flag this environment rejects (`expected absolute path: --heap-prof-interval=...`), and passing the **directory** `test/` fails on Node 24 with `ERR_UNSUPPORTED_DIR_IMPORT` (Node 26 tolerates it). Pass the file glob.
- **No `/tmp`.** Write scratch files inside the repo and delete them before committing, or redirect to a file you remove.
- **`gh repo create --source .` fails** here: `gh` cannot exec `git` from the Termux prefix (`permission denied`). Use `gh api -X POST user/repos ...` to create a repo, then plain `git push` — the repo-local credential helper `!gh auth git-credential` is already configured.
- Long command output can be truncated in the tool layer; redirect to a file and read it if a result looks cut off.

## Layout

```
app/
  core.mjs     pure engine: litres, money, variance, freeze, khata balances, CSV. No DOM, no storage.
  app.js       DOM + localStorage only; imports core.mjs
  index.html   six views: Shift, Day close, DSR, Khata, Setup, Data
  styles.css   light/dark, mobile-first
test/
  core.test.mjs    17 tests against the engine
  flow.test.mjs    5 whole-day flow tests
  backup.test.mjs  5 backup/settings regression tests
  khata.test.mjs   15 credit-ledger tests (balances, allocations, receipts, statements, freeze)
data/schema.sql  fuller target model (SQLite) — NOT wired to the app
docs/            research: registers, reconciliation, compliance, software, sources
index.html       Pages landing page
```

Storage: one JSON blob in `localStorage` under `petrolbunk.v1`, shaped by `demoState()` in `app.js`. It holds `tanks`, `nozzles`, `rates`, `days`, `shifts`, plus `customers` and `creditReceipts` for the khata ledger. There is no backend and no sync; Export JSON is the backup path.

## Invariants — do not break these

1. **Money is integer paise.** Never store floats of rupees. `toPaise` / `formatPaise` are the only converters.
2. **Litres are rounded to 3 decimals** via `r3()`.
3. **Net litres = gross − testing.** Testing fuel goes back into the tank; it is not a sale and must never be added back to stock.
4. **Book stock = opening + receipts − net sales.** Adding testing litres again is the classic double count this repo already fixed once.
5. **Short/excess sign: positive means short** (money missing). Every register in India writes short as a positive number regardless of sign convention in the maths.
6. **A closed day is immutable.** `freezeDay()` returns a deep-frozen snapshot. Corrections must be new, attributed entries — never edits to a closed day.
7. **Only closed shifts feed the DSR, stock variance and collections.** Open drafts are provisional and must stay out of the numbers.
8. **No network, no CDN, no remote fonts.** The app must work from static hosting and offline.
9. **Accessibility floor:** 44px touch targets, labelled inputs, visible focus, theme via CSS variables only (no hard-coded colours).
10. **One validation path.** `validateShiftForClose()` in the engine is used by the close button, `freezeDay()` and backup import. Never re-implement those rules in the UI — a hand-edited backup must hit the same checks.
11. **A closed shift is signed for what it shows.** Stamping `ratesPaise` and `nozzlesSnapshot` at close means later rate/price/setup edits cannot revalue or re-label it. Do not read live setup for a closed shift.
12. **Every active nozzle must be read.** An idle nozzle closes at `opening === closing` (testing must be 0); it is never silently skipped.
13. **Rates must be finite and > 0.** A missing, zero or negative rate is a blocking error anywhere sales exist.
14. **Opening stock is explicit.** `freezeDay()` rejects a day whose tank has no opening quantity; it is not silently treated as zero.
15. **Saved state follows the same rules as imports.** `load()` and import call `validateBackup()` then `normalizeState()`. Tank/nozzle IDs are unique, only closed shifts establish carry-forward, nested settings receive defaults, and evaporation allowances are finite and non-negative.
16. **Demo reload is destructive.** Always confirm, even when the outlet has setup but no shifts; demo replaces configuration as well as transactions.
17. **Khata balances are derived, never stored.** Outstanding = opening balance + closed-shift credit allocations − receipts. There is no independently editable balance field; `customerBalancePaise()` is the single source.
18. **A receipt is never new revenue.** A credit sale is revenue when fuel is dispensed (it is already in the shift's CREDIT tender and the DSR). A later customer payment settles receivables only — counting it as sales again double-counts revenue.
19. **Credit allocations must sum to the tender.** When a shift carries a `creditAllocations` list, the amounts are whole paise above zero, reference known customers, and sum exactly to the CREDIT tender. `validateShiftForClose()` enforces this for the close button, `freezeDay()` and import alike. Closed shifts saved before khata existed (no `creditAllocations` key) are grandfathered and stay valid; the UI stamps the key on every shift it closes going forward.
20. **Overpayments are rejected, not hidden.** `receiptIssues()` blocks a receipt larger than the derived outstanding balance at entry. Corrections are new attributed entries; reason-coded adjustments/write-offs are a later slice, not silent edits to a closed shift.

If a request conflicts with one of these, say so and explain the trade-off instead of silently breaking it.

## Adding a feature

1. Write the maths in `app/core.mjs` as a pure function.
2. Add a focused test under `test/` that pins the behaviour (including the failure case).
3. Wire it in `app/app.js` — rendering and storage only.
4. Update the docs that claim something about it (`README.md` and the relevant file in `docs/`).
5. Run `npm test`, then drive the real flow in the browser.

## Verification protocol

Never claim a change works from reading the diff.

- `npm test` — all tests pass.
- `npm start`, then exercise the actual flow: enter readings → close shift → enter dips → close day → read the DSR.
- Check the browser console has no errors.
- Check there is no horizontal overflow at phone width.
- For hosted changes: push, poll `gh api repos/Dilipkumarkv/petrol-bunk-accounts/pages --jq .status` until `built`, then fetch the URL and confirm the new content is actually served (not a cached old build).

## Deployment

- Pages source is `main` / root, `https://dilipkumarkv.github.io/petrol-bunk-accounts/`.
- The landing page is the repo-root `index.html`; the app is served from `/app/`.
- `.nojekyll` is required — do not remove it.
- Any push to `main` republishes the site. There is no staging environment.

## Domain accuracy rules

These are what make the repo useful rather than plausible-sounding:

- **MDG numbers must trace to a source** in [`docs/sources.md`](docs/sources.md). Do not invent tolerance, evaporation or penalty figures. The 4% tank-stock band and the MS 0.75% evaporation allowance are cited; anything beyond them is marked as unverified.
- **Illustrative figures stay labelled.** The worked example (905 L, ₹81,450, −50 L) is a teaching example, not market data.
- **Two tax regimes:** petrol and diesel are outside GST (§9(2) CGST) and carry state VAT + excise; lubricants and shop goods are GST-bearing. Never merge the two sales registers.
- **Dealer margin is business income**, not agency commission — don't reintroduce the 194H claim.

## Docs map

| Document | Owns |
| --- | --- |
| `README.md` | The report's front door: model, daily rhythm, DSR, app overview, status |
| `docs/registers.md` | Which register exists, who fills it, when |
| `docs/reconciliation.md` | The arithmetic and the worked example |
| `docs/compliance-and-tax.md` | MDG, Legal Metrology, GST/VAT, TDS, audit |
| `docs/software-and-repos.md` | SaaS landscape, open-source repos, gaps |
| `docs/sources.md` | Every URL, what it supported, what was not verified |
| `data/schema.sql` | Target data model (fuel volume, dips, receipts, credit, variance) |

Keep the README's Contents table in sync when files are added or renamed.

## Do not

- Don't commit tokens or credentials. The GitHub token lives at `~/.gh-token`, outside the repo.
- Don't add a backend, auth or analytics without asking — the app's selling point is that it is a static, local-only page.
- Don't "tidy" historical numbers in a frozen DSR, or make a closed day editable.
- Don't invent benchmarks, pricing or compliance figures to make docs look complete.
- Don't reformat unrelated files in the same commit.
