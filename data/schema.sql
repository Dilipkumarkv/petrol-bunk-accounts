-- Starter SQLite schema for an Indian petrol bunk's day-to-day accounting.
-- Design notes:
--   * Every quantity is stored in litres at 15 degC where it came from a dip or invoice.
--   * Money is stored in paise (INTEGER) to avoid float drift on a 0.3% margin.
--   * A closed business day is immutable; corrections are adjustment rows.

PRAGMA foreign_keys = ON;

CREATE TABLE outlet (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    omc           TEXT NOT NULL,           -- IOCL / BPCL / HPCL / Nayara / Jio-bp / Shell
    dealer_code   TEXT,
    state_code    TEXT,                    -- drives VAT rate set
    commission_paise_per_kl_ms  INTEGER,   -- from OMC circular, not hardcoded in logic
    commission_paise_per_kl_hsd INTEGER
);

CREATE TABLE tank (
    id                INTEGER PRIMARY KEY,
    outlet_id         INTEGER NOT NULL REFERENCES outlet(id),
    code              TEXT NOT NULL,       -- T1, T2 ...
    product           TEXT NOT NULL CHECK (product IN ('MS','HSD','MS_PREMIUM','HSD_PREMIUM')),
    capacity_litres   REAL NOT NULL,
    -- dip (mm) -> litres mapping lives in calibration_point, never a linear guess
    UNIQUE (outlet_id, code)
);

CREATE TABLE calibration_point (
    tank_id     INTEGER NOT NULL REFERENCES tank(id),
    dip_mm      REAL NOT NULL,
    volume_l    REAL NOT NULL,             -- at 15 degC, from the tank calibration chart
    PRIMARY KEY (tank_id, dip_mm)
);

CREATE TABLE nozzle (
    id            INTEGER PRIMARY KEY,
    outlet_id     INTEGER NOT NULL REFERENCES outlet(id),
    tank_id       INTEGER NOT NULL REFERENCES tank(id),
    label         TEXT NOT NULL,           -- DU1-N1
    product       TEXT NOT NULL,
    active_from   TEXT,
    active_to     TEXT
);

CREATE TABLE rate (
    outlet_id     INTEGER NOT NULL REFERENCES outlet(id),
    product       TEXT NOT NULL,
    effective_at  TEXT NOT NULL,           -- price revisions land at 06:00
    paise_per_litre INTEGER NOT NULL,
    PRIMARY KEY (outlet_id, product, effective_at)
);

CREATE TABLE business_day (
    id           INTEGER PRIMARY KEY,
    outlet_id    INTEGER NOT NULL REFERENCES outlet(id),
    business_date TEXT NOT NULL,           -- YYYY-MM-DD
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    closed_at    TEXT,
    closed_by    TEXT,
    dsr_json     TEXT,                     -- frozen snapshot of the DSR as generated
    UNIQUE (outlet_id, business_date)
);

CREATE TABLE shift (
    id              INTEGER PRIMARY KEY,
    business_day_id INTEGER NOT NULL REFERENCES business_day(id),
    seq             INTEGER NOT NULL,      -- 1,2,3
    opened_at       TEXT NOT NULL,
    closed_at       TEXT,
    supervisor      TEXT,
    UNIQUE (business_day_id, seq)
);

CREATE TABLE shift_nozzle (
    id              INTEGER PRIMARY KEY,
    shift_id        INTEGER NOT NULL REFERENCES shift(id),
    nozzle_id       INTEGER NOT NULL REFERENCES nozzle(id),
    opening_meter_l REAL NOT NULL,
    closing_meter_l REAL,
    testing_litres  REAL NOT NULL DEFAULT 0,   -- 5 L MDG check, returned to tank
    gross_litres    REAL GENERATED ALWAYS AS (closing_meter_l - opening_meter_l) VIRTUAL,
    net_litres      REAL GENERATED ALWAYS AS (closing_meter_l - opening_meter_l - testing_litres) VIRTUAL,
    UNIQUE (shift_id, nozzle_id)
);

-- Per-attendant cash accountability. Signed at the moment of counting, not later.
-- Sign convention matches the app: POSITIVE means SHORT (money missing).
CREATE TABLE attendant_drawer (
    id              INTEGER PRIMARY KEY,
    shift_id        INTEGER NOT NULL REFERENCES shift(id),
    attendant       TEXT NOT NULL,
    expected_paise  INTEGER NOT NULL,
    cash_paise      INTEGER NOT NULL,
    difference_paise INTEGER GENERATED ALWAYS AS (expected_paise - cash_paise) VIRTUAL,
    signed_at       TEXT,
    remark          TEXT
);

CREATE TABLE collection (
    id          INTEGER PRIMARY KEY,
    shift_id    INTEGER NOT NULL REFERENCES shift(id),
    tender      TEXT NOT NULL CHECK (tender IN ('CASH','UPI','CARD','CREDIT','FLEET','WALLET')),
    amount_paise INTEGER NOT NULL,
    reference   TEXT,                      -- UPI ref / POS slip no. / credit slip no.
    settled_at  TEXT,                      -- from acquirer statement, not from the app
    mdr_paise   INTEGER DEFAULT 0          -- booked as an expense, never netted off
);

CREATE TABLE customer (
    id            INTEGER PRIMARY KEY,
    outlet_id     INTEGER NOT NULL REFERENCES outlet(id),
    name          TEXT NOT NULL,
    phone         TEXT,
    gstin         TEXT,
    credit_limit_paise INTEGER DEFAULT 0
);

CREATE TABLE credit_sale (
    id             INTEGER PRIMARY KEY,
    shift_id       INTEGER NOT NULL REFERENCES shift(id),
    customer_id    INTEGER NOT NULL REFERENCES customer(id),
    vehicle_no     TEXT NOT NULL,          -- mandatory: a credit slip without a vehicle is uncollectable
    product        TEXT NOT NULL,
    litres         REAL NOT NULL,
    amount_paise   INTEGER NOT NULL,
    slip_no        TEXT,
    signature_ref  TEXT,                   -- photo of the signed slip
    settled_paise  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE receipt (                    -- tanker / decantation
    id                 INTEGER PRIMARY KEY,
    outlet_id          INTEGER NOT NULL REFERENCES outlet(id),
    tank_id            INTEGER NOT NULL REFERENCES tank(id),
    invoice_no         TEXT NOT NULL,
    invoice_date       TEXT NOT NULL,
    tank_lorry_no      TEXT,
    invoice_litres_15c REAL NOT NULL,       -- what you were billed
    invoice_density_15c REAL,
    invoice_temp_c     REAL,
    dip_before_mm      REAL,
    dip_after_mm       REAL,
    decanted_litres_15c REAL,               -- what you actually got
    short_litres       REAL GENERATED ALWAYS AS (invoice_litres_15c - decanted_litres_15c) VIRTUAL,
    samples_retained   INTEGER NOT NULL DEFAULT 0,
    claim_raised       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE dip (                        -- physical stock reading
    id            INTEGER PRIMARY KEY,
    business_day_id INTEGER NOT NULL REFERENCES business_day(id),
    tank_id       INTEGER NOT NULL REFERENCES tank(id),
    taken_at      TEXT NOT NULL,
    dip_mm        REAL NOT NULL,
    water_mm      REAL NOT NULL DEFAULT 0,
    density_15c   REAL,
    temp_c        REAL,
    volume_l      REAL NOT NULL,           -- from calibration chart
    phase         TEXT NOT NULL CHECK (phase IN ('OPEN','CLOSE','POST_DECANT'))
);

CREATE TABLE variance (                   -- one row per tank per day: book vs physical
    id                INTEGER PRIMARY KEY,
    business_day_id   INTEGER NOT NULL REFERENCES business_day(id),
    tank_id           INTEGER NOT NULL REFERENCES tank(id),
    opening_l         REAL NOT NULL,
    receipts_l        REAL NOT NULL DEFAULT 0,
    net_sales_l       REAL NOT NULL,
    book_closing_l    REAL NOT NULL,
    physical_l        REAL NOT NULL,
    variance_l        REAL NOT NULL,       -- physical - book; negative = loss
    evaporation_allow_l REAL,              -- MDG slab on quantity sold
    tolerance_band_l  REAL,                -- 4% of tank stock
    cause             TEXT,                -- decant short / evaporation / calibration / water / theft / unexplained
    approved_by       TEXT
);

CREATE TABLE expense (
    id              INTEGER PRIMARY KEY,
    business_day_id INTEGER NOT NULL REFERENCES business_day(id),
    category        TEXT NOT NULL,
    amount_paise    INTEGER NOT NULL,
    paid_by         TEXT,                  -- DRAWER / BANK / OWNER
    voucher_ref     TEXT,
    gst_included    INTEGER NOT NULL DEFAULT 0,
    note            TEXT
);

-- Lubes/shop: GST-bearing, so kept separate from fuel (VAT) sales.
CREATE TABLE shop_sale (
    id              INTEGER PRIMARY KEY,
    business_day_id INTEGER NOT NULL REFERENCES business_day(id),
    item            TEXT NOT NULL,
    hsn             TEXT,
    qty             REAL NOT NULL,
    amount_paise    INTEGER NOT NULL,
    tax_paise       INTEGER NOT NULL DEFAULT 0,
    invoice_no      TEXT,
    customer_gstin  TEXT
);

CREATE TABLE price_change_note (          -- stock revaluation on a rate revision
    id              INTEGER PRIMARY KEY,
    outlet_id       INTEGER NOT NULL REFERENCES outlet(id),
    effective_at    TEXT NOT NULL,
    product         TEXT NOT NULL,
    stock_litres    REAL NOT NULL,
    old_paise_per_litre INTEGER NOT NULL,
    new_paise_per_litre INTEGER NOT NULL,
    note_type       TEXT CHECK (note_type IN ('DEBIT','CREDIT')),
    note_value_paise INTEGER GENERATED ALWAYS AS
        ((new_paise_per_litre - old_paise_per_litre) * stock_litres) VIRTUAL
);

-- Immutability guard: refuse writes into a closed business day's sales tables.
CREATE TRIGGER shift_nozzle_closed_guard
BEFORE INSERT ON shift_nozzle
BEGIN
    SELECT RAISE(ABORT, 'business day is closed; post an adjustment instead')
    WHERE (SELECT bd.status FROM business_day bd
             JOIN shift s ON s.business_day_id = bd.id
            WHERE s.id = NEW.shift_id) = 'closed';
END;

CREATE INDEX idx_dip_day ON dip (business_day_id, tank_id);
CREATE INDEX idx_collection_shift ON collection (shift_id, tender);
CREATE INDEX idx_credit_customer ON credit_sale (customer_id, settled_paise);
