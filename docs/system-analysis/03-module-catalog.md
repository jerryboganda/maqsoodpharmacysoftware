# 03 — Module Catalog (Authoritative)

**System:** WASEELA ABUZAR V3 — vendor "Abuzar"/"Waseela" — deployment **"Fazal Din PP19"** (retail pharmacy, Pakistan)
**Analysis stage:** Stage 3 — Module Discovery & Classification (backbone document)
**Document owner:** Modernization analysis workstream
**Date of analysis:** 2026-08-01 / 2026-08-02
**Database analysed (live, read-only):** `FazalDinPP19DataBaseV2` on `localhost\SQLEXPRESS` (SQL Server 2019 Express, compat level 100)

---

## Purpose of this document

This is the **authoritative catalogue of every module in the product**, classified by whether it is actually used at the Fazal Din PP19 deployment, and what should happen to it in the Node/React/MySQL rebuild.

Because **no application source code exists** (zero `.pbl` / `.srw` / `.sru` / `.srd` / `.pbt` files survive — only `abuzar.exe` plus 117 compiled `.pbd` libraries), module discovery is reconstructed from **three independent, converging evidence sources** and cross-checked against real transaction volumes.

---

## Evidence sources used

| # | Source | What it proves | Location |
|---|--------|----------------|----------|
| E1 | **`dbo.Module`** (57 rows) — the application's own module registry | Canonical list of transactional module identities as the vendor named them | Live DB, dumped in full in §2.1 |
| E2 | **`dbo.Rights` (483) + `dbo.RightsCategory` (19) + `dbo.GroupRights` (720)** | The application's **menu tree**, reconstructed from `Rights.RightName` (full menu path) and `Rights.IndicesString` (tree order). This is the closest thing to a screen inventory that survives. | Live DB, dumped to `…/scratchpad/rights_tree.txt` (486 rows) |
| E3 | **117 compiled `.pbd` libraries** | Each `.pbd` is one PowerBuilder library = one module's windows/datawindows. Names are self-describing. | `E:/Pharma Software/V2_AbuzarSoftware/Application/*.pbd` |
| E4 | **`dbo.PreferencesCategory` (37) + `dbo.PreferencesSubCategory` (155) + `dbo.SoftwarePreferences` (1,352)** | The configurable feature-flag surface, organised by module. A preferences category existing = the module exists in the product. | Live DB, dumped in §2.4 |
| E5 | **`dbo.ConfigSetting` (9 rows)** | **Master kill-switches.** Decisive proof of which optional subsystems are OFF at this deployment. | Live DB, dumped in §2.5 |
| E6 | **`dbo.Global` (79 rows)** | Company-level GL account map (`GT_*` → account codes). Proves which accounting sub-systems are wired. | Live DB, dumped in §2.6 |
| E7 | **`dbo.InterfaceSetting` (725 rows)** | Per-module column layout/visibility config, keyed by `ModuleId` → proves which module screens are grid-driven and how wide they are. | Live DB, §2.7 |
| E8 | **762 tables + real row counts** | Used vs dormant. 507 tables (66%) are completely empty. | `…/scratchpad/table_rowcounts.tsv` |
| E9 | **762 programmable objects, full source** (643 procs, 74 functions, 34 views, 10 triggers, 1 rule) | The authoritative business logic. Serves as the "API layer". | `…/scratchpad/db_modules_full.sql` (2.48 MB) |
| E10 | **11,414 columns / 1,730 FK columns / 1,037 PK columns** | Schema shape. | `…/scratchpad/table_columns.tsv`, `foreign_keys.tsv`, `primary_keys.tsv` |
| E11 | **Filesystem layout** | Companion executables, fiscalization bridge, backup artefacts, junk. | `E:/Pharma Software/V2_AbuzarSoftware/` |
| E12 | **`E:/Pharma Software/ABUZAR_V2_RECOVERY_JOURNAL.md`** | Environment ground truth. | Project root |

**Deployment data window (Verified):** all transactional tables start **2025-01-01** and run to **2026-07-31**.
`Evidence: SELECT MIN(Date), MAX(Date) FROM SaleLedger → 2025-01-01 17:12:55 … 2026-07-31 18:41:03`; `SoftwarePreferences.appname = 'ABUZAR V3 01.01.2025'`. This is ~19 months of live operation.

---

## Evidence-label legend (applies to EVERY claim in this document)

| Label | Meaning |
|-------|---------|
| **Verified** | Read directly in a stored procedure / trigger / view / schema / live data. Cited. |
| **Strongly Inferred** | Multiple independent evidence sources converge; no single direct read. |
| **Unclear** | Evidence is ambiguous or contradictory. Requires human confirmation. |
| **Missing** | The capability is expected but no evidence of it exists. |
| **Deprecated** | Superseded artefact still present in the DB/filesystem. |
| **Broken/Incomplete** | Present but demonstrably non-functional or half-wired. |
| **Recommended** | A **proposal for the NEW system**. NOT an existing feature. Never confuse with the above. |

> **Rule enforced throughout:** an empty table proves **NON-USE at this deployment**, never that the feature is absent from the product. Both facts are stated separately for every Tier 2 module.

---

## Status vocabulary for modules

| Status | Definition |
|--------|-----------|
| **Verified-and-USED** | Module exists AND carries real transaction volume at Fazal Din PP19. |
| **Verified-but-DORMANT** | Module demonstrably exists in the product (registry / rights / .pbd / procs / tables) but has **zero business rows** here. |
| **Deprecated** | Legacy artefact of a prior system or prior version, retained but superseded. |
| **Broken/Incomplete** | Wired but with a demonstrable functional gap. |
| **Unclear** | Cannot be classified without owner/vendor input. |

---

## Modernization recommendation vocabulary

`Retain` · `Simplify` · `Redesign` · `Merge` · `Split` · `Deprecate` · `Remove-after-approval` · `Requires-clarification`

All are **Recommended** (proposals), never statements about the existing system.

---

# 1. MASTER SUMMARY TABLE

Row counts are the **largest business table** owned by the module (full table lists appear per module). "—" = module owns no transactional table.

## Tier 1 — Pharmacy Core (deep rebuild scope)

| # | Module | Tier | Status | Headline rows | Recommendation |
|---|--------|------|--------|---------------|----------------|
| T1-01 | Item Master & Item Basic Data | 1 | **Verified-and-USED** | `Item` 30,052 (28,893 active) | **Simplify** (148-col table → normalised core + pharmacy extensions) |
| T1-02 | Item Pricing, Price Policy & Price Change | 1 | **Verified-and-USED** | `PricePolicy` 30,052 / `PricePolicyDetail` 30,052 | **Redesign** (5 sale prices + policy engine → one rules engine) |
| T1-03 | Inventory / Stock & Batch Management | 1 | **Verified-and-USED** | `GodownDetail` 6,164 batches; `StockReport` 3,215,967 | **Redesign** (snapshot table → event-sourced ledger) |
| T1-04 | Expiry Management | 1 | **Verified-and-USED (report only)** | `GodownDetail.Expiry`; 57 expired-but-in-stock batches | **Retain + extend** |
| T1-04b | Expiry Intimation (supplier return workflow) | 1 | **Verified-but-DORMANT** | `ExpiryIntimation` 0 | **Requires-clarification** |
| T1-05 | Purchasing (Pack / Loose / Opening) | 1 | **Verified-and-USED** | `Purledger` 6,419 / `Purdetail` 113,082 | **Retain, Simplify** |
| T1-06 | Purchase Orders | 1 | **Verified-and-USED** | `PurOrderHeader` 2,810 / `PurOrderDetail` 108,423 | **Retain** |
| T1-07 | Purchase Returns | 1 | **Verified-and-USED** | `PRLedger` 634 / `PRdetail` 2,481 | **Retain** |
| T1-08 | Sales & Invoicing (Retail cash sale) | 1 | **Verified-and-USED** | `SaleLedger` 291,361 / `Saledetail` 620,525 | **Redesign** (148-col header → lean core) |
| T1-09 | Point of Sale (POS) | 1 | **Unclear** (registry+prefs exist; sales carry `SaleCatCode=3`, not a POS category) | — | **Requires-clarification** |
| T1-10 | Sale Returns | 1 | **Verified-and-USED** | `SRLedger` 30,704 / `SRdetail` 44,563 | **Retain** |
| T1-11 | Sale Orders | 1 | **Verified-but-DORMANT** | `SaleOrderHeader` 0 | **Deprecate for v1** |
| T1-12 | Quotations | 1 | **Verified-but-DORMANT** | `QuotationHeader` 0 | **Deprecate for v1** |
| T1-13 | Sale Templates | 1 | **Verified-and-USED** | `SaleTemplateHeader` 93 / detail 320 | **Retain, Simplify** |
| T1-14 | Refused Sales (lost-sale capture) | 1 | **Verified-but-DORMANT** | `RefusedSaleHeader` 0 | **Retain in v2** (high business value) |
| T1-15 | Deleted-Sale-Item audit log | 1 | **Verified-and-USED** | `DeletedSaleItem` 235,887 | **Redesign** → unified audit log |
| T1-16 | Customers | 1 | **Verified-but-TRIVIALLY-USED** | `Customer` 2 rows | **Redesign** (walk-in model) |
| T1-17 | Suppliers | 1 | **Verified-and-USED** | `Supplier` 235; `ItemSuppliers` 22,246 | **Retain** |
| T1-18 | Manufacturers / Goods Companies | 1 | **Verified-and-USED** | `Manufacturer` 838 | **Retain** |
| T1-19 | Receipts / Payments / Dues | 1 | **Verified-but-DORMANT** | `ReceiptHeader` 0, `DueSatisfyHeader` 0 | **Requires-clarification** |
| T1-20 | Accounting / GL (auto-posted) | 1 | **Verified-and-USED** | `VirtualGl` 1,015,581 | **Redesign** (see §T1-20 gaps) |
| T1-21 | Accounting Vouchers (manual JV/CP/CR/BP/BR) | 1 | **Verified-but-DORMANT** | `TransactionHeader` 0; all 22 `VocherCategory.Counter = 0` | **Retain in v2** |
| T1-22 | Chart of Accounts | 1 | **Verified-and-USED** | `Accounts` 264 / `SubAccounts` 29 / `MainAccounts` 5 / `CategoryAccounts` 13 | **Retain, Simplify** |
| T1-23 | Tax engine (GST / unit sales tax / adv. income tax) | 1 | **Verified-and-USED** | `SalesTaxSchedule` 7, `TaxCategory` 3 | **Redesign** |
| T1-24 | **FBR Fiscalization (POS invoice numbers)** | 1 | **Verified-and-USED — mission critical** | 290,922 of 291,361 invoices fiscalized (99.85%) | **Redesign** (must be rebuilt first-class) |
| T1-25 | FBR Digital Invoicing (PRAL DI) | 1 | **Verified-but-DORMANT (configured, not enabled)** | `Digitalized='N'` on all 291,361 | **Retain, build-ready** |
| T1-26 | Reporting engine (~240 report rights) | 1 | **Verified-and-USED** | 240 of 483 rights are reports | **Redesign** (see `10-reports-catalog.md`) |
| T1-27 | Dashboard | 1 | **Verified-but-UNCONFIRMED-USE** | 10 dashboard prefs; `dashboard.pbd` | **Redesign** |
| T1-28 | Users, Groups & Rights | 1 | **Verified-and-USED** | `Users` 9, `UserGroups` 9, `Rights` 483, `GroupRights` 720 | **Redesign** (plaintext passwords — Critical) |
| T1-29 | Settings / Preferences / Interface Setting | 1 | **Verified-and-USED** | `SoftwarePreferences` 1,352; `InterfaceSetting` 725 | **Simplify** (drastic cull) |
| T1-30 | Barcode & Label printing | 1 | **Verified-and-USED** | 18 barcode prefs; `barcodecomponents.pbd`, `labels.pbd` | **Retain, Simplify** |
| T1-31 | Stock Adjustments (increase/decrease) | 1 | **Verified-and-USED — but GL-BROKEN** | `AdjHeader` 1,542 / `AdjDetail` 11,181 | **Redesign** (see Critical risk) |
| T1-32 | Adjustment Buffer (stock-take staging) | 1 | **Verified-and-USED** | `AdjBufferHeader` 1,061 / detail 12,270 | **Merge** into T1-31 |
| T1-33 | Inter-Godown Transfers | 1 | **Verified-but-DORMANT** | `Godown` = 1 row → structurally impossible | **Remove-after-approval** |
| T1-34 | Issues / Issue Requests (internal consumption) | 1 | **Verified-but-DORMANT** | `IssueHeader` 0 | **Deprecate for v1** |
| T1-35 | Cashier Shift & Cashier Job Management | 1 | **Verified-but-DORMANT** | `CashierShift` 0, `CashierActivity` 0 | **Retain in v2** (real retail need) |
| T1-36 | Backup & Database Maintenance | 1 | **Verified-and-USED — partially repaired** | `DBCC_History` 767 | **Redesign** |
| T1-37 | Item Alerts / Notes / Restrictions | 1 | **Verified-and-USED (light)** | `ItemNotes` 30,046; `ItemAlert` 5 | **Retain, Simplify** |
| T1-38 | Data Export Utilities (distributor feeds) | 1 | **Verified-but-UNCONFIRMED-USE** | 11 named pharma-distributor exports | **Requires-clarification** |
| T1-39 | Item / Price change history & audit | 1 | **Verified-and-USED** | `ItemLog` 110,329; `PriceChanges` 8 | **Redesign** → unified audit |
| T1-40 | Multi-entry / bulk basic-data wizards | 1 | **Verified-and-USED** | 5 `multientry*.pbd` libraries | **Retain, Simplify** |
| T1-41 | Printing & print formats | 1 | **Verified-and-USED** | 5 `sprnt*.pbd` + 4 `*printouts.pbd` | **Redesign** |
| T1-42 | Sales-history caches | 1 | **Verified-and-USED** | `PreviousSaleHistory` 94,317; `LastPurchaseHistory` 9,746 | **Remove-after-approval** (derive live) |

## Tier 2 — Present in the product but DORMANT here (catalogue only, defer)

| # | Module | Tier | Status | Rows | Recommendation |
|---|--------|------|--------|------|----------------|
| T2-01 | Hospital / Patient / Clinic | 2 | **Verified-but-DORMANT** | `Patient` 0 (+30 empty clinical tables) | **Deprecate for v1** |
| T2-02 | E-Prescription | 2 | **Verified-but-DORMANT** | `PrescriptionHeader` 0 | **Deprecate for v1** |
| T2-03 | Patient Visits / Appointments | 2 | **Verified-but-DORMANT** | 9 empty `Visit*` tables | **Deprecate for v1** |
| T2-04 | Lab / Diagnostic / Services vertical | 2 | **Verified-but-DORMANT** | 40 empty `Service*` tables | **Deprecate for v1** |
| T2-05 | School / Education | 2 | **Verified-but-DORMANT** | `Student` 0 (+13 empty) | **Remove-after-approval** |
| T2-06 | HR / Employee / Payroll | 2 | **Verified-but-DORMANT** | 24 empty `EMP_*` tables | **Deprecate for v1** |
| T2-07 | Employee Attendance / Biometrics | 2 | **Verified-but-DORMANT** | `EMP_Attendance` 0; `EMP_Finger` 10 (device seed) | **Deprecate for v1** |
| T2-08 | Hotel / Guest | 2 | **Verified-but-DORMANT** | 9 empty `Guest*` tables | **Remove-after-approval** |
| T2-09 | Manufacturing / Production / Recipe | 2 | **Verified-but-DORMANT** | `ProdHeader` 0, `Recipe` 0 | **Remove-after-approval** |
| T2-10 | Packing / Work Orders | 2 | **Verified-but-DORMANT** | `PackingJob` 0, `WorkOrder` 0 | **Remove-after-approval** |
| T2-11 | Multi-branch CRS sync | 2 | **Verified-but-DORMANT — switch OFF** | 69 empty `CRS_*` tables; `AllowCRSDataTransfer='N'` | **Deprecate for v1** |
| T2-12 | Waseela Mini (companion/mobile export) | 2 | **Verified-but-DORMANT — switch OFF** | `WaseelaMiniFunctions='N'` | **Deprecate for v1** |
| T2-13 | Waseela DropBox (inter-site document exchange) | 2 | **Verified-but-DORMANT — switch OFF** | `WaseelaDropBoxVisibility='N'` | **Deprecate for v1** |
| T2-14 | Data Carry DB / cross-database transfer | 2 | **Verified-but-DORMANT — switch OFF** | `AllowCrossDatabaseDataTransfer='N'`; `TransferableData` 176 (config only) | **Deprecate for v1** |
| T2-15 | Loyalty / membership | 2 | **Verified-but-DORMANT** | 6 empty `Loyalty*` tables | **Retain in v2** |
| T2-16 | SMS notifications | 2 | **Verified-but-DORMANT — switch OFF** | `AllowSMSFunctions='N'`; 17 `VIEW_SMS_*` views exist | **Retain in v2** |
| T2-17 | Email / SMTP | 2 | **Verified-but-DORMANT** | `EmailTemplate` 0; 7 SMTP prefs | **Retain in v2** |
| T2-18 | Contact management / CRM | 2 | **Verified-but-DORMANT** | `ContactCard` 0 | **Remove-after-approval** |
| T2-19 | Advanced Sale / Advanced Purchase | 2 | **Verified-but-DORMANT** | `AdvSaleLedger` 0, `AdvPurHeader` 0 | **Remove-after-approval** |
| T2-20 | Proforma Sale / Proforma Purchase | 2 | **Verified-but-DORMANT** | `ProformaPurDetail` 0 | **Remove-after-approval** |
| T2-21 | Bill Summary (consolidated billing) | 2 | **Verified-but-DORMANT** | `BillSummary` 0 | **Remove-after-approval** |
| T2-22 | Installments / hire-purchase | 2 | **Verified-but-DORMANT** | 6 empty `Installment*` tables | **Remove-after-approval** |
| T2-23 | Post-dated cheques (receivable & payable) | 2 | **Verified-but-DORMANT** | `View_PrintPostDatedCheques` exists; no data | **Retain in v2** |
| T2-24 | Aging analysis / credit control | 2 | **Verified-but-DORMANT** | `AgingInterval` 1 / detail 8 (seed only) | **Deprecate for v1** |
| T2-25 | Debit / Credit Notes | 2 | **Verified-but-DORMANT** | `Notes` 0, `NotesDetail` 0 | **Retain in v2** |
| T2-26 | Incentive Sheet / sales commission | 2 | **Verified-but-DORMANT** | `IncentiveSheet` 0; `SalesMan` 1 | **Remove-after-approval** |
| T2-27 | Multi-Godown / warehouse network | 2 | **Verified-but-DORMANT** | `Godown` 1 | **Remove-after-approval** |
| T2-28 | Garments / apparel vertical | 2 | **Verified-but-DORMANT** | `ItemSize`/`ItemColour`/`ItemFabric`… all 1–2 seed rows | **Remove-after-approval** |
| T2-29 | Item Conversion / meter items | 2 | **Verified-but-DORMANT** | `ItemConversionHeader` 0, `ItemMeter` 0 | **Remove-after-approval** |
| T2-30 | Vehicle / transport / delivery | 2 | **Verified-but-DORMANT** | `Vehicle` 1, `TransportRoute` 1 | **Remove-after-approval** |
| T2-31 | Job Schedule / automation engine | 2 | **Verified-but-DORMANT** | no job rows; `sp_ActivateJob`, `sp_AdjustJobSchedule` exist | **Redesign** |
| T2-32 | Customer Licences & Sites | 2 | **Verified-but-DORMANT** | `CustomerSite`/licence tables empty | **Remove-after-approval** |
| T2-33 | Document gallery / image attachments | 2 | **Verified-but-LIGHTLY-USED** | `ItemImage` 100 | **Requires-clarification** |

## Tier 3 — Legacy / Deprecated artefacts

| # | Artefact group | Tier | Status | Rows | Recommendation |
|---|----------------|------|--------|------|----------------|
| T3-01 | `cmh_*` staging (prior system import) | 3 | **Deprecated** | 13,942 across 12 tables | **Remove-after-approval** (archive first) |
| T3-02 | `*Dump` / `*Mod` / `*Modified` invoice clones | 3 | **Deprecated** | all 0 | **Remove-after-approval** |
| T3-03 | `*Log` shadow-copy tables | 3 | **Deprecated / partly used** | `ItemLog` 110,329; others 0 | **Redesign** into one audit log |
| T3-04 | `Rightsclone` + `temp_GroupRights` | 3 | **Deprecated** | 2,094 + 6,265 | **Remove-after-approval** |
| T3-05 | `items_corrupted` | 3 | **Broken/Incomplete** (evidence of a past stock corruption event) | 3 | **Remove-after-approval** (preserve as incident record) |
| T3-06 | `IMP_*` import staging | 3 | **Deprecated** | all 0 | **Remove-after-approval** |
| T3-07 | `SheerazConvert` / `OldSheerazConvert` migration procs | 3 | **Deprecated** | — | **Remove-after-approval** |
| T3-08 | `sp_test1`, `sp_Test2`, `V_Temp`, `dt_verstamp003` | 3 | **Deprecated** | — | **Remove-after-approval** |
| T3-09 | `Junk/` folder (2024-11-11 snapshot, V2 DB dump, old FiscalizationApp) | 3 | **Deprecated** | — | **Remove-after-approval** (archive) |
| T3-10 | `SP_WayToMoon` licensing/anti-tamper probe (requires `xp_cmdshell`) | 3 | **Deprecated — security liability** | — | **Remove** in new system |
| T3-11 | `PBD_Backup/` duplicate library set | 3 | **Deprecated** | — | **Remove-after-approval** |

---

## Headline counts

| Metric | Value | Evidence |
|--------|-------|----------|
| Modules in `dbo.Module` registry | **57** | §2.1 |
| Compiled application libraries (`.pbd`) | **117** (+3 PB runtime) | §2.3 |
| Rights (menu leaves + permission toggles) | **483** | `dbo.Rights` |
| …of which report-related | **240 (49.7%)** | §2.2 |
| Preference categories (= configurable modules) | **37** | `dbo.PreferencesCategory` |
| Preference settings | **1,352** | `dbo.SoftwarePreferences` |
| Tables | **762** | `table_rowcounts.tsv` |
| …empty (unused here) | **507 (66.5%)** | `table_rowcounts.tsv` |
| Stored procedures | **643** | `objects_catalog.tsv` |
| Tier 1 modules (rebuild scope) | **44** | this document |
| Tier 2 modules (defer / catalogue) | **33** | this document |
| Tier 3 legacy artefact groups | **11** | this document |

---

# 2. RAW EVIDENCE BASE

## 2.1 `dbo.Module` — the application's own module registry (57 rows, dumped in full)

**Verified.** `Evidence: SELECT * FROM dbo.Module` (columns: `Module INT`, `Name VARCHAR`).

This is the **strongest single piece of evidence** about what modules the product ships. Note the ID blocks: 1–53 are transactional/document modules; 101–104 are a separate cash-transaction block.

| ID | Name | Tier | Used here? |
|----|------|------|-----------|
| 1 | SALES | 1 | Yes (2,131 invoices stamped) |
| 2 | SALES RETURN | 1 | Yes |
| 3 | PURCHASE | 1 | Yes |
| 4 | PURCHASE RETURN | 1 | Yes |
| 5 | ISSUE | 1 | No |
| 6 | RECEIPT | 1 | No |
| 7 | ADJUSTMENT | 1 | Yes |
| 8 | TRANSFER | 1 | No |
| 9 | ITEM | 1 | Yes |
| 10 | CASH SALE | 1 | Yes |
| 11 | CREDIT SALE | 1 | No (practically) |
| 12 | SALE ORDER | 1 | No |
| 13 | TRANSFER (TARGET) | 1 | No |
| 14 | PATIENT REGISTRATION | 2 | No |
| 15 | QUOTATION | 1 | No |
| 16 | PURCHASE ORDER | 1 | Yes |
| 17 | PRESCRIPTION | 2 | No |
| 18 | PATIENT PROFILE | 2 | No |
| 19 | VISIT APPOINTMENT | 2 | No |
| 20 | PATIENT VISIT | 2 | No |
| 21 | ADVANCED SALE | 2 | No |
| 22 | CASH SERVICE | 2 | No |
| 23 | CREDIT SERVICE | 2 | No |
| 24 | CUSTOMER | 1 | Yes (2 rows) |
| 25 | IN-PATIENT SALE | 2 | No |
| 26 | PROFORMA SALE | 2 | No |
| 27 | IN-PATIENT SERVICE | 2 | No |
| 28 | CASH SERVICE RETURN | 2 | No |
| 29 | CREDIT SERVICE RETURN | 2 | No |
| 30 | IN-PATIENT SERVICE RETURN | 2 | No |
| 31 | CASH SALE RETURN | 1 | Yes |
| 32 | CREDIT SALE RETURN | 1 | No |
| 33 | BUFFER SALE RETURN | 1 | No |
| 34 | IN-PATIENT SALE RETURN | 2 | No |
| 35 | POINT OF SALE | 1 | Unclear |
| 36 | PATIENT ADMISSION | 2 | No |
| 37 | RECEIPT TRANSACTION | 1 | No |
| 38 | PAYMENT TRANSACTION | 1 | No |
| 39 | SALE TEMPLATE | 1 | Yes (93 templates) |
| 40 | ISSUE REQUEST | 1 | No |
| 41 | Service Basic Data | 2 | No |
| 42 | GUEST CHECK IN | 2 | No |
| 43 | Purchase Of Services | 2 | No |
| 44 | Purchase Return Of Services | 2 | No |
| 45 | A/C VOUCHERS | 1 | No |
| 46 | Customer License | 2 | No |
| 47 | Customer Site | 2 | No |
| 48 | Item Registration Request | 1 | No |
| 49 | Garments Basic Data Wizard | 2 | No |
| 50 | Installment Receipt | 2 | No |
| 51 | Sale Of Services | 2 | No |
| 52 | Sale Return Of Services | 2 | No |
| 53 | Change Item Price | 1 | Yes |
| 101 | Cash Receipt | 1 | No |
| 102 | Cash Receipt Against Sale | 1 | No |
| 103 | Cash Payment | 1 | No |
| 104 | Cash Payment Against Purchase | 1 | No |

### 2.1.1 `dbo.ModuleEvent` — which modules have lifecycle hooks (20 rows)

**Verified.** `Evidence: SELECT * FROM dbo.ModuleEvent`

| Event | Modules |
|-------|---------|
| **Posting** | 1 SALES, 2 SALES RETURN, 3 PURCHASE, 4 PURCHASE RETURN, 5 ISSUE, 6 RECEIPT, 7 ADJUSTMENT, 8 TRANSFER, 12 SALE ORDER, 16 PURCHASE ORDER, 22 CASH SERVICE, 23 CREDIT SERVICE, 45 A/C VOUCHERS |
| **Saving** | 14 PATIENT REGISTRATION, 19 VISIT APPOINTMENT, 46 Customer License, 50 Installment Receipt |
| **Finalized** | 12 SALE ORDER |
| **Admission / Discharge** | 36 PATIENT ADMISSION |

**Strongly Inferred:** these are **SMS/notification trigger points** — every `ModuleEvent` row has a corresponding `VIEW_SMS_*` view (see §2.8). `Evidence: dbo.GetAssociatedRecipientForSMS` + 17 `VIEW_SMS_*` views; `SP_CreateAutoTriggerSMS`.

### 2.1.2 `dbo.WindowType` — the app's screen archetypes (5 rows)

**Verified.** `Evidence: SELECT * FROM dbo.WindowType`

| WinType | Name | Meaning (Strongly Inferred) |
|---------|------|------------------------------|
| 1 | HeaderWindow | Document header pane (invoice-level fields) |
| 2 | PopUpHeaderWindow | Header shown as a modal |
| 3 | DetailWindow | Line-item grid |
| 4 | ListWindow | Saved-document browser |
| 5 | SearchListWindow | Lookup/search picker |

This confirms the UI pattern for every transactional module: **Header + Detail grid + List + Search picker**, with per-module column visibility driven by `InterfaceSetting`. This is the single most important UX fact for the rebuild.

### 2.1.3 `dbo.CashAccAllowedModule` (22 rows) — modules that can take cash

**Verified.** Modules 10, 11, 14, 22, 23, 25–38, 42, 43, 44 may be assigned a cash account. Of these, only **10 CASH SALE** is exercised here.

---

## 2.2 The reconstructed menu tree (from `dbo.Rights`)

**Verified.** `Evidence: SELECT RightCode, LevelIndex, MenuName, RightName FROM dbo.Rights ORDER BY IndicesString` → 486 rows dumped to `…/scratchpad/rights_tree.txt`. `Rights.RightName` stores the **full comma-separated menu path**, so the top-level application menu can be recovered exactly.

### Top-level menu bar (Verified)

| Menu root | Rights under it | Share |
|-----------|-----------------|-------|
| **Reports** | 240 | 49.7% |
| **Sales** | 77 | 15.9% |
| **Basic Data** | 51 | 10.6% |
| **Purchase** | 38 | 7.9% |
| **Maintenance** | 33 | 6.8% |
| **Manage** | 25 | 5.2% |
| **Transactions** | 19 | 3.9% |
| **E-Prescription** | 2 | 0.4% |
| **Item Search Window** | 1 | 0.2% |

> **Key finding (Verified):** almost **half the entire permission surface is reporting**. Any rebuild that treats reporting as an afterthought will fail acceptance.

### Second-level menu structure (Verified — abridged to Tier 1 relevance)

| Root | Children |
|------|----------|
| **Sales** | Cash Sale · Credit Sale · POS Sale · Sale Return · Sales Return · Open Sale Return · Quotation · Refused Sales · Services · Service Return · Rights |
| **Purchase** | Purchases (Pack) · Purchases (Loose) · Opening Purchase · Purchase Order · Purchase Return · Rights |
| **Basic Data** | Item · Customer · Supplier · Patient · Student · Sale Template · State/Province · Tax Category |
| **Transactions** | Accounting Vouchers · Payroll Activities · Post Dated Cheques Receivables · Post Dated Cheques Payables |
| **Maintenance** | Adjustment · Change Items Price · Change Item Discount Category Wise · Change Item Reorder Qty · Item Priority · Lock Item Batches · Discount Policy · Godown Preferences · Preferences · Interface Setting · Database Utilities · Import Historical Data · Inplace Initialization · Modify Last Transaction Date · Modify Sale Invoices · Update Item Basic Data · Update Item Suppliers · Production · Receipt · Change Password |
| **Manage** | Users · Groups · Group Allowed Price Setting · Group Wise Cash Account Setting · Group Wise Header Setting · Group Wise Supplier Category · Cashier Management · Control Panel · Drop Box · Job Schedule · Session Monitor |
| **Reports** | Sales Reports · Stock Reports · Purchase Reports · Purchase Return Reports · Accounts Reports · Daily Reports · Item Reports · Godown Reports · Issue Reports · Listing · RePrinting · Special Reports · CRS Reports · Patient Reports · Student Reports · Service Reports · Sales Order Reports · Production Reports · Employee Reports · Rights |

### `dbo.RightsCategory` (19 rows) — the product's own vertical taxonomy

**Verified.** `Evidence: SELECT * FROM dbo.RightsCategory`, with counts from `dbo.Rights`.

| Cat | Name | Rights | Tier |
|-----|------|--------|------|
| 1 | General | 430 | 1 |
| 13 | Special Module | 40 | 1 |
| 12 | Reports Accounts | 4 | 1 |
| 4 | Patient | 4 | 2 |
| 3 | Multigodown | 2 | 2 |
| 7 | Services | 2 | 2 |
| 16 | Student | 2 | 2 |
| 2 | Accounts | 1 | 1 |
| 18 | Payroll | 1 | 2 |
| 5 | Garments | 0 | 2 |
| 6 | POS | 0 | 1 |
| 8 | Due | 0 | 1 |
| 9 | In-Patient | 0 | 2 |
| 10 | Reports Header Wise | 0 | 1 |
| 11 | Reports Data Portability | 0 | 1 |
| 14 | Copied Sale Invoices | 0 | 1 |
| 15 | Advance Purchases | 0 | 2 |
| 17 | Guest | 0 | 2 |
| 19 | Installment | 0 | 2 |

**Verified:** this taxonomy is the vendor's own admission that the product is a **multi-vertical suite** (pharmacy + hospital + school + garments + hotel + payroll) sold from one codebase.

---

## 2.3 The 117 compiled `.pbd` libraries → module mapping

**Verified.** `Evidence: E:/Pharma Software/V2_AbuzarSoftware/Application/*.pbd` — 120 files, of which 3 (`pbdwr125`, `pbsoapclient125`, `pbwsclient125`) are PowerBuilder runtime, leaving **117 application libraries**.

| Domain | `.pbd` libraries | Tier |
|--------|------------------|------|
| **App shell / infrastructure** | `abuzarapp`, `components`, `functions`, `templates`, `lists`, `dropdowns`, `popupmenus`, `printer`, `psrviewer`, `dw2xls`, `graphcomponents`, `reportdwarg`, `reportformat`, `reportviewer` | 1 |
| **Item / basic data** | `singleentry`, `singleentryitem`, `multientry`, `multientryitem`, `multientryitemrespwin`, `multientrygroups`, `multientrypolicy`, `changeitemprice`, `labels`, `barcodecomponents`, `barcodefunctions` | 1 |
| **Sales** | `salewin`, `salerespwin`, `saleprintouts`, `salemodified`, `salemodreports`, `poscomponents`, `saleorder`, `quotation`, `proformasales`, `advancedsale` | 1 |
| **Sale returns** | `salereturncomponents`, `salereturnprintouts` | 1 |
| **Purchasing** | `purchasecomponents`, `purchaseprintouts`, `purchaseresponsewin`, `pocomponents`, `prcomponents`, `advancedpurchase`, `proformapurchase` | 1 |
| **Inventory / stock** | `adjustment`, `transfer`, `issuecomponents`, `issuereq`, `expiryintimation`, `godownreports`, `stockreports` | 1 |
| **Accounting** | `accounts`, `accountsext`, `accountsrespwin`, `accountstemplate`, `accountreports`, `financialreports`, `agingreports`, `duecomponents`, `receiptcomponents`, `receiptreports`, `notescomponents`, `billsummary` | 1 |
| **Customers / suppliers** | `custcomponents` | 1 |
| **Reporting** | `reports`, `reports_cust`, `salereports`, `salereportscomp`, `salereportscust`, `salereportsdet`, `salereportssumm`, `itemreports`, `issuereports`, `managementreports`, `mgmtcomp`, `specialreports`, `purchase&returnreports`, `dashboard` | 1 |
| **Print format banks** | `sprntatod`, `sprntetok`, `sprntlton`, `sprntotos`, `sprntttoz` (alphabetically partitioned sale-printout libraries) | 1 |
| **Admin / config** | `preferences`, `cashierjob`, `incentivesheet` | 1 |
| **Hospital / clinic (Tier 2)** | `patientcomponents`, `patientreports`, `patientvisitcomp`, `patientvaccinecomp`, `ipsale`, `ipservices`, `eprescriptionbasics` | 2 |
| **Services / lab (Tier 2)** | `servicecomponents`, `serviceheads`, `servicemodules`, `servicepurcomponents`, `servicereports`, `serviceresult`, `servicesaleprintouts`, `servicesalesatoh`, `servicesalescomp`, `servicesalesitop`, `servicesalesqtoz`, `servicesalesreturn` | 2 |
| **School (Tier 2)** | `studentcomponents` | 2 |
| **HR / payroll (Tier 2)** | `employee`, `useratten` | 2 |
| **Hotel / guest (Tier 2)** | `guestcomponents` | 2 |
| **Manufacturing (Tier 2)** | `packingmodule` | 2 |
| **Multi-branch CRS (Tier 2)** | `crscomponents`, `crsreports`, `datatransferapp`, `datatransfercomponents` | 2 |
| **SMS (Tier 2)** | `smscomponents`, `smswebservices` | 2 |
| **CRM (Tier 2)** | `contactmanagement` | 2 |

**Companion executables (Verified):**
- `abuzar.exe` — main application
- `mdsys.exe` — secondary utility executable (purpose **Unclear**; `mdsys.ext` present)
- `FiscalizationApp/fiscalizationapp.exe` — **separate PowerBuilder app acting as the local FBR fiscalization bridge**; see T1-24.
- `PBD_Backup/` — duplicate `.pbd` set (Tier 3).

---

## 2.4 Preferences taxonomy — the configurable feature surface

**Verified.** `dbo.PreferencesCategory` = 37 rows; `dbo.PreferencesSubCategory` = 155 rows; `dbo.SoftwarePreferences` = 1,352 rows.
`Evidence: SELECT pc.Name, COUNT(*) FROM SoftwarePreferences sp JOIN PreferencesSubCategory sc ON sc.SubCatCode=sp.SubCatCode JOIN PreferencesCategory pc ON pc.CatCode=sc.CatCode GROUP BY pc.Name`

| Preferences category | Settings | Tier | Note |
|----------------------|----------|------|------|
| Sale | **325** | 1 | Largest by far — includes FBR Fiscalization (sub-cat 66) and FBR Digital Invoicing (67) |
| Service | 232 | 2 | Lab/diagnostic vertical |
| Purchase | 170 | 1 | Includes Adv. Purchase + Purchase Register |
| General | 48 | 1 | Software defaults, backup, data-carry, group category rights |
| Purchase Order | 45 | 1 | |
| Purchase Of Service | 43 | 2 | |
| Point of Sale | 38 | 1 | Includes LCD display, cash drawer, barcode printer settings |
| Quotation | 36 | 1 | |
| Patient | 34 | 2 | |
| Accounts | 33 | 1 | |
| Issue | 32 | 1 | |
| Sale Return | 32 | 1 | |
| Receipt | 28 | 1 | |
| Cashier Job Activity | 24 | 1 | |
| Purchase Return | 23 | 1 | |
| Transfer | 23 | 1 | |
| BarCode | 18 | 1 | |
| Payroll | 18 | 2 | |
| Sale Order | 17 | 1 | |
| Others | 17 | 1 | Activity Monitor |
| Reports | 12 | 1 | |
| Bill Summary | 12 | 2 | |
| Basic Data | 11 | 1 | |
| Item Price Checker | 11 | 1 | |
| Employee Attendance | 10 | 2 | |
| Adjustment | 10 | 1 | |
| Dashboard | 10 | 1 | |
| Email | 7 | 2 | SMTP |
| Waseela Mini | 7 | 2 | |
| SMS | 6 | 2 | |
| Recipe | 6 | 2 | |
| Production | 6 | 2 | |
| Guest | 6 | 2 | |
| Item Inquiry | 5 | 1 | |
| Drop Box | 4 | 2 | |
| Student | 3 | 2 | |
| Item Price Adjustment | 1 | 1 | |

**Verified:** the sub-category names reveal the *shape* of the configurability — for the Sale module alone there are separate sub-categories for **Invoice Header Window Visibility**, **Item Detail Window Visibility**, **Invoice Footer Window Visibility**, **Initial Column Value**, **Column Captions**, **Other Functionality**, **Quarter Page Footer**, **Full/Half Page Footer**, **Full Page Warranty**, **Sale Invoice Comments**, **Signature On Sales Invoice**, plus **FBR Fiscalization Settings** and **FBR Digital Invoicing**.

> **Modernization implication (Recommended):** this is a *screen-painter-as-configuration* architecture. Roughly 60–70% of the 1,352 preferences exist only to show/hide/caption grid columns on a fat client. A React rebuild replaces almost all of them with responsive layout + a small role-based field-visibility model.

---

## 2.5 `dbo.ConfigSetting` — master kill-switches (9 rows, dumped in full)

**Verified.** `Evidence: SELECT * FROM dbo.ConfigSetting` — **all nine are `'N'`.**

| Setting | Value | Consequence |
|---------|-------|-------------|
| `allow_multiple_session` | **N** | One session per user |
| `AllowArchive` | **N** | Archival subsystem off — the DB grows unbounded |
| `AllowCrossDatabaseDataTransfer` | **N** | Data-Carry DB off (T2-14) |
| `AllowCRSDataTransfer` | **N** | **Multi-branch CRS sync off (T2-11)** |
| `AllowSMSFunctions` | **N** | SMS off (T2-16) |
| `AllowSourceServerConnections` | **N** | Parent/child server links off |
| `CloudServerSettings` | **N** | Cloud sync off |
| `WaseelaDropBoxVisibility` | **N** | DropBox off (T2-13) |
| `WaseelaMiniFunctions` | **N** | Waseela Mini off (T2-12) |

> This is the **single cleanest piece of evidence in the entire system** that the deployment is a standalone single-site pharmacy. Every distributed/multi-site/messaging subsystem is switched off at the root.

---

## 2.6 `dbo.Global` — company-level GL account map (79 rows)

**Verified.** `Evidence: SELECT * FROM dbo.Global` — maps a symbolic name (`GT_*`) to `TableName` + `Code`. Every posting procedure resolves accounts through this table, e.g. `SET @ln_invacc = (SELECT code FROM global WHERE name = 'GT_InventoryAcc')` in `SP_VirtualGL_Sales`.

**Wired and used by Tier 1 pharmacy posting (Verified):**

| Global key | Table | Code | Description |
|------------|-------|------|-------------|
| `GT_PurchaseAccount` | accounts | 1 | PURCHASES ACCOUNT |
| `GT_CashACC` | accounts | 2 | CASH IN HAND ACCOUNT |
| `GT_AdvanceSalesTaxACC` | accounts | 3 | SALES TAX RECEIVABLES ACCOUNT |
| `GT_PurExpPayableAcc` | accounts | 4 | PURCHASE EXPENSE PAYABLE A/C |
| `GT_EquityACC` | accounts | 5 | CAPITAL ACCOUNT |
| `GT_SalesACC` | accounts | 6 | SALES ACCOUNT |
| `GT_InventoryAcc` | accounts | 7 | INVENTORY ACCOUNT |
| `GT_SalesReturnACC` | accounts | 8 | SALES RETURNS ACCOUNT |
| `GT_CostOfGoodsSoldAcc` | accounts | 9 | COST OF GOODS SOLD ACCOUNT |
| `GT_PurchaseReturnsAccount` | accounts | 12 | PURCHASES RETURNS ACCOUNT |
| `GT_OpeningSupplierACC` | accounts | 18 | OPENING SUPPLIERS ACCOUNT |
| `GT_RetailSaleCustomerACC` | accounts | 19 | **CASH SALES-WALKING CUSTOMER A/C** |
| `GT_WholeSaleCustomerACC` | Accounts | 22 | CREDIT SALES-WALKING CUSTOMER A/C |
| `GT_DiscountRecAllowedAcc` | accounts | 25 | DISCOUNT RECEIVED/ALLOWED ACCOUNT |
| `GT_AdvIncomeTaxPur` | accounts | 35 | ADVANCE INCOME TAX ON PURCHASE |
| `GT_AdvIncomeTaxSale` | accounts | 36 | ADVANCE INCOME TAX ON SALE |
| **`GT_FBRPOSFeeAcc`** | accounts | **37** | **FBR POS SERVICE FEE PAYABLE A/C** |
| `GT_CashierCashDiffSuspAcc` | Accounts | 42 | Account to Report Cashier Cash Diff. |
| `GT_StockAdjIncrease` | subaccounts | 18 | STOCK ADJUSTMENT INCREASE |
| `GT_StockAdjDecrease` | subaccounts | 19 | STOCK ADJUSTMENT DECREASE |
| `GT_Store` | **godown** | **1** | **Default Godown for Sale** — proves single-warehouse |

**Present but unused here (Verified-but-DORMANT):** `GT_RevenueFromServices` (23), `GT_ExpensesOnServices` (24), `GT_PayrollPayableAcc` (26), `GT_PayrollSalaries`/`Wages`/`AdminSalaries`/`Deductions` (20–24), `GT_SalesTaxPayableOnServices` (27), `GT_WithHoldingTax*` (28, 29), `GT_GoodsIssuedAcc` (30), `GT_GoodsReceiptAcc` (31), `GT_RawMaterialsAcc` (32), `GT_WIPAcc` (33), `GT_ReceiptExpPayableAcc` (34), `GT_ProductInvAcc`/`ProductSalesAcc`/`OtheRevFrmProductsAcc`/`CostOfProductsSaleAcc` (38–41).

> **Strongly Inferred:** the presence of Raw-Materials / WIP / Goods-Issued / Payroll globals confirms manufacturing and payroll are *shipped* in the product; their absence from `VirtualGl` confirms they are *unused here*.

---

## 2.7 `dbo.InterfaceSetting` (725 rows) — per-module grid layout

**Verified.** `Evidence: SELECT ModuleId, COUNT(*) FROM dbo.InterfaceSetting GROUP BY ModuleId` (columns: `ModuleId`, `sequenceid`, `colname`, `colcaption`, `visibility`, `WinType`, `InterfaceGroup`).

| ModuleId | Module name | Configured columns |
|----------|-------------|--------------------|
| 9 | **ITEM** | **144** |
| 48 | Item Registration Request | 110 |
| 24 | CUSTOMER | 85 |
| 14 | PATIENT REGISTRATION | 66 |
| 11 | CREDIT SALE | 55 |
| 16 | PURCHASE ORDER | 53 |
| 10 | CASH SALE | 51 |
| 53 | Change Item Price | 41 |
| 41 | Service Basic Data | 34 |
| 49 | Garments Basic Data Wizard | 23 |
| 1 | SALES | 20 |
| 21 | ADVANCED SALE | 15 |
| 12 | SALE ORDER | 14 |
| 47 | Customer Site | 9 |
| 5 | ISSUE | 8 |

`Evidence: dbo.SaleInterface` (22 rows) enumerates the sale-family UI variants: POINT OF SALE (POS), CASH SALES, CREDIT SALES, CASH SERVICE, CREDIT SERVICE, PROFORMA SALE, IN-PATIENT SALE, IN-PATIENT SERVICE, CASH SALE RETURN, CREDIT SALE RETURN, IN-PATIENT SALE RETURN, BUFFER SALE RETURN, CASH SERVICE RETURN, CREDIT SERVICE RETURN, IN-PATIENT SERVICE RETURN, PATIENT REGISTRATION, PATIENT ADMISSION, RECEIPT TRANSACTION, PAYMENT TRANSACTION, GUEST CHECK IN, Purchase Of Services, Purchase Return Of Services.

> **Verified:** the ITEM screen alone exposes **144 configurable columns**. This is the clearest quantification of the "one screen, every vertical" bloat problem.

---

## 2.8 Stored-procedure families (the de-facto API layer)

**Verified.** 643 procedures. Grouped by naming family:

| Family | Count (approx) | Purpose | Tier |
|--------|----------------|---------|------|
| `SP_VirtualGL_*` | 19 | GL posting per document type | 1 |
| `SP_CRS_*` / `sp_CRS_*` | ~50 | Multi-branch sync | 2 |
| `sp_Post*` | ~35 | Document posting (sale, purchase, returns, adj, issue, service, payroll…) | 1/2 |
| `sp_Lock*` | ~17 | Pessimistic document locking | 1 |
| `SP_Update*InvBalance` | 8 | Outstanding-balance recalculation | 1 |
| `SP_WaseelaMini_*` | 11 | Companion-app export | 2 |
| `SP_DB_*` (DropBox) | ~17 | Inter-site document exchange | 2 |
| `sp_*_From_DataCarryDB` / `_To_DataCarryDB` | ~18 | Cross-DB transfer | 2 |
| `SP_Generate_Svc_*` | 8 | Service invoice generation | 2 |
| Report/crosstab procs (`SP_MONTHLYSALES*`, `SP_*WISESALES*`, `_CROSSTAB`) | ~40 | Reporting | 1 |
| Fiscalization (`SP_FiscalizeSaleInvoice`, `SP_FiscalizeSRInvoice`, `SP_GetSaleInvoice_JSON`, `SP_GetSRInvoice_JSON`, `SP_RequestHttpWebService`) | 5 | **FBR** | 1 |
| DB maintenance (`sp_BackupDB`, `SP_CheckDBIntegrity`, `SP_DBReindex`, `SP_RepairDB`, `SP_CheckTable`, `SP_AlterDB`, `SP_DropTemporaryTables`) | ~10 | Ops | 1 |
| Licensing (`SP_WayToMoon`) | 1 | Anti-tamper probe via `xp_cmdshell` | 3 |

**10 triggers (Verified)** — `Evidence: objects_catalog.tsv`:

| Trigger | Table | Purpose | Tier |
|---------|-------|---------|------|
| `Trig_Item_AfterUpdate_UpdateLastUpdate_TimeStamp` | Item | Stamp `LastUpdate` | 1 |
| `Trig_GodownDetail_AfterUpdate_LastUpdated` | GodownDetail | Stamp batch `LastUpdated` | 1 |
| `Trig_PurLedger_AfterUpdate_UpdatePOStatistics_For_Purchases` | Purledger | Roll PO fulfilment stats | 1 |
| `Trig_SrLedger_AfterInsert_UpdateTotalOfSaleReturnsInSaleLedger` | SRLedger | Maintain `SaleLedger.TotalOfSaleReturns` | 1 |
| `Trig_UserGroups_After_Update_Delete` | UserGroups | Security audit → `UserGroupsLog` | 1 |
| `Trig_EMP_Payroll_AfterUpdate_Paid` | EMP_Payroll | Payroll | 2 |
| `Trig_Patient_AfterUpdate_InActiveCount` | Patient | Clinic | 2 |
| `Trig_ItemPart_*` / `Trig_ItemPartInModel_*` (3) | ItemPart / ItemPartInModel | Automotive-parts vertical | 2 |

**34 views (Verified):** 17 are `VIEW_SMS_*` (notification payloads), 5 are `VIEW_WaseelaMini_*`, 1 `View_CRS_ItemStockPosition`, 1 `View_DB_DropBox`, 1 `View_PrintPostDatedCheques`, 1 `View_ItemNotes`, 1 `GetAssociatedRecipientForSMS`, 1 `V_Temp` (junk).

> **Verified:** only **2 of 34 views** (`View_ItemNotes`, `View_PrintPostDatedCheques`) belong to Tier 1. The view layer is almost entirely Tier 2 messaging/sync scaffolding.

---

# 3. TIER 1 — PHARMACY CORE (deep rebuild scope)

Every module below uses the same template: **Status · Business purpose · Target users · Features · Screens (.pbd) · Key stored procedures · Database tables (rows) · Dependencies · Evidence · Current problems · Modernization recommendation.**

---

## T1-01 — Item Master & Item Basic Data

| Field | Content |
|-------|---------|
| **Status** | **Verified-and-USED** |
| **Tier** | 1 |
| **Rows** | `Item` **30,052** (28,893 active / 1,159 inactive) |

**Business purpose.** The product catalogue. Every medicine/SKU sold by the pharmacy, with pack structure, pricing, tax attributes, narcotics flags, refrigeration flags, prescription-required flags, reorder levels, and supplier association.

**Target users.** Pharmacy manager / data-entry operator (item creation, price maintenance); cashier (read-only lookup during sale).

**Features (Verified from rights + schema).**
- Create/modify item, alias names, activeness toggle, item restriction, restricted-item assignment
- Per-item: 5 sale prices, purchase price, retail price, average price, 5 recent purchase prices, 5 sale discount %, flat discount, min sale price, max sale discount %
- Pharmacy-specific flags: `Prescribed`, `Refrigrated`, `AntiNorCotix` (narcotics), `PrintExpiry`, `ConfirmExpiry`, `PrintItemBatch`, `Restricted`, `AllowSaleInDecimalQty`, `Ingredients1/2`, `GenericCode`
- Pack structure: `PackUnits`, `PackingFactor`, `PackCapacity`, `TotalPieces`, `PrefferedSaleQty`, `AllowDue`
- Replenishment: `ReorderQty`, `OptimumQty`, `MinQty`, `ReorderLevel`, `OptimumLevel`, `GeneratePO`, `ConsiderInPO`
- Tax: `SalesTax`, `GSTPerc1`, `GSTPerc2`, `PackSalesTax`, `PackPurTax`, `Taxable`, `SalesTaxScheduleCode`, `PCTCode`
- Sale-limit controls: `CheckUpperSaleQtyLimit`, `UpperSaleQtyLimit`, `LockSalePrice`, `LockDiscPerc`, `AllowSalePriceBelowAvgPrice`
- Item alerts (silent / info / permission / prohibition), item notes, item images
- Bulk maintenance: *Update Item Basic Data*, *Update Item Suppliers*, *Change Item Reorder Qty*, *Change Item Discount Category Wise*, *Item Priority Setting*

**Screens (.pbd).** `singleentryitem`, `multientryitem`, `multientryitemrespwin`, `multientry`, `multientrygroups`, `multientrypolicy`, `singleentry`, `itemreports`, `lists`, `dropdowns`

**Key stored procedures ("APIs").**
| Procedure | Role |
|-----------|------|
| `SP_InsertBasicData` / `SP_UpdateBasicData` / `SP_DeleteBasicData` | Generic basic-data CRUD dispatcher |
| `SP_IsActiveItem` | Activeness guard |
| `SP_SetItemActiveStatus` | Bulk activate/deactivate |
| `SP_GetAliasName`, `SP_GetItemAliasName`, `SP_GetAliasName_WithQty`, `SP_GetAliasName_WithQtyPrice`, `SP_GetAliasName_FromAllItems` | Item search/typeahead (5 variants) |
| `SP_CheckUniqueAliasName` | Alias uniqueness |
| `SP_Update_Item_MinQty` / `_OptimumQty` / `_ReorderQty` | Bulk replenishment maintenance |
| `SP_UpdateItems_CategoryWise` | Category-wide bulk update |
| `SP_Update_Supplier_Item_Info` | Item↔supplier association |
| `SP_RestrictSelectedClassItems` | Class-level restriction |
| `SP_CheckItemWiseUpperSaleQty_ForAnItem` | Sale-quantity ceiling enforcement |
| `SP_GetFirstItemImageDetail` | Item image |
| `SP_ItemClass`, `SP_ItemPacking`, `SP_ItemCategoryDiscPercList` | Lookup helpers |

**Database tables.**
| Table | Rows | Note |
|-------|------|------|
| `Item` | 30,052 | **148 columns** |
| `ItemNotes` | 30,046 | Free-text note per item (near-1:1) |
| `ItemSuppliers` | 22,246 | Item↔supplier with rate, disc%, lead days, priority |
| `ItemLog` | 110,329 | Full-row shadow copy on change (see T1-39) |
| `ItemImage` | 100 | |
| `Manufacturer` | 838 | |
| `ItemCategory` | 7 · `ItemClass` 12 · `ItemType` 2 · `ItemAlert` 5 · `ItemAlertType` 4 | Lookups |
| `GenericItem` 1 · `GenericItemType` 1 · `PCT` 3 · `DosageUnit` 16 | Pharmacy taxonomy (largely unseeded) |
| `items_corrupted` | 3 | Tier 3 incident record |

**Dependencies.** Feeds T1-02 (pricing), T1-03 (stock), T1-05/06/07 (purchase), T1-08/10 (sales), T1-30 (barcode), T1-26 (reports). Depends on `Manufacturer`, `ItemCategory`, `ItemClass`, `Godown`.

**Evidence.**
`Evidence: table_columns.tsv → Item has 148 columns`
`Evidence: SELECT Active, COUNT(*) FROM dbo.Item GROUP BY Active → 1:28893, 0:1159`
`Evidence: dbo.InterfaceSetting WHERE ModuleId=9 → 144 configurable columns`
`Evidence: dbo.Rights → "Basic Data , Item , Item , Modify Item Basic Data" (and 12 sibling item rights)`

**Current problems.**
1. **148 columns in one table** mixing pharmacy, garments (`ISizeCode`, `IColourCode`, `IFabricCode`, `IYarnCode`, `ISleeveCode`, `IBrandCode`, `ItemDesignCode`, `ItemThicknessCode`), automotive (`IPartCode`, `OldPartCode`, `ModelDescription`), and person-like fields (`Gender`, `Nationality`, `BirthDate`, `RegdNo`) — the last group is nonsensical for a medicine. **Verified.**
2. `GenericItem` = 1 row, `PCT` = 3 rows, `DosageUnit` = 16 — **generic-name and dosage taxonomy is effectively unpopulated**, so generic substitution and therapeutic-class reporting are not possible. **Verified — Missing capability in practice.**
3. `ItemNotes` is a separate 1:1 table for a single text column — needless join. **Verified.**
4. Five parallel sale prices + five discount % + five recent purchase prices with no declared semantics. **Unclear — requires owner validation.**

**Modernization recommendation (Recommended).** **Simplify.**
Split into `items` (core identity: code, name, generic, manufacturer, category, pack structure, flags) + `item_pricing` + `item_tax_profile` + `item_replenishment` + `item_supplier` + optional `item_attributes` JSON for the long tail. Drop all garments/automotive/person columns after a written owner sign-off. Populate a real generic/ATC taxonomy — this is the highest-value pharmacy upgrade available.

---

## T1-02 — Item Pricing, Price Policy & Price Change

| Field | Content |
|-------|---------|
| **Status** | **Verified-and-USED** |
| **Rows** | `PricePolicy` **30,052**, `PricePolicyDetail` **30,052**, `PriceChanges` 8, `GroupAllowedPrice` 54 |

**Business purpose.** Determines the price charged for an item, including quantity-break pricing, per-item discount, flat discount, and which price band (of five) a user group may see or apply.

**Features (Verified).**
- **Price policy per item** with `QtyLimit`, `Price`, `ExpiryDate`, `ItemFlatDisc`, `DiscPerc` → quantity-break / time-bounded pricing (`PricePolicyDetail`)
- 8 price types (`dbo.PriceType`): Sale Price 1–5, Purchase Price, Recent Purchase Price, Average Price
- **Group Allowed Price Setting** — which user group may use which price type (`GroupAllowedPrice`, 54 rows)
- *Change Items Price* bulk screen (Module 53, 41 configurable columns)
- *Modify Sale Price Upward* / *Downward* as **separate permissions**
- *Allow Sale Price Below AvgPrice* permission + per-item `AllowSalePriceBelowAvgPrice` flag
- `MinSalePrice`, `MaxSaleDiscPerc`, `SalePriceChangeMargin` guardrails
- Sale promotions (`SP_ApplySalePromotions`), discount policy (`SP_GetDiscountPolicyBased_ItemDiscount`), bonus policy (`SP_GetBonusPolicyBased_ItemBonusQty`)

**Screens (.pbd).** `changeitemprice`, `multientrypolicy`, `singleentryitem`

**Key stored procedures.**
| Procedure | Role |
|-----------|------|
| `SP_GetPricePolicyBased_ItemPrice` | Resolve effective price for qty |
| `SP_GetDiscountPolicyBased_ItemDiscount` | Resolve effective discount |
| `SP_GetBonusPolicyBased_ItemBonusQty` | Bonus/free-goods qty |
| `SP_Apply_SaleAmt_Based_DiscountPolicy` | Invoice-total-based discount |
| `SP_ApplySalePromotions` | Promotion application |
| `SP_AutoCreatePricePolicy` | Auto-generate a policy per item |
| `SP_MakePriceChanges` | Bulk price change |
| `SP_Update_ItemBatchSalePrice`, `Update_ItemBatchPrices` | Push new price down to batches |
| `sp_changeitemdisc`, `sp_changeitemdisc_manf_cat_packing` | Category/manufacturer-wide discount change |
| `sp_FetchCustomerLatestSalePrice`, `sp_FetchCustomerLatestDiscounts`, `sp_FetchCustomerLatestNetRate` | Customer-specific last-price recall |

**Dependencies.** T1-01 (item), T1-08 (sale), T1-28 (rights gate price bands).

**Evidence.**
`Evidence: PricePolicy = PricePolicyDetail = 30,052 rows = ~1 policy per item (Item=30,052)` — i.e. `SP_AutoCreatePricePolicy` has been run across the whole catalogue.
`Evidence: dbo.PriceType → 8 rows (Sale Price 1..5, Purchase, Recent Purchase, Average)`
`Evidence: dbo.Rights → "Sales , Rights , Modify Sale Price Upward" / "… Downward" / "Show Allow Sale Price Below AvgPrice"`

**Current problems.**
1. `PricePolicy` and `PricePolicyDetail` are 1:1 at 30,052 rows each — the quantity-break capability exists but is **not being used for tiering**; it is degenerate. **Verified.**
2. Pricing logic is spread across ≥10 procedures with overlapping responsibilities (policy, discount policy, bonus policy, promotions, customer-latest-price). Resolution order is **Unclear** and must be traced before rebuild.
3. `PriceChanges` has only 8 rows despite `ItemLog` having 110,329 — **price-change auditing is inconsistent**. **Broken/Incomplete.**

**Modernization recommendation (Recommended).** **Redesign.**
One deterministic pricing resolver with an explicit, testable precedence chain (base price → item policy → qty break → customer/group override → promotion → manual override, each with a guardrail check). Emit a `price_resolution_trace` per line so any invoice price can be explained. Collapse 5 price bands to a named price-list concept.

---

## T1-03 — Inventory / Stock & Batch Management

| Field | Content |
|-------|---------|
| **Status** | **Verified-and-USED — the highest-volume subsystem** |
| **Rows** | `StockReport` **3,215,967**; `GodownDetail` **6,164**; `Saledetail` 620,525; `Purdetail` 113,082 |

**Business purpose.** Batch-level (`Batch` + `Expiry`) perpetual inventory with weighted-average costing, plus a daily per-item stock/price snapshot used by all stock reporting.

**Features (Verified).**
- **Batch-level stock** keyed `(GCode, ICode, Batch, Expiry)` with `Priority` (FEFO ordering), `ManfDate`, `Locked` + `LockReasonCode`
- **Weighted-average costing** — `AvgPrice numeric(15,5)` maintained on `Item` and snapshotted per day in `StockReport`
- Perpetual inventory system (`inventorysystemused = 'P'`, `inventorymovementmethod = 1`)
- Batch re-prioritisation (`SP_RePrioritizeStockBatches`, `SP_GroupWise_RePrioritizeStockBatches`)
- Batch locking (*Lock Item Batches* menu, `sp_...LockBatch`)
- Stock-in-hand across ~20 report formats (batch/priority, audit, category, manufacturer, class, godown, back-date)
- Transit stock (`Item.TransitStock`), item meter (dormant), `TotalPieces` denormalisation

**Screens (.pbd).** `stockreports`, `godownreports`, `adjustment`, `transfer`, `issuecomponents`

**Key stored procedures.**
| Procedure | Role |
|-----------|------|
| `SP_StockReport` | Build/refresh the daily snapshot |
| `sp_UpdateItemStockBatch`, `sp_SaleUpdateItemStockBatch` | Decrement/increment batch qty |
| `SP_UpdateItemStockLedger`, `SP_UpdateStockLedger` | Ledger maintenance |
| `sp_UpdateItemAvgPrice`, `sp_GetItemAvgPrice`, `sp_GetItemAvgPriceForSale` | Weighted-average cost |
| `SP_Get_ItemBatch_CostPrice` | Batch cost lookup |
| `sp_GetItemStockAll`, `sp_GetItemStockBatch`, `sp_GetItemStockTotal`, `sp_GetItemStockInAllowedGodown`, `SP_GetItemStock_For_ConsideredGodowns`, `SP_GetItemStock_Exc_PendingDue` | 6 stock-availability variants |
| `SP_GetItemTotalPiecesInHand`, `SP_UpdateItemTotalPiecesInHand` | Piece-level rollup |
| `sp_ItemOpeningStock`, `sp_GodownItemOpeningStock` | Opening balances |
| `sp_StockRegister`, `sp_stock_inout`, `SP_STOCKLEDGER`, `sp_itemactivity`, `sp_itemingodowns` | Stock reporting |
| `SP_ItemStockMovementAtAvgPrice`, `sp_stockmovementcatwise`, `sp_stockmovementclasswise` | Movement valuation |
| `sp_AutoStockVerification` | Automated stock check |
| `SP_RepairBatchWiseCorruptedStock`, `SP_GodownDetail_RepairForZeroDecimal`, `sp_DeleteItemStockBatch` | **Repair utilities** |
| `sp_UpdateTransitStock` | Transit |

**Database tables.**
| Table | Rows | Note |
|-------|------|------|
| `StockReport` | **3,215,967** | Daily snapshot: `Date, GCode, ICode, Stock(15,4), PurchasePrice, SalePrice, AvgPrice(15,5), RecentPurchasePrice, PackUnits` |
| `GodownDetail` | 6,164 | Live batch stock; 6,012 distinct items in stock |
| `Godown` | **1** | `GODOWN1`, `GodownGroupCode=1` |
| `GodownGroup` | 1 | |
| `GroupAllowedGodown` | 33 | Group→godown permission |
| `ItemLog` | 110,329 | carries `Stock` and `NewSalePrice` at time of change |
| `items_corrupted` | 3 | `date, icode, name, stockinhand, stockshouldbe` |

**Dependencies.** Written by T1-05 (purchase), T1-07 (purchase return), T1-08 (sale), T1-10 (sale return), T1-31 (adjustment). Read by T1-26 (reports), T1-06 (PO), T1-30 (barcode).

**Evidence.**
`Evidence: SELECT COUNT(*), COUNT(DISTINCT ICode), SUM(CASE WHEN Expiry<GETDATE() AND CurrQty>0 THEN 1 ELSE 0 END) FROM dbo.GodownDetail → 6164 | 6012 | 57`
`Evidence: SELECT COUNT(*), MIN(Date), MAX(Date) FROM dbo.StockReport → 3,215,967 | 2025-01-01 | 2026-07-31`
`Evidence: SoftwarePreferences → inventorysystemused='P', inventorymovementmethod=1`
`Evidence: dbo.Global → GT_Store | godown | 1 | 'Default Godown for Sale'`

**Current problems.**
1. **`StockReport` is a materialised daily snapshot, 3.2M rows and growing ~5,600 rows/day** — it is a report accelerator, not a ledger. There is **no immutable stock movement ledger**; movement is reconstructed by differencing snapshots. **Verified — Architectural risk (High).**
2. **The existence of `SP_RepairBatchWiseCorruptedStock`, `SP_GodownDetail_RepairForZeroDecimal`, `sp_AutoStockVerification` and the `items_corrupted` table is direct evidence that stock corruption has occurred in production.** **Verified — Risk (High).**
3. `GodownDetail` has only 6,164 batch rows for 30,052 items — **80% of the catalogue carries no stock**, consistent with a long-tail pharmacy but also with dead-stock accumulation.
4. **57 batches are past expiry but still carry positive quantity.** **Verified — operational issue.**
5. Multi-godown machinery (`GroupAllowedGodown` 33 rows, `GodownGroup`, transfer procs) is fully built but `Godown` = 1. **Verified-but-DORMANT.**

**Modernization recommendation (Recommended).** **Redesign.**
Replace the snapshot with an **append-only `stock_movements` ledger** (one row per receipt/issue/adjustment/sale/return with batch, qty, unit cost, running cost) plus a materialised `stock_on_hand` projection rebuilt from the ledger. This makes stock provably reconstructible, eliminates the need for repair procedures, and turns `StockReport` into a cache that can be dropped and rebuilt. Keep FEFO batch priority. Keep weighted-average, but store the cost calculation inputs on every movement so any `AvgPrice` can be audited.

---

## T1-04 — Expiry Management

| Field | Content |
|-------|---------|
| **Status** | **Verified-and-USED (reporting only)** |
| **Rows** | `GodownDetail.Expiry` on 6,164 batches; **57 expired batches still in stock** |

**Business purpose.** Track batch expiry dates so that near-expiry stock can be sold first (FEFO), returned to supplier, or written off. Legally and commercially critical for a pharmacy.

**Features (Verified).**
- Expiry captured per batch at purchase (`GodownDetail.Expiry`, `Purdetail.Expiry`)
- `Item.PrintExpiry`, `Item.ConfirmExpiry`, `Item.PrintItemBatch` flags
- `DefaultExpiry` preference = `2030-12-12` (fallback for items without a real expiry)
- **Expiry Report** and **Expiry Report (Class-wise)** — and *Expiry Report* is one of only 5 `StartupRight` entries, i.e. it can be forced to open at application startup
- **Godown Wise Stock-With Batch Expiry Details** report
- Batch `Priority` field drives FEFO picking order

**Screens (.pbd).** `expiryintimation`, `stockreports`, `godownreports`

**Key stored procedures.** `sp_ConsolidatedExpiryIntimation`, `sp_ExtractExpiryIntimation`, `SP_AgingBasedEPI`, `SP_DB_Fetch_ExpiryIntimationView`, `SP_DB_Fetch_ExpiryIntimationDetailView`, `SP_DB_PushExpiryIntimationToDropBox`, `SP_DB_MarkExpiryIntimationAsPulled`, `SP_InsertExpIntimation_To_DataCarryDB`, `sp_ExpiryIntimationList_From_DropBox`, `sp_ExpiryIntimation_From_DataCarryDB`

**Database tables.** `GodownDetail` (6,164) · `ExpiryIntimation` **0** · `ExpiryIntimationDetail` **0** · `IntimationType` 2

**Evidence.**
`Evidence: SELECT SUM(CASE WHEN Expiry < GETDATE() AND CurrQty>0 THEN 1 ELSE 0 END) FROM dbo.GodownDetail → 57`
`Evidence: dbo.StartupRight → RightCode 4 | R | 'Exipry Report' | d_expiryreport | Allowed=Y` (vendor typo preserved)
`Evidence: SoftwarePreferences → DefaultExpiry = 2030-12-12`

**Current problems.**
1. **57 expired batches carry positive stock** — no hard block on selling expired stock is evidenced. **Verified — Risk (High, patient-safety and regulatory).**
2. `DefaultExpiry = 2030-12-12` means items entered without a real expiry silently get a 2030 date, **hiding them from expiry reports for years**. **Verified — Risk (High).**
3. The **Expiry Intimation workflow** (formal notification/return-to-supplier) has **zero rows** — the pharmacy uses only the report. **Verified-but-DORMANT (T1-04b).**
4. All 10 expiry-intimation procedures are wired to **DropBox / DataCarry**, which are switched OFF (`ConfigSetting`). So the intimation feature is unreachable in this configuration. **Broken/Incomplete.**

**Modernization recommendation (Recommended).** **Retain + extend (high priority).**
- Make expiry a first-class domain concept with **hard sale blocking** for expired batches (overridable only by an audited supervisor right).
- Replace `DefaultExpiry` with **mandatory expiry capture** at goods receipt; no silent default.
- Build a near-expiry dashboard with configurable horizons (30/60/90/180 days) and a supplier-return workflow that does **not** depend on the DropBox transport.
- Enforce FEFO at picking, not merely as a sortable `Priority`.

---

## T1-05 — Purchasing (Pack / Loose / Opening Purchase)

| Field | Content |
|-------|---------|
| **Status** | **Verified-and-USED** |
| **Rows** | `Purledger` **6,419** (6,418 posted, 1 unposted) · `Purdetail` **113,082** |

**Business purpose.** Goods receipt from suppliers. Creates batches, sets purchase cost, recalculates weighted-average cost, and posts the purchase to the GL against the supplier account.

**Target users.** Purchase officer / store in-charge; supervisor for posting.

**Features (Verified from rights + schema).**
- **Three purchase modes** as distinct menu entries and distinct permissions: **Purchases (Pack)**, **Purchases (Loose)**, **Opening Purchase** — each with separate *Posting* and *Modify* rights
- Per-line: `Batch`, `Expiry`, pack qty / loose qty / bonus qty, purchase price, sale price, disc %, item flat disc, unit sales tax, GST %, net rate, advance income tax %, sales-tax schedule, PCT code
- Invoice-level: supplier, supplier invoice no + date, GRN, `POCode` link, disc %, flat disc, misc charges 1–5, sales tax, invoice GST %, currency + conversion factor, credit days, LC number
- **Up to 10 purchase-expense account slots** (`QE1..QE5_AccCode`, `WE1..WE5_AccCode`) with 10 matching credit accounts (`QExp1..5_CrAccCode`, `WExp1..5_CrAccCode`)
- **Create New Item directly from the purchase screen** (right: `Purchase , Rights , Create New Item`)
- **Show Item Purchase History [Ctrl+H]** during entry
- **Allow Deviation From Previous Margin On Posting** — a margin-guard permission
- `UpdateAvgPriceWithNetRate` toggle — changes whether tax is folded into cost
- Advance income tax (filer/non-filer via `TaxCategory`)
- Daily/monthly item-category counters (`DailyCounter`, `MonthlyCounter`)

**Screens (.pbd).** `purchasecomponents`, `purchaseprintouts`, `purchaseresponsewin`, `advancedpurchase`, `proformapurchase`

**Key stored procedures.**
| Procedure | Role |
|-----------|------|
| `SP_VirtualGL_Purchase` | GL posting (DocumentType `PV`) |
| `SP_Add_ItemBatches_From_Purchase` | Batch creation |
| `sp_UpdateItemAvgPrice` | Weighted-average recalculation |
| `sp_UpdateItemPurDiscPerc` | Purchase discount maintenance |
| `sp_LockPurInvoice` | Pessimistic lock |
| `SP_GetPurInvBalance`, `SP_UpdatePurInvBalance` | Outstanding balance |
| `sp_GetReqdPurInvAccounts` | Resolve required GL accounts before posting |
| `SP_CheckUnpostedPurInvInTransactions` | Guard against posting conflicts |
| `sp_purchase_rate_comparison` | Rate comparison across suppliers |
| `sp_UpdatePurLedgerDailyICatCounter`, `sp_UpdatePurLedgerMonthlyICatCounter` | Counters |
| `SP_CreatePurchase_From_AdvPurchase`, `SP_CreatePurchase_From_ImpPur`, `SP_CreatePurchase_From_PurRegister` | Alternative entry paths |
| `SP_PurchaseBased_SatisfyDue` | Link purchase to customer dues |
| `SP_init_Fetch_LastPurchaseHistory` | Populate `LastPurchaseHistory` |

**Database tables.**
| Table | Rows |
|-------|------|
| `Purledger` | 6,419 (**105 columns**) |
| `Purdetail` | 113,082 |
| `LastPurchaseHistory` | 9,746 |
| `PurCategory` | 8 · `PurOrderCategory` 4 · `SupplierCategory` 1 |
| `Supplier` | 235 |
| `PurledgerMod` / `PurdetailMod` | 0 (Tier 3 clones) |
| `AdvPurHeader` / `AdvPurDetail` / `ProformaPurDetail` | 0 (Tier 2) |

**Dependencies.** T1-17 (supplier), T1-01 (item), T1-03 (stock/batch), T1-06 (PO), T1-20 (GL), T1-23 (tax).

**Evidence.**
`Evidence: SELECT Posted, COUNT(*), MIN(Date), MAX(Date) FROM dbo.Purledger GROUP BY Posted → Y:6418 (2025-01-01…2026-07-31), N:1 (2026-07-30)`
`Evidence: SELECT DocumentType, COUNT(*) FROM VirtualGl → PV = 18,790 rows`
`Evidence: dbo.Rights → "Purchase , Purchases (Pack) , Posting" / "Purchase , Purchases (Loose) , Posting" / "Purchase , Opening Purchase , Posting"`
`Evidence: Trig_PurLedger_AfterUpdate_UpdatePOStatistics_For_Purchases`

**Current problems.**
1. `Purledger` has **105 columns**, of which **20 are purchase-expense account slots** — a hard-coded 10-expense-line limit modelled as columns rather than rows. **Verified — design smell.**
2. **1 purchase invoice left unposted since 2026-07-30.** **Verified — operational hygiene.**
3. 6,419 purchase invoices produce only **18,790 GL rows** (≈2.9 rows/invoice) versus 291,361 sales producing 908,617 GL rows (≈3.1/invoice) — consistent, but see T1-20 for the cost-of-goods question.
4. Three purchase modes (Pack / Loose / Opening) with parallel permission sets triple the surface area for what is fundamentally one document with a unit-of-measure switch. **Strongly Inferred — simplification opportunity.**

**Modernization recommendation (Recommended).** **Retain, Simplify.**
One `purchase_invoice` document with a `receipt_mode` enum (pack / loose / opening) instead of three modules. Move the 20 expense-account columns to a `purchase_expense_lines` child table. Make supplier-invoice number + date mandatory and unique per supplier. Keep the "create item during receipt" flow — it is genuinely valuable in pharmacy.

---

## T1-06 — Purchase Orders

| Field | Content |
|-------|---------|
| **Status** | **Verified-and-USED** |
| **Rows** | `PurOrderHeader` **2,810** (all posted) · `PurOrderDetail` **108,423** |

**Business purpose.** Replenishment ordering. Computes required quantities from reorder/optimum levels and current stock, produces supplier orders, and tracks fulfilment against subsequent purchases.

**Features (Verified from the 9 dedicated PO rights).**
- Auto-calculation of required packs from `ReorderQty` / `OptimumQty` / `MinQty` / current stock
- Permissions to override the calculation: *Change Calculated Required Packs*, *Modify Required Pack(s) Qty*, *Modify Rate*, *Edit Minimum Qty.*, *Edit Reorder Qty.*, *Edit Optimum Qty.*, *Modify Purchase Order*
- *Apply Customer Associated Quotation (Alt+F8)*
- `ConsiderStockInPO` per godown; `Item.GeneratePO` and `Item.ConsiderInPO` flags
- Fulfilment tracking on `PurOrderDetail`: `QtySatisfied`, `BonusQtySatisfied`, `Stock`, `SoldQty`, `ReturnQty`
- PO-based disparity reporting (*P/O Based Purchase Disparity*, *Purchase Order Summary*, *Purchase Order Manf. Wise*)

**Screens (.pbd).** `pocomponents`, `purchase&returnreports`

**Key stored procedures.** `sp_PostPurOrder` · `SP_DB_Fetch_PurOrderHeaderView` / `_PurOrderDetailView` · `SP_DB_PushPOToDropBox` · `SP_DB_MarkPOAsPulled` · `sp_InsertPO_To_DataCarryDB` · `sp_POList_From_DataCarryDB` · `sp_POList_From_DropBox` · `SP_Import_Quot_SO_PO_FromParentServer` · `SP_GetItemReqQtyForTransfer` · `POPolicy` / `POPolicyDetail` driven logic

**Database tables.** `PurOrderHeader` 2,810 · `PurOrderDetail` **108,423** · `PurOrderCategory` 4 · `POPolicy` 7 · `POPolicyDetail` 35

**Dependencies.** T1-01 (item reorder levels), T1-03 (stock), T1-17 (supplier), T1-05 (purchase consumes the PO via `Purledger.POCode` and `Trig_PurLedger_AfterUpdate_UpdatePOStatistics_For_Purchases`).

**Evidence.**
`Evidence: SELECT Posted, COUNT(*), MIN(Date), MAX(Date) FROM dbo.PurOrderHeader GROUP BY Posted → Y:2810 | 2025-01-02 | 2026-07-30`
`Evidence: dbo.InterfaceSetting WHERE ModuleId=16 → 53 configured columns`
`Evidence: PurOrderDetail = 108,423 lines over 2,810 orders ≈ 38.6 lines/order`

**Current problems.**
1. `PurOrderDetail` (108,423) is nearly as large as `Purdetail` (113,082) — POs are large and detailed. Good practice, but the disparity reports exist because **PO→purchase matching is manual**. **Strongly Inferred.**
2. All 2,810 POs are `Posted='Y'` with no open/cancelled states visible — **PO lifecycle states are Unclear**; there is no evidence of a partial-fulfilment or cancellation state machine beyond the `QtySatisfied` counters.

**Modernization recommendation (Recommended).** **Retain.**
This is a genuinely well-used replenishment module and should be rebuilt closely. Add an explicit PO status machine (draft → sent → partially received → closed → cancelled) and automatic three-way matching (PO ↔ goods receipt ↔ supplier invoice). Keep the auto-calculation, but expose the calculation inputs so a buyer can see *why* a quantity was proposed.

---

## T1-07 — Purchase Returns

| Field | Content |
|-------|---------|
| **Status** | **Verified-and-USED** |
| **Rows** | `PRLedger` **634** (all posted) · `PRdetail` **2,481** |

**Business purpose.** Return goods to supplier (damaged, expired, wrong item, over-supply); reduce stock and reduce the supplier payable.

**Features (Verified).**
- Dedicated rights: *Post Purchase Return*, *Modify Purchase Return*, *Modify Price*, *Modify Disc. %*, *Show Invoices In List*
- Allocation of a return against specific purchase invoices (`SP_PostPRAllocationHeader`, `sp_LockPRAllocationInvoice`)
- Reporting: *Purchase Return Detail*, *Purchase Return Summary*, *Supplier Purchase Returns* (Detail / Summary)

**Screens (.pbd).** `prcomponents`, `purchase&returnreports`

**Key stored procedures.** `sp_PostPRLedger` · `SP_VirtualGL_PurchaseReturn` (DocumentType `PR`) · `sp_PostPRAllocationHeader` · `sp_LockPRInvoice` · `sp_LockPRAllocationInvoice` · `SP_GetPRInvBalance` · `SP_UpdatePRInvBalance` · `sp_GetReqdPurRetInvAccounts` · `SP_CheckUnpostedPRInvInTransactions` · `SP_DB_Fetch_PRHeaderView` / `_PrDetailView` · `sp_PostedPurAndReturnCategoryWise` · `sp_PurAndReturnCategoryWise`

**Database tables.** `PRLedger` 634 · `PRdetail` 2,481 · `PRAllocation*` (empty)

**Dependencies.** T1-05 (purchase), T1-03 (stock), T1-17 (supplier), T1-20 (GL).

**Evidence.**
`Evidence: SELECT Posted, COUNT(*) FROM dbo.PRLedger GROUP BY Posted → Y:634`
`Evidence: SELECT DocumentType, COUNT(*) FROM VirtualGl WHERE DocumentType='PR' → 1,395 rows`
`Evidence: dbo.Global → GT_PurchaseReturnsAccount = accounts 12; GT_PurchaseReturnsSubAccount = subaccounts 14`

**Current problems.**
1. 634 returns against 6,419 purchases = **9.9% return rate by invoice** — plausible for pharmacy (expiry returns), but the **return reason is not captured**: there is no reason-code column on `PRLedger`. **Verified — Missing.**
2. The link between an expiry-driven return and the Expiry Intimation module is absent because the latter is dormant. **Verified.**

**Modernization recommendation (Recommended).** **Retain.**
Add a mandatory **return reason** (expired / damaged / wrong-supply / over-supply / recall) and wire it to the expiry module so a near-expiry batch can be converted into a supplier return in one action. Add supplier credit-note tracking so the payable reduction is provable.

---
