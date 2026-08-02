# 07 — Accounting Logic: The General Ledger Engine

| Field | Value |
|---|---|
| **Document title** | Accounting Logic — Complete GL Posting Engine, Chart of Accounts, Receivables/Payables, Period Handling and Financial Reporting |
| **System under analysis** | WASEELA ABUZAR V3 (vendor "Abuzar"/"Waseela"), deployment **Fazal Din PP19** — retail pharmacy |
| **Platform** | Compiled PowerBuilder 12.5 32-bit desktop client (`abuzar.exe` + 122 `.pbd`) on Microsoft SQL Server 2019 Express, DB `FazalDinPP19DataBaseV2`, compat level 100 |
| **Analysis stage** | Stage 3 — Deep domain analysis (accounting domain) |
| **Analysis date** | 2026-08-01 |
| **Authority note** | **There is no application source code.** Zero `.pbl/.srw/.sru/.srd/.pbt` files exist. The authoritative business logic analysed here is the SQL Server programmable objects and schema. Anything computed only inside a compiled PowerBuilder DataWindow is *not* recoverable and is flagged as such. |

### Evidence sources used

| Source | What was used from it |
|---|---|
| `scratchpad/db_modules_full.sql` (2.48 MB, 762 objects: 643 procs, 74 functions, 34 views, 10 triggers) | **Primary evidence.** Full source of every posting procedure, balance function and report procedure. All line-number citations in this document refer to this file. |
| Live DB `FazalDinPP19DataBaseV2` (read-only `SELECT` only) | Chart-of-accounts contents, `Global` GT_ mappings, `SoftwarePreferences` values, real `VirtualGl` postings, row counts, balance verification |
| `scratchpad/table_columns.tsv` / `INFORMATION_SCHEMA` | `numeric(p,s)` precision of every monetary column |
| `scratchpad/table_rowcounts.tsv` | Used-vs-dormant determination |
| `E:/Pharma Software/ABUZAR_V2_RECOVERY_JOURNAL.md` | Environment ground truth |

### Evidence-label legend

Every material claim below carries exactly one label:

| Label | Meaning |
|---|---|
| **Verified** | Read directly in procedure source, schema, or live data. Reproducible. |
| **Strongly Inferred** | Multiple converging pieces of evidence, no direct single statement. |
| **Unclear** | Evidence is ambiguous or the logic lives in the unrecoverable compiled UI. |
| **Missing** | The capability does not exist anywhere in the database. |
| **Deprecated** | Exists but superseded by a newer object. |
| **Broken/Incomplete** | Exists but demonstrably does not do what its name/comment claims. |
| **Recommended** | A proposal for the NEW system. **Never an existing feature.** |

> **Rule applied throughout:** existing behaviour and proposed behaviour are kept rigorously separate. No recommendation is presented as an existing feature. Where a debit/credit rule could not be traced with certainty it is marked **Unclear** and added to the accountant-validation checklist rather than guessed.

---

## 1. Headline conclusion

**Verified.** The system contains a genuine, complete, product-grade double-entry accounting engine covering 20+ document types (sales, purchases, both returns, services, goods issue/receipt, stock adjustment, manual vouchers, notes receivable/payable, payroll, cashier shift reconciliation, patient/guest billing, sale orders, products). The engine is architecturally unusual but internally sound: **the GL is not written at transaction time — it is a lazily materialised projection** rebuilt on demand from the source documents by `dbo.SP_VirtualGL`.

**However, at this deployment only 4 of those 20+ document types have ever posted.** `VirtualGl` contains exactly `SV`, `SR`, `PV`, `PR` (sale, sale return, purchase, purchase return) and nothing else. Every settlement subsystem is empty: `GLHeader = 0`, `GLDetail = 0`, `ReceiptHeader = 0`, `IssueHeader = 0`, `Notes = 0`, `TransactionHeader = 0`, `EMP_Payroll = 0`, `CashierShift = 0`, `SummaryAccount = 0`. The consequence is that **the ledger records the origination of every economic event but never its settlement**: the cash account carries a PKR 214.3 M debit balance that has never been relieved, and PKR ~190 M of supplier credits have never been paid down in the books. Additionally, **cost of goods sold is never posted at all** (periodic inventory mode gates it off), and **all 1,542 stock adjustments are silently excluded from the GL** by a `WHERE AccCode IS NOT NULL` filter that no row satisfies.

The practical reading for the business owner: *the software's accounting module is capable, but at Fazal Din PP19 it has been used as an invoice/inventory system, not as a book of account.* The GL as it stands supports sales analysis, supplier-balance tracking and tax reporting — it does **not** support a trustworthy balance sheet, cash position, or profit figure without substantial reconstruction.

---

## 2. Chart of accounts

### 2.1 Structure — four levels, not three

**Verified.** The COA is a fixed **four-level** hierarchy. (The brief anticipated three levels; the live schema shows a `CategoryAccounts` tier between Main and Sub.)

```
MainAccounts (5)          MainAccCode, Name
   └── CategoryAccounts (13)   CatAccCode, MainAccCode, Name
          └── SubAccounts (29)     SubAccCode, CatAccCode, Name
                 └── Accounts (267)    AccCode, SubCode, Name, OpeningDate,
                                       AliasName, Active, Restricted,
                                       BalanceLimit numeric(15,2), Remarks,
                                       AlertCode, LocalAccountName
```

`Evidence: live query on MainAccounts / CategoryAccounts / SubAccounts / Accounts; Accounts column list from INFORMATION_SCHEMA.COLUMNS.`

> **Correction to prior findings.** Earlier analysis recorded `Accounts = 264`. The live count is **267** (all with `Active = 'Y'`). The live database is authoritative.

### 2.2 Level 1 — MainAccounts (5 rows, Verified)

| MainAccCode | Name |
|---|---|
| 1 | ASSETS |
| 2 | LIABILITIES |
| 3 | EQUITY/CAPITAL |
| 4 | REVENUES |
| 5 | EXPENSES |

### 2.3 Level 2 — CategoryAccounts (13 rows, Verified)

| CatAccCode | MainAccCode | Name | Note |
|---|---|---|---|
| 0 | 1 | FIXED ASSETS1 | Duplicate/legacy of code 2 — **Deprecated** |
| 1 | 1 | CURRENT ASSETS | `GT_CurrentAssetsCat` |
| 2 | 1 | FIXED ASSETS | `GT_FixedAssetsCat` |
| 3 | 1 | DEFFERED COST | `GT_DefferedCostsCat` (sic) |
| 4 | 2 | CURRENT LIABILITIES | `GT_CurrentLiabilitiesCat` |
| 5 | 2 | LONG TERM LIABILITIES | `GT_LongtermLiabilitiesCat` |
| 6 | 3 | EQUITY/CAPITAL | `GT_CapitalAccountsCat` |
| 7 | 4 | REVENUE FROM SALES | `GT_RevenueFromSalesCat` |
| 8 | 4 | OTHER REVENUES | `GT_OtherRevenuesCat` |
| 9 | 5 | DIRECT EXPENSES | `GT_DirectExpensesCat` |
| 10 | 5 | OPERATING EXPENSES | `GT_OperatingExpensesCat` |
| 11 | 5 | OTHER EXPENSES | `GT_OtherExpensesCat` |
| 12 | 1 | TEST | Junk row — **Deprecated** |

> **Note.** `CategoryAccounts` here is the COA category tier. It is **not** the same concept as `ReceiptCategoryAccounts` / `IssueCategoryAccounts`, which map document *categories* to default posting accounts.

### 2.4 Level 3 — SubAccounts (29 rows, Verified)

Sorted by parent category. `Accounts` column = number of leaf accounts actually attached.

| SubAccCode | CatAccCode | Name | # Leaf accounts |
|---|---|---|---|
| 1 | 9 | PURCHASES | 1 |
| 2 | 1 | CASH IN HAND | 1 |
| 3 | 1 | CUSTOMERS/DEBITORS | 2 |
| 4 | 1 | CASH AT BANK | **0** |
| 5 | 1 | SALES TAX RECEIVEABLES | 1 |
| 6 | 1 | SUSPENSE | 1 |
| 7 | 4 | SUPPLIERS/CREDITORS | **235** |
| 8 | 1 | INVENTORY | 2 |
| 9 | 6 | EQUITY/CAPITAL | 1 |
| 10 | 7 | SALES | 2 |
| 11 | 7 | SALES RETURNS | 1 |
| 12 | 9 | COST OF SALES | 2 |
| 13 | 8 | OTHER REVENUE/LOSS | 3 |
| 14 | 9 | PURCHASES RETURNS | 1 |
| 15 | 10 | MARKETING EXPENSES | **0** |
| 16 | 10 | ADMINSTRATIVE EXPENSES (sic) | 1 |
| 18 | 8 | STOCK ADJUSTMENT INCREASE | **0** |
| 19 | 11 | STOCK ADJUSTMENT DECREASE | **0** |
| 20 | 9 | PAYROLL - WAGES | **0** |
| 21 | 10 | PAYROLL - SALARIES | **0** |
| 22 | 10 | PAYROLL - ADMINISTRATIVE SALARIES | **0** |
| 23 | 1 | ADVANCES TO EMPLOYEES | **0** |
| 24 | 4 | PAYROLL DEDUCTIONS | **0** |
| 25 | 4 | EXPENSES PAYABLE A/C | 3 |
| 27 | 4 | TAXES PAYABLE A/C | 4 |
| 28 | 1 | TAXES RECEIVABLE A/C. | 2 |
| 30 | 1 | GOODS ISSUED/RECEIPT A/C. | 2 |
| 31 | 1 | RAW MATERIALS INVENTORY A/C. | 1 |
| 32 | 1 | WORK IN PROCESS INVENTORY A/C. | 1 |

**Verified.** `SubAccCode` 17, 26 and 29 do not exist — gaps in the seed data. **9 of 29 sub-accounts have zero leaf accounts** (bank, marketing, all payroll sub-accounts, both stock-adjustment sub-accounts, employee advances). These are shipped-but-unconfigured at this deployment; the product supports them.

### 2.5 Level 4 — the control accounts (Verified)

Accounts 1–42 are the system-reserved control accounts. Accounts 46–316 are almost entirely trade suppliers (**234 of them under SUPPLIERS/CREDITORS**).

| AccCode | Name | SubAccount | Main | Bound to Global key |
|---|---|---|---|---|
| 1 | PURCHASE ACCOUNT | PURCHASES | EXPENSES | `GT_PurchaseAccount` |
| 2 | CASH FROM SALE (DEFAULT) | CASH IN HAND | ASSETS | `GT_CashACC` |
| 3 | SALES TAX RECEIVEABLES ACCOUNT | SALES TAX RECEIVEABLES | ASSETS | `GT_AdvanceSalesTaxACC` |
| 4 | PURCHASE EXPENSE PAYABLE A/C | EXPENSES PAYABLE | LIABILITIES | `GT_PurExpPayableAcc` |
| 5 | CAPITAL ACCOUNT | EQUITY/CAPITAL | EQUITY | `GT_EquityACC` |
| 6 | SALES ACCOUNT | SALES | REVENUES | `GT_SalesACC` |
| 7 | INVENTORY ACCOUNT | INVENTORY | ASSETS | `GT_InventoryAcc` |
| 8 | SALES RETURN ACCOUNT | SALES RETURNS | REVENUES | `GT_SalesReturnACC` |
| 9 | COST OF GOODS SOLD ACCOUNT | COST OF SALES | EXPENSES | `GT_CostOfGoodsSoldAcc` |
| 12 | PURCHASES RETURNS ACCOUNT | PURCHASES RETURNS | EXPENSES | `GT_PurchaseReturnsAccount` |
| 18 | OPENING SUPPLIER | SUPPLIERS/CREDITORS | LIABILITIES | `GT_OpeningSupplierACC` |
| 19 | CASH SALES CUSTOMER | CUSTOMERS/DEBITORS | ASSETS | `GT_RetailSaleCustomerACC` |
| 22 | CREDIT SALES-WALKING CUSTOMER A/C | CUSTOMERS/DEBITORS | ASSETS | `GT_WholeSaleCustomerACC` |
| 23 | REVENUE FROM SERVICES A/C | OTHER REVENUE/LOSS | REVENUES | `GT_RevenueFromServices` |
| 24 | EXPENSES ON SERVICES A/C | ADMINSTRATIVE EXPENSES | EXPENSES | `GT_ExpensesOnServices` |
| 25 | DISCOUNT RECEIVED/ALLOWED ACCOUNT | OTHER REVENUE/LOSS | REVENUES | `GT_DiscountRecAllowedAcc` |
| 26 | PAYROLL PAYABLE ACCOUNT. | EXPENSES PAYABLE | LIABILITIES | `GT_PayrollPayableAcc` |
| 27 | SALES TAX PAYABLE ON SERVICES A/C | TAXES PAYABLE | LIABILITIES | `GT_SalesTaxPayableOnServices` |
| 28 | WITHHOLDING INCOME TAX LIABILITY A/C | TAXES PAYABLE | LIABILITIES | `GT_WithHoldingTaxPayable` |
| 29 | WITHHOLDING INCOME TAX RECEIVABLE A/C. | TAXES RECEIVABLE | ASSETS | `GT_WithHoldingTaxReceivable` |
| 30 | GOODS ISSUED A/C. | GOODS ISSUED/RECEIPT | ASSETS | `GT_GoodsIssuedAcc` |
| 31 | GOODS RECEIPT A/C. | GOODS ISSUED/RECEIPT | ASSETS | `GT_GoodsReceiptAcc` |
| 32 | RAW MATERIALS INVENTORY A/C. | RAW MATERIALS INV | ASSETS | `GT_RawMaterialsAcc` |
| 33 | WORK IN PROCESS INVENTORY A/C. | WIP INV | ASSETS | `GT_WIPAcc` |
| 34 | RECEIPT EXPENSES PAYABLE A/C. | EXPENSES PAYABLE | LIABILITIES | `GT_ReceiptExpPayableAcc` |
| 35 | ADVANCE INCOME TAX ON PURCHASE A/C. | TAXES RECEIVABLE | ASSETS | `GT_AdvIncomeTaxPur` |
| 36 | ADVANCE INCOME TAX ON SALE A/C. | TAXES PAYABLE | LIABILITIES | `GT_AdvIncomeTaxSale` |
| 37 | FBR POS SERVICE FEE PAYABLE A/C. | TAXES PAYABLE | LIABILITIES | `GT_FBRPOSFeeAcc` |
| 38 | PRODUCTS INVENTORY A/C. | INVENTORY | ASSETS | `GT_ProductInvAcc` |
| 39 | PRODUCTS SALES A/C. | SALES | REVENUES | `GT_ProductSalesAcc` |
| 40 | OTHER REVENUES FROM PRODUCTS A/C. | OTHER REVENUE/LOSS | REVENUES | `GT_OtheRevFrmProductsAcc` |
| 41 | COST OF PRODUCTS SALES A/C. | COST OF SALES | EXPENSES | `GT_CostOfProductsSaleAcc` |
| 42 | CASHIER CASH DIFFERENCE (SUSPENSE ACCOUNT) | SUSPENSE | ASSETS | `GT_CashierCashDiffSuspAcc` |

> **Classification anomalies to flag to an accountant.** Account 8 SALES RETURN and account 12 PURCHASES RETURNS are both contra accounts filed under the *positive* parent (`SALES RETURNS` → REVENUE FROM SALES; `PURCHASES RETURNS` → DIRECT EXPENSES). Their natural balances are therefore inverted relative to their parent category (sales returns carries a debit balance inside a revenue category; purchase returns carries a credit balance inside an expense category). Any report that naively sums a category will net these correctly **only if** it uses `SUM(Debit - Credit)` consistently — which `sp_IncomeStatement` does. **Verified**, but see §12 for the sign-convention concern.

### 2.6 The `Global` table — the account-binding indirection layer

**Verified.** No account code is hard-coded in the posting procedures. Every one is resolved at runtime from `dbo.Global` by a symbolic name, e.g.:

```sql
SET @ln_salesacc = (SELECT code FROM global WHERE name = 'GT_SalesACC')
```
`Evidence: db_modules_full.sql:59674 (SP_VirtualGL_Sales); the same pattern appears in all 20 posting procs.`

There are **81** `GT_*` bindings. This is the single most important extension point in the accounting design: re-pointing a `Global` row silently re-routes every future posting for that concept. It is also a risk — there is no constraint, audit trail, or validation on `Global`.

Complete binding table (**Verified**, live query):

| Global key | → AccCode/SubCode/CatCode | Global key | → code |
|---|---|---|---|
| GT_AdministrativeExpenseSub | 16 | GT_OpeningSupplierACC | 18 |
| GT_AdvanceSalesTaxACC | 3 | GT_OperatingExpensesCat | 10 |
| GT_AdvanceSlesTaxSub | 5 | GT_OtheRevFrmProductsAcc | 40 |
| GT_AdvanceToEmployees | 23 | GT_OtherExpensesCat | 11 |
| GT_AdvIncomeTaxPur | 35 | GT_OtherRevenuesCat | 8 |
| GT_AdvIncomeTaxSale | 36 | GT_OtherRevenueSub | 13 |
| GT_AssetMain | 1 | GT_PayrollAdminSalaries | 22 |
| GT_BankSub | 4 | GT_PayrollDeductions | 24 |
| GT_CapitalAccountsCat | 6 | GT_PayrollPayableAcc | 26 |
| GT_CashACC | 2 | GT_PayrollSalaries | 21 |
| GT_CashierCashDiffSuspAcc | 42 | GT_PayrollWages | 20 |
| GT_CashSub | 2 | GT_ProductInvAcc | 38 |
| GT_CostOfGoodsSoldAcc | 9 | GT_ProductSalesAcc | 39 |
| GT_CostOfProductsSaleAcc | 41 | GT_PurchaseAccount | 1 |
| GT_CostOFSalesSub | 12 | GT_PurchaseReturnsAccount | 12 |
| GT_CreditorsSub | 7 | GT_PurchaseReturnsSubAccount | 14 |
| GT_CurrentAssetsCat | 1 | GT_PurchaseSubAccount | 1 |
| GT_CurrentLiabilitiesCat | 4 | GT_PurExpPayableAcc | 4 |
| GT_DebitorsSub | 3 | GT_RawMaterialsAcc | 32 |
| GT_DefferedCostsCat | 3 | GT_RawMaterialsSub | 31 |
| GT_DirectExpensesCat | 9 | GT_ReceiptExpPayableAcc | 34 |
| GT_DiscountRecAllowedAcc | 25 | GT_RetailSaleCustomerACC | 19 |
| GT_EquityACC | 5 | GT_RevenueFromSalesCat | 7 |
| GT_EquityMain | 3 | GT_RevenueFromServices | 23 |
| GT_EquitySub | 9 | GT_RevenueMain | 4 |
| GT_ExpenseMain | 5 | GT_SalesACC | 6 |
| GT_ExpensesOnServices | 24 | GT_SalesReturnACC | 8 |
| GT_ExpPayableSubAcc | 25 | GT_SalesReturnSub | 11 |
| GT_FBRPOSFeeAcc | 37 | GT_SalesSub | 10 |
| GT_FixedAssetsCat | 2 | GT_SalesTaxPayableOnServices | 27 |
| GT_GoodsIssuedAcc | 30 | GT_StockAdjDecrease | 19 |
| GT_GoodsIssuedReceiptSub | 30 | GT_StockAdjIncrease | 18 |
| GT_GoodsReceiptAcc | 31 | GT_Store | 1 |
| GT_InventoryAcc | 7 | GT_SuspenseSub | 6 |
| GT_InventorySub | 8 | GT_TaxesPayable | 27 |
| GT_LiabilityMain | 2 | GT_TaxesReceivable | 28 |
| GT_LongtermLiabilitiesCat | 5 | GT_WholeSaleCustomerACC | 22 |
| GT_MarketingExpenseSub | 15 | GT_WIPAcc | 33 |
| GT_WithHoldingTaxPayable | 28 | GT_WIPSub | 32 |
| GT_WithHoldingTaxReceivable | 29 | | |

### 2.7 Supporting COA tables

| Table | Rows (live) | Purpose | Status |
|---|---|---|---|
| `SummaryAccount` / `SummaryAccountDetail` | **0** | Group several `AccCode`s so balance functions return a combined figure. Resolved by `udf_GetSummaryAccountList` (`db_modules_full.sql:64276-64303`). | **Verified** feature, **unused** here |
| `GroupSummaryAccount` | 0 | Grouping layer above summary accounts | Unused |
| `AccountGodown` | **0** | Restrict an account to a warehouse | Unused (single `Godown`) |
| `CashAccAllowedModule` | 22 | Whitelist of ModuleIDs allowed to select a cash account (10,11,14,22,23,25–38,42,43,44) | **Verified**, in use |
| `CategoryAccounts` | 13 | COA level-2 (see §2.3) | In use |
| `ReceiptCategoryAccounts` / `IssueCategoryAccounts` | 0 | Default Dr/Cr accounts per receipt/issue category | Unused (no receipts/issues) |
| `AgingInterval` / `AgingIntervalDetail` | 1 / 8 | One profile "DEFAULT" with buckets at 0, 1, 31, 61, 91, 121, 151, 181 days | **Verified**, configured but no receivables to age |
| `Currency` | 1 | `PAKISTANI RUPEE`, `RS.`, `ConversionFactor 1.00000` | See §11 |
| `CurrencyDenomination` | 1 | `Rs. 1`, type `C` | Cash-counting aid, effectively unused |

---

## 3. The posting engine — architecture

### 3.1 Deferred materialisation, not transactional posting

**Verified — this is the single most important architectural fact in the accounting domain.**

Every `sp_Post*` procedure in the system **only flips a flag**. None of them writes a ledger entry. Machine-verified across all 12 posting procedures:

| Procedure | Lines in body | `INSERT INTO VirtualGL` | Sets `Posted='Y'` | Tables updated |
|---|---|---|---|---|
| `sp_PostSaleLedger` | 343 | **0** | yes | `SaleLedger` |
| `sp_PostSaleLedgerHeaderWise` | 147 | **0** | yes ×3 | `SaleLedger` |
| `SP_PostSaleLedgerAreaWise` | 152 | **0** | yes ×3 | `SaleLedger` |
| `sp_PostSRLedger` | 21 | **0** | yes | `SRLedger` |
| `sp_PostPRLedger` | 14 | **0** | yes | `PRLedger` |
| `sp_PostAdjLedger` | 14 | **0** | yes | `AdjHeader` |
| `sp_PostStockAdjustment` | 330 | **0** | yes ×2 | `AdjBufferHeader` |
| `sp_PostIssueReq` | 9 | **0** | yes | `IssueReqHeader` |
| `sp_PostTransferHeader` | 3 | **0** | yes | `THeader` |
| `sp_PostBillSummary` | 121 | **0** | yes | `BillSummary` |
| `sp_PostInstallment` | 182 | **0** | yes | `Installment`, `InstallmentHeader` |
| `sp_PostPurOrder` | 61 | **0** | yes | `PurOrderHeader`, `Transit` |
| `sp_PostPayroll` | 129 | **0** | yes | `EMP_Payroll`, `EMP_Advance` |
| `sp_PostGeneralLedger` | 52 | **0** | yes | `GLHeader` (+ triggers SMS) |
| `sp_PostNote` / `sp_PostNotes` | 18 / 37 | **0** | yes | `Notes` |

`Evidence: automated scan of every object body in db_modules_full.sql for INSERT INTO VirtualGL / VirtualGLTemp / GLHeader / GLDetail.`

The actual ledger is produced later by `dbo.SP_VirtualGL @ac_type` (`db_modules_full.sql:57754-57972`), which is invoked on demand — notably from `SP_OpeningBalance` and `SP_AbsoluteOpeningBalance`, i.e. **whenever anybody asks for an account balance**.

```sql
-- SP_OpeningBalance, db_modules_full.sql:40359-40371
BEGIN
    EXECUTE SP_VirtualGL 'A'
    SET @BAL = ISNULL(
        (SELECT ISNULL(SUM(DEBIT - CREDIT), 0)
         FROM VIRTUALGL
         WHERE AccCode IN (SELECT AccCode FROM udf_GetSummaryAccountList(@AccCode))
           AND DATE <= @DateTime), 0)
END
```

**Implication (Strongly Inferred):** reading a balance mutates the database. `SP_VirtualGL` takes `TABLOCKX` on `VirtualGL` (`db_modules_full.sql:57761`) and runs a multi-statement transaction. On a 1.02 M-row ledger this is a serialisation point and a latency spike on every balance enquiry.

### 3.2 The two-stage fan-out

**Verified.** Posting proceeds in two stages.

**Stage 1 — collect.** 13 of the 20 sub-procedures write *compressed* rows into the staging table `VirtualGLTemp`, one row per document carrying **both** sides plus tax and payment columns:

```
DocumentCode, DocumentType, CatCode,
dr_acccode, cr_acccode, AlternateAccCode, date,
Gross numeric(15,2), SaleTax numeric(15,2), CGS numeric(15,2),
AdvIncomeTax numeric(12,2), FBRPosFee numeric(5,2),
Amt numeric(15,2), DrAmtAccCode, CrAmtAccCode, AmtDate, AmtRef, AmtBy,
dr_remarks, cr_remarks, saletax_remarks, ...
```

**Stage 2 — fan out.** `SP_VirtualGL` explodes each staging row into up to **8 balanced GL rows** via a single `INSERT … SELECT … UNION ALL` (`db_modules_full.sql:57833-57969`), tagged with `VRow`:

| `VRow` | Leg | Source clause |
|---|---|---|
| 0 | Primary debit | line 57835-57852 |
| 1 | Primary credit | line 57854-57868 |
| 2 | Sales tax (Dr or Cr by doc type) | line 57870-57881 |
| 2 | Advance income tax | line 57883-57894 |
| 2 | FBR POS service fee | line 57896-57907 |
| 3 | Debit of amount paid/received at invoice time | line 57909-57924 |
| 4 | Credit of amount paid/received at invoice time | line 57926-57941 |
| 0 | CGS pair (perpetual mode only) | line 57943-57969 |

The remaining 7 sub-procedures (`Vouchers`, `Notes`, `Payroll`, `CashierShift`) bypass staging and `INSERT INTO VirtualGL` directly, because their debit/credit amounts are already explicit.

### 3.3 The amount-allocation formula — where net-vs-gross is decided

**Verified.** This CASE expression is the heart of the engine and the most consequential single piece of logic in the accounting domain:

```sql
-- SP_VirtualGL, db_modules_full.sql:57842-57849
Debit = CASE
    WHEN dr_AccCode IN (SELECT acccode FROM accounts WHERE acccode IN
         (@ln_invacc, @goodsacc, @goodsissueacc, @ln_purchaseacc, @ln_salesacc,
          @ln_salesretacc, @ln_purchaseretacc, @ln_revfromservice))
    THEN Gross - ISNULL(AdvIncomeTax, 0) - ISNULL(FBRPosFee, 0)
    ELSE ISNULL(Gross, 0) + ISNULL(SaleTax, 0)
END
```

Read plainly: **the trading/control account (inventory, purchase, sales, returns, service revenue) receives the amount NET of advance income tax and FBR POS fee; the counterparty (cash, customer, supplier) receives the amount GROSS plus sales tax.** The difference is absorbed by the dedicated tax rows at `VRow = 2`, so the entry balances.

**Empirically confirmed against live data:**

*Sale invoice 880233* (`VirtualGl` live query):

| VRow | AccCode | Account | AltAcc | Debit | Credit |
|---|---|---|---|---|---|
| 0 | 2 | CASH FROM SALE (DEFAULT) | 19 | 420.00 | 0.00 |
| 1 | 6 | SALES ACCOUNT | — | 0.00 | 419.00 |
| 2 | 37 | FBR POS SERVICE FEE PAYABLE | — | 0.00 | 1.00 |

Cash (not a control account) takes gross 420.00; Sales (a control account) takes 420.00 − 1.00 FBR fee = 419.00. Balanced. ✔

*Purchase invoice 6419*:

| VRow | AccCode | Account | Debit | Credit |
|---|---|---|---|---|
| 0 | 1 | PURCHASE ACCOUNT | 8,750.25 | 0.00 |
| 1 | 123 | HAKEEM BIN HAZZAM (supplier) | 0.00 | 8,794.00 |
| 2 | 35 | ADVANCE INCOME TAX ON PURCHASE | 43.75 | 0.00 |

Purchase (control) takes 8,794.00 − 43.75 = 8,750.25; supplier takes gross 8,794.00; withholding tax asset 43.75. Balanced. ✔

### 3.4 `AlternateAccCode` — the statistical customer dimension

**Verified.** For cash sales the customer is *not* the debit account — cash is. The customer code is carried in a shadow column:

```sql
-- SP_VirtualGL_Sales, db_modules_full.sql:59694-59695
AlternateAccCode = CASE S.saleCatCode WHEN 1 THEN S.custcode
                                      WHEN 3 THEN S.custcode ELSE Null END
```
and it survives fan-out only if the primary account is a cash account:
```sql
-- SP_VirtualGL, db_modules_full.sql:57840
AlternateAccCode = CASE WHEN dr_AccCode IN
    (SELECT AccCode FROM Accounts WHERE SubCode IN
        (SELECT Code FROM Global WHERE Name = 'GT_CashSub'))
    THEN AlternateAccCode ELSE NULL END
```

This is why account 19 (CASH SALES CUSTOMER) has **zero** GL rows despite 291,361 cash-sale invoices: it is a reporting dimension, never a posted balance. **Verified** by live query (`SELECT COUNT(*) FROM VirtualGl WHERE AccCode IN (19,22)` → 0).

### 3.5 Global kill-switch

**Verified.** `SP_VirtualGL` opens with:

```sql
-- db_modules_full.sql:57799-57804
IF @AutoPurgeVirtualGL = 'Y'
BEGIN
    TRUNCATE TABLE VirtualGL
    COMMIT TRANSACTION T1
    RETURN
END
```

Setting `SoftwarePreferences.AutoPurgeVirtualGL = 'Y'` **destroys the entire general ledger on the next balance enquiry**, with no confirmation and no backup. Current live value is `N`. This is the highest-severity latent defect found in this domain.

---

## 4. Posting rules — complete Dr/Cr table

All rules below are **Verified** by reading the `dr_acccode` / `cr_acccode` (or explicit `Debit`/`Credit`) assignments in the cited procedure. `@x` denotes a `Global`-resolved account (see §2.6).

### 4.1 Sales cycle

| Doc type | Trigger condition | DEBIT | CREDIT | Source proc (line) |
|---|---|---|---|---|
| **SV** Sale invoice | `SaleLedger.Posted='Y' AND AccountFor='Y'` and not already in GL | `SaleCatCode` 1 or 3 → `SaleLedger.CashAccCode`; else → `SaleLedger.CustCode` | `@GT_SalesACC` (6) | `SP_VirtualGL_Sales` (59691-59693) |
| SV — receivable adj. | row in `SaleReceivableAdj` | `D.Debit>0` → `D.AccCode`, else `S.CustCode` | `D.Debit>0` → `S.CustCode`, else `D.AccCode` | same (59828-59829) |
| SV — cash via master window | `SaleCatCode NOT IN (1,3) AND CashCharged>0` | `S.CashAccCode` | `S.CustCode` | same (59850-59851) |
| SV — cashier window split | row in `CashierWindow` | `D.AccCode` | `S.CustCode` | same (59873-59874) |
| **SR** Sale return | `SRLedger.Posted='Y' AND AccountFor='Y'` | `@GT_SalesReturnACC` (8) | `SRCatCode` 6 or 8 → `CashAccCode`; else `CustCode` | `SP_VirtualGL_SalesReturn` (59927-59929) |
| SR — cash refund via window | `SRCatCode NOT IN (6,8) AND CashCharged>0` | `S.CustCode` | `S.CashAccCode` | same (59995-59996) |
| **SO** Sale order advance | `SaleOrderHeader.Posted='Y'` | `S.PaymentAccCode` | `S.CustCode` | `SP_VirtualGL_SaleOrder` (59637) |

### 4.2 Purchase cycle

| Doc type | Trigger condition | DEBIT | CREDIT | Source proc (line) |
|---|---|---|---|---|
| **PV** Purchase | `PurLedger.Posted='Y' AND AccountFor='Y'` | `@InvSys='P'` → `@GT_PurchaseAccount` (1); else `@GT_InventoryAcc` (7) | `PurCatCode=3` (Opening) → `@GT_EquityACC` (5); else `CustCode>0 ? CustCode : SuppCode` | `SP_VirtualGL_Purchase` (59301-59303) |
| PV — purchase expense | row in `PurExp`, `Amount>0` | `PE.AccCode` | `@GT_PurExpPayableAcc` (4) | same (59431-59432) |
| PV — qty expenses QE1–QE5 | `PurDetail.QEn <> 0` | `P.QEn_AccCode` | `P.QExpn_CrAccCode` | same (59452-59545) |
| PV — weight expenses WE1–WEn | `PurDetail.WEn <> 0` | `P.WEn_AccCode` | `P.WExpn_CrAccCode` | same (59567+) |
| **PR** Purchase return | `PRLedger.Posted='Y' AND AccountFor='Y'` | `PRCatCode=6` (Opening) → `@GT_EquityACC`; else `CustCode>0 ? CustCode : SuppCode` | `@InvSys='P'` → `@GT_PurchaseReturnsAccount` (12); else `@GT_InventoryAcc` | `SP_VirtualGL_PurchaseReturn` (59127-59129) |

**Empirically confirmed:** PR doc 2122 → Dr 107 DIAMOND (GS PHARMA) 6,408.00 / Cr 12 PURCHASES RETURNS 6,408.00. ✔

### 4.3 Inventory movement

| Doc type | Trigger | DEBIT | CREDIT | Source proc (line) |
|---|---|---|---|---|
| **AI** Stock adjustment increase | `AdjHeader.Posted='Y' AND AdjCatCode=1` **AND `AccCode IS NOT NULL`** | `@GT_InventoryAcc` (7) | `AdjHeader.AccCode` | `SP_VirtualGL_Adjustment` (58002-58003) |
| **AD** Stock adjustment decrease | as above, `AdjCatCode=2` | `AdjHeader.AccCode` | `@GT_InventoryAcc` (7) | same |
| **ISU** Goods issue | `IssueHeader.Posted='Y' AND AccountFor='Y' AND DrAccCode IS NOT NULL` | `IssueHeader.DrAccCode` | `@InvSys<>'P'` → `@GT_InventoryAcc`; else `@GT_GoodsIssuedAcc` (30) | `SP_VirtualGL_Issue` (58227-58228) |
| **RCT** Goods receipt | `ReceiptHeader.Posted='Y' AND AccountFor='Y' AND CrAccCode IS NOT NULL` | `@InvSys<>'P'` → `@GT_InventoryAcc`; else `@GT_GoodsReceiptAcc` (31) | `ReceiptHeader.CrAccCode` | `SP_VirtualGL_Receipt` (59938-59939) |
| RCT — qty/weight expenses | `ReceiptDetail.QEn/WEn <> 0` | `A.QEn_AccCode` / `A.WEn_AccCode` | `A.QExpn_CrAccCode` / `A.WExpn_CrAccCode` | same (59963+) |
| **CGS pair** (perpetual only) | `@InvSys <> 'P'` AND doc in (SV,SR) AND `CGS<>0` | SV → `@GT_CostOfGoodsSoldAcc` (9); SR → `@GT_InventoryAcc` | SV → `@GT_InventoryAcc`; SR → `@GT_CostOfGoodsSoldAcc` | `SP_VirtualGL` (57947, 57961) |

> **Critical:** `InventorySystemUsed = 'P'` (periodic) at this deployment, so **the CGS pair never fires**. See §14.2.

### 4.4 Manual vouchers, notes and transfers

| Doc type | Trigger | DEBIT | CREDIT | Source proc (line) |
|---|---|---|---|---|
| **CP/CR/BP/BR/JV/OPC/OPB/OPR/OPP/OPOR/OPOP/CRS/BRS/JVS/CPP/BPP/JVP/JVD/DNV/CNV/DNS/CNS** (22 categories) | `GLHeader.Posted='Y'` | `GLDetail.AccCode` where `GLDetail.debit > 0` | `GLDetail.AccCode` where `GLDetail.credit > 0` | `SP_VirtualGL_Vouchers` (60409-60413) |
| **NR** Note receivable | `Notes.Posted='Y'` `NoteCatCode=1` | `Notes.BankAccCode` | `Notes.AccCode` | `SP_VirtualGL_Notes` (58282-58302) |
| **NP** Note payable | `Notes.Posted='Y'` `NoteCatCode=2` | `Notes.AccCode` | `Notes.BankAccCode` | same |
| **Transaction window (receipt)** | `TransactionHeader.Posted='Y'`, `TransactionCatCode=1`, `CashCharged>0` | `TH.CashAccCode` | `TH.AccCode` | `SP_VirtualGL_TransactionWindow` (60277-60278) |
| Transaction window (receipt, detail) | as above, `TD.Amount>0` | `TD.AccCode` | `TH.AccCode` | same (60301-60302) |
| **Transaction window (payment)** | `TransactionCatCode=2`, `CashCharged>0` | `TH.AccCode` | `TH.CashAccCode` | same (60328-60329) |
| Transaction window (payment, detail) | as above, `TD.Amount>0` | `TH.AccCode` | `TD.AccCode` | same (60352-60353) |

Manual vouchers are the only mechanism where the user supplies both sides explicitly. `VocherCategory.HeaderTreatment`/`DetailTreatment` (`'C'`/`'D'`) drive which side the UI puts the header account on — e.g. CASH PAYMENT = header Credit / detail Debit. **Verified** from live `VocherCategory` contents; the actual enforcement lives in the compiled UI (**Unclear**).

### 4.5 Payroll

**Verified.** `SP_VirtualGL_Payroll` (`db_modules_full.sql:58419-58547`) writes directly to `VirtualGL` in five legs:

| Leg | Doc type | Account | Amount |
|---|---|---|---|
| Gross earnings | `PAY` | Dr `EMP_Employee.AccCode` | `BasicPay + overtime + bonuspay + specialpay + additionalpay + otherpay − fine − penalty − othercharge` (+…) |
| Advance recovery | `PAY` | Cr `EMP_Employee.AdvAccCode` | `EP.Advance` (only if `> 0`) |
| Statutory deductions | `PAY` | Cr `Accounts.AccCode` matched to `EMP_PayrollDeductions.DeductionCode` | `ROUND((BasicPay × Percentage × 0.01) + FlatAmount, 2)` |
| Net payable | `PAY` | Cr `@GT_PayrollPayableAcc` (26) | `EP.NetPayable` |
| Payment | `PAYD` | Dr `@GT_PayrollPayableAcc` (26) / Cr `EMP_Payroll.PaidVia` | `EP.NetPayable` |

Gated on `Posted='Y'` for `PAY` and `Posted='Y' AND Paid='Y'` for `PAYD`. Booking date controlled by preference `bookingdateinpayroll` (live value `P` = post date).

### 4.6 Cashier shift reconciliation

**Verified.** `SP_VirtualGL_CashierShift` (`db_modules_full.sql:58027-58145`), doc type `CSHIFT`, fires on `ShiftStatus='C'` (closed):

| Scenario | DEBIT | CREDIT | Amount |
|---|---|---|---|
| Cash handover | `CashierShift.AmtTransferedTo` | `CashierShift.CashAccCode` | `AmtTransfered` |
| Excess cash (`DiffAmt > 0`) | `CashAccCode` | `DiffTransferedTo` | `ABS(DiffAmt)` |
| Short cash (`DiffAmt < 0`) | `DiffTransferedTo` | `CashAccCode` | `ABS(DiffAmt)` |

`DiffTransferedTo` is intended to be account 42 CASHIER CASH DIFFERENCE (SUSPENSE) — but the account is *not* forced; it is whatever the shift record carries. **Unclear** whether the UI constrains it.

### 4.7 Services, products, patient/guest (dormant verticals)

| Doc type | Meaning | DEBIT | CREDIT | Proc (line) |
|---|---|---|---|---|
| **RS** Service sale | service invoice | `h.custcode` | `@GT_RevenueFromServices` (23) | `SP_VirtualGL_Services` (60075-60076) |
| RS — cash received | | `S.CashAccCode` | `S.CustCode` | same (60121-60122) |
| **RR** Service return | | `@GT_RevenueFromServices` | `h.custcode` | same (60167-60168) |
| RR — cash refund | | `S.CustCode` | `S.CashAccCode` | same (60210-60211) |
| **SP** Purchase of service | | `h.ExpAccCode` | `h.SuppCode` | `SP_VirtualGL_PurchaseServices` (59213) |
| SP — payment | | `S.SuppCode` | `S.CashAccCode` | same (59236-59237) |
| **RP** Purchase-of-service return | | `S.CashAccCode` | `S.SuppCode` | same (59289-59290) |
| **PDA** Product acquisition | | `@GT_ProductInvAcc` (38) | `SuppCode` | `SP_VirtualGL_Products` (58591-58592) |
| PDA — other revenue | | `SuppCode` | `@GT_OtheRevFrmProductsAcc` (40) | same (58615-58616) |
| **PDS** Product sale | | `CustCode` | `@GT_ProductSalesAcc` (39) | same (58639-58640) |
| PDS — cost | | `@GT_CostOfProductsSaleAcc` (41) | `@GT_ProductInvAcc` (38) | same (58663-58664) |
| **PG** Patient registration | | `Patient.CashAccCode` | `Patient.CustCode` | `SP_VirtualGL_Patient` (58339-58340) |
| **PA** Patient admission | | `PatientAdmission.CashAccCode` | `Patient.CustCode` | same (58376-58377) |
| **GC** Guest check-in | | `GuestCheckin.CashAccCode` | `Guest.CustCode` | `SP_VirtualGL_Guest` (58164-58165) |

All seven of these verticals are **shipped but dormant** at Fazal Din PP19 (source tables empty). The product supports them; this pharmacy does not use them.

### 4.8 Parallel engine: `SP_CRS_*`

**Verified.** A complete duplicate of the posting engine exists — `SP_CRS_VirtualGL` plus 10 `SP_CRS_VirtualGL_*` sub-procedures (`db_modules_full.sql:16975-18720`) — writing to `CRS_VirtualGL` / `CRS_VirtualGLTemp`. It uses the same `Global` bindings and the same Dr/Cr logic. This is the branch/central-reporting-server consolidation path. `CRS_VirtualGL` is **empty (0 rows)** at this deployment. It is a maintenance liability: any posting-rule change must be applied twice.

---

## 5. Journal / voucher behaviour

### 5.1 Voucher categories (22, Verified live)

| Code | Name | Short | JV? | Header side | Detail side | Invoice-based | InvType | AutoPost |
|---|---|---|---|---|---|---|---|---|
| 1 | CASH PAYMENT | CP | 0 | C | D | 0 | | N |
| 2 | CASH RECEIPT | CR | 0 | D | C | 0 | | N |
| 3 | BANK PAYMENT | BP | 0 | C | D | 0 | | N |
| 4 | BANK RECEIPT | BR | 0 | D | C | 0 | | N |
| 5 | JOURNAL VOUCHER | JV | **1** | — | — | 0 | | N |
| 6 | OPENING CASH IN HAND | OPC | 0 | C | D | 0 | | N |
| 7 | OPENING BANK BALANCES | OPB | 0 | C | D | 0 | | N |
| 8 | OPENING A/C RECEIVABLES | OPR | 0 | C | D | 0 | | N |
| 9 | OPENING A/C PAYABLES | OPP | 0 | D | C | 0 | | N |
| 10 | OPENING OTHER RECEIVABLES | OPOR | 0 | C | D | 0 | | N |
| 11 | OPENING OTHER PAYABLES | OPOP | 0 | D | C | 0 | | N |
| 12 | CASH RECEIPT AGAINST SALES | CRS | 0 | D | C | **1** | 1 | N |
| 13 | BANK RECEIPT AGAINST SALES | BRS | 0 | D | C | **1** | 1 | N |
| 14 | JOURNAL VOUCHER AGAINST SALES | JVS | **1** | — | — | **1** | 1 | N |
| 15 | CASH PAYMENT AGAINST PURCHASE | CPP | 0 | C | D | **1** | 2 | N |
| 16 | BANK PAYMENT AGAINST PURCHASE | BPP | 0 | C | D | **1** | 2 | N |
| 17 | JOURNAL VOUCHER AGNST PURCHASE | JVP | **1** | — | — | **1** | 2 | N |
| 18 | SUPPLIERS DISC. REC/ALLOWED | JVD | **1** | — | — | 0 | | **Y** |
| 19 | DEBIT NOTE VOUCHER. | DNV | 0 | C | D | 0 | | **Y** |
| 20 | CREDIT NOTE VOUCHER. | CNV | 0 | D | C | 0 | | **Y** |
| 21 | DEBIT NOTE AGAINT SALE. | DNS | 0 | C | D | **1** | 1 | **Y** |
| 22 | CREDIT NOTE AGAINTS SALE. | CNS | 0 | D | C | **1** | 1 | **Y** |

`VocherCategoryHeader` (20 rows) additionally restricts which `SubAccCode` may appear on the header of each category — e.g. CP/CR → SubAcc 2 (CASH IN HAND), BP/BR → SubAcc 4 (CASH AT BANK), all opening vouchers → SubAcc 9 (EQUITY/CAPITAL). **Verified.**

### 5.2 Voucher numbering

**Verified.** Two independent identifiers per voucher:

- **`GLVochCode`** — global surrogate key from `SP_GetTabMaxkey 'GLHeader'`
- **`VoucherCode`** — a *per-category* sequential number from `SP_GetVoucherCode` (`db_modules_full.sql:32703-32747`):

```sql
SELECT @ai_Vouchercode = Counter
FROM   dbo.VocherCategory WITH (UPDLOCK HOLDLOCK)
WHERE  VochCatCode = @ai_vochcatcode
...
Set @ai_Vouchercode = @ai_Vouchercode + 1
UPDATE dbo.VocherCategory SET Counter = @ai_Vouchercode WHERE ...
```

`UPDLOCK HOLDLOCK` gives correct concurrency, but the counter is **incremented before the voucher is known to save**, so aborted saves burn numbers — gaps are expected and are not evidence of deletion. **Strongly Inferred.**

`SP_SetVoucherCategoryCounters` (`db_modules_full.sql:48759-48760`, a single minified line) rebuilds all category counters from `GLHeader` — a repair utility.

`SP_CreateVoucher` (`db_modules_full.sql:12917-12953`) is the composed entry point: get key → get voucher code → `SP_SetGLHeader` → `SP_SetGLDetail`. Three specialised wrappers exist: `SP_CreateVoucher_From_ImpPur`, `_From_PurPayment`, `_From_SOReceipt`.

### 5.3 Transaction window

**Verified.** `TransactionHeader` / `TransactionDetail` with `TransactionType` / `TransactionCategory` is a second, simpler cash-movement mechanism (`TransactionCatCode` 1 = receipt, 2 = payment) posting through `SP_VirtualGL_TransactionWindow`. `TransactionHeader` is **empty** at this deployment.

### 5.4 What is actually in the journal here

**Verified.** `GLHeader = 0` and `GLDetail = 0`. **Not one manual voucher has ever been entered at Fazal Din PP19.** No cash payment, no bank transaction, no journal entry, no opening-balance voucher, no debit/credit note.

---

## 6. Receivables

### 6.1 Model

**Verified.** Receivables are tracked in two parallel places:

1. **The GL** — `VirtualGl` rows on customer accounts (SubAcc 3, CUSTOMERS/DEBITORS).
2. **The invoice** — `SaleLedger.OutstandingAmt numeric(15,2)`, `SaleLedger.UnReceivedBalance`, `SaleLedger.Balance`, maintained independently.

These two are **not reconciled by any procedure found in the database**. **Verified** (no proc cross-checks `SUM(VirtualGl)` against `SUM(SaleLedger.OutstandingAmt)`).

### 6.2 Balance functions

| Function | Signature | Behaviour |
|---|---|---|
| `Fn_AccountBalance` | `(@Date DATETIME, @AccCode INT) → numeric(15,5)` | **Broken/Incomplete.** Doc-comment says "uptill a specific date" but the body has **no date predicate**: `SELECT SUM(Debit-Credit) FROM VirtualGL WHERE AccCode = @AccCode`. `@Date` is accepted and ignored. `db_modules_full.sql:49-52` |
| `SP_OpeningBalance` | `(@AccCode, @DateTime, @Bal OUT)` | Correct: filters `DATE <= @DateTime`, expands through `udf_GetSummaryAccountList`. Runs `SP_VirtualGL 'A'` first. `db_modules_full.sql:40359-40371` |
| `SP_AbsoluteOpeningBalance` | `(@AccCode, @Bal OUT)` | All-time balance, summary-expanded. `db_modules_full.sql:2665-2677` |
| `Fn_OverDueBalance` | `(@Type, @Date, @AccCode, @OverDueDays)` | FIFO ageing — see below |
| `Fn_OverDueBalanceAll` | table-valued | Same, all accounts (`db_modules_full.sql:64109`) |
| `Fn_CustomerOverDueBalance` | table-valued | Customer-scoped (`db_modules_full.sql:61925`) |

> **`Fn_AccountBalance` ignoring `@Date` is a genuine defect**, not a naming quirk: any report or UI element that passes an as-of date to this function silently receives the *all-time* balance. Every consumer must be audited. Added to the accountant checklist (§16, item 6).

### 6.3 Ageing algorithm

**Verified.** `Fn_OverDueBalance` (`db_modules_full.sql:1404-1533`) implements oldest-first (FIFO) settlement:

1. Build `@lt_amt` = every **debit** (customer) or **credit** (supplier) row up to `@Date`, with `DaysOld = DATEDIFF(day, date, @Date)`, ordered oldest first.
2. Build `@lt_pmt` = the **total** of the opposite side up to `@Date` (a single aggregate, not matched to invoices).
3. Walk `@lt_amt` with a cursor, consuming `@lt_pmt` against each invoice until exhausted.
4. `@OverDueBal = SUM(Amount - Paid) WHERE DaysOld > @OverDueDays`.

**Important consequence (Strongly Inferred):** settlement is *not* invoice-referenced. A payment explicitly allocated to a specific invoice is nevertheless applied to the oldest open item by this function. Ageing reports and any invoice-level allocation records can therefore disagree.

Cursor-based row-by-row processing over a 1 M-row ledger — this is also the performance hotspot of the receivables module.

### 6.4 Ageing report family

**Verified.** Eight procedures, all reading `VirtualGl`:

| Proc | Line | Grouping |
|---|---|---|
| `sp_Aging` | 4554 | Account |
| `sp_Aging_Account` | 4747 | Single account |
| `sp_Aging_Cummulative` | 4970 | Cumulative buckets |
| `sp_Aging_CustomerWise` | 5200 | Customer |
| `sp_Aging_Per_Invoice` | 5385 | Invoice |
| `SP_Aging_SalesManWise` | 5622 | Salesman |
| `SP_Aging_SubAreaWise` | 5743 | Sub-area |
| `sp_AgingDetail` / `_SalePersonWise` | 6019 / 6215 | Detail |
| `sp_AgingBasedEPI` | 5864 | Per-invoice variant |

Buckets come from `AgingIntervalDetail`: **0, 1, 31, 61, 91, 121, 151, 181** days (one profile, "DEFAULT"). **Verified** live.

### 6.5 Invoice balance maintenance

**Verified.** Four near-identical setters, all guarded by `Marked='N' AND Posted='Y' AND AccountFor='Y'`:

```sql
-- SP_UpdateSaleInvBalance, db_modules_full.sql:57352-57358
UPDATE SaleLedger SET SaleLedger.OutstandingAmt = @an_amt
WHERE SaleLedger.SaleInvCode = @ai_SaleInvCode
  AND SaleLedger.Marked = 'N' AND SaleLedger.Posted = 'Y'
  AND SaleLedger.AccountFor = 'Y'
```

| Proc | Table | Line |
|---|---|---|
| `SP_UpdateSaleInvBalance` | `SaleLedger` | 57346 |
| `SP_UpdatePurInvBalance` | `PurLedger` | 57264 |
| `SP_UpdatePRInvBalance` | `PRLedger` | 57251 |
| `SP_UpdateSRInvBalance` | `SRLedger` | 57477 |

These are **absolute setters**, not deltas — the caller computes the new balance and overwrites. There is no optimistic-concurrency check, so two concurrent allocations against the same invoice can lose an update. **Verified** by absence of any version/rowversion predicate.

### 6.6 Return allocation

**Verified.** `SP_AllocateSaleReturn` (`db_modules_full.sql:6365-6466`) offsets a sale return against an original sale invoice:

1. `SP_CheckUnpostedSaleInvInTransactions` — refuse if unposted.
2. `SP_GetSRInvBalance` / `SP_GetSaleInvBalance` — read both balances; return 0 (no-op) if either is zero, error if negative.
3. `@amt = MIN(@Sale_Balance, @SR_Balance)`.
4. `SP_UpdateSRInvBalance` and `SP_UpdateSaleInvBalance` with the reduced figures.
5. `SP_CreateSRAllocation` writes `SRAllocationHeader` / `SRAllocationDetail`.

**Allocation never touches the GL.** `sp_PostSRAllocationHeader` and `sp_PostPRAllocationHeader` only set `Posted='Y'` on the allocation header. Equivalents exist for services (`SP_AllocateServiceReturn`, `SP_CreateServiceSRAllocation`) and locking (`sp_LockSRAllocationInvoice`, `sp_LockPRAllocationInvoice`). All allocation tables are **empty** here.

### 6.7 "Due" ≠ receivable — a naming trap

**Verified and important.** The `SP_AutoSatisfyDue` / `sp_SatisfyDueInBulk` / `SP_PurchaseBased_SatisfyDue` / `DueAdjHeader` / `DueSatisfyHeader` family is **not** about receivables. It is **back-order fulfilment**: items sold while out of stock (`SaleDetail.Due = 'D'`) that get "satisfied" when stock arrives.

```sql
-- SP_AutoSatisfyDue, db_modules_full.sql:8724-8733
DueQty = SD.LooseQty,
SatisfiedQty = ISNULL((SELECT SUM(dsd.DueSatisfyQty) FROM DueSatisfyHeader dsh, DueSatisfyDetail dsd ...), 0),
Stock = ISNULL((SELECT SUM(GD.CurrQty) FROM GodownDetail GD WHERE GD.ICode = SD.ICode AND SD.GCode = GD.GCode), 0)
...
WHERE SD.Due = 'D' AND (T.DueQty - T.SatisfiedQty) > 0 AND T.Stock > 0
```

Gated by `Godown.AutoSatisfyDue` (live value `'N'`) and preference `autoduesatisfyonpurpost` (live value `'N'`). Both off. **This belongs to the inventory domain, not accounting** — flagged here because the naming strongly suggests otherwise and a rebuild team could easily mis-model it.

### 6.8 Receivables at this deployment

**Verified.** There are effectively none:

- `SaleLedger` = 291,361 rows, **100 % `SaleCatCode = 3` (Retail Sale)** → all post Dr Cash.
- Customer accounts 19 and 22 have **0** GL rows.
- `Customer` table = 2 rows.
- `SaleLedger.AccountFor` and `Posted` are `'Y'` for all 291,361 rows.

The receivables subsystem is fully built and completely unexercised.

---

## 7. Payables

### 7.1 Model

**Verified.** Supplier balances live on the supplier's own account under SubAcc 7 (SUPPLIERS/CREDITORS) — **235 accounts**, i.e. the supplier master *is* the sub-ledger. There is no separate AP control account. Each purchase credits the supplier directly (`SP_VirtualGL_Purchase`, line 59303); each purchase return debits it (`SP_VirtualGL_PurchaseReturn`, line 59128).

`PurLedger.OutstandingAmt numeric(15,2)` mirrors the per-invoice balance, maintained by `SP_UpdatePurInvBalance`.

### 7.2 Settlement paths — all unused

| Path | Mechanism | Status here |
|---|---|---|
| Cash/bank payment voucher | `GLHeader`/`GLDetail` cat 1,3,15,16 → `SP_VirtualGL_Vouchers` | `GLHeader = 0` |
| Payment during invoice entry | `PurLedger.Amt` + `PaymentAccCode` → `VRow 3/4` legs | `Amt` path unexercised |
| Transaction window payment | `TransactionHeader` cat 2 | `TransactionHeader = 0` |
| Note payable | `Notes` cat 2 → `NP` | `Notes = 0` |
| PR allocation | `PRAllocationHeader/Detail` | 0 rows |

### 7.3 Actual payables position

**Verified** (live aggregation over `VirtualGl`, top balances):

| AccCode | Supplier | Debits | Credits | Balance |
|---|---|---|---|---|
| 117 | MULLER & PHIPS (M&P) | 53,629 | 24,171,609 | **−24,117,980** |
| 107 | DIAMOND (GS PHARMA) | 49,460 | 12,961,124 | −12,911,664 |
| 111 | PROMO TRADERS | 141,316 | 12,342,014 | −12,200,698 |
| 316 | SPECIAL GROUP | 27,926 | 12,132,616 | −12,104,690 |
| 102 | PREMIER AGENCIES (HIGHNOON) | 83,076 | 11,803,868 | −11,720,792 |
| 110 | LALS PHARMA | 97,020 | 11,632,836 | −11,535,816 |
| 118 | NEO IQBAL BROTHER | 85,760 | 10,606,982 | −10,521,222 |
| … | (227 more suppliers) | | | |

The only debits on supplier accounts are **purchase returns**, never payments. **Total book payables ≈ PKR 190 M and monotonically increasing since 2025-01-01.** In reality this pharmacy pays its suppliers; the books simply do not record it. This is the payables-side manifestation of the settlement gap.

---

## 8. Opening balances

### 8.1 Available mechanisms

**Verified.** Six voucher categories are reserved for opening balances (OPC, OPB, OPR, OPP, OPOR, OPOP — `VocherCategory` codes 6–11), all constrained by `VocherCategoryHeader` to SubAcc 9 (EQUITY/CAPITAL). Plus dedicated procedures:

| Proc | Line | Purpose |
|---|---|---|
| `SP_OpeningBalance` | 40345 | Account balance as at a date (summary-expanded) |
| `SP_AbsoluteOpeningBalance` | 2649 | All-time balance |
| `sp_AccountOpeningBalance` | 2679 | Report-oriented |
| `SP_OpeningCashInHand` | 40374 | Cash opening |
| `sp_GLOpeningBalance` | 32749 | GL opening |
| `sp_CLOpeningBalance` | 11269 | Customer opening |
| `sp_SLOpeningBalance` | 48768 | Supplier opening |
| `sp_GuestOpeningBalance` | 33373 | Guest |
| `sp_PatientOpeningBalance` | 40800 | Patient |
| `sp_StudentOpeningBalance` | 49936 | Student |
| `sp_ItemOpeningStock` / `sp_GodownItemOpeningStock` / `udf_openingstock` / `udf_GodownOpeningStock` / `udf_openingstocksingleitem` | 38378 / 32811 / 64439 / 64305 / 1623 | Inventory opening |
| `sp_init_customers_balances` / `sp_init_suppliers_balances` / `sp_init_others_balances` | — | Bulk seeding — these DO write `GLHeader`/`GLDetail` (3 inserts each) |
| `sp_init_opening_pur` / `sp_init_after_opening_voch` | 36387 / 35780 | Opening-purchase migration helpers |

### 8.2 What was actually done here

**Verified.** Exactly **one** opening entry exists in the entire ledger:

| DocCode | DocType | CatCode | AccCode | Date | Debit | Credit |
|---|---|---|---|---|---|---|
| 1 | **PV** | **3** | 5 (CAPITAL ACCOUNT) | 2025-01-01 16:42:43 | 0.00 | **11,873,579.00** |

This came through the **Opening Purchase** path, not an opening voucher:

```sql
-- SP_VirtualGL_Purchase, db_modules_full.sql:59302-59303
cr_acccode = CASE P.PurCatCode
    WHEN 3 THEN @ln_equityacc  /*Opening Purchase*/
    ELSE CASE WHEN P.CustCode > 0 THEN P.CustCode ELSE P.suppcode END END
```

`PurLedger` contains exactly **1 row with `PurCatCode = 3`** (of 6,419 total). So the go-live procedure was: enter the entire opening stock as a single "Opening Purchase" invoice → Dr PURCHASE ACCOUNT / Cr CAPITAL ACCOUNT 11,873,579.

**No opening cash, no opening bank, no opening receivables, no opening payables, no opening fixed assets were ever entered.** The books therefore start from an incomplete balance sheet.

---

## 9. Period closing and locking

### 9.1 There is none

**Missing.** Exhaustive search of all 762 objects found **zero** occurrences of `YearEnd`, `PeriodLock`, `ClosePeriod`, `FinancialYear`, or `FiscalYear`. There is:

- no period-close procedure
- no period-lock table or flag
- no retained-earnings roll-forward
- no year-end revenue/expense zeroing
- no posted-period guard on any `INSERT`/`UPDATE`

Consequently **any date can be posted or edited at any time, forever.**

### 9.2 `ServerDateMonth` is not a period lock

**Verified.** Both `ServerDateMonth` and `ServerDateMonthPur` are single-column, single-row tables (`LastMonthDate DATETIME`). Every one of their 12 references is inside an invoice-counter reset:

```
db_modules_full.sql:57365  Set @lastdate = (Select LastMonthDate From ServerDateMonth)
db_modules_full.sql:57377  Update ServerDateMonth Set LastMonthDate = GetDate()
```
in `sp_UpdateSaleLedgerDummyCounter` / `sp_UpdateSaleLedgerDummyCounter2` / `sp_UpdatePurLedgerDailyICatCounter` / `sp_UpdatePurLedgerMonthlyICatCounter`.

Their purpose is **monthly invoice-number reset** (preference `AutoMonthSaleInvCode`), not accounting period control. Live values: `2026-07-31 00:02:21` and `2026-07-31 08:29:33`.

### 9.3 What "posting" actually means

**Verified.** `Posted = 'Y'` on a source document means only *"this document is finalised and eligible for GL materialisation."* It does **not** mean immutable. `SP_Supervise_CashierActivity` (`db_modules_full.sql:50390+`) demonstrates the edit path on already-posted documents:

```sql
-- db_modules_full.sql:50432-50435
SET @Posted = (SELECT Posted FROM SaleLedger WHERE SaleInvCode=@DocCode)
IF @Posted = 'Y'
BEGIN
    DELETE VirtualGl WHERE DocumentType = 'SV' AND DocumentCode=@DocCode
END
```

**The correction mechanism is hard deletion of the GL rows, followed by silent re-derivation from the amended source document on the next `SP_VirtualGL` run.** There is no reversing entry, no audit trail, no "amended" marker. An auditor cannot tell that an invoice was changed after posting. Same pattern at lines 50464 (`RS`) and 50494 (`SR`), and in `SP_Apply_StudentFine_On_UnpaidInvoices` (lines 6631, 6649).

Whole-ledger truncation points: `SP_DeletePostedTransactions` (line 23229), `SP_DeleteSyncedTransactions` (line 23431), `sp_init_update_tabmaxkey` (line 36650), and the `AutoPurgeVirtualGL` switch (line 57801).

### 9.4 Unposted-transaction detection

**Verified.** Two families exist.

**Gate procedures** — `SP_CheckUnpostedTransactions` (`db_modules_full.sql:10572-10717`) raises an error if any source table has `Posted='N'`, checking in order: `SaleLedger`, `AdvSaleLedger`, `SRLedger`, `SRBufferLedger`, `AdvPurHeader`, `ImpPurHeader`, `PurRegister`, `PRLedger`, `IssueHeader`, `ReceiptHeader`, `THeader`, `AdjHeader`, `AdjBufferHeader`, …

> **Note:** the `PurLedger` check is **commented out** (lines 10600-10607) — purchase invoices are deliberately exempt from the gate. **Verified**; reason **Unclear**.

Companion per-document gates: `SP_CheckUnpostedSaleInvInTransactions`, `…PurInv…`, `…PRInv…`, `…SRInv…`, `…ServiceInv…`, `…ServicePRInv…`, `…ServicePurInv…`, `…ServiceSRInv…`, `SP_CheckUnpostedTransactionOfAnItem`.

**Discovery functions** — the `Fn_GetUnposted_*` table-valued family returns the unposted documents for UI listing: `_AccTrans` (62110), `_Adjustment` (62413), `_Purchase` (62498), `_PurchaseReturn` (62946), `_PurServices` (63064), `_SaleOrder` (63217), `_Sales` (63290), `_SalesReturn` (63554), `_Services` (63729), `_TransWindow` (63965).

Live status: `SaleLedger` has 0 unposted, `AdjHeader` has 0 unposted. Everything is posted.

---

## 10. Financial reports

### 10.1 What exists

| Report | Object | Line | Reads from | Status |
|---|---|---|---|---|
| Income statement | `sp_IncomeStatement` | 34158 | `VirtualGl` + `StockLedger` | **Broken/Incomplete** — see §10.3 |
| Income statement (branch) | `sp_CRS_IncomeStatement` | 13895 | `CRS_VirtualGL` | Unused (0 rows) |
| Daily income + GP summary | `SP_DailyIncomeStatement_With_GP_Summary` | 20846 | Services + `GLHeader` | Unusable — service/hospital shaped |
| Daily income + GP summary (v2) | `SP_DailyIncomeStatement_With_GP_Summary2` | 21147 | `ServiceHeader`/`ServiceRHeader` + `GLHeader`/`GLDetail` | Unusable here — both sources empty |
| Account ledger | `sp_AccountsLedger` / `sp_AccountsLedger1` | 3137 / 3310 | `GLHeader`+`GLDetail` **directly** | **Deprecated** — legacy 2002 proc, bypasses `VirtualGl`, so it shows nothing at this deployment |
| Daily item ledger | `sp_DailyLedger_LPLedger` | 21275 | `SaleLedger`/`SaleDetail` | Item-level sales report, **not accounting** |
| Ageing (8 variants) | `sp_Aging*` | see §6.4 | `VirtualGl` | Functional, nothing to age |
| Overdue lists | `SP_GetOverDueBlanceList`, `SP_GetCustomerOverDueBlanceList` | 31704 / 30948 | `VirtualGl` | Functional, unused |

### 10.2 What does NOT exist

**Missing.** Exhaustive text search for `trial balance` and `balance sheet` across all 2.48 MB of object source returned **zero matches**. All 34 views are SMS-notification or data-sync views — none is an accounting statement.

**There is no trial balance and no balance sheet in the database.** If the application presents them, they are computed entirely inside compiled PowerBuilder DataWindows and are **unrecoverable** (**Unclear** whether they exist at all in the UI). This is a first-order gap for the rebuild: the two most fundamental accounting statements have no server-side specification to port.

### 10.3 `sp_IncomeStatement` — structure and defects

**Verified.** The proc writes into a shared scratch table `ReportData` (`DELETE reportdata` first — no session isolation, so **concurrent report runs corrupt each other**; `ReportData` currently holds 7 stale rows). Sections, by `code2`:

| code2 | Line | Name | Computation |
|---|---|---|---|
| 1 | 34189 | REVENUE FROM SALES | `SUM(v.debit - v.credit)` over accounts in category 7, date-bounded |
| 2 | 34214 | COST OF SALES | `SUM(debit-credit)` over category 9 **+ opening stock value − closing stock value** from `StockLedger.newavgprice * newstock` |
| 3 | 34252 | GROSS PROFIT/LOSS | `SUM(value1)` over *all* rows so far |
| 4 | 34269 | OPERATING EXPENSES | `SUM(debit-credit)` over category 10 |
| 5 | 34296 | OPERATING PROFIT/LOSS | `SUM(value1) WHERE code2 IN (3,4)` |
| … | | OTHER REVENUES / OTHER EXPENSES / NET | categories 8 and 11 |

**Two defects:**

1. **`StockLedger` is empty (0 rows).** Both the opening- and closing-stock terms evaluate to 0, so the periodic-inventory COGS adjustment contributes nothing. Combined with the fact that category 9 (DIRECT EXPENSES) contains only the PURCHASE ACCOUNT, **"cost of sales" on this report equals total purchases for the period**, not cost of goods sold. Gross profit is therefore wrong by the entire inventory movement. **Verified.**

2. **Sign convention is credit-negative and never normalised.** Revenue is stored as `SUM(Debit − Credit)`, so a PKR 229 M revenue appears as **−229,385,121**. `GROSS PROFIT/LOSS` then sums revenue (negative) with COGS (positive), yielding a *negative number for a profit*. Whether the presentation layer flips the sign is **Unclear** (it lives in the compiled DataWindow). Until confirmed, every figure from this proc must be treated as sign-ambiguous. Added to the accountant checklist (§16, item 8).

### 10.4 Gross profit is recoverable — but not from the GL

**Verified.** Although the GL has no COGS, the cost data exists at line-item level:

```
SELECT SUM((LooseQty + BonusQty) * AvgPrice) FROM SaleDetail
  → 193,957,856.99
```

`SaleDetail.AvgPrice` holds the weighted-average cost at the moment of sale, and `SP_VirtualGL_Sales` already computes the aggregate per invoice:

```sql
-- db_modules_full.sql:59750
CGS = ISNULL(SUM((D.LooseQty + D.BonusQty) * D.AvgPrice), 0)
```

It is carried into `VirtualGLTemp.CGS` and then **discarded**, because the fan-out is gated on `WHERE @InvSys <> 'P'` (line 57955) and `InventorySystemUsed = 'P'`.

Indicative gross margin from source data: net sales (229,385,121 − 19,301,800) = **210,083,321**; COGS ≈ **193,957,857** (before return-cost adjustment) → roughly **8–12 %**, plausible for a Pakistani retail pharmacy. **Strongly Inferred** — an accountant must confirm the return-side cost treatment before this figure is relied upon.

---

## 11. Multi-currency

**Verified — present but unused.**

Schema support is real: `VirtualGl.CurrencyCode`, `VirtualGl.ConversionRate numeric(11,5)`, `GLHeader.ConversionRate numeric(11,5)`, `GLDetail.ForeignAmt numeric(15,5)`, plus `Currency` and `CurrencyDenomination` tables.

Live data:

- `Currency` = **1 row**: `PAKISTANI RUPEE`, `RS.`, `ConversionFactor = 1.00000`
- `VirtualGl`: `COUNT(DISTINCT CurrencyCode) = 1`, `COUNT(DISTINCT ConversionRate) = 1`, 1,020,457 of 1,021,852 rows carry a non-null currency
- `CurrencyDenomination` = 1 row (`Rs. 1`)

Critically, **no posting procedure performs any currency conversion**. `CurrencyCode` and `ConversionRate` are copied verbatim from the source document to the GL row; `Debit` and `Credit` are always in base currency. There is no FX gain/loss account, no revaluation procedure, no `ForeignAmt` population in `VirtualGl` (the column exists only on `GLDetail`).

**Conclusion:** multi-currency is a schema placeholder, not a working feature. Single-currency (PKR) is safe to assume for the rebuild.

---

## 12. Tax within accounting

### 12.1 Three tax streams

**Verified.** `SP_VirtualGL` emits three distinct tax legs, all at `VRow = 2`.

**(a) Sales tax / GST** — `db_modules_full.sql:57870-57881`

```sql
AccCode = CASE WHEN DocumentType = 'RS' OR DocumentType = 'RR'
               THEN @ln_salestaxonsvc ELSE @ln_salestaxacc END,
Debit  = CASE DocumentType WHEN 'PV' THEN SaleTax WHEN 'SR' THEN SaleTax WHEN 'RR' THEN SaleTax ELSE 0 END,
Credit = CASE DocumentType WHEN 'SV' THEN SaleTax WHEN 'PR' THEN SaleTax WHEN 'RS' THEN SaleTax ELSE 0 END
WHERE SaleTax <> 0
```

| Doc | Account | Side |
|---|---|---|
| PV Purchase | 3 SALES TAX RECEIVEABLES | **Debit** (input tax) |
| PR Purchase return | 3 | **Credit** (reversal) |
| SV Sale | 3 | **Credit** (output tax) |
| SR Sale return | 3 | **Debit** (reversal) |
| RS Service sale | 27 SALES TAX PAYABLE ON SERVICES | **Credit** |
| RR Service return | 27 | **Debit** |

> **Anomaly to flag.** Goods **output** tax is credited to account **3 SALES TAX RECEIVEABLES — a CURRENT ASSET** (`GT_AdvanceSalesTaxACC = 3`). Input and output GST therefore net inside one asset account rather than being split receivable/payable. Live position: 39,514 rows, Dr 4,168,064 / Cr 4,372,676 → **net credit balance of 204,612 sitting inside an asset account**, i.e. a liability presented as a negative asset. Services correctly use a liability account (27). **Verified**; whether this is intentional netting or a mis-binding is **Unclear** → accountant checklist §16 item 4.

**(b) Advance / withholding income tax** — `db_modules_full.sql:57883-57894`

```sql
AccCode = CASE WHEN DocumentType = 'SV' OR DocumentType = 'SR'
               THEN @ln_AdvIncomeTaxSale ELSE @ln_AdvIncomeTaxPur END,
Debit  = CASE DocumentType WHEN 'PV' THEN AdvIncomeTax WHEN 'SR' THEN AdvIncomeTax ELSE 0 END,
Credit = CASE DocumentType WHEN 'SV' THEN AdvIncomeTax WHEN 'PR' THEN AdvIncomeTax ELSE 0 END
WHERE DocumentType IN ('SV','SR','PV','PR') AND AdvIncomeTax <> 0
```

Purchase side → account 35 (asset, TAXES RECEIVABLE). Sale side → account 36 (liability, TAXES PAYABLE). Correctly classified.

Preferences: `ApplyAdvanceIncomeTaxInPur = 'Y'`, `ApplyAdvanceIncomeTaxInSale = 'N'`. Live: account 35 has 3,808 rows, Dr 696,928.69; account 36 has **0** rows. Consistent. **Verified.**

**(c) FBR POS service fee** — `db_modules_full.sql:57896-57907`

```sql
AccCode = @ln_fbrposfeeacc,   -- 37, FBR POS SERVICE FEE PAYABLE (liability)
Debit  = CASE DocumentType WHEN 'SR' THEN ISNULL(FBRPosFee, 0) ELSE 0 END,
Credit = CASE DocumentType WHEN 'SV' THEN ISNULL(FBRPosFee, 0) ELSE 0 END
WHERE DocumentType IN ('SV','SR') AND ISNULL(FBRPosFee, 0) <> 0
```

Pakistan FBR digital-invoicing levy. Preferences: `Auto_Apply_FBR_POS_Fee_InSale = 'Y'`, `Amount_For_FBR_POS_Fee_InSale = 1.00`, `FBRPOSID = 141973`, `ownertaxregno = 055-3252501`, `FetchFBRPosFeeForRefSR = 'Y'`.

Live: account 37 has 320,300 rows — Cr 291,361.00 (exactly Rs. 1 × 291,361 invoices) and Dr 28,939.00 (return reversals). Net liability **262,422**. Perfectly consistent. **Verified.**

### 12.2 Sales tax at this deployment

**Verified.** `SELECT COUNT(*) FROM SaleLedger WHERE ISNULL(SalesTax,0) <> 0` → **0**. No sale invoice carries invoice-level sales tax. Retail pharmacy sales here are GST-exempt or GST-inclusive-at-source. The purchase side does carry input tax (account 3 activity). Only the FBR Re.1 POS fee is applied per sale.

### 12.3 Gross-vs-net interaction

**Verified.** Because the amount formula (§3.3) gives the counterparty `Gross + SaleTax` while the control account gets `Gross − AdvIncomeTax − FBRPosFee`, and the tax legs supply exactly the differences, every document balances by construction. Confirmed globally: `SUM(Debit) = SUM(Credit) = 455,292,133.00`, difference **0.00** across 1,021,852 rows.

---

## 13. Returns and adjustments

### 13.1 Sales returns

**Verified.** `SP_VirtualGL_SalesReturn` (`db_modules_full.sql:59896-60038`). Debits account 8 SALES RETURN (a contra-revenue with debit balance), credits cash or customer per `SRCatCode` (6/8 = cash, else credit). It is a **gross-up, not a reversal**: the original SV entry remains untouched and a separate SR entry is added.

CGS reversal logic (only meaningful in perpetual mode):
```sql
-- db_modules_full.sql:59983
CGS = ISNULL(SUM((D.looseqty + D.bonusqty) *
      CASE WHEN S.SaleInvCode > 0 THEN D.AvgPrice
           ELSE (D.SRPrice * (1 - D.DiscPerc * 0.01) * (1 - S.DiscPerc * 0.01)) END), 0)
```
A return linked to an original invoice uses the recorded `AvgPrice`; an unlinked return **estimates cost from the discounted selling price** — economically wrong (it books cost equal to net revenue, i.e. zero margin on the return). Never executes here (`@InvSys='P'`), but is a live defect for any deployment using perpetual mode. **Verified.**

Live: 30,704 SR invoices, all `SRCatCode = 8` (Retail S/R). Empirically confirmed — doc 92307: Dr 8 SALES RETURN 16.00 / Cr 2 CASH 17.00 / Dr 37 FBR fee 1.00. ✔

### 13.2 Purchase returns

**Verified.** `SP_VirtualGL_PurchaseReturn`. Dr supplier (or `CustCode` if set, or equity for `PRCatCode=6` opening), Cr account 12 PURCHASES RETURNS. Live: 1,395 GL rows, account 12 net credit 3,480,475.

### 13.3 Stock adjustments — silently excluded

**Broken/Incomplete — high severity.**

`SP_VirtualGL_Adjustment` (`db_modules_full.sql:58000-58023`) requires:

```sql
FROM AdjHeader A, AdjDetail D
WHERE A.AdjCode IN (SELECT Code FROM #lsl) AND
      A.AdjCode = D.AdjCode AND A.AccCode IS NOT NULL
```

Live `AdjHeader` composition:

| Posted | AdjCatCode | AccCode state | Count |
|---|---|---|---|
| Y | 1 (INCREASE) | **NULL** | 824 |
| Y | 2 (DECREASE) | **NULL** | 718 |

**All 1,542 stock adjustments have `AccCode IS NULL`, so 100 % are excluded from the GL.** Confirmed by the absence of any `AI` or `AD` rows in `VirtualGl`.

Corroborating evidence: sub-accounts 18 (STOCK ADJUSTMENT INCREASE) and 19 (STOCK ADJUSTMENT DECREASE) have **zero leaf accounts**, so no valid `AccCode` could have been chosen even if the UI had asked. The `GT_StockAdjIncrease = 18` / `GT_StockAdjDecrease = 19` bindings point at empty sub-accounts.

**Business impact:** every inventory write-off, expiry, breakage, theft and count correction over the entire history has adjusted physical stock without any corresponding expense or inventory entry. Combined with the missing COGS (§10.3), inventory shrinkage is completely invisible in the financial statements.

### 13.4 Correction of posted documents

**Verified — see §9.3.** Amendments are handled by deleting the document's GL rows and re-deriving. No reversing entries, no audit trail. `VirtualGl` has no `CreatedOn`/`ModifiedOn`/`DeletedFlag` column.

---

## 14. Rounding and decimal precision

### 14.1 Declared precision

**Verified** from `INFORMATION_SCHEMA.COLUMNS`:

| Table | Column | Type | Max magnitude |
|---|---|---|---|
| `VirtualGl` | `Debit` | `numeric(15,2)` | 9,999,999,999,999.99 |
| `VirtualGl` | `Credit` | `numeric(15,2)` | " |
| `VirtualGl` | `OUTSTANDINGAMT` | `numeric(15,2)` | " |
| `VirtualGl` | `BALANCE` | `numeric(15,2)` | " |
| `VirtualGl` | `ConversionRate` | `numeric(11,5)` | 999,999.99999 |
| `GLDetail` | `Debit` / `Credit` / `OUTSTANDINGAMT` / `BALANCE` | `numeric(15,2)` | " |
| `GLDetail` | `ForeignAmt` | `numeric(15,5)` | 9,999,999,999.99999 |
| `GLHeader` | `ConversionRate` | `numeric(11,5)` | |
| `VirtualGlTemp` | `Gross` / `SaleTax` / `Amt` / `OutstandingAmt` / `Balance` / `CGS` | `numeric(15,2)` | |
| `VirtualGlTemp` | `AdvIncomeTax` | `numeric(12,2)` | 9,999,999,999.99 |
| `VirtualGlTemp` | **`FBRPosFee`** | **`numeric(5,2)`** | **999.99** |
| `Accounts` | `BalanceLimit` | `numeric(15,2)` | |
| balance functions | return type | `numeric(15,5)` | |

> **Precision cliff.** `VirtualGlTemp.FBRPosFee numeric(5,2)` caps the FBR POS fee at **999.99 per document**. Fine at the current Re. 1/invoice, but any future per-invoice fee ≥ 1,000 causes an arithmetic-overflow failure inside `SP_VirtualGL` — which, because it runs on every balance enquiry, would break balance reads system-wide.

> **Precision narrowing.** Balance functions return `numeric(15,5)` while the ledger stores `numeric(15,2)`; the legacy `sp_AccountsLedger` builds temp tables at `numeric(12,2)` (`db_modules_full.sql:3190-3191`), narrower than the source. Quantities are `numeric(15,4)`; `StockReport.AvgPrice` is `numeric(15,5)`.

### 14.2 Rounding behaviour

**Verified.** Document totals are rounded by a per-document-type preference, read via `Fn_Get_Int_Preference`:

| Preference | Live value | Used in |
|---|---|---|
| `roundsaleinvon` | **0** | `SP_VirtualGL_Sales` line 59669 |
| `roundsalereturninvon` | **0** | `SP_VirtualGL_SalesReturn` line 59907 |
| `roundpurinvon` | **0** | `SP_VirtualGL_Purchase` / `_PurchaseReturn` line 59104 |
| `roundsaleinvtonearestmultiple` | 0 | UI-level |
| `roundsaleinvtonearestmultiplelimit` | 50 | UI-level |

The value is passed as the second argument to T-SQL `ROUND(…, @RoundUpYo)` — so **0 means round to whole rupees**, which is why every GL figure observed is a whole number. This matches the live data (all `Debit`/`Credit` values end in `.00` except the advance-income-tax leg, e.g. 8,750.25 / 43.75, which is not subject to the document rounding).

**Nested rounding.** The tax computation rounds at three levels (`db_modules_full.sql:59700-59705`): per line item `ROUND(…, 2)`, then the invoice-level GST `ROUND(…, 2)`, then the whole expression `Round(…, @RoundUpYo)`. Compounding rounding differences of up to Re. 1 per invoice across 291,361 invoices is a material reconciliation risk. **Strongly Inferred.**

**Adjustments and issues/receipts round to whole rupees unconditionally** — hard-coded, not preference-driven:
```sql
-- SP_VirtualGL_Adjustment:58007, SP_VirtualGL_Issue:58232, SP_VirtualGL_Receipt:59943
Gross = Round(SUM(D.looseqty * D.Price), 0)
```

**Payroll deductions round to 2 dp** (`db_modules_full.sql:58489`): `Round((EP.BasicPay * EPD.Percentage * 0.01) + EPD.FlatAmount, 2)`.

### 14.3 Balance integrity — verified

Whole-ledger check on live data:

```
SUM(Debit)  = 455,292,133.00
SUM(Credit) = 455,292,133.00
Difference  =           0.00
Rows        =     1,021,852
```

And per document type, every type balances exactly:

| DocType | Rows | Total Debit | Total Credit | Date range |
|---|---|---|---|---|
| SV | 908,617 | 234,003,081.00 | 234,003,081.00 | 2025-01-01 → 2026-07-31 |
| SR | 93,050 | 19,691,239.00 | 19,691,239.00 | 2025-01-01 → 2026-07-31 |
| PV | 18,790 | 198,071,261.00 | 198,071,261.00 | 2025-01-01 → 2026-07-31 |
| PR | 1,395 | 3,526,552.00 | 3,526,552.00 | 2025-01-02 → 2026-07-30 |

**The double-entry mechanics are sound.** The problem is not arithmetic — it is coverage.

---

## 15. What is actually used at Fazal Din PP19

**Verified** (live row counts and GL aggregation).

### 15.1 Active

| Element | Evidence |
|---|---|
| Sale posting (`SV`) | 908,617 GL rows from 291,361 invoices, all `SaleCatCode = 3` (Retail Sale) |
| Sale return posting (`SR`) | 93,050 GL rows from 30,704 returns, all `SRCatCode = 8` |
| Purchase posting (`PV`) | 18,790 GL rows from 6,419 invoices (6,396 credit, 22 loose credit, 1 opening) |
| Purchase return posting (`PR`) | 1,395 GL rows |
| Supplier sub-ledger | 235 supplier accounts, 121 distinct accounts touched in GL |
| Input GST | Account 3: 39,514 rows |
| Advance income tax on purchase | Account 35: 3,808 rows, Dr 696,928.69 |
| FBR POS fee | Account 37: 320,300 rows |
| Rounding to whole rupees | All three round preferences = 0 |

### 15.2 Dormant (built, never used)

`GLHeader`/`GLDetail` (all 22 voucher categories) · `ReceiptHeader` · `IssueHeader` · `Notes` · `TransactionHeader` · `EMP_Payroll` · `CashierShift` · `SaleOrderHeader` · `DueAdjHeader` · `SRAllocationHeader` · `PRAllocationHeader` · `SummaryAccount`/`SummaryAccountDetail` · `AccountBalanceLog` · `AccountGodown` · `MasterCashWin` · `CashierWindow` · `SaleReceivableAdj` · `StockLedger` · `CRS_VirtualGL` · services · products · patient · guest · student verticals — **all 0 rows.**

### 15.3 Resulting book position (all-time, from `VirtualGl`)

| Account | Name | Balance (Dr +) | Reality check |
|---|---|---|---|
| 2 | CASH FROM SALE | **+214,311,842** | Cash has never been paid out or banked — fictional |
| 1 | PURCHASE ACCOUNT | +193,566,768 | Periodic system: no COGS, no closing-stock relief |
| 6 | SALES ACCOUNT | −229,385,121 | Correct |
| 8 | SALES RETURN | +19,301,800 | Correct (contra) |
| 12 | PURCHASES RETURNS | −3,480,475 | Correct (contra) |
| 5 | CAPITAL ACCOUNT | −11,873,579 | Single opening entry, 2025-01-01 |
| 7 | INVENTORY ACCOUNT | **0 rows** | Never posted |
| 9 | COST OF GOODS SOLD | **0 rows** | Never posted |
| 19 / 22 | Customer accounts | **0 rows** | Statistical only (`AlternateAccCode`) |
| 25 | DISCOUNT RECEIVED/ALLOWED | **0 rows** | Discounts netted into revenue, never separated |
| 42 | CASHIER CASH DIFFERENCE | **0 rows** | Never used |
| 46–316 | 234 suppliers | ≈ **−190,000,000** | Never paid down in the books |

---

## 16. Identified uncertainties

Ranked by impact on the rebuild.

| # | Uncertainty | Label | Why it matters |
|---|---|---|---|
| 1 | **No trial balance or balance sheet specification exists anywhere in the DB.** If the UI produces them, the logic is inside compiled DataWindows. | **Missing** / **Unclear** | The two most fundamental statements have no recoverable server-side definition to port. Must be re-specified from scratch with the accountant. |
| 2 | Is the settlement gap (no cash payments, no supplier payments) a *usage* choice or was a parallel manual/other system used? | **Unclear** | Determines whether historical GL data can be migrated at all, or only sales/purchase/tax history. |
| 3 | `sp_IncomeStatement` sign convention (credit-negative, never normalised) — does the DataWindow flip it? | **Unclear** | Every reported profit figure is sign-ambiguous until confirmed. |
| 4 | Output GST credited to account **3 SALES TAX RECEIVEABLES (an asset)** rather than a payable — intentional netting or mis-binding of `GT_AdvanceSalesTaxACC`? | **Unclear** | Affects tax-liability presentation and FBR filing correctness. |
| 5 | Why is the `PurLedger` unposted check **commented out** in `SP_CheckUnpostedTransactions` (lines 10600-10607)? | **Unclear** | Purchases can bypass a gate that all other documents must pass. |
| 6 | Which callers rely on `Fn_AccountBalance`'s ignored `@Date` parameter? | **Broken/Incomplete** + **Unclear** | Consumers silently get all-time balances where a period balance was intended. Consumers live in the compiled UI. |
| 7 | Does the UI constrain `CashierShift.DiffTransferedTo` to account 42, or is any account accepted? | **Unclear** | Cash-difference misposting risk if the module is ever enabled. |
| 8 | Do `VocherCategory.HeaderTreatment`/`DetailTreatment` actually enforce the Dr/Cr side, or are they advisory hints the UI may ignore? | **Unclear** | Determines whether voucher entry can produce unbalanced or mis-sided entries. |
| 9 | Are `SaleLedger.OutstandingAmt` and the GL customer balance ever reconciled? No procedure does it. | **Missing** | Two independent receivable figures that can silently diverge. |
| 10 | Purpose and activation conditions of the `SP_CRS_*` parallel engine (branch consolidation?). `CRS_VirtualGL` = 0 rows. | **Unclear** | If multi-branch is planned, this is the existing (duplicated) design. |
| 11 | Unlinked sale-return CGS estimated from discounted selling price (`db_modules_full.sql:59983`) — deliberate simplification or bug? | **Unclear** | Dormant here (periodic mode) but wrong in perpetual mode. |
| 12 | Exact semantics of `SaleLedger.Marked` (guards all four balance setters). | **Unclear** | Controls which invoices are eligible for balance updates. |

---

## 17. Accountant-validation checklist

**Every item below must be confirmed by a qualified accountant before any rebuild decision is finalised.** Items are ordered by materiality. Nothing here is a recommendation — these are questions about existing behaviour whose answers are needed to specify the new system.

### A. Foundational — must be answered first

| # | Question to confirm | Evidence to show the accountant |
|---|---|---|
| A1 | **Is the PKR 214.3 M cash balance and the PKR ~190 M supplier balance a true book position, or an artefact of never recording payments?** If artefact, what is the real cash and payables position at cut-over? | §7.3, §15.3; `GLHeader = 0` |
| A2 | **Confirm the intended opening balance sheet.** Only one opening entry exists (Dr Purchase / Cr Capital 11,873,579 via Opening Purchase, 2025-01-01). No opening cash, bank, receivables, payables or fixed assets. Is this correct? | §8.2 |
| A3 | **Confirm that cost of goods sold has never been booked** and agree the correct COGS treatment (periodic vs perpetual) for the new system. Line-level cost data exists (`SaleDetail.AvgPrice`, total 193,957,857). | §10.4, §4.3, `InventorySystemUsed = 'P'` |
| A4 | **Confirm that all 1,542 stock adjustments are correctly excluded from the GL** (they are, because `AccCode IS NULL` on every one). Agree the correct Dr/Cr treatment for stock increase and decrease going forward, and which accounts to create under sub-accounts 18/19 (currently empty). | §13.3 |
| A5 | **Confirm the sign convention** to be used in the income statement and whether the legacy credit-negative presentation must be preserved for comparability. | §10.3 |

### B. Posting-rule confirmations

| # | Rule to confirm | Source |
|---|---|---|
| B1 | Cash sale: **Dr Cash (2) / Cr Sales (6)**, customer carried only as `AlternateAccCode` — confirm the customer should have no ledger balance. | §4.1, §3.4 |
| B2 | Sale return: **Dr Sales Return (8) / Cr Cash (2)** as a gross-up, not a reversal of the original entry. | §13.1 |
| B3 | Purchase (periodic): **Dr Purchase (1) / Cr Supplier**; inventory account 7 never touched. | §4.2 |
| B4 | Purchase return: **Dr Supplier / Cr Purchases Returns (12)**. | §13.2 |
| B5 | Opening purchase (`PurCatCode = 3`): **Cr Capital (5)** rather than an opening-stock or suspense account. | §8.2 |
| B6 | Opening purchase return (`PRCatCode = 6`): **Dr Capital (5)**. | §4.2 |
| B7 | Control accounts receive amounts **net** of advance income tax and FBR fee; counterparties receive **gross plus** sales tax. | §3.3 |
| B8 | Payroll five-leg structure: gross earnings Dr employee account; advance Cr advance account; deductions Cr deduction accounts; net Cr Payroll Payable (26); payment Dr Payroll Payable / Cr paid-via account. | §4.5 |
| B9 | Cashier shift: excess cash Dr Cash / Cr difference account; short cash Dr difference account / Cr Cash. | §4.6 |
| B10 | Goods issue Dr user account / Cr Goods Issued (30); goods receipt Dr Goods Receipt (31) / Cr user account — in periodic mode. | §4.3 |

### C. Tax confirmations

| # | Question | Source |
|---|---|---|
| C1 | **Is it correct that output GST on goods is credited to account 3 SALES TAX RECEIVEABLES, an ASSET?** Current net credit balance 204,612 sits inside an asset account. | §12.1(a) |
| C2 | Confirm services output tax correctly uses liability account 27 while goods uses asset account 3 — is this asymmetry intended? | §12.1(a) |
| C3 | Confirm advance income tax on purchase → asset 35 and on sale → liability 36. Confirm `ApplyAdvanceIncomeTaxInSale = 'N'` is correct. | §12.1(b) |
| C4 | Confirm FBR POS fee of Re. 1.00 per sale invoice, reversed on returns, accrued to liability 37 (net 262,422). Confirm remittance/clearing process. | §12.1(c) |
| C5 | Confirm that **no sale invoice carries invoice-level sales tax** (`SaleLedger.SalesTax = 0` on all 291,361 rows) is correct for this pharmacy's tax status. | §12.2 |
| C6 | Confirm input-tax recoverability treatment given input and output GST net inside one account. | §12.1(a) |

### D. Rounding, precision and reconciliation

| # | Question | Source |
|---|---|---|
| D1 | Confirm rounding to **whole rupees** on sale, sale return and purchase documents (all three preferences = 0) is the intended policy. | §14.2 |
| D2 | Confirm the three-level nested rounding in the tax computation is acceptable, and agree a tolerance for reconciliation. | §14.2 |
| D3 | Confirm hard-coded whole-rupee rounding on adjustments, issues and receipts. | §14.2 |
| D4 | Confirm `numeric(15,2)` is sufficient headroom for the ledger, and agree the FBR fee cap issue (`numeric(5,2)` = max 999.99). | §14.1 |
| D5 | Agree the reconciliation procedure between `SaleLedger.OutstandingAmt` and the GL customer balance (none exists today). | §6.1, §16 item 9 |

### E. Controls, audit and period

| # | Question | Source |
|---|---|---|
| E1 | **Confirm that amending a posted invoice by deleting its GL rows and silently re-deriving is unacceptable going forward**, and agree the reversing-entry policy for the new system. | §9.3 |
| E2 | Agree the accounting-period definition, close procedure and lock rule — **none exists today**. | §9.1 |
| E3 | Agree the year-end retained-earnings roll-forward — **none exists today**. | §9.1 |
| E4 | Confirm who may change `Global` GT_ account bindings and what audit trail is required (today: anyone, none). | §2.6 |
| E5 | Confirm the `AutoPurgeVirtualGL` whole-ledger truncation switch must be removed. | §3.5 |
| E6 | Agree the required GL audit columns (created/modified/by/reversed-by) — `VirtualGl` has none. | §13.4 |
| E7 | Confirm the ageing policy: oldest-first (FIFO) settlement ignoring invoice-level allocation, buckets 0/1/31/61/91/121/151/181 days. | §6.3, §6.4 |
| E8 | Confirm discount treatment: discounts are netted into revenue and account 25 DISCOUNT RECEIVED/ALLOWED is never posted. Should discounts be separately disclosed? | §15.3 |
| E9 | Confirm single-currency (PKR) operation and that multi-currency is not required. | §11 |

---

## 18. Modernisation notes (Node / React / MySQL rebuild)

**All items in this section are `Recommended` — proposals for the new system, not descriptions of existing behaviour.**

1. **Replace lazy materialisation with transactional posting.** Write balanced journal lines inside the same database transaction as the source document. The `VirtualGl` rebuild-on-read model makes every balance enquiry a write, takes `TABLOCKX` on a 1 M-row table, and lets a single preference truncate the ledger. Model as immutable `journal_entry` / `journal_line` with a `DECIMAL(19,4)` amount, a `CHECK` that debits equal credits per entry, and a nightly integrity job.

2. **Preserve the `Global` account-binding indirection — it is genuinely good design.** Port the 81 `GT_*` keys to a typed, validated `account_bindings` configuration with FK constraints to the account table, plus change auditing. This is what makes the engine deployment-configurable.

3. **Flatten the four-level COA but keep the levels as attributes.** MainAccounts → CategoryAccounts → SubAccounts → Accounts is rigid. A recursive `accounts(id, parent_id, type, normal_balance)` tree with a materialised path gives the same reports plus arbitrary depth. Carry `normal_balance` explicitly so contra accounts (8, 12) stop being ambiguous.

4. **Make corrections explicit.** Replace the delete-and-re-derive pattern with reversing journal entries and an `amends_entry_id` link. Never hard-delete a ledger row. Add `created_at`, `created_by`, `reversed_by_entry_id`.

5. **Implement period close and locking — it does not exist today.** A `periods(id, start, end, status)` table with a posting guard, plus a year-end close that rolls revenue/expense into retained earnings.

6. **Build the trial balance and balance sheet server-side.** They have no recoverable definition; specify them fresh with the accountant (checklist §17 A5, E2). Do not attempt to reverse-engineer them from the compiled DataWindows.

7. **Fix the three confirmed defects during the port, not after:** `Fn_AccountBalance` ignoring `@Date`; the `AccCode IS NULL` filter that silences all stock adjustments; the unlinked-sale-return CGS estimated from selling price.

8. **Decide the COGS model deliberately.** The cost data exists (`SaleDetail.AvgPrice`) and the engine already computes per-invoice CGS — it is simply discarded in periodic mode. Perpetual inventory with real-time COGS posting is achievable on day one and removes the largest single gap in the current books.

9. **Replace the `ReportData` shared scratch table.** `DELETE reportdata` at the start of every report makes concurrent reporting unsafe. Use parameterised queries returning result sets, or per-session temp storage.

10. **Retire the `SP_CRS_*` duplicate engine.** If multi-branch consolidation is needed, implement it as a `branch_id` dimension on a single journal, not a parallel set of 11 procedures that must be kept in lockstep.

11. **Migration scope decision (needs A1/A2 answered first).** Given the settlement gap, the realistic options are (a) migrate balances only, opening the new system with an accountant-prepared opening balance sheet, or (b) migrate the full SV/SR/PV/PR history as analytical data while opening the GL fresh. Option (b) preserves 1.02 M rows of sales and supplier history without importing a fictional cash balance.

12. **Numeric policy.** Use `DECIMAL(19,4)` for all monetary storage, round only at presentation and at legally-mandated document totals, and record the applied rounding on the document. Eliminate the `numeric(5,2)` FBR-fee cap and the `numeric(12,2)` narrowing in legacy report temp tables.

13. **Single currency.** Multi-currency is a schema placeholder with no conversion logic anywhere. Build PKR-only, and add currency later behind a proper FX-revaluation design if ever needed.

---

*End of document 07 — Accounting Logic.*
