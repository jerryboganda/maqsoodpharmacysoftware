# 09 — Roles, Permissions & Security Model

**System:** WASEELA ABUZAR V3 (vendor "Abuzar"/"Waseela") — deployment **Fazal Din PP19**, retail pharmacy
**Document:** `09-roles-permissions.md` — complete security / authorization model
**Analysis stage:** Stage 3 — Domain deep-dive (authorization, identity, audit)
**Date of analysis:** 2026-08-01
**Database analysed (live, read-only):** `FazalDinPP19DataBaseV2` on `localhost\SQLEXPRESS` (SQL Server 2019 Express 15.0.2000.5, DB compatibility level **100**)

---

## Evidence sources used

| # | Source | How used |
|---|---|---|
| E1 | **Live database, read-only queries** (`SELECT` / `sys.*` catalogue views only) | Authoritative dump of `Module`, `Rights`, `GroupRights`, `Groups`, `Users`, `UserGroups`, `RightsCategory`, `WindowType`, `StartupRight`, `SpecialRight`, `ModuleEvent`, `UserAuthenticationInfo`, `Rightsclone`, `temp_GroupRights`, all `GroupAllowed*` tables, `sys.configurations`, `sys.server_principals`, `sys.database_permissions` |
| E2 | `…/scratchpad/db_modules_full.sql` (2.48 MB, all 762 programmable objects) | Full source of `fn_GetGroupCode`, `fn_GetGodown`, `fn_GetHeader`, `SP_Check_UserAttendance`, `SP_Mark_UserAttendance`, `SP_Insert_EventLog`, `SP_Insert_PostedInvoiceEditingLog`, `SP_UpdateActivityMonitor`, `SP_WayToMoon`, `SP_RequestHttpWebService`, `SP_DB_Fetch_DropBoxInfo`, `SP_GetPricePolicyBased_ItemPrice`, `Trig_UserGroups_After_Update_Delete`, `sp_GenerateItemLog_DataCarryDB` |
| E3 | `…/scratchpad/table_columns.tsv`, `table_rowcounts.tsv`, `primary_keys.tsv`, `foreign_keys.tsv` | Column/type/row-count cross-checks |
| E4 | `E:/Pharma Software/ABUZAR_V2_RECOVERY_JOURNAL.md` | Environment ground truth: hardcoded `sa` password, `xp_cmdshell` requirement, plaintext `Users` passwords, backup media passwords |
| E5 | `E:/Pharma Software/V2_AbuzarSoftware/Application/*.pbd` (122 compiled PowerBuilder libraries) | Existence only — **no source code**; used to reason about where enforcement *must* live |
| E6 | Derived matrices written during this analysis: `…/scratchpad/rights_all.tsv`, `matrix_W.tsv`, `matrix_A.tsv`, `grouprights_all.tsv`, `rightsclone_L12.tsv` | Per-group right expansion |

> **Row counts differ slightly from the project baseline.** The baseline sheet (from `sys.partitions`) reported `Rights=483`, `GroupRights=720`, `UserGroups=9 groups`. Exact `COUNT(*)` against the live DB returns **`Rights=486`**, **`GroupRights=726`**, and **`UserGroups` is a 9-row *user→group mapping*, not a group list — the group list is `dbo.Groups` with 4 rows.** The exact counts in this document supersede the baseline. `Evidence: SELECT COUNT(*) FROM Rights → 486; SELECT COUNT(*) FROM GroupRights → 726; SELECT COUNT(*) FROM Groups → 4`.

---

## Evidence-label legend

| Label | Meaning |
|---|---|
| **Verified** | Read directly from live DB data, stored-procedure/trigger/view source, or schema metadata. Evidence pointer supplied. |
| **Strongly Inferred** | Multiple converging pieces of evidence, but the decisive artefact (the compiled PowerBuilder code) cannot be read. |
| **Unclear** | Evidence is ambiguous or contradictory; must be confirmed with the vendor or by observing the running app. |
| **Missing** | The capability is absent from the system entirely. |
| **Deprecated** | Present but superseded / no longer written to. |
| **Broken/Incomplete** | Present but demonstrably non-functional or half-wired. |
| **Recommended** | A proposal for the **NEW** system. **Not an existing feature.** |

> **Rule applied throughout:** an *empty table* is evidence of **non-use at this deployment**, not evidence that the product lacks the feature.

---

# PART A — EXECUTIVE SUMMARY

**The authorization model is a two-level, positive-grant, group-based ACL: `User → (exactly one) Group → set of Rights`. There are no roles-per-user, no permission inheritance, no deny rules, and no per-record ownership. `Rights` is a flat catalogue of 486 named permission atoms of two kinds — 322 *menu/action* rights (`Object='A'`) that show or hide a specific menu leaf, and 164 *window* rights (`Object='W'`) that enable or disable a specific control, keystroke or field inside a specific screen. A group either has a right (a row in `GroupRights` with `Status=1`) or it does not. There is no view/create/edit/delete/approve/export axis in the data model at all — those verbs, where they exist, are hard-coded into individual right *names* (e.g. `Cash Sale Posting`, `Modify Item Basic Data`, `Save As Excel`). Enforcement is almost entirely **client-side inside the compiled `abuzar.exe`**; the SQL Server layer checks rights in only a handful of procedures, and every user session connects to SQL Server as **`sa` (sysadmin) with a password hardcoded in the binary**, so the entire permission model is advisory rather than enforced.**

This deployment runs **9 users across 4 groups** (`ADMINISTRATOR`, `REMOTE`, `SHIFT INCHARGE`, `SALES OFFICER`) — 5 of the 9 real staff are `SALES OFFICER`, 3 are `SHIFT INCHARGE`, and 1 (`ADMIN`) is `ADMINISTRATOR`. `REMOTE` is defined but assigned to nobody. Application passwords are stored in **plaintext** and are trivially weak (`"1"`, `"0"`, `"3"`, `"25"`, `"55"`, `"60"`, `"z0"`).

---

# PART B — THE REAL MODULE LIST (`dbo.Module`)

**Verified.** `Evidence: SELECT Module, Name FROM dbo.Module ORDER BY Module` — 57 rows, exact. This is the vendor's canonical enumeration of transactional document types. It is the single most authoritative artefact for module discovery, because `ModuleID` is the foreign key used by `GroupAllowedGodown`, `GroupAllowedHeader`, `GroupAllowedPrice`, `GroupAllowedRecipient`, `GroupCashAccount`, `CashAccAllowedModule`, `PatientCatAllowedModule` and `ModuleEvent`.

| Module | Name | Relevant at Fazal Din PP19? |
|---:|---|---|
| 1 | SALES | **Yes** (core) |
| 2 | SALES RETURN | **Yes** (core) |
| 3 | PURCHASE | **Yes** (core) |
| 4 | PURCHASE RETURN | **Yes** (core) |
| 5 | ISSUE | Configured (godown/price/recipient rows exist), low/no volume |
| 6 | RECEIPT | Configured (godown/price/recipient rows exist), low/no volume |
| 7 | ADJUSTMENT | Configured |
| 8 | TRANSFER | Configured (single godown → moot) |
| 9 | ITEM | **Yes** (master data) |
| 10 | CASH SALE | **Yes** — the primary sale flow (cash-sale retail model) |
| 11 | CREDIT SALE | Menu granted to ADMIN only |
| 12 | SALE ORDER | Header right granted to ADMIN only |
| 13 | TRANSFER (TARGET) | Not used |
| 14 | PATIENT REGISTRATION | Not used (clinical vertical) |
| 15 | QUOTATION | Granted to ADMIN + SHIFT INCHARGE |
| 16 | PURCHASE ORDER | **Yes** |
| 17 | PRESCRIPTION | Not used |
| 18 | PATIENT PROFILE | Not used |
| 19 | VISIT APPOINTMENT | Not used |
| 20 | PATIENT VISIT | Not used |
| 21 | ADVANCED SALE | Not used |
| 22 | CASH SERVICE | Not used |
| 23 | CREDIT SERVICE | Not used |
| 24 | CUSTOMER | Master data (2 rows) |
| 25 | IN-PATIENT SALE | Not used |
| 26 | PROFORMA SALE | Not used |
| 27 | IN-PATIENT SERVICE | Not used |
| 28 | CASH SERVICE RETURN | Not used |
| 29 | CREDIT SERVICE RETURN | Not used |
| 30 | IN-PATIENT SERVICE RETURN | Not used |
| 31 | CASH SALE RETURN | **Yes** |
| 32 | CREDIT SALE RETURN | Not used |
| 33 | BUFFER SALE RETURN | Not used |
| 34 | IN-PATIENT SALE RETURN | Not used |
| 35 | POINT OF SALE | Not used |
| 36 | PATIENT ADMISSION | Not used |
| 37 | RECEIPT TRANSACTION | Cash-account mapping exists for ADMIN/REMOTE |
| 38 | PAYMENT TRANSACTION | Cash-account mapping exists for ADMIN/REMOTE |
| 39 | SALE TEMPLATE | Not used |
| 40 | ISSUE REQUEST | Not used |
| 41 | Service Basic Data | Not used |
| 42 | GUEST CHECK IN | Not used (hospitality vertical) |
| 43 | Purchase Of Services | Cash-account mapping exists for SALES OFFICER |
| 44 | Purchase Return Of Services | Not used |
| 45 | A/C VOUCHERS | Accounting vouchers — window rights exist, ADMIN only |
| 46 | Customer License | Not used |
| 47 | Customer Site | Not used |
| 48 | Item Registration Request | Not used |
| 49 | Garments Basic Data Wizard | Not used (garments vertical) |
| 50 | Installment Receipt | Not used |
| 51 | Sale Of Services | Not used |
| 52 | Sale Return Of Services | Not used |
| 53 | Change Item Price | **Yes** (maintenance) |
| 101 | Cash Receipt | Accounting sub-module |
| 102 | Cash Receipt Against Sale | Accounting sub-module |
| 103 | Cash Payment | Accounting sub-module |
| 104 | Cash Payment Against Purchase | Accounting sub-module |

**Note the numbering gap.** IDs 1–53 are contiguous document modules; 101–104 are a separate "cash transaction" block. There is no ID 54–100. **Verified** — `SELECT Module FROM Module ORDER BY Module` returns exactly this set.

### B.2 — Module events (`dbo.ModuleEvent`, 20 rows) — **Verified**

`Evidence: SELECT * FROM ModuleEvent`. This table declares which lifecycle event each module fires (used by the alert/SMS/notification subsystem).

| Event | Modules that fire it |
|---|---|
| `Posting` | 1 SALES, 2 SALES RETURN, 3 PURCHASE, 4 PURCHASE RETURN, 5 ISSUE, 6 RECEIPT, 7 ADJUSTMENT, 8 TRANSFER, 12 SALE ORDER, 16 PURCHASE ORDER, 22 CASH SERVICE, 23 CREDIT SERVICE, 45 A/C VOUCHERS |
| `Saving` | 14 PATIENT REGISTRATION, 19 VISIT APPOINTMENT, 46 Customer License, 50 Installment Receipt |
| `Finalized` | 12 SALE ORDER |
| `Admission` / `Discharge` | 36 PATIENT ADMISSION |

**Implication (Strongly Inferred):** `Posting` is the system's only approval-like state transition. There is no separate "approve", "authorise" or "verify" concept anywhere in the rights model (see §D.4).

### B.3 — Full vendor menu surface (`dbo.Rightsclone`) — **Verified**

`dbo.Rightsclone` (2,122 rows) is the vendor's **master right catalogue** for the whole product line; `dbo.Rights` (486 rows) is the **subset activated for this pharmacy licence**. `Evidence: SELECT COUNT(*) FROM Rightsclone rc WHERE NOT EXISTS(SELECT 1 FROM Rights r WHERE r.RightCode=rc.RightCode) → 1,636 orphans`, i.e. 1,636 of the vendor's rights are *not* present in this installation's `Rights` table.

The master catalogue has **11 top-level menus**; this deployment has only **6**:

| Root (IndicesString) | Menu name | Present in this deployment's `Rights`? |
|---|---|---|
| `2,` | Purchase | **Yes** (right 3) |
| `3,` | Sales | **Yes** (right 9) |
| `4,` | Transactions (accounting vouchers, PDC, payroll, installments) | **NO** — `SELECT COUNT(*) FROM Rights WHERE IndicesString LIKE '4,%' → 0` |
| `5,` | Reports | **Yes** (rights 1 and 25 — duplicated, see §D.7) |
| `6,` | Basic Data | **Yes** (right 74) |
| `7,` | Maintenance | **Yes** (right 90) |
| `8,` | Manage | **Yes** (right 100) |
| `9,` | E-Prescription | **NO** — 0 rows |
| `10,` | Patient Management | **NO** — 0 rows |
| `11,` | Activities (Passport, Production, Work Order, Product) | **NO** — 0 rows |

**This is the cleanest available proof of what the product *can* do versus what this pharmacy *has*.** The vendor menu includes 33 Purchase sub-modules, 31 Sales sub-modules, 35 Report families, 58 Basic-Data masters, 55 Maintenance utilities and 44 Manage/administration screens. Full extract: `…/scratchpad/rightsclone_L12.tsv`.

---

# PART C — HOW RIGHTS ARE MODELLED

## C.1 Entity model — **Verified** (all columns read from `sys.columns`)

```
Users (9)                 Groups (4)                    Rights (486)
 UserCode   PK ──┐         GroupCode PK ──┐               RightCode PK ──┐
 UserName        │         GroupName      │               RightName      │
 Password ⚠ plain│         + 27 policy cols│              MenuName       │
 FatherName      │                        │               LevelIndex     │
 Address         │                        │               IndicesString  │
 Phone           │                        │               Object ('A'|'W')│
 Active ('Y'/'N')│                        │               RightCatCode ──┼──> RightsCategory (19)
                 │                        │                              │
                 └──> UserGroups (9) <────┘   GroupRights (726) <─────────┘
                        UserCode  PK             GroupCode PK
                        GroupCode PK             RightCode PK
                        ModifiedBy               Status (tinyint, always 1)
                          │
                          │ TRIGGER Trig_UserGroups_After_Update_Delete
                          ▼
                      UserGroupsLog (9)
```

### `dbo.Rights` — the permission atom

`Evidence: sys.columns for OBJECT_ID('Rights')`

| Column | Type | Meaning (**Verified** from data) |
|---|---|---|
| `RightCode` | `smallint` NOT NULL | PK. Sparse, vendor-assigned (values seen: 1…1831, then a 5000-block 5027…5310). |
| `RightName` | `varchar(150)` NOT NULL | Full breadcrumb, e.g. `Sales , Rights , Modify Sale Item Discount%`. |
| `MenuName` | `varchar(60)` NULL | Leaf label shown in the UI, e.g. `Retail Sale`. |
| `LevelIndex` | `smallint` NOT NULL | Menu depth. **`0` = window right (not a menu item)**; 1 = top-level menu; 2–5 = sub-menu depth. Distribution: `0→164, 1→7, 2→52, 3→132, 4→116, 5→15`. |
| `IndicesString` | `varchar(30)` NOT NULL | Materialised menu path, e.g. `5,2,1,22,` = Reports → Stock Reports → Stock in Hand → Audit Purpose. Empty string for window rights. |
| `Object` | `char(1)` NOT NULL | **`'A'` = Action/menu right (322 rows); `'W'` = Window right (164 rows).** |
| `RightCatCode` | `smallint` NOT NULL | FK → `RightsCategory`. Licensing/vertical bucket. |

`Evidence: SELECT Object, COUNT(*) FROM Rights GROUP BY Object → A=322, W=164`.

### `dbo.RightsCategory` (19 rows) — **Verified**

`Evidence: SELECT * FROM RightsCategory ORDER BY RightCatCode`

| Code | Name | Rights in this deployment |
|---:|---|---:|
| 1 | General | 430 |
| 2 | Accounts | 1 |
| 3 | Multigodown | 2 |
| 4 | Patient | 4 |
| 5 | Garments | 0 |
| 6 | POS | 0 |
| 7 | Services | 2 |
| 8 | Due | 0 |
| 9 | In - Patient | 0 |
| 10 | Reports Header Wise | 0 |
| 11 | Reports Data Portability | 0 |
| 12 | Reports Accounts | 4 |
| 13 | Special Module | 40 |
| 14 | Copied Sale Invoices | 0 |
| 15 | Advance Purchases | 0 |
| 16 | Student | 2 |
| 17 | Guest | 0 |
| 18 | Payroll | 1 |
| 19 | Installment | 0 |

**Strongly Inferred:** `RightCatCode` is the *licensing / vertical feature-flag* dimension. Categories with 0 rights are verticals not licensed here (Garments, POS, In-Patient, Guest/hospitality, Installments, Due management). Category 13 "Special Module" (40 rights) holds the CRS multi-branch consolidation, data-export utilities for specific pharma distributors (Global Pharma, Pharma Link, Next Pharma, Bosch/Linz, Otsuka, Libra, Racket, Neutro, Masood Homoeo), Production, and Document Gallery/attachments.

### `dbo.GroupRights` — the grant

| Column | Type | Meaning |
|---|---|---|
| `GroupCode` | `smallint` NOT NULL | FK → `Groups` |
| `RightCode` | `smallint` NOT NULL | FK → `Rights` |
| `Status` | `tinyint` NOT NULL | **Always `1` in every one of the 726 rows.** `Evidence: SELECT GroupCode, Status, COUNT(*) FROM GroupRights GROUP BY GroupCode, Status` → only `Status=1` combinations exist. |

**Verified:** the model is **positive-grant only**. The presence of a row *is* the grant. `Status` has never been used to encode a deny or a partial level. There is no deny rule, no precedence, and no inheritance.

`Evidence: SELECT COUNT(*) FROM GroupRights g WHERE NOT EXISTS(SELECT 1 FROM Rights r WHERE r.RightCode=g.RightCode) → 0` — referential integrity is clean.

### `dbo.UserGroups` — the membership

| Column | Type | Meaning |
|---|---|---|
| `UserCode` | `smallint` NOT NULL | FK → `Users` |
| `GroupCode` | `smallint` NOT NULL | FK → `Groups` |
| `ModifiedBy` | `smallint` NOT NULL | UserCode of whoever last changed the assignment |

**Verified — one group per user, enforced by convention not by constraint.** The table is a many-to-many *shape*, but `dbo.fn_GetGroupCode` collapses it to a single group:

```sql
-- Evidence: db_modules_full.sql lines 354-372
CREATE FUNCTION DBO.fn_GetGroupCode (@UserCode SMALLINT)
RETURNS SMALLINT
AS
BEGIN
DECLARE @GroupCode SMALLINT
SET @GroupCode =
	ISNULL((SELECT MIN(GroupCode)
	FROM UserGroups
	WHERE UserCode = @UserCode), 0)
RETURN @GroupCode
END
```

**Broken/Incomplete — `MIN(GroupCode)` silently discards multi-group membership.** If a user were placed in two groups, every server-side check would use only the *lowest-numbered* one. Since `ADMINISTRATOR` is GroupCode 2 (the lowest in use), adding any user to ADMINISTRATOR *plus* a restricted group would silently grant full admin on the server side. `Evidence: dbo.fn_GetGroupCode → SELECT MIN(GroupCode) FROM UserGroups`. The same `MIN()` idiom recurs inline: `Evidence: db_modules_full.sql:31852 → SELECT MIN(GroupCode) FROM UserGroups WHERE UserCode=@UserCode`.

### `dbo.UserRights` (0 rows) — **Deprecated / Unused**

Columns `UserCode, RightCode, Status` — a per-user override table with the identical shape to `GroupRights`. **Zero rows.** `Evidence: table_rowcounts / SELECT COUNT(*) FROM UserRights → 0`. No stored procedure references it (`grep -i "UserRights" db_modules_full.sql` → no hits). The product ships the ability to override a right for an individual user, but this deployment does not use it, and the SQL layer never consults it.

### `dbo.Rightsclone` (2,122 rows) and `dbo.temp_GroupRights` (6,265 rows) — **Deprecated staging**

- `Rightsclone` is the vendor master catalogue (see §B.3). Same column set as `Rights`.
- `temp_GroupRights` holds a **default rights template for 16 archetypal group codes** (1, 2, 3, 4, 5, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20) with 4–1,578 rights each. `Evidence: SELECT GroupCode, COUNT(*) FROM temp_GroupRights GROUP BY GroupCode`. Twelve of those group codes **do not exist** in this deployment's `Groups` table. **Strongly Inferred:** this is the vendor's out-of-the-box group template, left behind after installation/upgrade. It is not read by any stored procedure.

---

## C.2 How a permission is *evaluated*

### C.2.1 The two enforcement points — **Strongly Inferred**

Because there is no application source code, the evaluation path can only be reconstructed from the data model plus the (very few) SQL-side checks. The picture is unambiguous:

| Right kind | `Object` | `LevelIndex` | What it controls | Where enforced |
|---|---|---|---|---|
| **Action / menu right** | `'A'` | 1–5 | Whether a menu leaf at path `IndicesString` is visible/enabled | **Client only** (`abuzar.exe` builds the menu tree from `Rights` ⋈ `GroupRights` on login) |
| **Window right** | `'W'` | `0` | Whether a named control, keystroke, column or field inside one screen is enabled | **Client only**, with ~11 exceptions listed below |

**There is no per-module, per-window generic CRUD matrix.** The verbs live inside the right *name*. Examples (**Verified**, `Evidence: SELECT RightName FROM Rights WHERE Object='W'`):

| Verb encoded | Example right(s) |
|---|---|
| Create | 5101 `Add New Item`, 5121 `Create New Item` (from purchase screen) |
| Read / reveal a field | 705 `Show Purchase Price`, 706 `Show Avg. Price`, 523 `Display (PurchasePrice, RecentPurchasePrice, AvgPrice)`, 547 `Show Account Balance`, 587 `Item Search Window , Show Purchase Price` |
| Read / list | 564 `Show Invoice List`, 566 `Show Item List`, 538 `Show Invoices In List Window`, 565 `Show Transaction List` |
| Edit | 502 `Cash Sale Modify`, 507 `Pack Purchase Modify`, 510 `Modify Item Basic Data`, 549 `Modify Purchase Order`, 5192 `Modify Price` |
| Save | 531 `Save Invoice(Ctrl + S)`, 700 `Save Invoice [Ctrl + S]` (sale-return variant) |
| Post ("approve") | 500 `Cash Sale Posting`, 501 `Credit Sale Posting`, 504/505/506 purchase posting, 5207 `Post Purchase Return`, 5218 `Post`, 622 `Save and Post`, 708 `Save and Post (Ctrl + Q)` |
| Export | 637 `Save As`, 638 `Save As Excel` |
| Print | 5217 `Print Report`, 5027 `Show Print Preview` |
| Override a business rule | 511 `Modify Sale Price Downward`, 701 `Modify Sale Price Upward`, 611 `Override Customer Credit Limit`, 1797 `Allow Sale Price Below AvgPrice`, 5229 `Allow Deviation From Previous Margin On Posting` |
| Scope-widening | 515 `Assign Restricted Items`, 537 `View Restricted Account(s) in Transaction(s)`, 606 `Show All Vouchers in Transaction List` |

**Missing — there is no DELETE right of any kind.** `Evidence: grep -iE "delete|remove|void|cancel" over all 486 rows of Rights` returns exactly one hit, and it is a *report*: right 1518 `Reports , Item Reports , Deleted Sale Items Log`. Deletion is therefore either impossible in the UI or ungoverned. **Unclear which** — requires observation of the running app. Related: preference `PreserveDeletedSaleItemsLog = 'Y'` exists (`Evidence: SoftwarePreferences PrefID 3115`), and `SaleLedger.DELETED char(1)` exists as a soft-delete flag, so *soft* deletion is real but unguarded by any right.

**Missing — there is no APPROVE / AUTHORIZE / VERIFY right.** `Evidence: grep -iE "approve|authoriz|verif" over Rights` → 0 hits. The only near-equivalents are `Supervise All/Selected/Current [F7/F8/F9]` in the Cashier Activity Window (rights 5064, 5065, 5067) — and the Cashier module is entirely unused here (`CashierActivity`, `CashierShift`, `CashierJob` all 0 rows). **Posting is the de-facto approval step.**

### C.2.2 The eleven server-side right checks — **Verified**

Only three stored procedures in the entire 762-object corpus consult `GroupRights`. Everything else trusts the client.

**1. Restricted-item visibility — right `515`.** Used ~30 times across the item-search/pricing procedures:

```sql
-- Evidence: db_modules_full.sql:29885 (and 29 further occurrences)
(item.Restricted='N' OR (Item.Restricted='Y' AND
   Exists (select * from grouprights where rightcode = 515 and groupcode = @GroupCode) ) )
```

Real data: `SELECT Restricted, COUNT(*) FROM Item GROUP BY Restricted` → **`Y`=146, `N`=29,906`**. All four groups hold right 515, so the filter is currently a no-op at this deployment. **Verified.**

**2. Price-policy disclosure — rights `5070`, `5071`, `5072`** in `SP_GetPricePolicyBased_ItemPrice`:

```sql
-- Evidence: db_modules_full.sql:31852-31854
SET @GetPrice        = ISNULL((SELECT RightCode FROM GroupRights WHERE GroupCode IN
    (SELECT MIN(GroupCode) FROM UserGroups WHERE UserCode=@UserCode) AND RightCode=5070), 0)
SET @GetItemFlatDisc = ... AND RightCode=5071 ...
SET @GetItemDiscPerc = ... AND RightCode=5072 ...
```
Note: rights 5070/5071/5072 **do not exist** in this deployment's `Rights` table, so these always resolve to 0. **Broken/Incomplete.**

**3. Drop-Box document-type filter — rights `5294`–`5300`** in `SP_DB_Fetch_DropBoxInfo`:

```sql
-- Evidence: db_modules_full.sql:21496-21533
SET @GroupCode = (SELECT dbo.fn_GetGroupCode(@UserCode))
SET @RightCode = (SELECT MAX(RightCode) FROM GroupRights WHERE GroupCode=@GroupCode AND RightCode=5294)
IF @RightCode = 5294  SET @DocType = @DocType + '''S'','     -- Sale
... 5295 → 'SR', 5296 → 'P', 5297 → 'PR', 5298 → 'PO', 5299 → 'IS', 5300 → 'EI'
```
Rights 5294–5300 also do not exist in this deployment's `Rights`. **Broken/Incomplete** here (multi-branch Drop Box is unused).

**Conclusion (Verified):** apart from right 515, **not a single posting, modification, pricing, discounting, accounting or reporting stored procedure verifies the caller's permission.** `sp_PostSaleLedger`, `sp_PostPurLedger`, voucher posting, invoice modification and GL writes all execute unconditionally for whoever calls them.

### C.2.3 Group-level *policy* fields that are never enforced by SQL — **Broken/Incomplete, Critical**

`dbo.Groups` carries 27 policy columns beyond `GroupCode`/`GroupName`/`Remarks`. `Evidence: sys.columns for OBJECT_ID('Groups')`. Their live values:

| Column | ADMINISTRATOR (2) | REMOTE (5) | SHIFT INCHARGE (11) | SALES OFFICER (12) |
|---|---:|---:|---:|---:|
| `saleinvflatdisc` | 50.00 | 0.00 | 0.00 | 0.00 |
| `saleItemdiscperc` | 50.00 | 0.00 | 0.00 | 0.00 |
| `AccumulatedDiscPerc` | 0.00 | 0.00 | 0.00 | 0.00 |
| `AccumDiscPercCaution` | 0.00 | 0.00 | 0.00 | 0.00 |
| `ServiceDiscPercLimit` | 100.00 | 100.00 | 0.00 | 0.00 |
| `MaxServiceFlatDisc` / `MaxServiceInvFlatDisc` | 0.00 | 0.00 | 0.00 | 0.00 |
| **`FinancialLimitPerTransaction`** | **100000.00** | 100000.00 | 100000.00 | 100000.00 |
| **`MaxQtyLimit`** | **10000** | 10000 | 10000 | 10000 |
| `SalePriceInItemList` | 1 | 1 | 1 | 1 |
| `ConsiderAllDiscountsOnItem` | Y | Y | Y | Y |
| `AutoRefreshItemList` / `…Time` | N / 0 | N / 0 | N / 0 | N / 0 |
| `*GodownStrategy` (9 columns) | all 1 | all 1 | all 1 | all 1 |

**These limits are enforced nowhere in the database.** `Evidence: grep -iE "FinancialLimitPerTransaction|MaxQtyLimit|saleinvflatdisc|saleItemdiscperc|AccumulatedDiscPerc" over db_modules_full.sql → ZERO matches across all 762 programmable objects.` Only two of the 27 columns are ever read server-side:

```sql
-- Evidence: db_modules_full.sql:27512
SET @IssueGodownStrategy = ISNULL((SELECT IssueGodownStrategy FROM Groups WHERE GroupCode=@GroupCode), 1)
-- Evidence: db_modules_full.sql:28709
SET @GodownStrategy = ISNULL((SELECT ReceiptGodownStrategy FROM Groups WHERE GroupCode=@GroupCode), 1)
```

**Risk (Critical):** the per-transaction financial cap (PKR 100,000), the max-quantity cap (10,000), and the maximum discount percentages are **client-side-only guard rails**. Any user who can reach SQL Server — and every user's session already runs as `sa` — bypasses all of them.

---

## C.3 Data-scoping tables (the `GroupAllowed*` family) — the *row-level* security layer

These tables answer "which **data partitions** may this group touch in this module", as distinct from "which buttons may it press". Two are read by SQL scalar functions; the rest are client-side.

### C.3.1 `GroupAllowedGodown` (33 rows) — **Verified, server-enforced**

Columns: `GroupCode, GCode, Module, Priority`. Read by:

```sql
-- Evidence: db_modules_full.sql:337-352
CREATE FUNCTION DBO.fn_GetGodown(@GroupCode SMALLINT, @Module SMALLINT)
RETURNS SMALLINT AS BEGIN
DECLARE @GCode AS SMALLINT
SET @GCode = (SELECT TOP 1 GCode FROM GroupAllowedGodown
	WHERE GroupAllowedGodown.GroupCode = @GroupCode
	  AND GroupAllowedGodown.Module = @Module
	ORDER BY Priority, GCode)
RETURN @GCode END
```
…and callers hard-fail if the group has no allowed godown:
```sql
-- Evidence: db_modules_full.sql:8298-8300
Set @GCode = DBO.fn_GetGodown(@GroupCode, @Module)
IF @GCode <= 0 OR @GCode IS NULL
	RaisError( 'You have No Allowed Godown for Issue Module' ,16,1)
```
It is also used to constrain transfer posting:
```sql
-- Evidence: db_modules_full.sql:45262 (sp_PostTransferHeader)
... ELSE (SELECT G.GCode From GroupAllowedGodown G WHERE G.GroupCode = @ai_groupcode
          AND G.Module = 8 AND Godown.GCode = G.GCode) END
```

Live data: all 4 groups are mapped to `GCode=1` for modules 1–8 (`Priority=10`); ADMINISTRATOR additionally has module 15 (Quotation). Since `dbo.Godown` has exactly **1 row**, godown scoping is a no-op at this site — but the mechanism is real and server-enforced.

### C.3.2 `GroupAllowedHeader` (35 rows) — **Verified, server-enforced**

Columns: `GroupCode, HeaderCode, Module, Priority`. Read by `dbo.fn_GetHeader` with the identical `TOP 1 … ORDER BY Priority, HeaderCode` shape (`Evidence: db_modules_full.sql:373-390`). "Header" = invoice-numbering series / branded document header. All 4 groups map to `HeaderCode=1` for modules 1–8; ADMIN adds modules 12 and 15; REMOTE adds module 12.

### C.3.3 `GroupAllowedPrice` (54 rows) — **Verified, client-enforced**

Columns: `GroupCode, Module, PriceTypeCode`. Determines which of 8 price tiers a group may select.

| Group | Modules covered | Price types allowed |
|---|---|---|
| 2 ADMINISTRATOR | 1 (Sales), 5 (Issue), 6 (Receipt) | **1–8 (all)** |
| 5 REMOTE | 1, 5, 6 | **1–8 (all)** |
| 11 SHIFT INCHARGE | 1, 5, 6 | **1 only** |
| 12 SALES OFFICER | 1, 5, 6 | **1 only** |

**This is a genuine, meaningful restriction:** floor staff can sell only at the standard retail price tier; only ADMINISTRATOR/REMOTE can pick alternate price lists. No SQL procedure references `GroupAllowedPrice` (`grep` → 0 hits), so it is **client-enforced only**.

### C.3.4 `GroupCashAccount` (43 rows) — **Verified, client-enforced**

Columns: `GroupCode, ModuleID, CashAccCode`. Every row in this deployment points at **`AccCode=2 — "CASH FROM SALE (DEFAULT)"`**. `Evidence: SELECT ga.*, a.Name FROM GroupCashAccount ga LEFT JOIN Accounts a ON a.AccCode=ga.CashAccCode`.

| Group | Modules mapped |
|---|---|
| 2 ADMINISTRATOR | 19 modules (10,11,14,22,23,25,26,27,28,29,30,31,32,33,34,35,36,37,38) |
| 5 REMOTE | same 19 modules |
| 11 SHIFT INCHARGE | **only 10 (Cash Sale) and 31 (Cash Sale Return)** |
| 12 SALES OFFICER | **only 10, 31, and 43 (Purchase of Services)** |

**Strongly Inferred:** this is the cash-drawer/till mapping. Floor staff are confined to the cash-sale and cash-sale-return tills.

Companion `CashAccAllowedModule` (22 rows) whitelists which modules may have a cash account at all: modules 10, 11, 14, 22, 23, 25–38, 42, 43, 44. **Verified.**

### C.3.5 `GroupVoucherCategory` (25 rows) — **Verified, client-enforced**

Columns: `GroupCode, VochCatCode, Status`. ADMINISTRATOR: voucher categories 1–17, 19–22 (21 categories, `Status=1`). REMOTE: categories 1–4. **SHIFT INCHARGE and SALES OFFICER: none — they cannot post any accounting voucher category.**

### C.3.6 `GroupAllowedRecipient` (8 rows) — **Verified**

Columns: `GroupCode, ModuleID, RecipientCode, Priority`. Only ADMINISTRATOR, modules 5 (Issue) and 6 (Receipt), recipients 1–4.

### C.3.7 `GroupSummaryAccount` (1 row) — **Verified**

Columns: `GroupSummaryAccCode, NAME`. Single row: `1 = 'DEFAULT'`. Note this table is *not* group-scoped despite the name — it is a lookup of summary-account groupings.

### C.3.8 `PatientCatAllowedModule` (8 rows) — **Verified, dormant**

Columns: `PatientCatCode, ModuleID`. Patient category 1 → modules 2, 10, 11, 12, 14, 17, 22, 23. Patient management is unused at this deployment.

### C.3.9 Empty scoping tables — **shipped but unused here**

| Table | Rows | Columns | Purpose (**Strongly Inferred**) |
|---|---:|---|---|
| `GroupAllowedGroups` | 0 | — | Which groups a group may administer (delegated admin) |
| `GroupAllowedServiceCategory` | 0 | — | Service-category scoping (services vertical unused) |
| `GroupSupplierCategory` | 0 | — | Supplier-category scoping |
| `GroupAllowedStartupRight` | 0 | `GroupCode, RightCode, Details, Arguments(text)` | Per-group startup jobs (backups/reports auto-run at login) |
| `GroupWiseImpExpTemplate` | 0 | — | Import/export template scoping |
| `GroupPurExpTemplate` | 0 | — | Purchase-expense template scoping |
| `ItemAllowedMeter` | 0 | — | Metered-item scoping (utility vertical) |
| `UserAllowedDoctor` | 0 | — | User↔doctor association (clinical) — governed by preference `enforceuserdoctorassociation='Y'` |
| `CustAllowedServices` | 0 | — | Customer↔service entitlement |
| `SalesManScope` | 0 | — | Salesman territory scoping |
| `GroupItemCategory` / `GroupCustomerCategory` | n/a | — | Menu rights 185 / 453 exist in `Rightsclone` but the screens are ADMIN-only and unused |

> **Important framing for the owner:** these are *product* features that exist and would work; they are simply not configured at Fazal Din PP19 because this is a single-godown, single-till, cash-retail pharmacy.

---

## C.4 Startup and "special" rights

### `dbo.StartupRight` (5 rows) — **Verified**

Columns: `RightCode, RightType char(1), RightName varchar(255), ObjectName varchar(100), Allowed char(1)`.

| RightCode | Type | Name | ObjectName | Allowed |
|---:|:--:|---|---|:--:|
| 1 | `B` | Manual Backup | | `Y` |
| 2 | `B` | Auto Client Backup | | `Y` |
| 3 | `B` | Auto Startup Backup | | `Y` |
| 4 | `R` | Exipry Report *(sic)* | `d_expiryreport` | `Y` |
| 5 | `R` | Re-Order Level Report | `d_reorderlevelreport` | `Y` |

`RightType`: `B` = Backup job, `R` = Report (DataWindow object name given). All 5 are globally `Allowed='Y'`. The per-group refinement table `GroupAllowedStartupRight` is **empty**, so no group has startup jobs bound. **Strongly Inferred:** `StartupRight` is a *global* enable list and `GroupAllowedStartupRight` narrows it per group; with the latter empty, behaviour is **Unclear** (either "all groups get all 5" or "nobody gets any"). Menu right 1117 `Manage , Startup` exists in `Rightsclone` but **not** in this deployment's `Rights`.

### `dbo.SpecialRight` (4 rows) — **Verified, and a security finding**

Columns: `RightID varchar(100), RightName varchar(100), Enable char(1), RightPwd varchar(100)`.

| RightID | RightName | Enable | **RightPwd (plaintext)** |
|---:|---|:--:|---|
| 1 | Modify Posted Sales | `N` | `spcadminsecrets` |
| 2 | Modify Posted Sales Return | `N` | `spcadminsecrets` |
| 3 | Modify Posted Purchases | `N` | `spcadminsecrets` |
| 4 | Modify Posted Purchase Return | `N` | `spcadminsecrets` |

**This is the break-glass mechanism for editing already-posted (ledger-affecting) documents.** All four are currently **disabled** (`Enable='N'`) at this deployment — a *good* control. The password is a **shared, plaintext, vendor-wide constant** (`spcadminsecrets`), stored in a readable table and identical across all four rights. No stored procedure references `SpecialRight` (`grep` → 0 hits), so the check is entirely client-side.

Consistent with this, `PostedInvoiceEditingLog` has **0 rows** — no posted invoice has ever been edited through the governed path at this site. `Evidence: SELECT COUNT(*) FROM PostedInvoiceEditingLog → 0`.

### `dbo.UserAuthenticationInfo` (1 row) — **Verified, and a security finding**

Single column `AuthenticationKey varchar(20)`. Live value: **`12345678`**. Menu right 1030 `Maintenance , Change Authentication Key` exists in `Rightsclone` (not in this deployment's `Rights`). **Strongly Inferred:** a shared secondary key gating sensitive maintenance actions and/or data-carry import-export. It is at its trivial factory default.

### `dbo.WindowType` (5 rows) — **Verified**

`WinType, Name`: `1 HeaderWindow, 2 PopUpHeaderWindow, 3 DetailWindow, 4 ListWindow, 5 SearchListWindow`. This is a UI taxonomy used by the vendor's window framework. It is **not referenced by `Rights`** (`Rights` has no `WinType` column) and no stored procedure joins it. **Strongly Inferred:** consumed only by the compiled client for column-preference / layout persistence.

---

# PART D — THE ACTUAL DEPLOYMENT: 9 USERS, 4 GROUPS

## D.1 The 4 groups — **Verified**

`Evidence: SELECT GroupCode, GroupName FROM dbo.Groups`

| GroupCode | GroupName | Rights held (A + W = total) | % of all 486 rights | Members |
|---:|---|---|---:|---|
| **2** | **ADMINISTRATOR** | 322 A + 164 W = **486** | **100%** | 1 (`ADMIN`) |
| **5** | **REMOTE** | 1 A + 5 W = **6** | 1.2% | **0 — unassigned** |
| **11** | **SHIFT INCHARGE** | 65 A + 58 W = **123** | 25.3% | 3 |
| **12** | **SALES OFFICER** | 57 A + 54 W = **111** | 22.8% | 5 |

`Evidence: SELECT g.GroupCode, g.GroupName, r.Object, COUNT(*) FROM GroupRights gr JOIN Groups g … JOIN Rights r … GROUP BY g.GroupCode, g.GroupName, r.Object`

**Verified:** `ADMINISTRATOR` holds **every single right in the catalogue** (322 + 164 = 486 = `COUNT(*) FROM Rights`). There is no right that nobody holds: `SELECT COUNT(*) FROM Rights r WHERE NOT EXISTS(SELECT 1 FROM GroupRights g WHERE g.RightCode=r.RightCode) → 0`.

**`REMOTE` (GroupCode 5) is a 6-right read-only viewer** with zero members: right 1 (`Reports` menu root) plus window rights 5256 `Show Sale Price`, 5257 `Show Sale Discount %`, 5258 `Show Flat Discount`, 5286 `Show Invoices In List Window` (Services), 5290 `Modify Price/Values in Purchase`. **Note the anomaly:** 5290 is a *modify* right granted to an otherwise read-only group — see Risks.

## D.2 The 9 users — **Verified** (⚠ passwords stored and displayed here in plaintext exactly as they exist in the DB)

`Evidence: SELECT * FROM dbo.Users ORDER BY UserCode` and `SELECT * FROM dbo.UserGroups ORDER BY UserCode`

| UserCode | UserName | **Password (plaintext in DB)** | FatherName | Address | Phone | Active | GroupCode | Group | Assigned by |
|---:|---|---|---|---|---|:--:|---:|---|---:|
| 1 | `ADMIN` | `pakistan9080` | ADMIN'S FATHER | *(blank)* | SDF3E | Y | **2** | ADMINISTRATOR | 1 |
| 2 | `RAEES KHAN` | `1` | | | | Y | **12** | SALES OFFICER | 1 |
| 3 | `DR SAIRA` | `55` | | | | Y | **11** | SHIFT INCHARGE | 1 |
| 4 | `ZUBAIR ARIF` | `z0` | | | | Y | **12** | SALES OFFICER | 1 |
| 5 | `SHAZIB` | `25` | | | | Y | **11** | SHIFT INCHARGE | 1 |
| 6 | `HAMMAD` | `3` | | | | Y | **12** | SALES OFFICER | 1 |
| 7 | `HAMID ALI` | `60` | | | | Y | **12** | SALES OFFICER | 1 |
| 8 | `ALI` | `0` | | | | Y | **12** | SALES OFFICER | 1 |
| 9 | `FARYAD` | `60` | | | | Y | **11** | SHIFT INCHARGE | 1 |

All 9 users are `Active='Y'`. **Verified:** `SELECT Active, COUNT(*) FROM Users GROUP BY Active → Y=9`.

> ⚠ **Note the duplicate password:** users 7 (`HAMID ALI`) and 9 (`FARYAD`) share the password `60`. Since authentication is username + password, this is not directly exploitable, but it is symptomatic.
>
> ⚠ `dbo.Users` has **no** email, no password-hash column, no `LastLogin`, no `FailedAttempts`, no `LockedUntil`, no `MustChangePassword`, no `PasswordChangedOn`. Columns are exactly: `UserCode, UserName, Password, FatherName, Address, Phone, Active`. **Verified from `sys.columns`.**

### D.2.1 Real workload per user — **Verified**

`Evidence: SELECT u.UserCode, u.UserName, COUNT(s.SaleInvCode) FROM Users u LEFT JOIN SaleLedger s ON s.SalesmanCode=u.UserCode GROUP BY …`

| User | Group | Sale invoices attributed (`SaleLedger.SalesmanCode`) | Item changes logged (`ItemLog.UserCode`) |
|---|---|---:|---:|
| 1 ADMIN | ADMINISTRATOR | 869 | **73,101** |
| 2 RAEES KHAN | SALES OFFICER | 12,509 | 10 |
| 3 DR SAIRA | SHIFT INCHARGE | 6,228 | 12,707 |
| 4 ZUBAIR ARIF | SALES OFFICER | **104,446** | 1,014 |
| 5 SHAZIB | SHIFT INCHARGE | 3,578 | 4,135 |
| 6 HAMMAD | SALES OFFICER | 7,579 | 6 |
| 7 HAMID ALI | SALES OFFICER | 65,757 | 18,992 |
| 8 ALI | SALES OFFICER | 57,148 | 106 |
| 9 FARYAD | SHIFT INCHARGE | 33,247 | 258 |
| | | **291,361 total** | **110,329 total** |

**Strongly Inferred:** `ZUBAIR ARIF`, `HAMID ALI` and `ALI` are the primary counter staff (≈78% of all invoices). `ADMIN` does very little selling but the overwhelming majority of item-master changes.

### D.2.2 Group-assignment history — **Verified**

`dbo.UserGroupsLog` (9 rows) is populated by an AFTER UPDATE/DELETE trigger:

```sql
-- Evidence: db_modules_full.sql:64896-64907
Create Trigger Trig_UserGroups_After_Update_Delete On UserGroups For Update,Delete As
Declare @logdate DateTime
Set @logdate = GetDate()
Insert Into UserGroupsLog
Select @logdate,usercode,groupcode,modifiedby
From   Deleted
IF @@ERROR <> 0
Begin
    RaisError('Database Problem Occur in generating UserGroupsLog',16,1)
End
```

Live history (**Verified**, `SELECT * FROM UserGroupsLog ORDER BY LogDate`) — the row records the **previous** value (`FROM Deleted`):

| LogDate | UserCode | *Previous* GroupCode | ModifiedBy |
|---|---:|---:|---:|
| 2025-01-15 16:12 | 3 (DR SAIRA) | 12 SALES OFFICER | 1 |
| 2025-02-11 15:30 | 3 (DR SAIRA) | 12 SALES OFFICER | 1 |
| 2025-03-17 14:11 | 2 (RAEES KHAN) | 11 SHIFT INCHARGE | 1 |
| 2025-03-17 19:14 | 2 (RAEES KHAN) | 11 SHIFT INCHARGE | 1 |
| 2025-03-17 20:01 | 6 (HAMMAD) | 11 SHIFT INCHARGE | 1 |
| 2025-05-14 22:21 | 6 (HAMMAD) | 12 SALES OFFICER | 1 |
| 2025-06-18 19:08 | 8 (ALI) | 12 SALES OFFICER | 1 |
| 2026-01-26 17:37 | 9 (FARYAD) | 11 SHIFT INCHARGE | 1 |
| 2026-05-02 13:02 | 3 (DR SAIRA) | 11 SHIFT INCHARGE | 1 |

**Broken/Incomplete:** the trigger logs the *old* group but **not** the new one, and fires only on UPDATE/DELETE — **initial group assignment (INSERT) is never logged**. There is also no equivalent trigger on `Users` (password changes, activation/deactivation, user creation are **not audited at all**) and none on `GroupRights` (**permission grants and revocations are not audited at all**). `Evidence: only 10 triggers exist in the entire database; the complete list is Trig_EMP_Payroll_AfterUpdate_Paid, Trig_GodownDetail_AfterUpdate_LastUpdated, Trig_Item_AfterUpdate_UpdateLastUpdate_TimeStamp, Trig_ItemPart_AfterUpdate_…, Trig_ItemPartInModel_AfterDelete_…, Trig_ItemPartInModel_AfterInsertUpdate_…, Trig_Patient_AfterUpdate_InActiveCount, Trig_PurLedger_AfterUpdate_UpdatePOStatistics_For_Purchases, Trig_SrLedger_AfterInsert_UpdateTotalOfSaleReturnsInSaleLedger, Trig_UserGroups_After_Update_Delete.`

---

# PART E — ROLES × PERMISSIONS MATRIX

## E.1 How to read this matrix

The brief asks for the axes *module visible / view / create / edit / delete / approve / export / financial / admin*. **These axes do not exist natively in the data model** (see §C.2.1). The matrix below is therefore a **faithful projection**: every cell is derived from one or more concrete `RightCode`s, and the right codes are named so any claim can be re-checked with
`SELECT * FROM GroupRights WHERE GroupCode=<g> AND RightCode=<r>`.

**Legend**
`●` = granted &nbsp;|&nbsp; `○` = not granted &nbsp;|&nbsp; `—` = no such right exists in the model (capability is ungoverned or absent) &nbsp;|&nbsp; `n/a` = module not present in this deployment's `Rights`

Column meanings, as mapped to real right kinds:
- **Visible** = the menu right (`Object='A'`) for that module's menu leaf.
- **View** = list/read window rights (`Show … List`, `Show/Display … Price`).
- **Create** = `Add New` / `Save Invoice` rights.
- **Edit** = `Modify …` rights.
- **Delete** = *no delete right exists anywhere* → always `—`.
- **Approve** = *no approve right exists*; the nearest equivalent is **Post**, shown here.
- **Export** = 637 `Save As` + 638 `Save As Excel` (report data-portability). Print (5217) shown separately in notes.
- **Financial** = ability to see/alter money-affecting fields (cost prices, margins, discounts, accounts).
- **Admin** = ability to manage users, groups, rights, preferences, database.

## E.2 The matrix — **Verified** (every cell traced to `GroupRights`)

### ADMINISTRATOR (GroupCode 2) — holds all 486 rights

| Functional area | Visible | View | Create | Edit | Delete | Post ("Approve") | Export | Financial | Admin |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Cash Sale (retail) | ● | ● | ● | ● | — | ● | ● | ● | ● |
| Credit Sale (wholesale) | ● | ● | ● | ● | — | ● | ● | ● | ● |
| Sale Return (cash + credit) | ● | ● | ● | ● | — | ● | ● | ● | ● |
| Open Sale Return | ● | ● | ● | ● | — | ● | ● | ● | ● |
| Refused Sales | ● | ● | ● | ● | — | — | ● | ● | ● |
| Quotation | ● | ● | ● | ● | — | — | ● | ● | ● |
| Purchase (Pack + Loose) | ● | ● | ● | ● | — | ● | ● | ● | ● |
| Opening Purchase | ● | ● | ● | ● | — | ● | ● | ● | ● |
| Purchase Return | ● | ● | ● | ● | — | ● | ● | ● | ● |
| Purchase Order | ● | ● | ● | ● | — | ● | ● | ● | ● |
| Item master | ● | ● | ● | ● | — | — | ● | ● | ● |
| Customer master | ● | ● | ● | ● | — | — | ● | ● | ● |
| Supplier master | ● | ● | ● | ● | — | — | ● | ● | ● |
| Accounting Vouchers (window rights only) | n/a¹ | ● | ● | ● | — | ● | ● | ● | ● |
| Accounts Reports / Ledgers | ● | ● | — | — | — | — | ● | ● | ● |
| Stock / Sales / Purchase Reports | ● | ● | — | — | — | — | ● | ● | ● |
| Adjustment (stock) | ● | ● | ● | ● | — | ● | ● | ● | ● |
| Godown Preferences / Transfer | ● | ● | ● | ● | — | ● | ● | ● | ● |
| **Manage → Users / Groups / Rights** | ● | ● | ● | ● | — | — | ● | ● | **●** |
| **Maintenance → Preferences, DB Utilities, Modify Posted Invoices** | ● | ● | ● | ● | — | — | ● | ● | **●** |

¹ The `Transactions` menu root right does not exist in `Rights` — see §E.4 anomaly A1.

### SHIFT INCHARGE (GroupCode 11) — 123 rights — members: DR SAIRA, SHAZIB, FARYAD

| Functional area | Visible | View | Create | Edit | Delete | Post | Export | Financial | Admin |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Cash Sale (retail) | ● *(r10)* | ○ *(no r538)* | ● *(r531, r644)* | ○ *(no r502)* | — | ● *(r500, r708)* | ○ | ◐ *(r523, r591, r589, r590, r516)* | ○ |
| Credit Sale (wholesale) | ○ *(no r11)* | ○ *(no r645)* | ○ | ○ *(no r503)* | — | ● *(r501)* ⚠ | ○ | ○ | ○ |
| Sale Return — Cash | ● *(r12, r13)* | ● *(r567)* | ● *(r700)* | ○ *(no r595)* | — | ● *(r623)* | ○ | ● *(r5283-5285)* | ○ |
| Sale Return — Credit | ○ *(no r14)* | ● | ● | ○ | — | ● | ○ | ● | ○ |
| Open Sale Return | ○ *(no r106)* | ○ | ○ | ○ | — | ○ | ○ | ○ | ○ |
| Quotation | ● *(r193)* | ● | ● | ○ *(no r602/676)* | — | — | ○ | ○ | ○ |
| Purchase (Pack) | ● *(r2)* | ● *(r564)* | ● *(r528)* | ● *(r507)* | — | ● *(r504)* | ○ | ● *(r704, r5290, r5091)* | ○ |
| Purchase (Loose) | ○ *(no r137)* | — | — | ○ *(no r508)* | — | ○ *(no r505)* | ○ | ○ | ○ |
| Opening Purchase | ● *(r6)* | ● | ● | ● *(r509)* | — | ● *(r506)* | ○ | ● | ○ |
| Purchase Return | ● *(r105)* | ● *(r568)* | ● | ● *(r552, r5192, r5193)* | — | ● *(r5207)* | ○ | ● | ○ |
| Purchase Order | ● *(r4)* | ● | ● | ● *(r549, r614, r617, r691, r632-634)* | — | — | ○ | ● | ○ |
| Item master | ● *(r81, r345)* | ● *(r566, r705-707, r5256-5258)* | ● *(r5101, r5121)* | ● *(r510, r512, r514, r515, r524)* | — | — | ○ | ● | ○ |
| Customer master | ○ *(no r78)* | ○ | ○ | ○ *(no r649)* | — | — | ○ | ○ | ○ |
| Supplier master | ● *(r355)* | ● | ● | ○ *(no r650)* | — | — | ○ | ○ *(no r720)* | ○ |
| Accounting Vouchers | ○ | ○ *(no r565/606)* | ○ | ○ | — | ○ *(no r622/5218)* | ○ | ○ | ○ |
| Accounts Reports / Ledgers | ○ *(no r54/58/358)* | ○ | — | — | — | — | ○ | ○ | ○ |
| Daily Reports (Sale/SR/Pur/PO) | ● *(r26,27,30,33,1078)* | ● | — | — | — | — | ○ *(no r637/638)* | ● | ○ |
| Stock Reports (incl. narcotics registers) | ● *(r43,44,152,194,242,255,326,379,1068,1142,1269,1689)* | ● | — | — | — | — | ○ | ● | ○ |
| Sales Reports (Category Wise) | ● *(r49,51,123,220,285)* | ● | — | — | — | — | ○ | ● | ○ |
| Purchase Reports | ● *(r52,53,148,172,173,184,197,221,256,1082)* | ● | — | — | — | — | ○ | ● | ○ |
| RePrinting (7 formats) | ● *(r177,178,260,261,487,860,913,943)* | ● | — | — | — | — | ○ | ● | ○ |
| Print reports | — | — | — | — | — | — | ● *(r5217 Print only)* | — | ○ |
| Maintenance → Change Password (own) | ● *(r91)* | — | — | ● | — | — | — | — | ○ |
| Maintenance → Update Item Basic Data / Suppliers / Reorder Qty / **Change Items Price** | ● *(r829, r950, r997, r120)* | ● | — | ● | — | — | ○ | **●** | ○ |
| Maintenance → DB Utilities (**Backup**, **Check Integrity**) | ● *(r121, r1308, r1309)* | ● | — | — | — | — | — | — | **◐** |
| **Manage** (Users/Groups/Rights/Preferences) | ○ *(no r100)* | ○ | ○ | ○ | — | — | ○ | ○ | **○** |

### SALES OFFICER (GroupCode 12) — 111 rights — members: RAEES KHAN, ZUBAIR ARIF, HAMMAD, HAMID ALI, ALI

Identical to SHIFT INCHARGE except for the deltas below (**Verified** by diffing `GroupRights` for 11 vs 12):

| Right | Name | SHIFT INCHARGE | SALES OFFICER |
|---:|---|:--:|:--:|
| 538 | Sales → Show Invoices In List Window | ○ | **●** |
| 645 | Sales → Credit Sales Retrieve | ○ | **●** |
| 595 | Sale Return → **Modify Sale Return Price** | ○ | **●** |
| 14 | Sales → Sale Return → Credit Sale (menu) | ○ | **●** |
| 170, 171 | Reports → Purchase → SupplierWise (+ Detail) | ○ | **●** |
| 947 | Reports → Purchase Order Manf. Wise | ○ | **●** |
| 700 | Sale Return → Save Invoice [Ctrl+S] | **●** | ○ |
| 5101 | Item → **Add New Item** | **●** | ○ |
| 5229 | Purchase → Allow Deviation From Previous Margin On Posting | **●** | ○ |
| 5245 | Purchase → Attach Document(s) | **●** | ○ |
| 5283/5284/5285 | Purchase Return → View Invoice-level Disc%/Flat/Misc | **●** | ○ |
| 193 | Sales → Quotation (menu) | **●** | ○ |
| 81, 345 | Basic Data → Item → Item (menu) | **●** | ○ |
| 27, 30, 33, 1078 | Reports → Daily → Sale / SR / Purchase / PO | **●** | ○ |
| 49, 51, 123, 220, 285 | Reports → Sales Reports family | **●** | ○ |

**Business reading (Strongly Inferred):**
- `SHIFT INCHARGE` is the **supervisor of the shift**: can create items, see daily sale/purchase/return reports, quote customers, and override purchase margin on posting.
- `SALES OFFICER` is the **counter operator**: can process cash sales and returns end-to-end (including credit-sale returns and re-pricing a return), can post purchases, but cannot see daily sales reports and cannot create new items from the Item screen (though **can** create items from the purchase screen via right 5121 — see anomaly A3).

### REMOTE (GroupCode 5) — 6 rights — **no members**

| Right | Object | Name |
|---:|:--:|---|
| 1 | A | `Reports` (top-level menu) |
| 5256 | W | Basic Data → Item → Show Sale Price |
| 5257 | W | Basic Data → Item → Show Sale Discount % |
| 5258 | W | Basic Data → Item → Show Flat Discount |
| 5286 | W | Sales → Services → Show Invoices In List Window |
| 5290 | W | **Purchase → Modify Price/Values in Purchase** |

## E.3 Financial-control summary (the owner's key question)

| Financial control | ADMIN | SHIFT INCHARGE | SALES OFFICER | REMOTE |
|---|:--:|:--:|:--:|:--:|
| See item **purchase / average / recent-purchase cost** (r523, r705, r706, r707, r587) | ● | ● | ● | ○ |
| Change **sale price downward** (r511) | ● | ○ | ○ | ○ |
| Change **sale price upward** (r701) | ● | ○ | ○ | ○ |
| **Sell below average cost** (r1797) | ● | ○ | ○ | ○ |
| Change **item-level discount %** in sale (r516) | ● | ● | ● | ○ |
| Change **item-level flat discount** in sale (r517) | ● | ○ | ○ | ○ |
| Change **sale-return price** (r519, r595) | ● | ○ | ● *(r595)* | ○ |
| **Change item master prices in bulk** (menu r120 `Change Items Price`) | ● | ● | ● | ○ |
| Modify price/values in **purchase** (r5290) | ● | ● | ● | **●** ⚠ |
| Modify **purchase-return** price / disc% (r5192, r5193) | ● | ● | ● | ○ |
| Deviate from previous margin on purchase posting (r5229) | ● | ● | ○ | ○ |
| **Override customer credit limit** (r611) | ● | ○ | ○ | ○ |
| Post **accounting vouchers** (r622, r5218) | ● | ○ | ○ | ○ |
| See **account balances** / ledgers (r546, r547, r58, r358) | ● | ○ | ○ | ○ |
| See **restricted accounts** in transactions (r537) | ● | ○ | ○ | ○ |
| **Export report data** to file / Excel (r637, r638) | ● | ○ | ○ | ○ |
| **Print** any report (r5217) | ● | ● | ● | ○ |
| **Modify a POSTED invoice** (`SpecialRight` 1–4) | **disabled globally** (`Enable='N'`) | disabled | disabled | disabled |
| **Preview sale invoice margin** (r574) | ● | ○ | ○ | ○ |
| **Backup the database** (r1308) | ● | ● | ● | ○ |

**Verified.** The two controls a pharmacy owner most cares about — *who can change a price* and *who can see profit* — split as follows: **all** operational groups can see cost prices and can bulk-change item prices via `Maintenance → Change Items Price` (right 120), but only ADMIN can move a *sale line's* price up or down inside an invoice, sell below cost, or preview invoice margin.

## E.4 Anomalies and internal inconsistencies in the current configuration — **Verified**

| # | Anomaly | Evidence | Severity |
|---|---|---|---|
| **A1** | The whole **`Transactions` menu root (`4,`)** is absent from `Rights`, yet 11 *window* rights for the Accounting-Voucher screen exist and are granted to ADMINISTRATOR (537, 546, 547, 565, 593, 606, 622, 5218, 5239, 5240, 5249). It is **Unclear** whether the menu is therefore hidden for everyone, or unrestricted for everyone. | `SELECT COUNT(*) FROM Rights WHERE IndicesString LIKE '4,%' → 0` | **High — must be resolved before the rebuild** |
| **A2** | `SHIFT INCHARGE` and `SALES OFFICER` hold **right 501 `Credit Sale Posting`** but *not* menu right 11 `Sales , Credit Sale`. They can post a credit sale they cannot open. | `matrix_W.tsv` r501 SI=Y SO=Y; `matrix_A.tsv` r11 SI=. SO=.` | Medium |
| **A3** | `SALES OFFICER` cannot open the Item screen (no right 81/345) and cannot `Add New Item` (no 5101), **but holds 5121 `Purchase , Rights , Create New Item`** — i.e. can create item masters from inside a purchase invoice. | `GroupRights` 12 ⊃ 5121 | Medium |
| **A4** | `REMOTE`, a 6-right read-only group, holds **5290 `Modify Price/Values in Purchase`**. | `GroupRights` 5 ⊃ 5290 | Medium (dormant — 0 members) |
| **A5** | Two distinct rights (**1** and **25**) both represent `Reports` at `LevelIndex=1, IndicesString='5,'`. Duplicate menu-root rights. | `SELECT RightCode, MenuName FROM Rights WHERE LevelIndex=1` | Low |
| **A6** | Rights **5070/5071/5072** (price-policy disclosure) and **5294–5300** (Drop-Box doc types) are referenced by stored procedures but **do not exist** in `Rights`, so those checks always evaluate false. | `db_modules_full.sql:31852`, `:21515` vs `SELECT … FROM Rights WHERE RightCode IN (5070,…,5300)` | Medium (Broken/Incomplete) |
| **A7** | All operational groups can **run a database backup** (right 1308 under `Maintenance → Database Utilities`). Backup media is written with the vendor-fixed passwords `alfia<servername>` / `alcia<servername>`. | `GroupRights` 11/12 ⊃ 1308; `db_modules_full.sql:45390` | **High** |
| **A8** | `Rights.MenuName` contains vendor typos that will surface in any UI reusing them: `Exipry Report`, `Dail Reports`, `Datbase Utilities`, `Rorder Level Report`, `Norcotix`. | `SELECT MenuName FROM Rights` | Low (cosmetic) |

---

# PART F — IDENTITY, SESSIONS AND ATTENDANCE

## F.1 Authentication — **Verified: there is no server-side authentication**

**There is no login stored procedure.** `Evidence: grep -iE "^-- ==== .*(Login|Auth|Logon|Valid.*User)" over db_modules_full.sql → 0 matches.` `dbo.Users.Password` is never read by any procedure, function, view or trigger. `Evidence: grep -i "password" over db_modules_full.sql` returns only (a) two `INSERT INTO TraderDBV3.Dbo.Users (… PassWord …)` data-migration statements at lines 2042 and 2250, and (b) `BACKUP/RESTORE … MEDIAPASSWORD` literals.

**Strongly Inferred:** `abuzar.exe` performs `SELECT … FROM Users WHERE UserName = ? ` and compares the plaintext `Password` column in the client process. This means:
- The password travels from SQL Server to the client **in the clear over TDS** on every login attempt.
- Anyone who can run a `SELECT` against `dbo.Users` — and every workstation already holds `sa` credentials in the binary — reads every password.

**Missing entirely** (verified absent from the schema and from all 762 programmable objects):
- password hashing or salting
- password complexity / minimum length policy
- password expiry or forced rotation
- failed-attempt counting or account lockout
- session tokens, session timeout, idle logout
- multi-factor authentication
- login/logout audit records

`AllowLoginAUserMultipleTimes = 'Y'` — **Verified**, `SoftwarePreferences PrefID 65`. Concurrent sessions for the same user account are explicitly permitted.

## F.2 Step-up ("re-authentication") preferences — **Verified**

The product implements a *re-prompt for user + password* at sensitive moments, configured per screen via `dbo.SoftwarePreferences`. Live values at this deployment:

| Preference `Name` | Caption | Value |
|---|---|:--:|
| `salesalesmanwindow` | Ask User/Password in Cash Sale | **Y** |
| `creditsaleaskuserpassword` | Ask User/Password in Credit Sale | **Y** |
| `askuserpwdinsalereturn` | Ask User/Password in Sale Return | **Y** |
| `AskUserPwdInSaleOrder` | Ask User/Password in Sale Order | **Y** |
| `AskUserPwdOnsavingInTransfer` | Ask User Password On Saving (Transfer) | **Y** |
| `transuserwindow` | Ask User Password in Transaction | **Y** |
| `POSSaleSalesmanWindow` | Ask User/Password In POS | **Y** |
| `ApplySalesTaxOnSavingBeforeUserPwd` | Apply S/Tax Before User Password | **Y** |
| `puruserwindow` | Ask User/Password (Purchase) | **N** |
| `askuserpasswordinitem` | Ask User/Password In Item | **N** |
| `AskUserPwdInAdjustment` | Ask User/Password in Adjustment | **N** |
| `askuserpwdinpatientreg` | Ask User/Password In Patient Registration | **N** |
| `AskUserPwdInStudentReg` | Ask User/Password | **N** |

**This is where `SaleLedger.SalesmanCode` comes from** — the re-prompt at save time is what attributes an invoice to a named user. **Strongly Inferred**, corroborated by the fact that all 291,361 invoices carry a non-null `SalesmanCode` spread across all 9 users, while `ModifiedBy` and `PostedBy` are **NULL on all 291,361 rows** (`Evidence: SELECT ModifiedBy, COUNT(*) FROM SaleLedger GROUP BY ModifiedBy → single NULL group of 291,361`).

**Risk:** because the check is client-side and passwords are 1–2 characters (`"1"`, `"0"`, `"3"`), the step-up prompt provides essentially no assurance. A counter operator can attribute a sale to a colleague by typing that colleague's one-digit password.

## F.3 Machine attribution — **Verified**

`SaleLedger.MachineName varchar(20)` records the workstation. Live distribution:

| MachineName | Invoices |
|---|---:|
| `FDPP1-PC` | 132,755 |
| `FNS1-PC` | 66,665 |
| `FNS-PC` | 54,480 |
| `FNS2-PC` | 29,982 |
| `WIN-4MB7DTJ8638` | 4,729 |

Four production tills plus one machine that looks like an un-renamed default Windows install (`WIN-4MB7DTJ8638`, 4,729 invoices). `ActivityMonitor` and `PostedInvoiceEditingLog` also carry `MachineName`/`Machine`.

## F.4 Attendance (time-in / time-out) — **Verified but unused**

`dbo.UserAttendance` — `UserCode, TimeIn, TimeOut, Remarks, RowID` — **0 rows**. Menu rights `7,35 Maintenance , User Time-in` (1015) and `7,36 User Time-out` (1016) exist in `Rightsclone` but **not** in this deployment's `Rights`.

The two procedures are well-written and would work:

```sql
-- Evidence: db_modules_full.sql:9722-9738
CREATE PROCEDURE SP_Check_UserAttendance @UserCode SMALLINT, @RowID INT OUTPUT
AS
SET @RowID=ISNULL((SELECT rowid=MAX(RowID)
		FROM UserAttendance
		WHERE UserCode = @UserCode AND TimeOut IS NULL AND TimeIn IS NOT NULL), -1)
RETURN 0
```

```sql
-- Evidence: db_modules_full.sql:39476-39545 (SP_Mark_UserAttendance)
--Lock user first so that no other request can time-in the specified user
SET @uc = (SELECT UserCode FROM Users WITH (UPDLOCK HOLDLOCK) WHERE UserCode = @UserCode)
EXECUTE SP_Check_UserAttendance @UserCode, @rid out
...
IF @Mode=1   -- Time-in
	INSERT INTO DBO.UserAttendance (UserCode, TimeIn, TimeOut, Remarks)
	SELECT @UserCode, @Dt, NULL, ''
ELSE          -- Time-out
	SET @dt2 = (SELECT TimeIn FROM DBO.UserAttendance WHERE UserCode = @UserCode AND RowID = @RowID)
	IF @dt2 > @date_in_out
		RaisError('User Time-in date is greater than current system date…', 16, 1, @username, @rid)
	ELSE
		UPDATE DBO.UserAttendance SET TimeOut = @dt WHERE UserCode = @UserCode AND RowID = @RowID
```

**Note the design detail:** `@date_in_out` is passed **from the client**, with `GetDate()` commented out (`/*GetDate()*/`). The user's own machine clock determines the timestamp. **Risk (Medium):** attendance would be trivially falsifiable if enabled.

**Attendance is not the same as login.** There is no session table at all: `CashierShift`, `CashierShiftUsers`, `CashierActivity`, `CashierJob` are all **0 rows**, and `Manage → Session Monitor` (right 1292) is an ADMIN-only screen with no backing table in use.

---

# PART G — AUDIT TRAIL: WHAT IS ACTUALLY AUDITED

## G.1 Audit tables — schema and live population — **Verified**

| Table | Rows | Key columns | Written by | Verdict |
|---|---:|---|---|---|
| **`ItemLog`** | **110,329** | `ItemRowID, LogDate, UserCode, ChangeReason, Module, + 134 snapshot columns of the full Item row` | **Client** (only SQL writer is `sp_GenerateItemLog_DataCarryDB`, for import scenarios) | ✅ **The single genuinely useful audit trail.** Full before-image of the item master on every change. |
| `EventLog` | **1** | `EventID, Date, EventType, Module, Detail, UserCode` | `SP_Insert_EventLog` | ⚠ Effectively unused. Sole row: `2024-05-30 19:35:41 / Alert / Auto Restore/Recovery / "Auto Database Recovery Resulted in Success. Backup Restored = AutoClientFazalDinPP19DBDump2" / UserCode 1` |
| `ActivityMonitor` | **0** | `DocumentCode, DocumentType, DocCatCode, Category, Date, PartyType, PartyCode, UserCode, Amount, Remarks, Printed, MachineName, HeaderNo, HeaderInvNo` | `SP_UpdateActivityMonitor`, cleared by `SP_ClearActivityMonitorHistory` | ⚠ **It is a live *work-queue*, not a history.** `SP_UpdateActivityMonitor` **DELETEs then re-INSERTs** the row for each document. 0 rows = queue drained, not "nothing happened". |
| `UserGroupsLog` | **9** | `LogDate, UserCode, GroupCode, ModifiedBy` | Trigger `Trig_UserGroups_After_Update_Delete` | ◐ Partial — logs the *old* group only; INSERTs not logged |
| `PostedInvoiceEditingLog` | **0** | `LogId, Date, DocumentType, DocumentCode, Machine, UserCode` | `SP_Insert_PostedInvoiceEditingLog` | ✅ Zero rows = **no posted invoice has ever been edited** (consistent with `SpecialRight.Enable='N'`) |
| `DBRepairLog` | **0** | `RowID, Date, RepairLevel, ObjectName` | `SP_CheckDBIntegrity` / repair procs (`db_modules_full.sql:9990`, `:46748`) | ✅ Zero rows = no DBCC repair has ever been run |
| `AutoSaleLog` | **0** | `ASLogCode, Date, SaleTemplateCode, SSaleInvCode, ESaleInvCode, SDate, EDate` | `sp_GenerateMarkedSaleFromTemplate` (`:27456`) | Feature unused |
| `CustLog` | **0** | `CustLogID, CustCode, ColumnName, LastValue, NewValue, Date, UserCode` | **No SQL writer** — client only | ⚠ Column-level customer change log — **never written**. (Only 2 customers exist.) |
| `SaleLedgerLog` | **0** | 150 columns (full `SaleLedger` snapshot) | **No SQL writer** | ⚠ **Invoice-header change history is NOT captured.** |
| `SaledetailLog` | **0** | 73 columns (full `SaleDetail` snapshot) | **No SQL writer** | ⚠ **Invoice-line change history is NOT captured.** |
| `AccountBalanceLog` | 0 | `LogID, Date, Acccode, Balance` | — | Unused |
| `PrescriptionHeaderLog` / `PrescriptionDetailLog` / `ItemMeterLog` | 0 | — | — | Clinical/metering verticals unused |
| `DataTransferLog`, `DataImportLog`, `CRS_DataTransferLog` | 0 | — | — | Multi-branch sync unused |

`Evidence: table rows from sys.partitions cross-checked with SELECT COUNT(*); writers located by grep for "INSERT … <Table>" across db_modules_full.sql.`

### `ItemLog` in detail — **Verified**

| Dimension | Live values |
|---|---|
| Date range | 2025-01-01 18:53 → 2026-07-31 16:40 (110,329 rows) |
| `Module` | `Purchase Posting` 105,847 · `Item Form` 4,020 · *(blank)* 461 · `Change Item Price - Manufacturer Wise` 1 |
| `ChangeReason` | `Multiple Changes` 106,216 · `saleprice` 1,458 · `New Item` 1,079 · *(blank)* 474 · `name` 210 · `iccode` 192 · `taxable` 175 · `saleprice,saleprice` 113 · `minqty` 93 · `packunits` 58 |

**Strongly Inferred:** ItemLog is written primarily as a side-effect of purchase posting (a purchase updates cost/sale price), and secondarily from the Item form. `ChangeReason` is a comma-joined list of changed column names, which for bulk changes degenerates to the literal `'Multiple Changes'`.

## G.2 Audit coverage assessment

### What **IS** audited — **Verified**

| Event | Where captured | Attribution |
|---|---|---|
| Item master change (price, name, tax, packing, reorder, activeness…) | `ItemLog` — full 134-column before-image | `UserCode` + `LogDate` + `Module` + `ChangeReason` |
| Who created/attributed each sale invoice | `SaleLedger.SalesmanCode` + `MachineName` + `Date` | 291,361 rows, all attributed |
| Group re-assignment of a user (old value) | `UserGroupsLog` via trigger | `ModifiedBy` |
| Automatic DB restore/recovery event | `EventLog` | 1 row |
| Item stock-position snapshots | `StockReport` (3.2 M rows) | Not user-attributed |

### What is **NOT** audited — **Verified, this is the critical gap list**

| Un-audited event | Consequence |
|---|---|
| **Login / logout / failed login** | No table, no procedure, no column. Impossible to know who was in the system, when, or whether anyone tried to break in. |
| **Password change** | `Maintenance → Change Password` (right 91) is granted to all groups. No log. |
| **User created / deactivated / deleted** | No trigger on `dbo.Users`. |
| **Right granted or revoked** (`GroupRights` INSERT/DELETE) | No trigger on `GroupRights`. **Permission changes are completely invisible.** |
| **Group created / renamed / policy-limit changed** (`Groups`) | No trigger. Someone raising `FinancialLimitPerTransaction` leaves no trace. |
| **First-time group assignment** (`UserGroups` INSERT) | Trigger is `FOR Update, Delete` only. |
| **Sale invoice header/line modified after save** | `SaleLedgerLog` / `SaledetailLog` exist with the right shape but are **never written**. `SaleLedger.ModifiedBy` and `.PostedBy` are **NULL on all 291,361 rows**. |
| **Purchase / purchase-return / voucher modification** | No log tables at all. |
| **Report viewed / exported / printed** | No log. Right 638 `Save As Excel` allows silent bulk data extraction. |
| **Customer or supplier master change** | `CustLog` never written; no `SupplierLog` exists. |
| **Database backup taken** (and by whom, to where) | No log. Backup right is held by all groups. |
| **`SpecialRight` toggled from `N` to `Y`** | No log. |
| **Any direct SQL modification** | No SQL Server Audit specification exists; `default trace enabled=1` is the only server-side trace and it does not capture DML. |

`Evidence: sys.database_audit_specifications and sys.server_audit_specifications are empty; only 10 DML triggers exist, none on Users/Groups/GroupRights/SaleLedger/PurLedger/VirtualGl.`

---

# PART H — SECURITY FINDINGS

Severity scale: **Critical** (immediate financial/regulatory exposure) · **High** · **Medium** · **Low**.

## H.1 Identity & credentials

| # | Finding | Severity | Evidence |
|---|---|:--:|---|
| **S1** | **Application passwords stored in plaintext** in `dbo.Users.Password varchar(60)`. Anyone with `SELECT` on one table owns every account. | **Critical** | `SELECT UserCode, UserName, Password FROM Users` returns readable values; `sys.columns` shows no hash column |
| **S2** | **Passwords are trivially weak.** Seven of nine are 1–2 characters: `1`, `0`, `3`, `25`, `55`, `60`, `z0`. Two users share `60`. The admin password `pakistan9080` is a dictionary word + digits. | **Critical** | live `Users` data |
| **S3** | **The SQL Server `sa` password (`2yhg35xe`) is hardcoded inside `abuzar.exe`** and transmitted by every workstation on every launch. It was recovered by packet-capturing the TDS `LOGIN7` message. | **Critical** | `ABUZAR_V2_RECOVERY_JOURNAL.md` lines 28, 47, 197–215 |
| **S4** | **Every application session runs as SQL Server `sysadmin`.** There is no least-privilege database principal: `sys.database_principals` for this DB contains only `dbo`, `guest`, `INFORMATION_SCHEMA`, `sys`. Therefore the entire `Rights`/`GroupRights` model is **advisory**: any user with a SQL client and the (recoverable) `sa` password has unrestricted DROP/UPDATE/DELETE on all 762 tables. | **Critical** | `SELECT dp.name, dp.type_desc, r.name FROM sys.database_principals dp …` → only `dbo` (db_owner) |
| **S5** | **`UserAuthenticationInfo.AuthenticationKey = '12345678'`** — a shared secondary secret at factory default. | **High** | `SELECT * FROM UserAuthenticationInfo` |
| **S6** | **`SpecialRight.RightPwd = 'spcadminsecrets'`** — a plaintext, shared, vendor-wide break-glass password identical across all four posted-invoice-edit rights. | **High** | `SELECT * FROM SpecialRight` |
| **S7** | **Backup media passwords are a fixed vendor formula** — `MEDIAPASSWORD='alcia'+@ServerName`, `PASSWORD='alfia'+@ServerName`. Knowing the server name is enough to restore any backup. | **High** | `db_modules_full.sql:45390, :45927, :45946, :57709, :57734` |
| **S8** | SQL Server runs in **mixed-mode** authentication (`SERVERPROPERTY('IsIntegratedSecurityOnly')=0`) with `sa` **enabled** and `is_expiration_checked = 0`. | **High** | `sys.server_principals` ⋈ `sys.sql_logins` |
| **S9** | **`BUILTIN\Users` is a SQL Server login.** Every interactive Windows user on the machine can connect to the instance. | **Medium** | `sys.server_principals` |
| **S10** | **No password policy, expiry, complexity, lockout, or failed-attempt tracking** in the application. `dbo.Users` has no columns for any of it. | **High** | `sys.columns` for `Users` |
| **S11** | **No session management.** No session table, no timeout, no idle logout, no forced-logout, and `AllowLoginAUserMultipleTimes='Y'` explicitly permits unlimited concurrent sessions per account. | **High** | `SoftwarePreferences` PrefID 65; absence of any session table |

## H.2 Server configuration

| # | Finding | Severity | Evidence |
|---|---|:--:|---|
| **S12** | **`xp_cmdshell` is ENABLED and must stay enabled.** The app calls it at startup for licence/dependency probing. Combined with S3/S4 this is **arbitrary OS command execution as the SQL Server service account from any workstation**. | **Critical** | `sys.configurations: xp_cmdshell value=1, value_in_use=1`; `SP_WayToMoon` at `db_modules_full.sql:61322` → `EXEC @rt_code = master..xp_cmdshell @cmdline, NO_OUTPUT` |
| **S13** | **`Ole Automation Procedures` is ENABLED.** Used by `SP_RequestHttpWebService` to make outbound HTTP/SOAP calls via `MSXML2.ServerXMLHttp` (FBR digital invoicing). With sysadmin access this is a second arbitrary-code path. | **High** | `sys.configurations: Ole Automation Procedures = 1`; `db_modules_full.sql:46973-47062` → `exec sp_OACreate 'MSXML2.ServerXMLHttp', @obj out` |
| **S14** | **Database compatibility level 100 (SQL Server 2008).** Blocks modern security and language features (e.g. `STRING_AGG`, `Always Encrypted` tooling ergonomics, some `sys.dm_*` improvements) and signals the codebase's real age. | **Medium** | `SELECT compatibility_level FROM sys.databases → 100` |
| **S15** | **No encryption at rest.** `is_encrypted = 0` (no TDE), no Always Encrypted columns (`sys.column_encryption_keys` empty), no column masking (`sys.masked_columns` empty). | **Medium** | `sys.databases`, `sys.column_encryption_keys` |
| **S16** | **No SQL Server Audit specification** at server or database level. `default trace` is the only trace and it captures no DML. | **High** | `sys.database_audit_specifications` / `sys.server_audit_specifications` empty |
| **S17** | **Dynamic SQL built by string concatenation** in at least 8 procedures using `EXEC(@qry)`, including import/export paths that concatenate table and column names. | **Medium** | `grep -cE "EXEC\s*\(" db_modules_full.sql → 8`; e.g. `db_modules_full.sql:37143`, `:51636`, `:53007` |

## H.3 Authorization-model weaknesses

| # | Finding | Severity | Evidence |
|---|---|:--:|---|
| **S18** | **Authorization is enforced in the client, not the server.** Only right 515 is checked in production SQL paths. No posting, pricing, discounting or GL procedure verifies the caller. | **Critical** | `grep -i "GroupRights" db_modules_full.sql` → hits in only 3 procedures, of which 2 reference non-existent right codes |
| **S19** | **Group financial limits are unenforceable.** `Groups.FinancialLimitPerTransaction` (100,000), `MaxQtyLimit` (10,000), `saleinvflatdisc`, `saleItemdiscperc`, `AccumulatedDiscPerc`, `ServiceDiscPercLimit` are referenced by **zero** SQL objects. | **Critical** | `grep` over all 762 objects → 0 matches for all six column names |
| **S20** | **`fn_GetGroupCode` uses `MIN(GroupCode)`** — multi-group membership silently resolves to the lowest group code, which at this deployment is `2 = ADMINISTRATOR`. Adding a user to ADMINISTRATOR + any restricted group grants full server-side privilege. | **High** | `db_modules_full.sql:354-372` |
| **S21** | **No deny rules, no inheritance, no per-record ownership, no separation of duties.** A single group holds *create*, *modify* and *post* for the same document. `SHIFT INCHARGE` and `SALES OFFICER` can each create, edit and post a purchase invoice unaided. | **High** | `GroupRights` for 11/12 contains 504, 507, 528 simultaneously |
| **S22** | **No delete right exists**, yet `SaleLedger.DELETED char(1)` and preference `PreserveDeletedSaleItemsLog='Y'` prove deletion happens. Deletion is entirely ungoverned by the rights model. | **High** | `grep -i delete` over `Rights` → 1 hit, a report |
| **S23** | **All operational groups can back up the database** (right 1308, granted to groups 2/11/12) with vendor-fixed media passwords. Any counter staffer can walk out with the full customer, cost and margin dataset. | **High** | `GroupRights` 11/12 ⊃ 1308; `db_modules_full.sql:45390` |
| **S24** | **Break-glass password is shared and static.** Enabling `SpecialRight` would let anyone knowing `spcadminsecrets` retro-edit posted, GL-affecting invoices with only a `PostedInvoiceEditingLog` row (no before/after image). | **High** | `SELECT * FROM SpecialRight` |
| **S25** | **The `Transactions` (accounting voucher) menu root has no right**, leaving the accounting module's menu visibility undefined while its window rights remain ADMIN-only. | **High (Unclear)** | `SELECT COUNT(*) FROM Rights WHERE IndicesString LIKE '4,%' → 0` |
| **S26** | **Configuration drift / dead permission data.** `Rightsclone` (2,122 rows, 1,636 orphaned), `temp_GroupRights` (6,265 rows for 16 group codes, 12 of which don't exist), `UserRights` (0 rows). Nobody can tell from the DB which is authoritative without reading the binary. | **Medium** | counts as cited in §C.1 |

## H.4 Audit weaknesses

| # | Finding | Severity | Evidence |
|---|---|:--:|---|
| **S27** | **No login/logout audit whatsoever.** | **Critical** | no table, no procedure, no column |
| **S28** | **No audit of permission changes** (`GroupRights`, `Groups`, `Users`). | **Critical** | only 10 triggers exist; none on these tables |
| **S29** | **Invoice modification history is not captured.** `SaleLedgerLog`/`SaledetailLog` exist with correct 150/73-column shapes but have **no writer and 0 rows**; `SaleLedger.ModifiedBy` and `.PostedBy` are NULL on all 291,361 rows. | **Critical** | `SELECT ModifiedBy, COUNT(*) FROM SaleLedger GROUP BY ModifiedBy` → one NULL group of 291,361 |
| **S30** | **Attendance timestamps come from the client clock**, not `GETDATE()` — `SP_Mark_UserAttendance` takes `@date_in_out` as a parameter with `/*GetDate()*/` commented out. | **Medium** (dormant — 0 rows) | `db_modules_full.sql:39510` |
| **S31** | **`ActivityMonitor` is a queue, not a log** — `SP_UpdateActivityMonitor` deletes and re-inserts. Anyone reading it as an audit trail will be misled. | **Medium** | `db_modules_full.sql:55985-55990` → `DELETE DBO.ActivityMonitor WHERE DocumentType = @DocumentType AND DocumentCode = @DocumentCode` |
| **S32** | **No report-access or export logging** while `Save As Excel` (638) permits silent bulk extraction. | **Medium** | absence of any log table + right 638 |

---

# PART I — **RECOMMENDED** RBAC MODEL FOR THE REBUILD

> ⚠ **Everything in Part I is a PROPOSAL for the new Node/React/MySQL system. None of it exists today.** Label: **Recommended**.

## I.1 Design principles

1. **Enforce on the server, always.** Every mutating API endpoint checks permission server-side. The React client uses permissions only to *hide* UI; it never *is* the control.
2. **Deny by default.** No permission row ⇒ denied.
3. **Preserve the existing vocabulary.** Migrate `Module` (57 rows) and the 486 `Rights` names as the seed catalogue so staff recognise the screens — but re-express them on an explicit resource × action grid.
4. **Separate `permission` (what) from `scope` (which rows).** The `GroupAllowed*` family proves the vendor already needed this; make it first-class.
5. **Many-to-many roles per user**, with union-of-permissions semantics (never `MIN()`).
6. **Every authorization decision and every permission change is auditable.**

## I.2 Proposed schema (MySQL 8)

```sql
-- ---------- Identity ----------
CREATE TABLE app_user (
  user_id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  username           VARCHAR(64)  NOT NULL UNIQUE,
  display_name       VARCHAR(120) NOT NULL,
  email              VARCHAR(255) NULL,
  password_hash      VARCHAR(255) NOT NULL,        -- argon2id; NEVER the password
  password_algo      VARCHAR(32)  NOT NULL DEFAULT 'argon2id',
  password_set_at    DATETIME     NOT NULL,
  must_change_pw     TINYINT(1)   NOT NULL DEFAULT 1,
  mfa_secret_enc     VARBINARY(255) NULL,
  failed_attempts    SMALLINT     NOT NULL DEFAULT 0,
  locked_until       DATETIME     NULL,
  is_active          TINYINT(1)   NOT NULL DEFAULT 1,
  legacy_user_code   SMALLINT     NULL,            -- maps to dbo.Users.UserCode
  created_at DATETIME NOT NULL, created_by BIGINT NULL,
  updated_at DATETIME NOT NULL, updated_by BIGINT NULL
);

-- ---------- Permission catalogue ----------
CREATE TABLE resource (             -- e.g. 'sale.cash', 'purchase.order', 'item', 'gl.voucher'
  resource_key  VARCHAR(64) PRIMARY KEY,
  module_id     SMALLINT NOT NULL,                 -- maps to legacy dbo.Module.Module
  display_name  VARCHAR(120) NOT NULL,
  is_financial  TINYINT(1) NOT NULL DEFAULT 0
);

CREATE TABLE action (               -- the explicit verb axis the legacy system lacked
  action_key VARCHAR(24) PRIMARY KEY               -- view,list,create,edit,delete,post,unpost,
);                                                 -- approve,export,print,reprice,discount,override

CREATE TABLE permission (
  permission_id BIGINT PRIMARY KEY AUTO_INCREMENT,
  resource_key  VARCHAR(64) NOT NULL,
  action_key    VARCHAR(24) NOT NULL,
  legacy_right_code SMALLINT NULL,                 -- traceability to dbo.Rights.RightCode
  risk_level    ENUM('low','medium','high','critical') NOT NULL DEFAULT 'low',
  UNIQUE KEY uq_perm (resource_key, action_key),
  FOREIGN KEY (resource_key) REFERENCES resource(resource_key),
  FOREIGN KEY (action_key)   REFERENCES action(action_key)
);

-- ---------- Roles ----------
CREATE TABLE role (
  role_id     BIGINT PRIMARY KEY AUTO_INCREMENT,
  role_key    VARCHAR(64) NOT NULL UNIQUE,
  display_name VARCHAR(120) NOT NULL,
  is_system   TINYINT(1) NOT NULL DEFAULT 0,       -- system roles cannot be deleted
  legacy_group_code SMALLINT NULL
);
CREATE TABLE role_permission (
  role_id BIGINT NOT NULL, permission_id BIGINT NOT NULL,
  granted_at DATETIME NOT NULL, granted_by BIGINT NOT NULL,
  PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE user_role (                            -- MANY-TO-MANY, union semantics
  user_id BIGINT NOT NULL, role_id BIGINT NOT NULL,
  valid_from DATETIME NOT NULL, valid_to DATETIME NULL,   -- supports temporary elevation
  assigned_by BIGINT NOT NULL, assigned_at DATETIME NOT NULL,
  PRIMARY KEY (user_id, role_id)
);

-- ---------- Scope (row-level), replacing the GroupAllowed* family ----------
CREATE TABLE role_scope (
  role_id     BIGINT NOT NULL,
  scope_type  ENUM('godown','header','price_tier','cash_account','voucher_category',
                   'supplier_category','service_category','branch') NOT NULL,
  scope_value VARCHAR(64) NOT NULL,
  module_id   SMALLINT NULL,                       -- NULL = applies to all modules
  priority    SMALLINT NOT NULL DEFAULT 10,
  PRIMARY KEY (role_id, scope_type, scope_value, module_id)
);

-- ---------- Numeric limits, ENFORCED SERVER-SIDE ----------
CREATE TABLE role_limit (
  role_id    BIGINT NOT NULL,
  limit_key  VARCHAR(64) NOT NULL,                 -- max_txn_value, max_qty, max_line_disc_pct,
  limit_value DECIMAL(18,4) NOT NULL,              -- max_inv_flat_disc, max_price_delta_pct
  PRIMARY KEY (role_id, limit_key)
);

-- ---------- Sessions ----------
CREATE TABLE user_session (
  session_id   CHAR(36) PRIMARY KEY,
  user_id      BIGINT NOT NULL,
  issued_at    DATETIME NOT NULL,
  expires_at   DATETIME NOT NULL,
  last_seen_at DATETIME NOT NULL,
  ip_address   VARBINARY(16) NULL,
  workstation  VARCHAR(64) NULL,                   -- successor to SaleLedger.MachineName
  revoked_at   DATETIME NULL,
  revoked_by   BIGINT NULL
);

-- ---------- Audit (append-only) ----------
CREATE TABLE security_audit (
  audit_id   BIGINT PRIMARY KEY AUTO_INCREMENT,
  occurred_at DATETIME(3) NOT NULL,
  actor_user_id BIGINT NULL,
  session_id CHAR(36) NULL,
  event_type VARCHAR(64) NOT NULL,   -- login.success, login.fail, logout, session.revoked,
                                     -- password.change, user.create, user.deactivate,
                                     -- role.assign, role.revoke, permission.grant,
                                     -- permission.revoke, limit.change, breakglass.enable,
                                     -- authz.denied, export.run, backup.run
  resource_key VARCHAR(64) NULL,
  target_id  VARCHAR(64) NULL,
  ip_address VARBINARY(16) NULL,
  workstation VARCHAR(64) NULL,
  detail_json JSON NULL,
  INDEX ix_audit_time (occurred_at),
  INDEX ix_audit_actor (actor_user_id, occurred_at)
);

CREATE TABLE data_change_audit (     -- successor to ItemLog, generalised
  change_id  BIGINT PRIMARY KEY AUTO_INCREMENT,
  occurred_at DATETIME(3) NOT NULL,
  actor_user_id BIGINT NOT NULL,
  table_name VARCHAR(64) NOT NULL,
  pk_value   VARCHAR(64) NOT NULL,
  operation  ENUM('INSERT','UPDATE','DELETE') NOT NULL,
  before_json JSON NULL,
  after_json  JSON NULL,
  reason     VARCHAR(255) NULL,       -- successor to ItemLog.ChangeReason
  source_module VARCHAR(64) NULL,     -- successor to ItemLog.Module
  INDEX ix_dca (table_name, pk_value, occurred_at)
);
```

## I.3 Recommended role set (seeded from the four real groups + separation of duties)

| Role key | Display name | Maps from | Notes |
|---|---|---|---|
| `owner` | Owner / Proprietor | — (new) | Sees all financials + reports; **cannot** post transactions |
| `sys_admin` | System Administrator | `ADMINISTRATOR` (2) | Users, roles, permissions, preferences, backups. **No** transaction posting, **no** price change |
| `pharmacy_manager` | Pharmacy Manager | `ADMINISTRATOR` (2) operational half | Pricing, item master, purchase approval, reports, discount override |
| `shift_incharge` | Shift In-charge | `SHIFT INCHARGE` (11) | Supervise counter, quotations, item creation, daily reports |
| `sales_officer` | Sales Officer / Counter | `SALES OFFICER` (12) | Cash sale + cash return end-to-end; no cost visibility by default |
| `purchase_officer` | Purchase Officer | split out of 11/12 | Create/edit purchase & PO — **cannot post** (separation of duties) |
| `accountant` | Accountant | `ADMINISTRATOR` (2) accounting half | Vouchers, ledgers, GL, reconciliations |
| `auditor` | Auditor (read-only) | `REMOTE` (5) | Read-everything, write-nothing, export-with-logging |

**Deliberate change from today (Recommended):** split *create/edit* from *post* on purchases, and split *system administration* from *business administration*. Today one group (`ADMINISTRATOR`) does everything, and the counter groups can create, edit **and** post a purchase invoice unaided (finding S21).

## I.4 Recommended target matrix (starting configuration)

`●` full · `◐` conditional (limit- or scope-bound) · `○` none

| Resource | owner | sys_admin | pharmacy_manager | shift_incharge | sales_officer | purchase_officer | accountant | auditor |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `sale.cash` view/list | ● | ○ | ● | ● | ● | ○ | ● | ● |
| `sale.cash` create | ○ | ○ | ● | ● | ● | ○ | ○ | ○ |
| `sale.cash` edit (unposted) | ○ | ○ | ● | ● | ◐ own-shift | ○ | ○ | ○ |
| `sale.cash` post | ○ | ○ | ● | ● | ● | ○ | ○ | ○ |
| `sale.cash` unpost / edit-posted | ○ | ○ | ◐ break-glass | ○ | ○ | ○ | ◐ break-glass | ○ |
| `sale.cash` discount ≤ limit | ○ | ○ | ● | ◐ ≤5% | ◐ ≤2% | ○ | ○ | ○ |
| `sale.cash` reprice line | ○ | ○ | ● | ◐ | ○ | ○ | ○ | ○ |
| `sale.return` create/post | ○ | ○ | ● | ● | ● | ○ | ○ | ○ |
| `purchase` create/edit | ○ | ○ | ● | ● | ○ | ● | ○ | ○ |
| `purchase` post | ○ | ○ | ● | ● | ○ | **○** | ○ | ○ |
| `purchase.order` create/edit | ○ | ○ | ● | ● | ● | ● | ○ | ○ |
| `item` view cost/margin | ● | ○ | ● | ● | **○** | ● | ● | ● |
| `item` create | ○ | ○ | ● | ● | ○ | ◐ from PO | ○ | ○ |
| `item` reprice | ○ | ○ | ● | ◐ ≤ limit | ○ | ○ | ○ | ○ |
| `gl.voucher` create/post | ○ | ○ | ○ | ○ | ○ | ○ | ● | ○ |
| `gl.ledger` view | ● | ○ | ● | ○ | ○ | ○ | ● | ● |
| `report.*` view/print | ● | ○ | ● | ● | ◐ own sales | ◐ purchase | ● | ● |
| `report.*` export (logged) | ● | ○ | ● | ○ | ○ | ○ | ● | ◐ logged |
| `admin.user` / `admin.role` | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ |
| `admin.backup` | ○ | ● | ○ | **○** | **○** | ○ | ○ | ○ |
| `admin.preferences` | ○ | ● | ◐ business prefs | ○ | ○ | ○ | ○ | ○ |
| `audit.read` | ● | ● | ◐ | ○ | ○ | ○ | ◐ | ● |

## I.5 Recommended non-negotiable controls

| Control | Requirement |
|---|---|
| Password storage | **argon2id** (or bcrypt cost ≥ 12). Plaintext migration is a one-way reset: on cutover, force every user to set a new password. |
| Password policy | Min 12 chars, breach-list check (k-anonymity HIBP), no reuse of last 5, 90-day rotation for privileged roles. |
| Lockout | 5 failed attempts → 15-minute lock, exponential backoff, all attempts written to `security_audit`. |
| MFA | Required for `sys_admin`, `owner`, `accountant`, `pharmacy_manager`. |
| Sessions | Short-lived access token (15 min) + rotating refresh token; server-side revocation list; idle timeout 20 min for counter roles; admin can force-logout. |
| Database account | Application connects as a **non-sysadmin** MySQL user with `SELECT/INSERT/UPDATE` on business tables and `EXECUTE` on procedures; **no** `DROP`, **no** `FILE`, **no** `SUPER`. Credentials in a secrets store / env var — **never** in the binary. |
| Server-side limit enforcement | `role_limit` values are evaluated inside the transaction that writes the document, not in the browser. |
| Break-glass | Per-user MFA challenge (not a shared password), time-boxed (≤60 min), auto-expiring, mandatory reason, full before/after image written to `data_change_audit`, plus alert e-mail to owner. |
| Audit immutability | `security_audit` and `data_change_audit` are append-only (no UPDATE/DELETE grant), retained ≥ 7 years for FBR/tax defensibility. |
| Export controls | Every export writes `security_audit(event_type='export.run')` with row count and filter parameters. |
| Backup | Only `sys_admin`; backups encrypted with a key from the secrets store, **never** a name-derived formula. |
| Transport | TLS on the DB connection and on the web app; no plaintext credential ever crosses the wire. |
| No `xp_cmdshell` equivalent | The new stack must have **no** OS-shell path from the database. The startup licence probe (`SP_WayToMoon`) must be re-implemented in the application tier or removed. |

## I.6 Recommended migration plan for permissions

1. **Freeze and snapshot** `Rights`, `GroupRights`, `Groups`, `UserGroups`, `Users` (done — see `…/scratchpad/rights_all.tsv`, `grouprights_all.tsv`).
2. **Classify all 486 rights** onto the `resource × action` grid. Keep `legacy_right_code` on every `permission` row for traceability and for the owner's sign-off review.
3. **Discard** `Rightsclone`, `temp_GroupRights`, `UserRights`, `Rightsclone` orphans, and all rights in `RightsCategory` buckets with 0 rows (Garments, POS, In-Patient, Guest, Installment, Due, Student, Payroll, Patient, Services) **unless the owner explicitly wants that vertical**.
4. **Re-derive the four groups as eight roles** (§I.3), then run a diff report: "under the new model, user X gains/loses the following capabilities" — and have the owner sign it.
5. **Force a password reset for all 9 users** at cutover. Do not migrate any password value.
6. **Do not migrate** `SpecialRight`, `UserAuthenticationInfo`, or any hardcoded credential.
7. **Backfill audit**: import `ItemLog` (110,329 rows) into `data_change_audit` and `UserGroupsLog` (9 rows) into `security_audit` so history is not lost.

---

# PART J — UNKNOWNS AND ITEMS REQUIRING VALIDATION

## J.1 Requires vendor confirmation or observation of the running app

| # | Question | Why it matters |
|---|---|---|
| U1 | With the `Transactions` menu root (`4,`) absent from `Rights`, is the Accounting-Voucher menu **hidden for everyone** or **unrestricted for everyone**? | Determines whether floor staff can currently reach the GL. **High impact.** |
| U2 | Is a right the client checks *by code* or *by menu path*? If a right row is missing entirely (rather than merely un-granted), does the client fail open or fail closed? | Governs the interpretation of A6 (rights 5070–5072, 5294–5300) and of U1. |
| U3 | Are `Object='A'` rights evaluated on the **leaf only**, or does the client also require every ancestor in `IndicesString`? | `SALES OFFICER` holds leaf 14 (`Sale Return → Credit Sale`) — reachable only if ancestors 12 and 9 are also held (they are), so the model is consistent; but the rule must be confirmed for the rebuild. |
| U4 | Does the client honour `GroupRights.Status`, or only row presence? All 726 rows are `Status=1`, so it has never been exercised. | Affects whether a "revoke without delete" path exists. |
| U5 | Is `StartupRight.Allowed='Y'` a global grant when `GroupAllowedStartupRight` is empty, or does empty mean "nobody"? | Determines whether auto-backup currently runs. |
| U6 | Exactly which UI action writes `ItemLog` — and does it capture *every* item change or only price-affecting ones? | `ItemLog` is the only real audit trail; its completeness determines how much history survives migration. |
| U7 | Does the client ever write `SaleLedger.ModifiedBy` / `PostedBy`? They are NULL in 291,361/291,361 rows. Dead columns, or written only on a path never exercised here? | Confirms S29. |
| U8 | Who currently knows the `ADMIN` password and the `sa` password? | Immediate operational risk. |

## J.2 Requires accountant / owner validation

| # | Item |
|---|---|
| V1 | Is it acceptable that **`SHIFT INCHARGE` and `SALES OFFICER` can create, edit AND post a purchase invoice** with no second pair of eyes? (rights 504 + 507 + 528 held together) |
| V2 | Is it acceptable that **all counter staff can see item purchase cost, average cost and recent purchase price** (rights 523, 705, 706, 707)? |
| V3 | Is it acceptable that **all groups can run `Maintenance → Change Items Price`** (right 120) — a bulk price-change utility? |
| V4 | Is it acceptable that **all groups can back up the database** (right 1308) with a guessable media password? |
| V5 | Should the **PKR 100,000 per-transaction limit** and **10,000 max-quantity limit** actually be enforced? They are currently decorative. |
| V6 | The **`REMOTE` group** (0 members) holds `Modify Price/Values in Purchase`. Delete the group, or fix it? |
| V7 | Confirm the intended split between `SHIFT INCHARGE` and `SALES OFFICER`. The current split is inconsistent (see §E.2 delta table) and looks accreted rather than designed. |
| V8 | Should `SpecialRight` (edit posted invoices) remain permanently disabled? It is currently `N` for all four — a good control worth formalising. |

---

# APPENDIX A — Complete window-right (`Object='W'`) matrix, all 164 rights

Legend: `Adm`=ADMINISTRATOR(2), `Rem`=REMOTE(5), `SI`=SHIFT INCHARGE(11), `SO`=SALES OFFICER(12).
Full machine-readable file: `C:/Users/Admin/AppData/Local/Temp/claude/E--Pharma-Software/6817c053-0a3d-471f-ae16-ab90c079cc3d/scratchpad/matrix_W.tsv`

**ADMINISTRATOR holds all 164.** 103 of the 164 are ADMIN-only. The 61 shared with SI and/or SO are:

| Code | Right | Adm | Rem | SI | SO |
|---:|---|:--:|:--:|:--:|:--:|
| 500 | Cash Sale Posting | ● | ○ | ● | ● |
| 501 | Credit Sale Posting | ● | ○ | ● | ● |
| 504 | Pack Purchase Posting | ● | ○ | ● | ● |
| 506 | Opening Purchase Posting | ● | ○ | ● | ● |
| 507 | Pack Purchase Modify | ● | ○ | ● | ● |
| 509 | Opening Purchase Modify | ● | ○ | ● | ● |
| 510 | Modify Item Basic Data | ● | ○ | ● | ● |
| 512 | Modify Item Activeness | ● | ○ | ● | ● |
| 514 | Modify Item Restriction | ● | ○ | ● | ● |
| 515 | Assign Restricted Items | ● | ○ | ● | ● |
| 516 | Modify Sale Item Discount% | ● | ○ | ● | ● |
| 523 | Display (PurchasePrice, RecentPurchasePrice, AvgPrice) | ● | ○ | ● | ● |
| 524 | Modify Item Alias Name | ● | ○ | ● | ● |
| 528 | Purchase — Save and Posting | ● | ○ | ● | ● |
| 531 | Sales — Save Invoice (Ctrl+S) | ● | ○ | ● | ● |
| 538 | Sales — Show Invoices In List Window | ● | ○ | ○ | ● |
| 549 | Modify Purchase Order | ● | ○ | ● | ● |
| 552 | Modify Purchase Return | ● | ○ | ● | ● |
| 564 | Purchase — Show Invoice List | ● | ○ | ● | ● |
| 566 | Item — Show Item List | ● | ○ | ● | ● |
| 567 | Sale Return — Show Invoices In List | ● | ○ | ● | ● |
| 568 | Purchase Return — Show Invoices In List | ● | ○ | ● | ● |
| 575 | Sales — Item Sale History | ● | ○ | ● | ● |
| 589 | Sale footer — View Invoice-Level Flat Discount | ● | ○ | ● | ● |
| 590 | Sale footer — View Invoice-Level Misc. Charges | ● | ○ | ● | ● |
| 591 | Sale footer — View Invoice-Level Discount(%) | ● | ○ | ● | ● |
| 595 | Sale Return — Modify Sale Return Price | ● | ○ | ○ | ● |
| 614 | PO — Change Calculated Required Packs | ● | ○ | ● | ● |
| 617 | PO — Modify Rate | ● | ○ | ● | ● |
| 623 | Sale Return — Save and Post | ● | ○ | ● | ● |
| 632 | PO — Edit Minimum Qty | ● | ○ | ● | ● |
| 633 | PO — Edit Reorder Qty | ● | ○ | ● | ● |
| 634 | PO — Edit Optimum Qty | ● | ○ | ● | ● |
| 644 | Sales — Cash Sales Retrieve | ● | ○ | ● | ● |
| 645 | Sales — Credit Sales Retrieve | ● | ○ | ○ | ● |
| 675 | Sales — Open (Ctrl+G) | ● | ○ | ● | ● |
| 687 | PO — Apply Customer Associated Quotation (Alt+F8) | ● | ○ | ● | ● |
| 691 | PO — Modify Required Pack(s) Qty | ● | ○ | ● | ● |
| 700 | Sale Return — Save Invoice (Ctrl+S) | ● | ○ | ● | ○ |
| 704 | Purchase — Show Price/Values | ● | ○ | ● | ● |
| 705 | Item — Show Purchase Price | ● | ○ | ● | ● |
| 706 | Item — Show Avg. Price | ● | ○ | ● | ● |
| 707 | Item — Show Recent Purchase Price | ● | ○ | ● | ● |
| 708 | Sales — Save and Post (Ctrl+Q) | ● | ○ | ● | ● |
| 5091 | Purchase — Show Item Purchase History (Ctrl+H) | ● | ○ | ● | ● |
| 5101 | Item — **Add New Item** | ● | ○ | ● | ○ |
| 5121 | Purchase — **Create New Item** | ● | ○ | ● | ● |
| 5192 | Purchase Return — Modify Price | ● | ○ | ● | ● |
| 5193 | Purchase Return — Modify Disc. % | ● | ○ | ● | ● |
| 5207 | Purchase Return — Post | ● | ○ | ● | ● |
| 5217 | Reports — **Print Report** | ● | ○ | ● | ● |
| 5229 | Purchase — Allow Deviation From Previous Margin On Posting | ● | ○ | ● | ○ |
| 5245 | Purchase — Attach Document(s) | ● | ○ | ● | ○ |
| 5256 | Item — Show Sale Price | ● | ● | ● | ● |
| 5257 | Item — Show Sale Discount % | ● | ● | ● | ● |
| 5258 | Item — Show Flat Discount | ● | ● | ● | ● |
| 5283 | Purchase Return — View Invoice-Level Discount(%) | ● | ○ | ● | ○ |
| 5284 | Purchase Return — View Invoice-Level Flat Discount | ● | ○ | ● | ○ |
| 5285 | Purchase Return — View Invoice-Level Misc. Charges | ● | ○ | ● | ○ |
| 5286 | Services — Show Invoices In List Window | ● | ● | ● | ● |
| 5290 | Purchase — **Modify Price/Values in Purchase** | ● | ● | ● | ● |

### The 103 ADMIN-only window rights (grouped)

- **Sale pricing/discount overrides:** 502 Cash Sale Modify · 503 Credit Sale Modify · 511 Modify Sale Price Downward · 701 Modify Sale Price Upward · 513 Display Price List In Sale · 517 Modify Sale Item FlatDiscount · 518 Modify SR Item Discount% · 519 Modify SR SalePrice · 551 Save as Normal Sale · 1797 Allow Sale Price Below AvgPrice · 5247 Apply Customized GST% in Unit S/Tax · 1820 Show Pre Disc. %
- **Sale insight:** 535 View Stock In Sale/Return Footer · 539 Show Net Amount Column · 545 Item Priority Setting · 574 **Preview Sale Invoice Margin** · 576 Previous Invoice Info · 603 Show Refused Sale Entry Form · 611 **Override Customer Credit Limit** · 5056 Customer-Wise Sale Detail Report · 5253 Branch-Wise Item Stock Position · 5259–5262 F6/F7/F8/F9 helper windows on Qty · 5282 Item Purchase History · 5309 Print Patient Labels
- **Purchase (loose):** 505 Loose Purchase Posting · 508 Loose Purchase Modify · 5267 Fetch Purchase Invoice From Other Sources
- **Accounting voucher window:** 537 View Restricted Accounts · 546 View Accounts Ledger Report · 547 Show Account Balance · 565 Show Transaction List · 593 Populate Invoices · 606 Show All Vouchers · 622 Save and Post · 5218 Post · 5249 Modify Date · 5266 Lock Debit/Credit Amount · 1754/1755 Attach Document / Document Gallery · 5252 Show Patient Ledger · 5264/5265 Student fine waiver / receivables
- **Reports data portability:** 637 **Save As** · 638 **Save As Excel**
- **Master data:** 525 Modify Customer Alias · 526 Modify Supplier Alias · 649 Modify Customer Basic Data · 650 Modify Supplier Basic Data · 673 Modify Customer Lisc. Expiry · 720 Supplier — Show Account Ledger · 587 Item Search Window — Show Purchase Price · 1796 Show Allow Sale Price Below AvgPrice
- **Quotation / order:** 602 Modify Quotation · 676 Edit Quotation · 1825 Generate Sales From Pending Quotations
- **Stock / godown:** 548 Modify Batch and Expiry · 553/554 Adjustment Decrease/Increase Modify Price · 613 Stock Adjustment Save and Posting · 1826 InterGodown Modify Transfer
- **Cashier management (module unused):** 5027, 5064, 5065, 5066, 5067, 5068, 5250
- **Fiscalisation / FBR:** 5237, 5238, 5241, 5242, 5302–5305, 1821 Digitalize Sale Invoice, 1822 Update Digital Invoice Info
- **Multi-branch / CRS (unused):** 1749–1753, 5306 Drop Box Mark as Pulled
- **Other verticals (unused):** 5255 Production Buffer · 5263 Student Registration · 5268 E-Prescription Appointments · 5287 Generate Payroll Slips · 5289 POS Save as Credit · 5308 Post Employee Advance · 5310 ICD · 1811 Discount Policy Based Profit Margin · 5239/5240 PDC Modify Date · 5213–5216 Sales Return footer views · 5243/5244 Sale Attach Document / Gallery · 5246 Purchase Document Gallery

---

# APPENDIX B — Evidence index (quick lookup)

| Claim | Evidence pointer |
|---|---|
| 57 modules and their names | `SELECT Module, Name FROM dbo.Module ORDER BY Module` |
| 486 rights, 322 action + 164 window | `SELECT Object, COUNT(*) FROM Rights GROUP BY Object` |
| 726 grants, all `Status=1` | `SELECT GroupCode, Status, COUNT(*) FROM GroupRights GROUP BY GroupCode, Status` |
| 4 groups, ADMIN holds 100% | `SELECT g.GroupCode, g.GroupName, r.Object, COUNT(*) FROM GroupRights gr JOIN Groups g … JOIN Rights r … GROUP BY …` |
| 9 users, plaintext passwords, all active | `SELECT * FROM dbo.Users ORDER BY UserCode` |
| One group per user via `MIN()` | `db_modules_full.sql:354-372` (`dbo.fn_GetGroupCode`) |
| Godown scoping is server-enforced | `db_modules_full.sql:337-352` (`dbo.fn_GetGodown`); `:8298`; `:45262` |
| Header scoping is server-enforced | `db_modules_full.sql:373-390` (`dbo.fn_GetHeader`) |
| Only right 515 is checked in production SQL | `db_modules_full.sql:29885` and 29 further identical predicates |
| Group financial limits are never enforced | `grep -iE "FinancialLimitPerTransaction\|MaxQtyLimit\|saleinvflatdisc\|saleItemdiscperc\|AccumulatedDiscPerc" db_modules_full.sql` → 0 matches |
| No login procedure exists | `grep -iE "^-- ==== .*(Login\|Auth\|Logon)" db_modules_full.sql` → 0 matches |
| Users.Password never read by SQL | `grep -i "password" db_modules_full.sql` → only migration INSERTs + BACKUP media passwords |
| Group-change trigger | `db_modules_full.sql:64896-64907` (`Trig_UserGroups_After_Update_Delete`) |
| Only 10 triggers exist in the DB | `grep -n "^-- ==== \[SQL_TRIGGER\]" db_modules_full.sql` |
| `xp_cmdshell` enabled + used at startup | `sys.configurations`; `db_modules_full.sql:61322-61348` (`SP_WayToMoon`) |
| Ole Automation enabled + used | `sys.configurations`; `db_modules_full.sql:46973-47062` (`SP_RequestHttpWebService`) |
| No least-privilege DB principal | `SELECT dp.name, dp.type_desc, r.name FROM sys.database_principals dp LEFT JOIN sys.database_role_members …` |
| Backup media password formula | `db_modules_full.sql:45390` |
| ActivityMonitor is a queue not a log | `db_modules_full.sql:55985-55990` |
| `SaleLedger.ModifiedBy`/`PostedBy` all NULL | `SELECT ModifiedBy, COUNT(*) FROM SaleLedger GROUP BY ModifiedBy` |
| ItemLog is the only real audit trail | `SELECT MIN(LogDate), MAX(LogDate), COUNT(*) FROM ItemLog`; `SELECT Module, COUNT(*) FROM ItemLog GROUP BY Module` |
| Vendor master menu (11 roots) vs deployed (6) | `SELECT RightCode, MenuName FROM Rightsclone WHERE Object='A' AND LevelIndex=1`; `SELECT COUNT(*) FROM Rights WHERE IndicesString LIKE '4,%'` |
| Hardcoded `sa` password, plaintext user passwords | `E:/Pharma Software/ABUZAR_V2_RECOVERY_JOURNAL.md` lines 28, 47, 61–62, 197–215, 346–352 |

---

*End of document 09-roles-permissions.md*
