# 00b — Owner Decisions & Confirmed Requirements

**Purpose:** the running, authoritative record of decisions the business owner has made during analysis, and the binding requirements that follow from them. Everything here **overrides** inferences drawn from code or schema.

**Evidence labels:** `Verified` (confirmed from code/schema/live data) · `Owner-confirmed` (stated by the business owner) · `Recommended` (proposal for the new system — **not** an existing feature).

---

## Decision log

| # | Date | Question | Decision | Status |
|---|------|----------|----------|--------|
| D1 | 2026‑08‑01 | Analysis & rebuild scope breadth | **Pharmacy business system in full** — inventory, purchasing, sales/POS, customers/suppliers, receipts/payments, accounting/GL, reporting, **plus tax and FBR fiscalization and everything pharmacy‑related**. Non‑pharmacy verticals (hospital, school, HR, hotel, manufacturing, multi‑branch sync) are **catalogued but deferred** — never silently dropped. | ✅ Settled |
| D2 | 2026‑08‑01 | Live database access during analysis | **Read‑only introspection authorized** (SELECT / metadata only). | ✅ Settled |
| D3 | 2026‑08‑01 | Pre‑2025 history | **None exists.** The 19‑month window (2025‑01‑01 → 2026‑07‑31) is the complete migration scope. | ✅ Settled |
| D4 | 2026‑08‑01 | Currency | **PKR.** | ✅ Settled |
| D5 | 2026‑08‑01 | Customer model | **Walk‑in cash model confirmed.** No accounts‑receivable module required for current operations. | ✅ Settled |
| D6 | 2026‑08‑01 | Cash vouchers / journals kept outside the system? | **No** — none inside the system, none outside. ⇒ the operated system is a **trading ledger**, not full financial accounting (see `06a` §8). | ✅ Settled |
| D7 | 2026‑08‑01 | The ~21,000 never‑stocked items | **Keep every item. All visible by default. Visibility must be 100% configurable on/off from the admin panel UI.** See R1 below. | ✅ Settled |
| D8 | 2026‑08‑01 | Add expenses + cash book to the rebuild? (`06a` §8 Options A/B/C) | **Option B approved** — port the trading ledger as‑is, then **add** expense entry, cash/bank book, and a plain‑language profit statement. See R2 below, which was **substantially widened** by the F1 finding. | ✅ Settled |
| **D9** | 2026‑08‑01 | How are supplier payments made/tracked? (finding F1) | **"Add all options for the respective user to select from."** ⇒ Do not hardcode a single method. Ship every realistic option, let the user pick per transaction, and let the admin enable/disable options. **Generalised into the project‑wide principle P1 below.** | ✅ Settled |
| **D10** | 2026‑08‑01 | Opening balances at cutover | **"Start everything from zero."** All *financial* opening balances (cash, bank, suppliers, customers) begin at **zero** in the new system — no phantom balances are imported. See R3. | ✅ Settled |
| **D11** | 2026‑08‑01 | Physical stock at cutover | **"Carry stock over."** Stock quantities + average costs migrate unchanged (they are trustworthy). See R3.3. | ✅ Settled |
| **D12** | 2026‑08‑01 | Add real batch + expiry tracking to the rebuild? (finding F2) | **YES — approved.** Real batch/expiry tracking becomes a **Tier‑1** feature of the new system. See R4. | ✅ Settled |
| **D13** | 2026‑08‑02 | Must the till work offline (U-079)? | **YES — must keep selling if internet/server is unavailable.** Architecture-shaping: the POS client cannot be a thin client entirely dependent on a live connection; it needs local-first operation with sync on reconnect. See R5.1. | ✅ Settled |
| **D14** | 2026‑08‑02 | On-premise vs. cloud hosting (U-080)? | **Offer BOTH (per P1); cloud is the default.** Cloud deployment runs on infrastructure **the owner controls** (his own account), never the vendor's — so the vendor never holds a copy of his data. Backups additionally export to the owner's own Google Drive as an owner-controlled offsite copy. **Technical correction made to the literal request:** a live database cannot safely run inside a file-sync folder (corruption risk under concurrent writes) — Drive is the *backup destination*, not the live data store. See R5.2. | ✅ Settled |
| **D15** | 2026‑08‑02 | UI language (U-115)? | **Bilingual — English and Urdu, switchable.** The single largest accessibility decision; shapes every screen. See `16-modern-ux-blueprint.md`. | ✅ Settled |
| **D16** | 2026‑08‑02 | Second branch intent (U-016)? | **Expanded beyond the original question — "add multi tenancy and multi branch management."** Not just a quiet `branch_id` field: the owner wants the rebuild to support **multiple separate pharmacy businesses (tenants)**, each with their own branches, isolated data, and admin. Consistent with him operating other sites under the same product today (`MehmoodDataBase`, `KausarDataBase` — see `02` §1). **This materially widens the technical blueprint** — see R6. | ✅ Settled |
| **D17** | 2026‑08‑02 | Tax registration number hardcoded as "055-3252501" — real value? (U-061) | **Not hardcoded anywhere.** NTN/STRN and other business-identity fields are **admin-editable settings**, scoped **per tenant** (each pharmacy business has its own tax identity) given D16. No single value is baked into config or code. | ✅ Settled |
| **D18** | 2026‑08‑02 | DRAP / controlled-drug regulatory obligations (U-062)? | **YES — real obligations exist. Research them fully and build compliant record-keeping, but it must be "super easy" to use.** Initial research done — see R7. Full compliance scope still needs a licensed pharmacist/regulatory consultant to finalise; this analysis does not invent regulated-domain requirements from web research alone. | 🟡 Research started, finalisation pending professional sign-off |
| **D19** | 2026‑08‑02 | Which FBR regime — POS fiscalization or Digital Invoicing? (U-060) | **Both, admin-switchable — "the user decides which to activate and make primary." POS fiscalization (the current, live one) is the default/primary.** Same P1 pattern applied to a compliance mechanism. Still needs written accountant/tax-adviser confirmation of which is *legally* required — the system supports either, but only one may be lawful at a time. | ✅ Settled (system design); legal confirmation still pending |
| **D20** | 2026‑08‑02 | Downtime tolerance? (U-121) | **"Not even a second — zero tolerance."** Escalates R5.1 from "survive outages" to "local-first, no single point of failure." See the revised R5.1. | ✅ Settled |
| **D21** | 2026‑08‑02 | Who administers the system day to day? (U-122) | **"Both — me across sites, staff per-site."** Confirms the R6 tenant model exactly: owner is the platform-level admin across all his pharmacy sites; each site's own staff handles that site's day-to-day admin. | ✅ Settled |

---

## P1 — Project‑wide design principle: "offer every option, let the user choose, let the admin curate"

**Established by the owner via D7 (item visibility) and D9 (payment methods). This now governs the whole rebuild.**

> Wherever the analysis cannot determine *how* this pharmacy does something — and wherever different staff may legitimately do it differently — **do not hardcode one answer.** Ship every realistic option, let the user select per transaction, and give the administrator a switch to hide the ones this business never uses.

### Rules

**P1.1 — Never hardcode a business assumption.** If the evidence does not settle it, it becomes a selectable option, not a guess baked into code.

**P1.2 — Sensible default, always changeable.** Every option list has one pre‑selected default (the most common choice) so routine work stays fast — one keystroke, not a decision.

**P1.3 — Admin can disable what is unused.** Unused options are switched off in the admin panel so the day‑to‑day UI stays clean. Disabling **hides** an option; it never deletes data, and history that used it still displays correctly. *(Same non‑destructive rule as R1.1.)*

**P1.4 — Options are data, not code.** Adding a new payment method, expense category, or adjustment reason must be an admin action, never a developer deployment.

**P1.5 — Role‑appropriate.** "The respective user" (D9) means each role sees the options relevant to them — a cashier sees counter payment methods; the owner/admin sees bank transfer, cheque and adjustments. Enforced by the permission model.

**P1.6 — Clean UI despite many options.** Long option lists are grouped, searchable, and show only enabled entries. Breadth of capability must never become clutter — this is an accessibility requirement (brief §7), not a preference.

**P1.7 — Every option is audited.** The chosen option is stored on the transaction and appears in the audit trail and on reports.

### Where P1 applies (initial list — extend as analysis continues)

| Area | Options to offer |
|------|------------------|
| Supplier payment method (R2.1) | Cash · Bank transfer · Cheque · Bank draft/pay order · Online/IBFT · Mobile wallet (Easypaisa / JazzCash) · Credit note adjustment · Other (free text) |
| Expense payment method (R2.2) | same list as above |
| Expense category (R2.2) | Seeded from existing `SubAccounts` expense groups + admin‑definable additions |
| Payment allocation (R2.1) | Against specific invoices · Oldest‑first (FIFO) · Reduce running balance only |
| Sale payment method | Cash · Card · Mobile wallet · Mixed/split · Credit *(admin‑disableable — currently walk‑in cash only, per D5)* |
| Stock adjustment reason | Damage · Expiry · Theft/shrinkage · Count correction · Sample/donation · Breakage · Other |
| Item visibility scope (R1.6) | Sales/POS · Purchase · Reports · Stock lists |
| Document/print format | A4 · A5 · thermal receipt · PDF · email |
| Opening balance method (R3) | Start at zero · Enter manually · Import from reconciled statement |

---

## R1 — Item catalogue visibility (from D7)

### Current state (Verified)

| Fact | Value | Evidence |
|------|-------|----------|
| Item master size | **30,052** items | `SELECT COUNT(*) FROM Item` |
| Marked `Active = 1` | **28,893** (96.1%) | `Item.Active` |
| Marked `Active = 0` | **1,159** (3.9%) | `Item.Active` |
| Items that ever held stock | **8,042** | `COUNT(DISTINCT ICode) FROM StockReport` |
| **Active but never stocked** | **20,861** | join of the two above |

- An item visibility mechanism **already exists**: `Item.Active tinyint NOT NULL DEFAULT (1)`.
  `Evidence: dbo.Item.Active`; read via `dbo.SP_IsActiveItem` (returns 0 = INACTIVE, 1 = ACTIVE); written via `dbo.SP_SetItemActiveStatus(@ICode, @Active)` — which validates input and returns 0 on success / ‑1 on failure.
- The same `Active` flag pattern already exists on other master tables: `Accounts.Active`, `SalesMan.ACTIVE`, `Users.Active`. `Verified` — so one consistent visibility concept can cover all master data.
- **The flag is under‑used as curation:** 20,861 items are visible yet have never held stock, meaning the counter‑staff search list is ~3.6× larger than the range the pharmacy actually trades. `Verified`.

### The requirement (Owner‑confirmed, D7)

> **Never delete an item. Show everything by default. Give the administrator complete, reversible control over what is visible — from the UI, not the database.**

### Specification

**R1.1 — Non‑destructive forever.** No item is ever deleted or archived out of existence. Visibility is presentation only; all history, stock movements, and ledger references remain intact and reportable regardless of visibility state. `Recommended` (as a hard rule for the new system).

**R1.2 — Default visible.** All 30,052 items ship visible after migration, preserving the existing `Item.Active` values (28,893 on / 1,159 off) rather than re‑deriving them. Migration must not silently change any item's visibility. `Recommended`.

**R1.3 — Per‑item toggle.** A single, obvious on/off control on the item record. Maps directly to the existing `Item.Active` flag ⇒ **Retain with technical rewrite**, not a new concept. `Recommended` (UI), on `Verified` foundation.

**R1.4 — Bulk operations.** Select many items (via search/filter) and toggle visibility in one action, with a confirmation summarising exactly how many items will change and a single‑click undo. Required because curating ~21,000 items one at a time is not humane. `Recommended`.

**R1.5 — Rule‑based visibility presets (admin panel).** Saved, *non‑destructive* rules the admin can enable/disable at will, e.g.:
- "Hide items never stocked"
- "Hide items with no sales in the last N months"
- "Hide items with zero stock and no pending purchase order"
- "Hide discontinued manufacturers"

Each preset shows a live count of what it would hide **before** it is applied, is reversible with one click, and never edits data — it only changes what the search list shows. `Recommended`.

**R1.6 — Scope switches.** The admin can control visibility independently per context, because the right answer differs by screen: **Sales/POS search**, **Purchase entry**, **Reports**, **Stock lists**. (A pharmacist may want a narrow list at the counter but the full catalogue when ordering.) `Recommended`.

**R1.7 — Always escapable.** Any screen that applies a visibility filter must offer a clearly labelled **"Show all items"** override, so a hidden item can always be found and sold. Hidden must never mean unreachable. `Recommended` — this is an accessibility and error‑prevention requirement, not a nicety.

**R1.8 — Audited.** Every visibility change (who, when, which items, old → new) is written to the audit log, consistent with the existing `ItemLog` pattern (109,473 rows). `Recommended`, extending `Verified` behaviour.

**R1.9 — Consistent across master data.** The same visibility model applies to items, accounts, salesmen, suppliers, customers and users — one mental model, one UI pattern. Justified by the existing `Active` columns on `Accounts`, `SalesMan`, `Users`. `Recommended`.

**R1.10 — Admin panel placement.** Settings → **Catalogue & Visibility**, in plain language ("Which products appear when staff search?"), never as raw flag names. Every control carries a one‑line plain‑English explanation and a live preview count. `Recommended`.

### Why this matters (business rationale)

| Without configurability | With R1 |
|---|---|
| 28,893 items in the counter search list; slow lookup, mis‑picks under queue pressure | Admin tunes the list to the ~8,000 actually traded, instantly and reversibly |
| Cleaning the catalogue means deleting — irreversible, and it breaks history | Nothing is ever destroyed; visibility is a view, not a deletion |
| Only a developer with database access can change it | The owner changes it from the admin screen, safely |

### Acceptance criteria

1. All 30,052 items migrate with visibility state preserved exactly (28,893 visible / 1,159 hidden); reconciliation report proves it.
2. An administrator can toggle any single item's visibility from the UI, and the change is audited.
3. An administrator can bulk‑toggle a filtered set, see the affected count before confirming, and undo it.
4. Enabling any visibility preset never modifies item data — proven by a before/after row‑hash comparison of the `items` table.
5. Every item‑search screen exposes a working "Show all items" override.
6. A hidden item remains fully reportable and can still be transacted when explicitly selected.
7. Visibility settings are per‑context (sales / purchase / reports / stock) and persist per deployment.

---

---

## F1 — CRITICAL FINDING: the ledger records money coming in, but never money going out

**Status: `Verified` from live GL data. Severity: Critical. This is the most consequential finding of the analysis so far.**

### The chart of accounts is sound

Four levels, correctly structured. `Verified`.

`MainAccounts` (5) → `CategoryAccounts` (13) → `SubAccounts` (29) → `Accounts` (267)

| Level | Contents |
|-------|----------|
| MainAccounts | ASSETS · LIABILITIES · EQUITY/CAPITAL · REVENUES · EXPENSES |
| CategoryAccounts | CURRENT ASSETS · FIXED ASSETS · DEFFERED COST · CURRENT LIABILITIES · LONG TERM LIABILITIES · EQUITY/CAPITAL · REVENUE FROM SALES · OTHER REVENUES · DIRECT EXPENSES · OPERATING EXPENSES · OTHER EXPENSES *(+ "FIXED ASSETS1" and "TEST" — data‑quality noise)* |
| SubAccounts | CASH IN HAND · CASH AT BANK · CUSTOMERS/DEBITORS · SUPPLIERS/CREDITORS · INVENTORY · SALES · SALES RETURNS · PURCHASES · COST OF SALES · MARKETING EXPENSES · ADMINSTRATIVE EXPENSES · PAYROLL‑SALARIES · TAXES PAYABLE · … |
| Accounts | 267 postable accounts, all `Active='Y'`, incl. ~235 individual supplier accounts |

> Note: `SubAccounts.CatAccCode` references `CategoryAccounts`, **not** `MainAccounts`. An earlier working assumption that these were mis‑mapped was **wrong and has been corrected** — the hierarchy is intact.

### What actually posts (Verified)

| Account | GL entries | Total Debit | Total Credit | Net |
|---------|-----------:|------------:|-------------:|-----|
| CASH FROM SALE (DEFAULT) | 322,065 | 234,003,081 | 19,691,239 | **214,311,842 Dr** |
| SALES ACCOUNT | 291,361 | 0 | 229,385,121 | 229,385,121 Cr |
| SUPPLIERS/CREDITORS (235 accounts, 112 active) | — | 3,526,552 | 186,197,682 | **182,671,130 Cr** |
| PURCHASE ACCOUNT | 6,416 | 193,566,768 | 0 | 193,566,768 Dr |
| SALES RETURN ACCOUNT | 30,704 | 19,301,800 | 0 | 19,301,800 Dr |
| PURCHASES RETURNS | 634 | 0 | 3,480,475 | 3,480,475 Cr |
| SALES TAX RECEIVEABLES | 39,514 | 4,168,064 | 4,372,676 | 204,612 Cr |
| ADVANCE INCOME TAX ON PURCHASE | 3,808 | 696,929 | 0 | 696,929 Dr |
| **FBR POS SERVICE FEE PAYABLE** | 320,300 | 28,939 | 291,361 | 262,422 Cr |
| EQUITY/CAPITAL | — | 0 | 11,873,579 | 11,873,579 Cr |
| **EXPENSES PAYABLE / ADMIN EXPENSES / MARKETING EXPENSES / COST OF SALES / INVENTORY / CASH AT BANK** | — | **0** | **0** | **never used** |

### The three structural gaps

**1. No supplier payment is ever recorded.** `Verified`.
Only `PV` (purchase) and `PR` (purchase return) document types ever touch a supplier account. Suppliers have been credited **186,197,682** and debited only **3,526,552** — and every one of those debits is a purchase return, not a payment. The recorded liability to distributors therefore stands at **182,671,130 PKR** and only ever grows.

**2. Cash only ever flows in.** `Verified`.
`CASH FROM SALE` is debited by every sale (234,003,081) and credited only by sale returns (19,691,239). No cash ever leaves the account — not for supplier payments, not for expenses, not for bank deposits. The books therefore show **214,311,842 PKR sitting in the till**.

**3. No expense has ever been recorded.** `Verified`.
`MARKETING EXPENSES`, `ADMINSTRATIVE EXPENSES`, `EXPENSES PAYABLE`, `PAYROLL‑SALARIES`, `COST OF SALES`, `CASH AT BANK` and `INVENTORY` all have **zero** GL entries across the full 19 months.

### What this means

The ledger is **arithmetically perfect but economically incomplete**. Debits equal credits exactly (`06a` §1) because every transaction it *does* record is balanced — but it records only half the business. Two headline figures in the current system are consequently **fiction**, and no report built on them can be trusted:

- "Cash in hand: 214 million" — the money was really spent on stock, wages, rent and supplier payments.
- "Owed to suppliers: 183 million" — most of this has almost certainly been paid.

**This is not a data‑corruption problem and not a migration risk** — it is a *scope* problem: the software was never used for the money‑out half of the business. It also strongly suggests **why a rebuild is wanted**.

### Consequences for the project

1. **Do NOT migrate `CASH IN HAND` or `SUPPLIERS/CREDITORS` balances as opening balances.** They are not real. Opening balances must be established from a physical count and a supplier‑statement reconciliation at cutover, signed off by the owner. `Recommended` — and this is now a hard migration requirement in `06a` §6 (supersedes a naive balance carry‑forward).
2. **Gross profit remains trustworthy** (sales, returns, purchases and stock valuation are all recorded), so existing sales/stock/GP reporting can be ported with confidence.
3. **Net profit, cash position and true payables do not exist today** and cannot be back‑computed from this data.
4. **R2 must therefore cover supplier payments first** — a bigger gap than expenses.

### ❓ Required from the owner before R2 is finalised

> **How are supplier payments actually made and recorded today?** (Bank transfer? Cash to the distributor's rep? A paper ledger? Bank statements only?) And should the new system's supplier balances **start from zero at cutover** after reconciling against supplier statements?

---

## F2 — CRITICAL FINDING: the pharmacy is not actually tracking medicine expiry or batches

**Status: `Verified` from live data (`08-inventory-logic.md` §10). Severity: Critical — patient‑safety relevant.**

The software **ships a complete batch and expiry subsystem** — batch numbers, per‑batch pricing, expiry‑intimation documents, FEFO/FIFO batch prioritisation, batch locking. But at this deployment it is **switched off in practice**:

| Evidence | Value |
|----------|-------|
| Stock rows with a real batch number | ~4% (96%+ carry the placeholder `'.'`) |
| Stock rows with a real expiry date | ~1% (99%+ carry a sentinel far‑future date) |
| `ItemBatches` table | **0 rows** |
| `ItemBatchPricing` table | **0 rows** |
| `ExpiryIntimation` table | **0 rows** |

**What this means for the business:** the system today **cannot answer "what is about to expire?"** and cannot stop expired stock being sold or block a short‑dated batch. For a pharmacy this is the most serious functional gap found — expired medicine is a safety and compliance issue, not just a stock nuisance.

**Why it probably happened (Strongly Inferred):** entering an expiry date and batch on every purchase line is slow at a high‑volume counter (~540 sales/day), so staff left the fields blank and the system accepted the placeholder.

### Recommended for the rebuild (labelled `Recommended` — an improvement, not a port)

- **First‑class expiry tracking** with a dashboard: "expiring in 30/60/90 days", value at risk, and a near‑expiry pick‑list for returns to supplier.
- **Make batch/expiry capture fast, not optional** — scan the barcode/QR to auto‑fill batch and expiry so it costs the cashier no time (ties to the barcode hardware already present).
- **FEFO by default** (first‑expiry‑first‑out) at point of sale, with an override.
- **Block or warn** on selling expired stock, admin‑configurable (per P1: warn / block / allow).

> ✅ **RESOLVED 2026‑08‑01 (D12): YES — approved.** Real batch/expiry tracking is now a Tier‑1 feature of the rebuild. Full specification in **R4** below.

---

## R2 — Expenses, cash book & real profit (from D8)

**Every item in R2 is `Recommended` — a NEW capability. None of it exists in the current system.**

### R2.1 Supplier payments *(highest priority — closes gap F1.1)*
Record a payment against a supplier: date, supplier, amount, **payment method (full selectable list per P1)**, paid‑from account, reference/cheque no., notes, optional photo of the receipt. Posts `Dr Supplier / Cr Cash‑or‑Bank`.

**Payment method — all options offered (P1):** Cash · Bank transfer · Cheque · Bank draft / pay order · Online transfer (IBFT) · Mobile wallet (Easypaisa / JazzCash) · Credit‑note adjustment · Other (free text). Default: Cash. Admin may disable unused methods.

**Allocation — all options offered (P1):** against specific purchase invoices · oldest‑first (FIFO) · reduce running balance only. Default: oldest‑first.

*Reuses the dormant‑but‑present `PurPayment`, `TransactionHeader/Detail` and `SP_CreateVoucher_From_PurPayment` design concepts — to be assessed in `07-accounting-logic.md` rather than invented from scratch.*

### R2.2 Expense entry *(closes gap F1.3)*
Simple form: date, category, amount, paid from, payee, notes, optional receipt photo. Categories seeded from the existing `SubAccounts` expense groups (Marketing, Administrative, Payroll‑Salaries, Payroll‑Wages) plus practical additions (rent, utilities, freight, repairs, bank charges). Recurring expenses (rent, salaries) can be templated so they are one click each month.

### R2.3 Cash & bank book *(closes gap F1.2)*
A running "Money In / Money Out / Balance" view per cash and bank account. Cash sales flow in **automatically from existing POS postings — never re‑entered** (critical: must read existing `SV` postings, not duplicate them). Money out comes from R2.1 and R2.2. Supports cash↔bank transfers and cash drawings.

### R2.4 Daily cash reconciliation
End‑of‑day: system shows expected cash, user enters counted cash, difference is shown and explained/approved. *The dormant `CashierShift` / `CashierShiftCashCount` / `CashierWindow` tables already model this — activate rather than reinvent.*

### R2.5 Plain‑language profit statement
No debit/credit jargon. Literally:

```
Money from sales            1,234,567
Less: cost of goods sold     -900,000
= Gross profit                334,567
Less: expenses               -120,000
= What you actually made      214,567
```
With drill‑down to the underlying transactions, and a period selector (day/month/year).

### R2.6 True supplier balances
"Who do I owe, and how much?" — per supplier, aged. Only meaningful once R2.1 exists and opening balances are reset (see F1 consequence 1).

### R2.7 Never break the trading ledger
R2 must be **additive**. Existing SV/SR/PV/PR posting behaviour is preserved byte‑for‑byte so historical sales, stock and GP reports remain reproducible. Any new posting uses new document types.

### R2.8 Accountant validation gate
The debit/credit rules for every new posting in R2 must be reviewed and signed off by a qualified accountant before implementation. Carried into `07-accounting-logic.md`'s validation checklist.

### Acceptance criteria
1. Recording a supplier payment reduces that supplier's balance and the cash/bank balance by the same amount, and the GL still satisfies `SUM(Debit) = SUM(Credit)`.
2. Cash sales appear in the cash book **exactly once** — proven by reconciling cash‑book inflows against `SUM(SV debits to cash)` for the same period.
3. Recording an expense reduces cash/bank and appears in the profit statement in the correct category and period.
4. The profit statement's gross‑profit line **exactly matches** the legacy gross‑profit report for any historical period (proves R2.7).
5. Daily cash reconciliation produces an auditable count‑vs‑expected record with the variance explained.
6. Every R2 transaction is fully audited (who, when, what, before → after) and reversible only by an audited reversal, never a silent edit.

---

## R3 — Opening balances: start from zero (from D10)

**Owner decision: "start everything from zero."** This is the correct call — finding F1 proved the legacy cash and supplier balances are fiction, and importing them would carry a ~183 million rupee phantom debt and a ~214 million rupee phantom till into a brand‑new system.

### R3.1 Financial balances start at zero ✅

| Balance | Legacy (fiction) | New system at cutover |
|---------|------------------|------------------------|
| Cash in hand | 214,311,842 Dr | **0** — or the actual counted cash, owner's choice (P1) |
| Cash at bank | never used | **0** — or the actual bank statement balance |
| Suppliers / creditors | 182,671,130 Cr | **0** — or per‑supplier reconciled figures |
| Customers / debtors | 0 (walk‑in cash, D5) | **0** |
| Equity / capital | 11,873,579 Cr | **0** — or owner‑stated capital |

Per **P1**, the migration tool offers three methods per balance type — **Start at zero** (default) · **Enter manually** · **Import from reconciled statement** — so the owner can start clean now and still enter real figures later without a developer.

### R3.2 Historical transactions still migrate ✅
"Start from zero" applies to **opening balances only**, not to history. The 19 months of transactions (2025‑01‑01 → 2026‑07‑31, per D3) still migrate in full so past sales, purchases, returns, stock movements and gross‑profit reports remain reproducible. `Confirmed by D3.`

### R3.3 ✅ CONFIRMED EXCEPTION: physical stock carries over (does NOT start at zero)

**Owner‑confirmed 2026‑08‑01: "carry stock over."** Stock **quantities** and **average costs** migrate unchanged (these are `Verified` trustworthy — see below). No physical stock‑take or freeze window is required at cutover; verification counts can happen after go‑live at the owner's pace.

**Rationale (why this is the right exception to "everything from zero"):**

The pharmacy holds **real physical medicine on the shelves right now**. Stock is not a bookkeeping balance — it is countable goods with real value, and — unlike the cash and supplier balances (F1) — it is continuously and correctly maintained by every purchase and sale. `Verified` via `06a` §5 and `08-inventory-logic.md` (moving weighted‑average cost validated 100% against 10,173 live purchase lines; authoritative balance table `GodownDetail`). Zeroing it would force a 0‑stock day‑one (nothing sellable until re‑counted) and make stock valuation and gross profit wrong until a full count of ~8,000 active lines is done — for no benefit, since the data is already correct.

**What carries over (Verified):** per‑item, per‑godown stock **quantity** and **moving‑average cost** from `GodownDetail`, plus sale/purchase‑price fields. This is the real, reconcilable inventory.

> ⚠️ **Correction to an earlier statement of mine — batch & expiry do NOT meaningfully exist to carry over.** `08-inventory-logic.md` proves this deployment is **not actually tracking batches or expiry**: 96%+ of stock rows carry a placeholder batch (`'.'`) and a sentinel expiry date, and `ItemBatches` / `ItemBatchPricing` / `ExpiryIntimation` are all empty. So "carry stock over" carries the quantities and costs (real) and whatever placeholder batch/expiry values exist (not real). **This is itself a major finding — see F2.**

### R3.4 Cutover requirements
1. Physical cash count on cutover day, recorded and signed.
2. Supplier statements requested and reconciled *before* entering any opening supplier balance (or deliberately left at zero).
3. The zero/manual/imported choice per balance type is recorded in the migration log with who chose it and when.
4. Legacy fiction balances are **archived for reference, never imported** — they remain visible in read‑only historical reports so the old numbers can still be explained.

---

## R4 — Batch & expiry tracking (from D12)

**Every item in R4 is `Recommended` — a NEW capability the current deployment does not use (finding F2).** The product's schema already models most of it (`ItemBatches`, `ItemBatchPricing`, `ExpiryIntimation`, batch prioritisation, `GodownDetail` keyed by batch+expiry), so this is **activating and modernising designed capability**, not inventing from nothing — but because it is unused today, it is treated as new for planning and testing.

### R4.1 Capture batch + expiry at intake, made effortless (P1 + F2)
On purchase/goods‑receipt, capture **batch number** and **expiry date** per line. To avoid the data‑entry burden that killed this in the legacy system:
- **Barcode / QR / DataMatrix scan auto‑fills** batch and expiry where the pack encodes them (GS1) — cashier does nothing extra. *(Barcode hardware and `QRCodeGenLibrary.dll` are already present.)*
- Manual entry with a fast date picker and "same as previous line" shortcut as fallback.
- Admin‑configurable strictness (per P1): **require** batch/expiry · **prompt but allow skip** · **off** — per item category (e.g. require for medicines, off for general goods).

### R4.2 Expiry visibility & alerts *(the core business win)*
- Dashboard tile and dedicated screen: **"Expiring in 30 / 60 / 90 days"**, with quantity and **value at risk** per bucket.
- Near‑expiry pick‑list to drive **returns to supplier** or markdown decisions before stock is dead.
- Configurable alert thresholds (admin), and optional SMS/notification (reuses existing SMS capability).

### R4.3 FEFO at point of sale
- **First‑Expiry‑First‑Out** batch selection by default at the till (the product already ships FEFO/FIFO/LIFO re‑prioritisation logic — adopt FEFO as the default).
- Cashier override allowed and audited.

### R4.4 Expired‑stock guardrail (per P1: warn / block / allow)
- Selling an expired or past‑threshold batch triggers an admin‑configured response: **warn** (cashier confirms), **block** (needs supervisor override), or **allow** (log only).
- Default recommendation: **warn** for near‑expiry, **block** for already‑expired.

### R4.5 Batch‑level cost & traceability
- Preserve item‑level moving‑average costing (R‑from‑`08`) as the financial basis, **and** record batch identity per movement for **traceability/recall** — being able to answer "which customers/sales got batch X" if a manufacturer recall occurs.
- `Recommended`: keep costing at item level (proven, simple) but carry batch as a *dimension*, not as a separate costing method, unless the owner later wants batch‑level costing.

### R4.6 Migration stance
- Historical stock carries over with its placeholder batch/expiry (R3.3) — **not back‑filled** (the real dates are unknowable retrospectively).
- Real batch/expiry data accrues from **go‑live forward** as new purchases are received. The expiry dashboard becomes fully meaningful within one stock‑turn cycle.
- A one‑time optional "stock‑take with expiry capture" can seed current shelf stock with real dates if the owner wants immediate coverage (their choice, not required).

### Acceptance criteria
1. A purchase line can capture batch + expiry by scan or manually; strictness follows the admin setting per item category.
2. The "expiring soon" screen lists correct items/quantities/value for 30/60/90‑day buckets against live data.
3. At sale, FEFO selects the earliest‑expiry available batch by default; overrides are audited.
4. Attempting to sell expired stock produces the admin‑configured warn/block/allow behaviour.
5. Given a batch number, the system lists every purchase and sale of that batch (recall traceability).
6. Item‑level gross profit is unchanged by the introduction of batch tracking (proves R4.5 additivity).

---

## R5 — Deployment: offline capability, hosting and data sovereignty (from D13, D14)

### R5.1 Offline-capable POS *(D13 — must-have, not optional; escalated 2026-08-02 to "zero tolerance for downtime")*

The counter must keep selling when internet or the server is unreachable. When asked how much downtime the business could tolerate, the owner's answer was **"not even a second — zero tolerance."** Taken literally, no system can guarantee absolute zero downtime — hardware fails, and this business has just lived through a fire that proves it. Taken as a design target, it is exactly right, and it changes R5.1 from "handle outages gracefully" to **"the local client is the primary system, not a fallback."** `Recommended` architecture:
- The POS client holds a **local, authoritative-enough cache** of what it needs to sell — active items, prices, stock levels as of last sync, and the ability to **queue completed sales locally**.
- On reconnect, queued sales sync to the server **in order**, with document numbers reserved in a way that survives an offline gap without collision (this is the same concern already flagged in `12-risks-gaps.md` for `SP_GetTabMaxkey`-style counters — the new system's numbering must be race-safe *and* offline-safe).
- FBR fiscalization (which the legacy system calls synchronously) must **queue and retry** rather than block a sale when unreachable, with a clear, honest UI state ("this sale will be reported to FBR once back online") — never a silent skip.
- Admin-configurable: how long the till may operate offline before requiring a supervisor acknowledgement, to bound the reconciliation risk of a long offline stretch.
- **No single point of failure by design**: the local client holds enough to keep selling indefinitely, not just through a brief blip — cloud/central server is where data converges and is backed up, not where the sale itself depends on a live round-trip.

### R5.2 Hosting and data sovereignty *(D14)*

Per **P1**, both deployment modes are offered and admin-selectable:

| Mode | Description | Default |
|---|---|---|
| **Cloud-hosted** | Runs on infrastructure the **owner** provisions and controls (his own cloud account) — the development/vendor side never holds a standing copy of his live data. | **Default** |
| **On-premise** | A local machine at the pharmacy, as today. | Available, owner's choice |

**The literal request — "store all data on Google Drive" — needed a technical correction, not a refusal of the intent.** A live transactional database cannot safely live inside a file-sync folder: sync tools read and rewrite files outside the database engine's control, which corrupts an actively-written database (a well-documented failure class, independent of which sync provider is used). Given this business already lost its entire system once to the fire, building in a *second* way to lose data would be a real disservice.

What delivers the actual intent — full data sovereignty, nothing held by the vendor — safely:
1. **Cloud hosting runs on an account only the owner controls.** No standing vendor access to live data.
2. **Automated backups are exported and pushed to the owner's own Google Drive** (or another destination he controls) as a routine, scheduled job — this is a safe, standard pattern (backup files, not a live database) and directly strengthens the offsite-backup gap already flagged for the pharmacy's new post-fire machine (`14-unknowns-and-questions.md` U-124, U-099, U-121).
3. **Full self-service export at any time** — the owner is never dependent on the vendor to get his own data out.

### Acceptance criteria
1. A sale can be completed with no network connection and appears correctly once sync resumes, with no duplicate or lost invoice numbers.
2. FBR fiscalization queues and retries rather than blocking or silently skipping a sale when offline.
3. The system deploys successfully on infrastructure the owner alone provisions and controls, with no standing vendor credential to the live database.
4. A scheduled backup job successfully places a restorable backup file in the owner's own Google Drive (or equivalent), independent of the primary hosting.
5. The owner can export a complete copy of his data at any time without vendor involvement.

---

## R6 — Multi-tenancy and multi-branch (from D16)

**Scope expansion, `Recommended`.** The original question (does this one pharmacy expect a second branch) was answered far more broadly: the owner wants the platform itself to support **multiple separate pharmacy businesses**, not just multiple locations of one business. This is a genuine architectural pivot, not a configuration toggle, and must be reflected everywhere the technical blueprint currently assumes a single business:

- **Data model:** every tenant-owned table carries a `tenant_id` (and, within a tenant, a `branch_id`) from day one — retrofitting this to a live multi-tenant ledger later is exactly the kind of expensive-later change `00b`/`14` U-016 originally warned about, now confirmed as needed.
- **Isolation:** one tenant must never be able to see or affect another's data, even through a bug — this is a security requirement, not just a modelling one.
- **Admin model:** a tenant-level admin (e.g., a pharmacy owner) manages their own branches, staff, item visibility (R1), options (P1) and settings; a platform-level admin (the owner, across all his sites) manages tenants themselves.
- **Reporting:** per-branch, per-tenant, and (for the owner, across his own sites) cross-tenant rollups.
- **Consistent with observed reality:** the legacy product already serves multiple named sites (`FazalDinPP19...`, `MehmoodDataBase`, `KausarDataBase`) as **separate physical databases** — i.e., today's "multi-tenancy" is one database per client with no shared platform. R6 asks for a real shared platform instead.

**This changes effort sizing materially** — it must be factored into the phased roadmap (`22-final-master-revamp-plan.md`) as a Foundation-phase (P1) architectural decision, not a later add-on.

## R7 — DRAP / regulatory compliance (from D18)

**`Recommended`, with an explicit "needs a professional" boundary — consistent with this analysis never guessing a regulated domain.**

**What initial research confirmed (`Verified` from DRAP's own regulatory instruments, via web research 2026-08-02):**
- Pakistan's pharmaceutical track-and-trace regime is genuinely current: **S.R.O. 470(I)/2017** (original mandate) → **S.R.O. 962(I)/2019** (revised after Supreme Court intervention, 3 Aug 2018 order) → **S.R.O. 963(I)/2026**, published **9 June 2026** — the current, finalised regulation.
- **Mandatory: a GS1 2D DataMatrix barcode on secondary packaging encoding GTIN + Batch Number + Expiry Date + Serial Number**, required within **4 months of the June 2026 publication — i.e. imminently, around October 2026**, alongside per-unit serialization.
- Applies to allopathic drugs (human and veterinary, including biologicals). Exempt: alternative medicine, OTC non-drug products, nutraceuticals, medical devices, medical gases, radiopharmaceuticals.
- **This directly validates R4's design assumption** (U-049): scannable GS1 batch/expiry codes on medicine packaging are becoming a legal manufacturing requirement, not a hopeful assumption — R4's scan-to-fill approach is well-timed, not speculative.

**What is genuinely still open, and belongs to a pharmacist/regulatory consultant, not this analysis:**
- Whether this track-and-trace regulation imposes any **direct obligation on the retail dispensing pharmacy itself** (vs. being purely an upstream manufacturer/packaging requirement the pharmacy simply benefits from).
- Controlled-substance register requirements, prescription-retention periods, and any pharmacist-countersignature rule under the Drugs Act 1976 / DRAP Act 2012 / Control of Narcotic Substances Act 1997 — none of these were confirmed at the level of detail needed to build a compliant feature.
- Licence renewal tracking obligations specific to this pharmacy.

**Design commitment regardless of the final scope:** whatever record-keeping DRAP requires, the UI must be **"super easy"** — the owner's explicit instruction. `Recommended` pattern: capture the required fields as a natural extension of the sale/purchase flow already being designed (e.g., a controlled-substance sale prompts one extra, clearly-labelled field at the point it's already being rung up), never a separate compliance module staff have to remember to visit.

**Sources:** [DRA.gov.pk](https://www.dra.gov.pk/) · [Drugs Act 1976 (DRAP)](https://www.dra.gov.pk/wp-content/uploads/2022/10/Drugs-Act-1976.pdf) · [Pakistan Pharmaceutical Track and Trace System — VISIOTT](https://www.visiott.com/traceability-articles/pakistan-pharmaceutical-track-and-trace-system/)

---

## Cross‑references

- Migration reconciliation baseline & the trading‑ledger finding → `06a-data-profile-reconciliation-baseline.md`
- Item master, pricing and stock semantics → `08-inventory-logic.md`
- Admin/settings module and the existing preferences store (`SoftwarePreferences`, `InterfaceSetting`, `ConfigSetting`, `Global`) → `03-module-catalog.md`
- Admin panel UX patterns, plain‑language settings, preview‑before‑apply → `16-modern-ux-blueprint.md`
- Feature mapping old → new → `21-feature-traceability-matrix.md`
