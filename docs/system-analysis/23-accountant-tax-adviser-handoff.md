# 23 — Accountant & Tax-Adviser Sign-Off Packet

**Prepared:** 2026-08-02, during Phase 0 (discovery sign-off) of the WASEELA ABUZAR V3 modernization project.
**Audience:** a qualified accountant and a tax adviser, retained by the business owner (Abuzar). Read this document alone — it does not require the other 23 analysis documents, though every claim in it is drawn from and traceable to them.
**Purpose:** to obtain professional rulings on accounting and tax questions that the analysis team is **not qualified, and not willing, to guess.** Every item below blocks part of the rebuild until it is answered.

**The existing system was not modified to produce this document.** Every finding is read-only: SQL Server metadata queries and stored-procedure source, nothing else.

**Evidence labels used throughout:** `Verified` — read directly from live data or stored-procedure source code. `Unclear` — the behaviour is observable but its *correctness* or *intent* cannot be determined without a professional ruling. `Missing` — no definition of the required logic exists anywhere in the system.

**How to use this document:** each item is a question, with the evidence that prompted it and a place to record your ruling. Please return answers referencing the item ID (A1, C4, T2, etc.) so they can be filed back into the master unknowns register (`14-unknowns-and-questions.md`) without ambiguity. Where you disagree with how a question is framed, please say so — the framing is the analysis team's best understanding, not a constraint on your answer.

---

## 0. Context you need before the questions make sense

**What this system is.** A single retail pharmacy in Gujranwala has operated a compiled point-of-sale and inventory system (WASEELA ABUZAR V3) for at least 19 months (2025‑01‑01 to 2026‑07‑31 — no earlier data survives). The business is being rebuilt on modern technology (Node.js, React, MySQL), and this rebuild must preserve everything the current books can be trusted for, while fixing what they cannot.

**The one finding that shapes almost every question below.** The system's general ledger is arithmetically perfect — debits equal credits, to the paisa, across 1,021,852 posted lines — but it has **only ever recorded four kinds of transaction**: sales, sale returns, purchases, and purchase returns. In over nineteen months of trading:

- **No supplier payment has ever been posted.** Suppliers have been credited PKR 186,197,682 and debited only PKR 3,526,552 (all of which are purchase returns, not payments). The books therefore claim the business owes its distributors **PKR 182,671,130** — a figure that has only ever grown, because nothing has ever reduced it.
- **No cash payment out of the till has ever been posted** — not to a supplier, not to an expense, not to a bank. Cash has been debited PKR 234,003,081 (every sale) and credited only PKR 19,691,239 (sale returns). The books therefore claim there is **PKR 214,311,842 sitting in the till.**
- **No expense of any kind — rent, salaries, utilities — has ever been posted.** The relevant accounts (Marketing Expenses, Administrative Expenses, Payroll, Cash at Bank, Cost of Sales) have **zero** entries across the entire period.

The owner has confirmed directly that this is not a data problem — no cash vouchers, supplier payments, or expenses are recorded anywhere, on paper or otherwise, outside this system either. **The cash and supplier-payable figures the software reports today are not real financial positions.** Sales, purchases, returns, and stock movement, by contrast, **are** believed to be soundly recorded — that belief is precisely what item A1 below asks you to test.

**The decision already made, subject to your confirmation.** The owner has decided that when the new system goes live, **all financial opening balances (cash, bank, supplier, customer, equity) start at zero**, rather than carrying forward the figures above. Physical stock is the one exception — it carries over unchanged, because (subject to item A3/A4) it is believed to be a real, continuously-maintained figure, unlike cash and payables. Item A1 and A2 below ask you to sign off on this reasoning, not merely to be informed of it.

---

## PART 1 — For the accountant

**35 items, grouped by priority. Section A gates the rest — please address it first.** The full evidence trail behind every item lives in `07-accounting-logic.md`, cited by section number in the right-hand column.

### A. Foundational — please answer these first

| # | Question | Evidence |
|---|---|---|
| **A1** | Is the PKR 214.3M cash balance and the ~PKR 190M supplier balance a true book position, or purely an artefact of payments never being recorded? If an artefact — as the analysis believes — what should the real cash and payables position be established as at cut-over? *(This is the professional confirmation the "start from zero" decision above is resting on.)* | §7.3, §15.3 — `GLHeader` (manual journal table) has 0 rows across the entire period |
| **A2** | Please confirm the intended opening balance sheet. Only one opening entry exists in the whole system: a single Dr Purchase / Cr Capital of PKR 11,873,579, dated 2025‑01‑01 (booked as an "Opening Purchase" document). There is no opening cash, bank, receivables, payables, or fixed-asset entry anywhere. Is this the correct starting position, or should the new system's opening balance sheet be constructed differently? | §8.2 |
| **A3** | Please confirm that cost of goods sold has never been posted to the general ledger, and advise the correct COGS treatment (periodic vs. perpetual) for the new system. Line-level cost data does exist separately (`SaleDetail.AvgPrice`, summing to PKR 193,957,857 across 620,617 sale lines) — the question is what to do with it going forward. | §10.4, §4.3 — `InventorySystemUsed = 'P'` (periodic) |
| **A4** | Please confirm that all 1,542 stock adjustments over the period are correctly excluded from the ledger (they are — every one has a null GL account code), and advise the correct debit/credit treatment for stock increases and decreases going forward, including which accounts to use (two sub-accounts exist for this but have never been populated). | §13.3 |
| **A5** | Please confirm the sign convention to use in the income statement, and whether the existing credit-negative presentation (unconfirmed whether the screen ever corrects it) needs to be preserved for comparability with historical reports. | §10.3 |

### B. Posting-rule confirmations

These are the debit/credit rules the current system actually follows. Please confirm each is correct, or specify the correction, before it is carried into the new system.

| # | Rule as currently implemented | Evidence |
|---|---|---|
| B1 | Cash sale: Dr Cash / Cr Sales. The customer is recorded for reference only and carries no ledger balance. | §4.1, §3.4 |
| B2 | Sale return: Dr Sales Return / Cr Cash — booked as a fresh entry, not a reversal of the original sale. | §13.1 |
| B3 | Purchase (periodic method): Dr Purchase / Cr Supplier. The inventory account itself is never touched. | §4.2 |
| B4 | Purchase return: Dr Supplier / Cr Purchases Returns. | §13.2 |
| B5 | Opening purchase entries credit Capital rather than an opening-stock or suspense account. | §8.2 |
| B6 | Opening purchase returns debit Capital. | §4.2 |
| B7 | Control accounts (customer/supplier) receive amounts net of advance income tax and the FBR fee; the counterparty accounts (sales/purchase) receive the gross amount plus sales tax. | §3.3 |
| B8 | Payroll postings use a five-leg structure: gross earnings to the employee, advances to an advance account, deductions to deduction accounts, net pay to Payroll Payable, and the eventual payment clearing that liability. *(Dormant — never used at this site — but the rule exists in the software and may matter if payroll is added.)* | §4.5 |
| B9 | Cashier shift over/under: excess cash is debited to Cash and credited to a "difference" account; a shortfall is the reverse. *(Also dormant here.)* | §4.6 |
| B10 | Goods issued between locations: Dr the receiving party / Cr Goods Issued; goods received: Dr Goods Receipt / Cr the issuing party — under the periodic method. *(Not used at this single-location site, but relevant if multi-branch is built — see the owner's new multi-tenancy decision, `00b` D16.)* | §4.3 |

### C. Tax-adjacent accounting questions

*(These sit at the accountant/tax-adviser boundary — please coordinate with the tax adviser on Part 2 for C1, C4 and C6 in particular.)*

| # | Question | Evidence |
|---|---|---|
| C1 | Output sales tax on goods is currently credited to account "3 — Sales Tax Receivables," which is classified as an **asset**, not a liability. The account currently carries a net credit balance of PKR 204,612 — a liability sitting inside an asset account. Is this intentional netting, or a mis-configuration that should be corrected in the new system? | §12.1(a) |
| C2 | Output tax on **services** correctly uses a liability account (27), while output tax on **goods** uses the asset account in C1. Is this asymmetry intended? | §12.1(a) |
| C3 | Advance income tax on purchases posts to an asset account (35); advance income tax on sales posts to a liability account (36) but is currently switched off (`ApplyAdvanceIncomeTaxInSale = 'N'`). Please confirm both are correct. | §12.1(b) |
| C4 | The system charges customers Re. 1.00 per sale invoice as an "FBR POS fee," reversed on returns, currently sitting at a net liability of PKR 262,422. Please confirm the correct accounting treatment and the remittance process to FBR. | §12.1(c) |
| C6 | Input tax and output tax currently net together inside the single asset account described in C1. Please confirm the correct input-tax recoverability treatment given this. | §12.1(a) |

### D. Rounding, precision and reconciliation

| # | Question | Evidence |
|---|---|---|
| D1 | Sales, sale returns, and purchases are all rounded to the nearest whole rupee (no paisa). Please confirm this is the intended policy going forward. | §14.2 |
| D2 | The tax calculation itself contains three levels of nested rounding. Please confirm this is acceptable, and — separately — agree a reconciliation tolerance the migration can be measured against (an exact-to-the-paisa match may not be achievable given the nested rounding). | §14.2 |
| D3 | Stock adjustments, goods issues, and receipts are also hard-rounded to whole rupees. Please confirm. | §14.2 |
| D4 | The ledger stores monetary values as `numeric(15,2)` — please confirm this has sufficient headroom, and note that the FBR-fee column is capped at `numeric(5,2)` (a maximum of PKR 999.99), which may need widening. | §14.1 |
| D5 | There is currently no reconciliation between the "outstanding amount" recorded on each sale invoice and the customer's balance in the general ledger — the two can silently diverge, and nothing checks. Please agree the reconciliation procedure the new system should run. | §6.1 |

### E. Controls, audit and period-close

| # | Question | Evidence |
|---|---|---|
| E1 | Today, amending a posted invoice deletes its general-ledger entries and silently re-derives new ones — there is no reversing-entry trail. Please confirm this is unacceptable going forward, and agree the reversing-entry policy the new system should enforce instead. | §9.3 |
| E2 | There is currently no accounting-period concept, no period-close procedure, and no lock preventing a past period from changing. Please define the period model and close checklist the new system should implement. | §9.1 |
| E3 | There is no year-end retained-earnings roll-forward today. Please define one. | §9.1 |
| E4 | Today, any user can change the account bindings that determine where automatic postings go, with no audit trail. Please confirm who should be permitted to do this in the new system, and what approval/audit trail should be required. | §2.6 |
| E5 | The current system has a single administrative switch that, if enabled, silently deletes the **entire** general ledger and rebuilds it from source documents. Please confirm this must not exist in the new system. | §3.5 |
| E6 | Please specify the audit columns the new ledger must carry (created-by, modified-by, reversed-by, timestamps) — the current ledger has none of these. | §13.4 |
| E7 | Please confirm the ageing policy: the current system settles amounts oldest-first by document date (not due date), in buckets of 0 / 1–30 / 31–60 / 61–90 / 91–120 / 121–150 / 151–180 / 180+ days, and ignores invoice-level allocation. | §6.3, §6.4 |
| E8 | Discounts are currently absorbed directly into revenue — the dedicated "Discount Received/Allowed" account has never been posted to. Should discounts be shown as a separate line in the new system's reporting? | §15.3 |
| E9 | Please confirm single-currency (PKR) operation is correct and multi-currency support is not required. | §11 |

---

## PART 2 — For the tax adviser

### T1. Which FBR regime legally applies

The software supports two Federal Board of Revenue integration modes: **POS fiscalization** (currently live — every invoice is fiscalized and carries the Re. 1 fee described in C4) and **"Digital Invoicing"** (built into the software but never switched on or used). The owner's stated understanding is that POS fiscalization is the correct regime, and has asked that the new system support **both**, selectable by an administrator, with POS fiscalization as the default. **Please confirm in writing which regime this pharmacy is legally required to operate under**, since only one can be lawful for a given business at a given time even though the system will technically support either.

*Evidence: `11-integrations-dependencies.md` §2, §12.*

### T2. Zero invoice-level sales tax on every invoice

No sale invoice in the system — across all 291,361 invoices over 19 months — carries any invoice-level sales tax (`SalesTax = 0` on every row, confirmed by direct query). Purchases, by contrast, do carry input tax. **Please confirm whether zero output sales tax on every sale is correct for this pharmacy's registration status**, or whether tax is being under-declared.

*Evidence: `07-accounting-logic.md` §12.2 — `SELECT COUNT(*) FROM SaleLedger WHERE ISNULL(SalesTax,0) <> 0` returns 0.*

### T3. Unfiscalized sale returns and invoices — disclosure, not a rebuild question

This is not something the rebuild caused or can fix retroactively — the owner should simply be made aware, and you should advise whether any correction or retrospective filing is needed:

- **19,642 sale returns from 2025 were never sent to FBR for fiscalization.**
- **439 sale invoices were never fiscalized at all.**

*Evidence: `11-integrations-dependencies.md` §12, item 3 (verified by direct count).*

### T4. The FBR POS fee — see item C4 above

Please coordinate with the accountant on C4 (Part 1) — the Re. 1.00 per-invoice fee's correct classification and remittance process needs both a tax and an accounting ruling.

### T5. Output GST inside an asset account — see items C1, C2, C6 above

Please coordinate with the accountant on C1, C2, and C6 — the classification of output GST directly affects the FBR filing position, not just the books.

---

## Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Accountant | | | |
| Tax adviser | | | |

Please return this document (or a marked-up copy) with answers referenced by item ID. Answers will be filed into `14-unknowns-and-questions.md` (the master unknowns register) and `00b-owner-decisions-and-requirements.md` (binding decisions), both of which override any inference the analysis team drew from the code or schema alone.

---

*Companion documents, for reference only — not required reading to complete this packet: `06a-data-profile-reconciliation-baseline.md` (the underlying data profile), `07-accounting-logic.md` (full accounting analysis, source of Part 1), `11-integrations-dependencies.md` (source of Part 2's FBR findings), `12-risks-gaps.md` (the full risk register).*
