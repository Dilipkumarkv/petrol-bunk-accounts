# Reconciliation: the arithmetic

Three reconciliations happen every day, in this order, and each one is cheaper than the next:

1. **Metre** — litres dispensed per nozzle (mechanical truth).
2. **Cash** — rupees collected against rupees billed (human truth).
3. **Stock** — litres in the tank against litres the book says are there (physical truth).

The DSR is the document where all three land on one page.

## 1. Metre reconciliation (per nozzle, per shift)

```
gross_litres = closing_totaliser - opening_totaliser
net_litres   = gross_litres - testing_litres
sales_value  = net_litres × rate_of_the_day
```

Rules that matter:

- **Carry-forward:** opening of shift *n* must equal closing of shift *n−1*. Enforce it in software; a wrong carry-forward is the classic silent error.
- **Testing litres:** the 5-litre MDG nozzle check is poured back into the tank, so it is subtracted from gross litres. It is not a sale, and it is not a loss.
- **Rate of the day:** prices change at 06:00. A shift that straddles a price revision must be split, or valued at the correct rate per side of the revision.
- **No lump sums.** Never book "petrol ₹1,20,000" as a sales figure; derive value from litres × rate so VAT and margin both work.

## 2. Cash reconciliation (per attendant, per shift)

```
expected_collection = fuel_sales_value + lube/shop_sales_value
collected = cash_counted + card_settled + upi_received + credit_slips_signed
difference = expected_collection - collected     # positive = short, negative = excess
```

Notes:

- **Credit is not cash.** Credit (khata, fleet card, OMC fleet) is settled later; it is recorded as a receivable with a name and vehicle number at the time of sale, never as a total.
- **Expenses paid from the drawer** must be vouchered at the moment of payment, otherwise the drawer looks short by exactly the expense.
- **Settlement fees are an expense**, not a deduction from sales. Book the gross collection and post the MDR separately.
- Small two-way variance is normal (change-making). Persistent one-way shortage is a process problem; the usual culprit is late-recorded credit sales, not dishonesty.
- Short/excess is **signed by the attendant** before they leave the shift. A signature collected a week later is not a control.

## 3. Stock reconciliation (per tank, per day)

```
book_closing = opening_stock + receipts - net_sales
variance     = physical_dip_litres - book_closing      # negative = loss
```

`net_sales` is already net of testing litres (gross − testing), because the 5-litre MDG check goes back into the tank. Adding testing litres back a second time is the most common stock-maths error: it silently inflates book stock in both the register and the variance.

Where:

- `opening_stock` = yesterday's physical dip (not yesterday's book figure — otherwise errors compound forever).
- `physical_dip_litres` comes from the dip in mm → calibration chart, **temperature/density corrected**.
- `receipts` are invoice quantities, but only count what was actually decanted; short delivery is a separate claim.

### Why temperature appears in a "litres" problem

Fuel is invoiced and reconciled on a 15 °C reference basis, while a dispenser sells ambient-temperature volume. On a hot afternoon, a litre in the tank is not a litre at 15 °C. That is the entire reason the density register exists, and it is why naive "dip minus sales" arithmetic shows phantom gains and losses across the day.

### Applying the MDG tolerance (the number an inspector will use)

MDG §5.1.11 treats stock variation as beyond permissible limits only after allowing for normal operational variation and specified evaporation/handling losses on **quantity sold**:

- Normal operational band: **4% of tank stock** (also reflected in the Motor Spirit and HSD (Prevention of Malpractices) rules: ±4% of tank stock).
- MS evaporation/handling loss allowance: **0.75%** on quantity sold up to an annual average of 600 KL, then **0.60%** on the additional quantity — with further slabs for higher volumes as specified in the guideline.

Practical reading: a 50-litre dip shortfall is almost never an MDG "irregularity", but it is still your money and still needs a cause. Classify every variance into one of:

- decantation short delivery (claim it),
- evaporation/handling (allowed, within slab),
- temperature/density correction error (fix the register),
- dispenser calibration drift (call Legal Metrology / OMC),
- water ingress or tank leak (urgent),
- unexplained (investigate, then write off with approval).

## Worked example (illustrative figures)

**Setup:** one HSD nozzle, one 20 KL diesel tank, day rate ₹90.00/L, shift 06:00–14:00.

**Metre**

| Item | Value |
| --- | --- |
| Opening totaliser | 1,24,500.00 L |
| Closing totaliser | 1,25,410.00 L |
| Gross litres | 910.00 L |
| Testing litres (5 L, returned) | 5.00 L |
| **Net litres sold** | **905.00 L** |
| Value @ ₹90.00 | **₹81,450.00** |

**Cash**

| Tender | Amount |
| --- | --- |
| Cash | ₹42,000 |
| UPI | ₹21,450 |
| Card/POS | ₹8,000 |
| Credit slip (named, vehicle no.) | ₹10,000 |
| **Total collected** | **₹81,450** |
| Difference | **₹0 — balanced** |

Variant: if cash counted were ₹41,850, the shift shows **short ₹150**, signed by the attendant, and carried into the day's short/excess summary — not silently rounded away.

**Stock**

| Item | Litres |
| --- | --- |
| Opening dip (06:00) | 12,000 |
| Tanker receipt decanted | 8,000 |
| Net sales (already excludes testing) | 905 |
| Book closing | 19,095 |
| Physical dip (22:00) | 19,045 |
| **Variance** | **−50 L (−0.26% of tank stock)** |

Interpretation:

- 4% of 19,045 L ≈ 762 L — the variance is far inside the MDG outer band.
- Evaporation allowance at 0.75% of 905 L sold ≈ 6.8 L.
- So ~43 L of the shortfall is unexplained and worth chasing: check the decantation before/after dips, then the calibration chart, then the dispenser.

This is the useful output of daily accounting: not "the day balanced", but "43 litres are missing and here are the three things to check before tomorrow".

## Day close and freezing

At day close:

1. Every shift closed, every attendant signed.
2. Evening dip on every tank, variance computed with reasons.
3. Credit sales matched to customer accounts.
4. DSR generated and **frozen** — saved as it was, never recalculated.

Later expenses, supplier payments and bank reconciliations attach to the closed day as separate entries with their own audit trail. In spreadsheet practice this is the rule most often broken: someone edits a formula next week and the historical record silently changes, destroying its value in any dispute.

## Weekly and monthly

**Weekly:** match UPI/card collections to the acquirer settlement statement (that is the only place a "successful" charge that later failed is visible), review khata ageing, compare per-attendant short/excess trends.

**Monthly:** stock reconciliation across all tanks, expense posting, dealer commission invoice, VAT return (fuel) and GST return (lubes/shop), TDS/TCS checks, salary and statutory payments, and a one-page margin statement (litres × commission + lube margin − expenses − losses).
