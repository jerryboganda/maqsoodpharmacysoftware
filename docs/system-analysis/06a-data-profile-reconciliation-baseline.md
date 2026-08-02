# 06a — Live Data Profile & Migration Reconciliation Baseline

**Analysis stage:** Stage 2 (System Inventory)
**Method:** read‑only SQL queries against the live database `FazalDinPP19DataBaseV2` on `localhost\SQLEXPRESS` (user‑authorized, SELECT‑only).
**Purpose:** establish the *numerical* baseline that any MySQL migration must reproduce exactly (brief §12), and size the system for performance testing (brief §20).

**Evidence labels used:** `Verified` = read directly from live data. `Strongly Inferred` = multiple converging evidence. `Recommended` = proposal for the new system, not an existing feature.

---

## 1. Headline: the ledger is balanced ✅ (Verified)

```sql
SELECT COUNT(*), SUM(Debit), SUM(Credit), SUM(Debit)-SUM(Credit) FROM VirtualGl;
```

| Metric | Value |
|--------|-------|
| Total GL entries | **1,021,852** |
| Sum of Debits | **455,292,133.00** |
| Sum of Credits | **455,292,133.00** |
| **Difference** | **0.00** |

> **Verified.** Double‑entry integrity holds exactly across the entire ledger. `Evidence: dbo.VirtualGl` (Debit/Credit `numeric(15,2)`).
> **This is the single most important reconciliation invariant for migration.** Post‑migration, this query against MySQL must return the identical four numbers.

---

## 2. Data window & business scale (Verified)

| Table | First txn | Last txn | Rows |
|-------|-----------|----------|------|
| `SaleLedger` (sale invoices) | 2025‑01‑01 | 2026‑07‑31 | 291,361 |
| `Saledetail` (sale lines) | — | — | 620,525 |
| `SRLedger` (sale returns) | 2025‑01‑01 | 2026‑07‑31 | 30,704 |
| `SRdetail` | — | — | 44,563 |
| `Purledger` (purchase invoices) | 2025‑01‑01 | 2026‑07‑31 | 6,419 |
| `Purdetail` | — | — | 113,082 |
| `PRLedger` (purchase returns) | 2025‑01‑02 | 2026‑07‑30 | 634 |
| `PRdetail` | — | — | 2,481 |
| `PurOrderHeader` / `PurOrderDetail` | 2025‑01‑02 | 2026‑07‑30 | 2,810 / 108,423 |
| `AdjHeader` / `AdjDetail` (stock adjustments) | 2025‑01‑01 | 2026‑07‑29 | 1,542 / 11,181 |
| `VirtualGl` (general ledger) | 2025‑01‑01 | 2026‑07‑31 | 1,021,852 |
| `StockReport` (daily stock snapshot) | 2025‑01‑01 | 2026‑07‑31 | 3,215,967 |

**Key conclusion (Verified):** the live dataset spans **~19 months (2025‑01‑01 → 2026‑07‑31)**, not decades. Every transactional table starts on/about 2025‑01‑01, which is **Strongly Inferred** to mean the database was started fresh (or archived/cut over) on 1 Jan 2025. *This materially shrinks migration risk and volume.*

### Trading volume

| Year | Sale invoices | Total sales value |
|------|---------------|-------------------|
| 2025 (full) | 197,625 | 159,623,943 |
| 2026 (Jan–Jul) | 93,736 | 74,379,138 |
| **Total** | **291,361** | **234,003,081** |

- ≈ **540 sale invoices per trading day** (197,625 ÷ ~366) — a high‑throughput retail pharmacy counter.
- ≈ **PKR 160 million/year** turnover (currency **Strongly Inferred** as PKR from the Pakistan FBR fiscalization integration; to be confirmed with the owner).
- Average invoice value ≈ **803**; average ≈ 2.1 lines per invoice (620,525 lines ÷ 291,361 invoices).

> **Performance implication (Recommended):** the rebuild must comfortably handle ~600 invoices/day with sub‑second POS response, and report over ~1M GL rows / 3.2M stock‑snapshot rows. This is *modest* for MySQL 8 on modern hardware — no sharding or distributed architecture is warranted. It does mandate correct indexing and pre‑aggregation for reports.

---

## 3. Posting status (Verified)

| Check | Result |
|-------|--------|
| `SaleLedger` with `Posted='Y'` | **291,361** |
| `SaleLedger` not posted | **0** |

> **Verified.** There is **no unposted backlog**. Every sale invoice in the system has been posted to the ledger. Migration does not need to handle a half‑posted state — but the rebuild must still preserve the post/unpost concept (see `07-accounting-logic.md`).

---

## 4. What actually posts to the GL (Verified) — a decisive scope finding

```sql
SELECT DocumentType, COUNT(*), SUM(Debit), SUM(Credit) FROM VirtualGl GROUP BY DocumentType;
```

| DocumentType | Entries | Debit | Credit | Meaning (Strongly Inferred) |
|---|---|---|---|---|
| **SV** | 908,617 | 234,003,081.00 | 234,003,081.00 | Sale voucher |
| **SR** | 93,050 | 19,691,239.00 | 19,691,239.00 | Sale return |
| **PV** | 18,790 | 198,071,261.00 | 198,071,261.00 | Purchase voucher |
| **PR** | 1,395 | 3,526,552.00 | 3,526,552.00 | Purchase return |

**Findings:**

1. **Only four document types ever post.** Despite the schema supporting receipts, journal vouchers, payroll, patient, guest, cashier‑shift and service postings (`SP_VirtualGL_Receipt`, `_Vouchers`, `_Payroll`, `_Patient`, `_Guest`, `_CashierShift`, `_Services`, …), **none of them have produced a single GL row**. `Verified` — those posting paths are **dormant at this deployment**.
2. **SV debit total (234,003,081.00) ties *exactly* to total sales value** from `SaleLedger.InvTotal` (159,623,943 + 74,379,138). `Verified` — a clean cross‑table reconciliation proving sales→GL consistency.
3. Each type is internally balanced (Dr = Cr per type). `Verified`.
4. ≈ **3.1 GL entries per sale invoice** (908,617 ÷ 291,361) — consistent with a compound posting (e.g. cash/receivable, sales income, and a tax or cost leg). *The exact debit/credit account mapping is traced in `07-accounting-logic.md`; it is **not** guessed here.*

> **Modernization implication:** the accounting rebuild's *critical path* is four posting routines, not the dozens the schema implies. This is a major, evidence‑backed scope reduction — but the dormant paths must still be catalogued (nothing disappears silently) and the owner must confirm they are genuinely unused rather than temporarily idle.

---

## 5. `StockReport` granularity (Verified)

| Metric | Value |
|--------|-------|
| Rows | 3,215,967 |
| Distinct items (`ICode`) | **8,042** |
| Distinct dates | **545** |

545 dates ≈ the 19‑month window ⇒ **one row per item per trading day** (8,042 × 545 = 4,382,890 possible vs 3,215,967 actual ⇒ rows written only for items with activity/stock on that date). `Strongly Inferred`: `StockReport` is a **daily per‑item stock & price snapshot**, not an event‑level movement ledger.

Note the contrast: the item master holds **30,050** items but only **8,042** ever appear in stock snapshots ⇒ **~73% of the item catalogue is inactive/never stocked**. `Verified`. *(Candidate for archival in the rebuild — flag for owner decision, do not delete silently.)*

---

## 6. Reconciliation checklist for migration (Recommended)

Each of these must produce **identical** results in SQL Server (before) and MySQL (after). This is the acceptance gate for cutover.

| # | Invariant | Baseline value (2026‑08‑01) |
|---|-----------|------------------------------|
| R1 | `SUM(Debit) = SUM(Credit)` in GL | both `455,292,133.00`, diff `0.00` |
| R2 | Total GL entries | `1,021,852` |
| R3 | GL Dr/Cr per DocumentType | SV/SR/PV/PR table in §4 |
| R4 | Sale invoice count | `291,361` |
| R5 | Sale line count | `620,525` |
| R6 | Total sales value (`SUM(InvTotal)`) | `234,003,081` |
| R7 | Sale‑return count / value | `30,704` / `19,691,239` |
| R8 | Purchase invoice count / GL value | `6,419` / `198,071,261` |
| R9 | Purchase‑return count / value | `634` / `3,526,552` |
| R10 | Posted vs unposted sale invoices | `291,361` / `0` |
| R11 | Item master count | `30,050` |
| R12 | Distinct items with stock history | `8,042` |
| R13 | Closing stock qty & value per item per godown | *(to be captured from `GodownDetail` + `StockReport` at cutover — see `08-inventory-logic.md`)* |
| R14 | Supplier count | `235` |
| R15 | Customer count | `2` |
| R16 | User/group counts | `9` / `9` |

> **Recommended process (brief §12):** capture this baseline **immediately before** cutover (values will have moved on), run the migration into MySQL, re‑run all 16 checks, and require a byte‑for‑byte match report signed off by the owner/accountant before go‑live. Never a one‑step uncontrolled migration.

---

## 7. Open questions raised by this profile

| # | Question | Why it matters | Who answers |
|---|----------|----------------|-------------|
| ~~Q1~~ | ~~Is there **pre‑2025 history** in another database/backup that must also migrate?~~ **RESOLVED 2026‑08‑01 by the owner: there is NO pre‑2025 data. The 19‑month window (2025‑01‑01 → 2026‑07‑31) is the complete migration scope.** | Migration scope is now fixed and bounded — no additional archive discovery, no multi‑era schema reconciliation, and historical‑report reproducibility only needs to hold from 2025‑01‑01. | ✅ Owner (answered) |
| ~~Q2~~ | ~~Is the currency **PKR**?~~ **RESOLVED 2026‑08‑01: yes, PKR.** | Money formatting, rounding to 2dp, and FBR tax logic all assume PKR. | ✅ Owner (answered) |
| ~~Q3~~ | ~~Are receipts/vouchers/journal entries genuinely unused, or entered outside the system?~~ **RESOLVED 2026‑08‑01: they are genuinely unused — no cash vouchers are kept outside the system either.** | See §8 — this redefines what "accounting" means in this system. | ✅ Owner (answered) |
| Q4 | Should the ~22,000 never‑stocked items be archived? | Cleaner catalogue and faster search, but must not lose history. | Owner |
| ~~Q5~~ | ~~Why are there **2 customers** but 291,361 invoices?~~ **RESOLVED 2026‑08‑01: confirmed walk‑in cash model.** | No accounts‑receivable module is required for current operations. | ✅ Owner (answered) |

*(Remaining unknowns are carried into `14-unknowns-and-questions.md`.)*

---

## 8. Decisive scope consequence: this is a *trading ledger*, not full financial accounting

**Status: `Verified` (data) + owner‑confirmed (2026‑08‑01).**

Three independent facts converge:

1. The GL contains **only** SV / SR / PV / PR document types — sale, sale return, purchase, purchase return (§4).
2. Every receipt, voucher, journal, payroll, cashier‑shift, patient and guest posting path exists in code but has produced **zero** rows.
3. The owner confirms **no cash vouchers or journals are maintained outside the system**, and sales are **walk‑in cash** (no receivables).

**Therefore (Verified):** the system as operated records the **trading cycle only** — purchases in, sales out, returns both ways, and the stock valuation that follows. It does **not** perform:

| Not present in the operated system | Consequence |
|---|---|
| Expense accounting (rent, salaries, utilities, freight) | No true operating‑profit figure exists |
| Cash book / bank accounts / reconciliation | Cash position is not tracked as an account balance |
| Accounts receivable | Not needed — cash sales (owner‑confirmed) |
| Accounts payable as a live ledger | Supplier balances exist in schema; usage to be confirmed in `07-accounting-logic.md` |
| Equity, fixed assets, depreciation | No balance sheet is derivable today |
| Formal period close / year‑end | To be confirmed in `07-accounting-logic.md` |

**What the system *can* legitimately produce today:** gross sales, sales returns, net sales, purchases, purchase returns, **gross profit**, stock quantity and stock valuation, and sales tax figures. `Strongly Inferred` from §4 plus the report procedures (`sp_IncomeStatement`, `SP_DailyIncomeStatement_With_GP_Summary`).

### Implications for the rebuild — a business decision is required

| Option | What it means | Trade‑off |
|--------|---------------|-----------|
| **A. Faithful port** | Rebuild the trading ledger exactly as‑is (SV/SR/PV/PR only). | Lowest risk, fastest, zero retraining. But the owner still cannot see true net profit, cash position, or a balance sheet. |
| **B. Trading ledger + expenses & cash book** *(Recommended)* | Port A, then **add** simple expense entry, a cash/bank book, and a real profit statement — presented in plain language, not accountant jargon. | Modest extra scope; turns the software from a stock‑and‑sales tracker into something that answers "did I actually make money this month?" Must be built as a **new** module, clearly labelled — it is *not* present today. |
| **C. Full double‑entry accounting suite** | Complete COA, journals, fixed assets, depreciation, formal period close, balance sheet. | Largest scope; requires a qualified accountant to define policy; likely more than a single‑branch retail pharmacy needs. |

> ⚠️ **Anti‑hallucination note:** Options B and C are **`Recommended`** — proposals for the new system. Neither is an existing feature. Any document that describes the current system's "accounting" must scope it to the trading cycle described above.
> **This choice must be made by the owner (ideally with an accountant) before Phase 6 of the roadmap.** It is carried into `14-unknowns-and-questions.md` as a required business decision.
