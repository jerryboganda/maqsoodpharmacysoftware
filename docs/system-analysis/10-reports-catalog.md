# 10 — Reporting Inventory & Report Catalog

**System:** WASEELA ABUZAR V3 (vendor "Abuzar"/"Waseela") — deployment **"Fazal Din PP19"**, a retail pharmacy
**Analysis stage:** Stage 10 — Reporting layer (report inventory, parameters, data sources, formulas, export, risks, modernization mapping)
**Document status:** Evidence-based reverse engineering. **There is no application source code.** The authoritative behaviour is the SQL Server programmable objects, the schema, the live data, and the compiled PowerBuilder `.pbd` libraries (read as binary strings only).
**Date of analysis:** 2026-08 (live DB read-only session)

---

## Evidence sources used

| # | Source | What it proved |
|---|---|---|
| E1 | `dbo.Rights` (486 rows) — live DB | The **deployed** menu tree, incl. 240 report nodes / **197 leaf reports** |
| E2 | `dbo.Rightsclone` (2,122 rows) — live DB | The **vendor master** menu catalogue, incl. 953 report nodes / **792 leaf reports** |
| E3 | `dbo.GroupRights` (726 rows) + `dbo.Groups` + `dbo.UserGroups` | Which role can run/print/export which report |
| E4 | `dbo.ReportTitles` (6 rows), `dbo.ReportFilter` (2 rows), `dbo.ReportData` (7 rows), `dbo.CrossTab_ReportData` (0 rows) | Report title overrides, saved filters, and the **global scratch result tables** |
| E5 | `db_modules_full.sql` (2.48 MB, all 762 programmable objects) at `C:/Users/Admin/AppData/Local/Temp/claude/E--Pharma-Software/6817c053-0a3d-471f-ae16-ab90c079cc3d/scratchpad/db_modules_full.sql` | Every report stored procedure's full SQL. Line numbers cited below are line numbers in this file. |
| E6 | `table_columns.tsv`, `table_rowcounts.tsv`, `primary_keys.tsv`, `foreign_keys.tsv` (same scratchpad dir) | Schema of `ReportData` / `CrossTab_ReportData` / `StockReport`; proof of used-vs-dormant tables |
| E7 | Compiled report libraries `E:/Pharma Software/V2_AbuzarSoftware/Application/*.pbd` (122 files) | **3,015 distinct DataWindow objects**, **1,080 `w_arg_*` parameter windows**, **357 `w_selectformat_*` layout pickers** (extracted as UTF-16LE strings) |
| E8 | `E:/Pharma Software/V2_AbuzarSoftware/Application/*.dll` | Export stack: `pb2xls.dll` + `dw2xls.pbd` (Excel), `pbDWExcel12Interop125.dll`, `tp15_pdf.dll` + `tp15_*.dll` (PDF/RTF/HTML/DOC), `QRCodeGenLibrary.dll` |
| E9 | `E:/Pharma Software/V2_AbuzarSoftware/Application/Reports/rptPrintCheque.rpt` | The only external report file — a Crystal Reports cheque layout |
| E10 | Live-data profiling queries (SELECT-only) | Dimension cardinality, posting status, tax column population, GL activity, snapshot cadence |

---

## Evidence-label legend

Every material claim in this document carries exactly one label.

| Label | Meaning |
|---|---|
| **Verified** | Read directly in a stored procedure / view / trigger / schema / live data. Reproducible. |
| **Strongly Inferred** | Multiple independent pieces of evidence converge; no single decisive statement was readable (usually because the UI is compiled). |
| **Unclear** | Evidence is ambiguous or absent; stated as a question, not a fact. |
| **Missing** | The capability is referenced but its implementation/data is not present. |
| **Deprecated** | Present in the product but superseded by a newer object. |
| **Broken/Incomplete** | Present and reachable, but demonstrably produces wrong or empty output at this deployment. |
| **Recommended** | A proposal for the NEW Node/React/MySQL system. **Never** an existing feature. |

> **Rule observed throughout:** an empty table proves *non-use at Fazal Din PP19*. It does **not** prove the feature is absent from the product. These two are kept separate everywhere below.

---

# 1. Executive summary

**Headline (Verified):** Reporting is by far the largest surface of this application. The vendor's master menu catalogue contains **792 distinct leaf report menu items**; **197 of them are switched on at Fazal Din PP19**. Behind them sit **3,015 compiled DataWindow layout objects**, **1,080 parameter-entry windows**, and **~78 report-producing stored procedures**. Every server-side report writes its result into **one of two global, untyped, un-keyed scratch tables (`ReportData`, `CrossTab_ReportData`) that are `DELETE`d at the start of each run** — so two users running two reports at the same time corrupt each other's output. That single architectural fact is the most important thing to know about this reporting layer.

### 1.1 Report counts and confidence

| Measure | Count | Label | Confidence |
|---|---:|---|---|
| Report menu nodes in vendor master (`Rightsclone`, `RightName LIKE 'Reports%'`) | 953 | Verified | High |
| **Distinct leaf reports in vendor master** (nodes with no children) | **792** | Verified | High |
| Report menu nodes deployed here (`Rights`) | 240 | Verified | High |
| **Distinct leaf reports deployed at Fazal Din PP19** | **197** | Verified | High |
| …of which are genuine pharmacy analytics (excl. 11 partner data-export utilities, 8 document re-prints, 12 CRS, 2 patient, 2 student, 1 employee, 1 production) | **~160** | Strongly Inferred | Medium-High |
| Report menu sections in vendor master | 36 | Verified | High |
| Report menu sections deployed here | 20 | Verified | High |
| Distinct DataWindow objects across report libraries | 3,015 | Verified | High |
| …excluding parameter DataWindows (`d_arg_*`/`dw_arg_*` = 303) | 2,712 | Verified | High |
| Parameter windows (`w_arg_*`) | 1,080 | Verified | High |
| Layout-picker windows (`w_selectformat_*`) | 357 | Verified | High |
| Programmable objects touching `ReportData` | 87 | Verified | High |
| Programmable objects touching `CrossTab_ReportData` | 9 | Verified | High |
| …of the 96, actual report producers (rest reuse `ReportData` as a generic RPC buffer) | ~78 | Strongly Inferred | Medium-High |

**Why 792 ≠ 3,015:** one menu item frequently maps to several DataWindow layouts ("Format 2", "Format 3", "Audit Format", drill-downs, sub-reports), and `w_selectformat_*` (357 windows) exists precisely to let the user pick among them at run time. **Verified** via `Rights` entries such as `Reports , Daily Reports , Sale , Sale Detail` and `… Sale Detail (Format 2)` being separate menu leaves while `d_dailysalesdetail`, `d_dailysalesdetail_format2`, `d_dailysalesdetail_invwise` are separate DataWindows.

**My realistic answer to "how many distinct reports are there?":**

- **For the rebuild scope: 197** (what users here can actually open), of which **~160** are true pharmacy analytics. Confidence: **High**.
- **For the product as a whole: 792.** Confidence: **High** on the count, **Medium** on how many are genuinely distinct rather than format variants of one another — de-duplicating by underlying question would likely collapse 792 to roughly **250–350 distinct analytical questions**. Confidence on that de-duplicated figure: **Medium** (it requires opening each compiled layout, which is not possible without source).

### 1.2 The five findings that matter most

1. **Global scratch tables, no session key.** `ReportData` and `CrossTab_ReportData` have **no user/session/spid column** and every producer begins `DELETE ReportData` / `TRUNCATE TABLE ReportData`. **Verified** — `table_columns.tsv` shows 51 columns on `ReportData`, none identifying a session; `dbo.SP_MONTHLYSALES` line 39825 opens with `DELETE ReportData`. Concurrency-unsafe by construction.
2. **The GL-based Income Statement is Broken/Incomplete here.** `sp_IncomeStatement` computes Cost of Sales as *(Direct-Expenses GL movement) + (opening inventory from `StockLedger`) − (closing inventory from `StockLedger`)*, gated on preference `InventorySystemUsed = 'P'`. **Verified:** the preference **is** `'P'`, and **`dbo.StockLedger` contains 0 rows**. Both inventory terms evaluate to 0, and account 9 `COST OF GOODS SOLD ACCOUNT` has **zero** entries in `VirtualGl`. Gross Profit therefore reduces to *Sales − Purchases*, which is not gross profit.
3. **The profit number the business actually uses comes from a different place.** `SP_DailyIncomeStatement_With_GP_Summary` and `VIEW_SMS_DailySalesAndReturnSummary` compute CGS as `SUM((LooseQty + BonusQty) * SaleDetail.AvgPrice)` — the weighted-average cost **snapshotted onto each sale line at sale time**. **Verified**, and the data supports it: only **2 of 620,619** `SaleDetail` rows have a null/zero `AvgPrice`.
4. **Most reporting dimensions are dead at this site.** `Area`=1 ("DEFAULT AREA"), `SubArea`=1, `Region`=1 ("Testing"), `Zone`=0, `SalesMan`=1 ("\*\*\*"), `CustomerCategory`=1, `Customer`=2, `Godown`=1. **Verified.** The entire area/sub-area/zone/region/salesman/customer-category cross-tab report family — one of the largest in the product — produces single-column output here. Only **ItemCategory (7)**, **ItemClass (12)**, **Manufacturer (838)** and **User (9)** are live grouping dimensions.
5. **Export is a privilege, and only ADMIN has it.** `Rights` 637 `Save As`, 638 `Save As Excel`, 5217 `Print Report` are window-level rights (`Object='W'`). **Verified:** `GroupRights` grants 637 and 638 **only to group 2 (ADMINISTRATOR)**; groups 11 (SHIFT INCHARGE) and 12 (SALES OFFICER) get 5217 `Print Report` only.

---

# 2. How reporting actually works — the six layers

**Strongly Inferred** overall architecture (assembled from `Rights`, the `.pbd` string inventory, and the stored-procedure contracts). Each individual layer's evidence is cited.

```
┌─ 1. MENU + ENTITLEMENT ────────────────────────────────────────────┐
│  Rights.RightName (comma path) + Rights.IndicesString (tree pos)   │
│  filtered by GroupRights(GroupCode, RightCode, Status)             │
└───────────────────────────┬────────────────────────────────────────┘
                            v
┌─ 2. PARAMETER ENTRY ───────────────────────────────────────────────┐
│  1,080 x w_arg_*.win  +  303 x d_arg_*.dwo (pick-lists / ranges)   │
│  vocabulary: sdate, ldate, manf, cust, cat, class, pack, item,     │
│  godown, area, salesman, pricetype, sinvcode..linvcode, grouping   │
└───────────────────────────┬────────────────────────────────────────┘
                            v
┌─ 3. LAYOUT SELECTION (optional) ───────────────────────────────────┐
│  357 x w_selectformat_*.win  → choose among "Format 2/3/4/Audit"   │
└───────────────────────────┬────────────────────────────────────────┘
                            v
┌─ 4. DATA ACQUISITION — three mutually exclusive patterns ──────────┐
│  4a  PROC→SCRATCH : EXEC sp_x @args → DELETE+INSERT ReportData     │
│                     (or CrossTab_ReportData) → DW selects it       │
│  4b  DW-EMBEDDED  : DataWindow carries its own SELECT (no proc)    │
│  4c  SNAPSHOT     : DW reads pre-built StockReport / ItemLog       │
└───────────────────────────┬────────────────────────────────────────┘
                            v
┌─ 5. PRESENTATION ──────────────────────────────────────────────────┐
│  DataWindow.Print.Preview = yes  (w_preview_invoices, dw_preview)  │
│  ReportTitles overrides the caption; ReportFilter re-applies a     │
│  saved DataWindow filter expression                                │
└───────────────────────────┬────────────────────────────────────────┘
                            v
┌─ 6. OUTPUT ────────────────────────────────────────────────────────┐
│  wf_preview | wf_saveas (native SaveAs!) | wf_saveasexcel (dw2xls  │
│  + pb2xls.dll) | wf_saveaspdf (tp15_pdf.dll) | Print               │
│  gated by Rights 5217 / 637 / 638                                  │
└────────────────────────────────────────────────────────────────────┘
```

### 2.1 Layer 1 — Menu & entitlement

**Verified.** `Rights` is the live menu; `Rightsclone` is the vendor's full catalogue. `Rights` (486) is a strict subset of `Rightsclone` (2,122) — a check for `RightCode` present in `Rights` but absent from `Rightsclone` returns **0**. Deployment = "copy the subset of the master menu this customer bought".

Tree position is encoded in `Rights.IndicesString` as a comma path; the whole Reports menu lives under root index `5,`.

| Column | Meaning | Evidence |
|---|---|---|
| `RightCode` | PK, referenced by `GroupRights` | Verified |
| `RightName` | Full comma-separated menu path, e.g. `Reports , Stock Reports , Expiry Report` | Verified |
| `MenuName` | Leaf caption | Verified |
| `LevelIndex` | Depth (0 = window-level right, 1..5 = menu depth) | Verified |
| `IndicesString` | Path of menu indices, e.g. `5,2,2,` | Verified |
| `Object` | `A` = menu action (322 rows), `W` = in-window right (164 rows) | Verified |
| `RightCatCode` | Right category | Verified |

**Menu-tree data defects (Verified, Broken/Incomplete):**

| Defect | Detail |
|---|---|
| Duplicate tree position `5,` | `RightCode` 1 and 25, both named `Reports` |
| Duplicate tree position `5,3,11,` | `Slow/Fast moving Items` (129) and `Slow/Fast Moving Items Summary` (130) collide |
| **Cross-branch collision `5,3,2,`** | `Reports , Daily Reports , Sales , Sales Summary` (51) and `Reports , Sales Reports , Category Wise` (285) share a tree slot — two different menus, one index |
| Malformed index `5, 6,8,` | `RightCode` 68 `Reports , Listing , Manufacturer List` — embedded space in the index path |
| 3 report rights with blank `IndicesString` | 637 `Save As`, 638 `Save As Excel`, 5217 `Print Report` (correct — these are `Object='W'`) |

The same 3 duplicate-index defects exist in `Rightsclone`, i.e. they ship from the vendor.

### 2.2 Layer 2 — Parameter entry

**Verified** from the UTF-16 string inventory of the report `.pbd` files: **1,080 distinct `w_arg_*` windows** and **303 `d_arg_*` / `dw_arg_*` DataWindows**. `reports.pbd` (20.4 MB) alone holds **794** `w_arg_*` windows plus the base class chain `w_listarguments`.

The naming convention encodes the filter set. Token frequency across the 1,080 windows (**Verified**):

| Token | Occurrences | Meaning |
|---|---:|---|
| `sdate` | 378 | Start date |
| `ldate` | 358 | Last/end date |
| `manf` / `manfs` / `manufacturers` | 178 | Manufacturer (multi-select) |
| `cust` / `customer(s)` | 146 | Customer |
| `sinvcode` / `linvcode` / `sinv` / `linv` | 148 | Invoice-number range (start…last) |
| `cat` / `cats` / `categories` / `category` | 100 | Item category |
| `class` / `classes` | 59 | Item class |
| `grouping` | 39 | The `@ReportGrouping` char — M/C/L/P |
| `item(s)` | 55 | Item multi-select |
| `area` / `areas` / `subareas` | 65 | Area / sub-area |
| `godown(s)` | 40 | Warehouse |
| `pricetype` | 19 | Valuation basis (sale / trade / purchase / average) |
| `salesman` / `sman` | 30 | Sales person |
| `pack` / `packs` | 34 | Packing |
| `zone` | 14 | Zone |
| `saletype` | 13 | Sale type |
| `header` | 12 | `HeaderNo` (invoice series) |

Examples of real window names (**Verified**): `w_arg_areas_saletype_range_post_grouping`, `w_arg_categories_period_price_bonus_ret`, `w_arg_cat_class_manufacturers`, `w_arg_areas_sman_period_invstatus`, `w_arg_billsummaryreport_areawise`.

**The universal `@ReportGrouping` contract (Verified).** Most stock/sales procs take `@ReportGrouping CHAR(1)` plus `@GroupList VARCHAR(8000)` (a CSV of codes) and resolve items via two helper functions:

```sql
INSERT INTO @Tab_GroupList SELECT CODE FROM udf_StringToTabl(@GroupList, ',')
INSERT INTO @Tab_ItemList  SELECT CODE FROM udf_selectitems(@ReportGrouping, @GroupList)
```
`Evidence: dbo.SP_GodownWiseStockInHand, db_modules_full.sql lines 32937–33039`

Grouping codes, decoded from the `CASE` in the same proc (**Verified**):

| `@ReportGrouping` | Dimension | Item column | Lookup table |
|---|---|---|---|
| `M` | Manufacturer | `Item.ManfCode` | `Manufacturer` (838 rows) |
| `C` | Item Category | `Item.ICatCode` | `ItemCategory` (7 rows) |
| `L` | Item Class | `Item.ICCode` | `ItemClass` (12 rows) |
| `P` (else) | Packing | `Item.PackCode` | `ItemPacking` |

**`@Pricetype` is NOT consistent across procs — this is a real trap (Verified).**

| Proc | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| `SP_GodownWiseStockInHand` (line 32937, header comment + `CASE`) | Sale/Trade | Purchase | Average | — |
| `SP_SUBAREASALES_CROSSTAB` (line 50085, header comment) | Actual | Sale/Trade | Purchase | Average |

**Risk (High):** the same parameter name means different things in different reports. Two reports valued "at price type 2" are not comparable.

### 2.3 Layer 3 — Layout selection

**Verified.** 357 `w_selectformat_*` windows exist, e.g. `w_selectformat_expiryreport`, `w_selectformat_minlevelreport`, `w_selectformat_monthlysalesreport`, `w_selectformat_godowndetailreport`, `w_selectformat_manfwise_claimablereport`, `w_selectformat_saleinvtypewisereport`. `reportformat.pbd` (4.07 MB) contains the format descriptions, including literal captions such as `&3) . . . Standard (For Save as Excel)` — **Verified**, and it shows layouts are explicitly tagged for Excel-friendliness.

### 2.4 Layer 4 — Data acquisition (the three patterns)

#### Pattern 4a — Proc → global scratch table

**Verified.** 87 objects reference `ReportData`; 9 reference `CrossTab_ReportData`.

`ReportData` schema (**Verified**, `table_columns.tsv`): 51 untyped generic slots —
`code1..code11` `numeric(15,4)`, `value1..value9` `numeric(15,2)`, `value10..value16` `numeric(15,5)`, `value17,value18` `numeric(18,2)`, `BigValue1..BigValue10` `bigint`, `date1,date2` `datetime`, `name1..name8` `varchar(100)`, `name10,name11` `varchar(255)`. **No primary key. No session column. All columns nullable.**

`CrossTab_ReportData` schema (**Verified**): `Code1..Code10`, `Name1..Name10`, `Value1..Value15`, then the pivot block `C_Code1..C_Code13` / `C_Name1..C_Name13` (column headers) with `Qty1..Qty13` / `Val1..Val13` (cells), plus `TotQty`, `TotVal`. **A hard limit of 13 pivot columns per page.**

The pivot is built by **dynamic SQL in a `WHILE` loop, one `EXECUTE()` per column** (**Verified**):

```sql
SET @UPD = 'UPDATE CrossTab_ReportData SET C_Name' + @str_col +
           ' = ''' + @colname + ''', C_Code' + @str_col + ' = ' + @colcode +
           ' WHERE CODE2 = ' + LTRIM(RTRIM(STR(@curriter, 7)))
EXECUTE (@UPD)
```
`Evidence: dbo.SP_SUBAREASALES_CROSSTAB, db_modules_full.sql lines 50190–50205`

When there are more dimension members than fit in 13 columns, the proc **pages** them: `SET @iterations = CEILING(@totareas/@TotCol)` and stamps a page number into `Code2` (**Verified**, same proc, line ~50168).

Totals are a **second, separate proc call** (**Verified**):

```sql
UPDATE CrossTab_ReportData
SET TOTQTY = T.TotQty, TOTVAL = T.TotVAL
FROM CrossTab_ReportData C,
 (SELECT CODE1,
    TOTQTY = SUM(ISNULL(QTY1,0)+...+ISNULL(QTY13,0)),
    TOTVAL = SUM(ISNULL(VAL1,0)+...+ISNULL(VAL13,0))
  FROM CrossTab_ReportData GROUP BY CODE1) T
WHERE C.CODE1 = T.CODE1
```
`Evidence: dbo.SP_UPDATE_TOTAL_CrossTab_ReportData, db_modules_full.sql lines 55910–55938`

`SP_UPDATE_TOTAL_CrossTab_ReportData2` (line 55939) is identical **except** it also folds `Value1..Value13` into `TOTQTY` — i.e. a variant for reports where the "Value" block carries quantities too. **Verified.** Two near-identical procs with a subtle semantic difference is a maintenance hazard.

**Nested scratch dependency (Verified, Critical).** `sp_AccountsLedger` calls `sp_AccountsBalance`, which writes `ReportData`, then reads it back:

```sql
exec sp_accountsBalance @ad_StartDate
...
Insert #lt_Accounts
Select code1, name1, name2, value1 from ReportData
```
`Evidence: dbo.sp_AccountsLedger, db_modules_full.sql lines 3137–3200`

So a *second* user starting *any* report between those two statements silently blanks the first user's opening balances.

#### Pattern 4b — DataWindow-embedded SQL

**Strongly Inferred.** Of the 197 deployed leaf reports, only ~40 map to a named stored procedure. The remainder (expiry, re-order/optimum level, stock-in-hand variants, listings, re-prints, most Daily Reports) have **no** matching proc in `db_modules_full.sql`; their SQL is compiled into the DataWindow. Corroborating evidence: `dbo.ReportFilter` stores filters keyed by **DataWindow name**, not by proc name —

```
ReportIdentifier                            | FilterName | FilterExpression
d_manf_cat_class_pack_auditstockinhand      |            | qty>0
d_manf_cat_class_pack_auditstockinhand      | QTY>0      |  qty  > 0
```
`Evidence: SELECT * FROM dbo.ReportFilter (live DB)`

**Consequence for the rebuild (Critical):** the SQL for roughly **three quarters** of the deployed reports **cannot be recovered from the database**. It exists only inside the compiled `.pbd` files.

#### Pattern 4c — Pre-built snapshot

**Verified.** Two snapshot stores:

| Store | Rows | Built by | Cadence |
|---|---:|---|---|
| `StockReport` | 3,215,967 | `dbo.SP_StockReport` (line 49885) | Daily, **545 distinct days**, `2025-01-01 → 2026-07-31`, fired at **00:00:03** |
| `ItemLog` | 109,473 | trigger/app on `Item` change (139-column full row image) | Per item change |

`SP_StockReport` body (**Verified**, lines 49907–49933):

```sql
INSERT INTO StockReport (Date, GCode, ICode, Stock, PurchasePrice, SalePrice,
    AvgPrice, RecentPurchasePrice, PackUnits)
SELECT Date=GETDATE(), Gcode=Gd.GCode, ICode=Gd.ICode, Stock=SUM(Gd.CurrQty),
    PurchasePrice=I.PurPrice, SalePrice=I.SalePrice, AvPrice=I.AvgPrice,
    RecentPurchasePrice=I.RecentPurPrice, PackUnits=I.PackUnits
FROM GodownDetail Gd, Item I
WHERE Gd.ICode = I.ICode AND
    CONVERT(VARCHAR(100), GETDATE(), 101) NOT IN
    (SELECT DISTINCT CONVERT(VARCHAR(100), Date, 101) FROM STOCKREPORT)
GROUP BY Gd.GCode, Gd.ICode, I.PurPrice, I.SalePrice, I.AvgPrice, I.RecentPurPrice, I.PackUnits
```

Notes:
- The idempotence guard is a **correlated `NOT IN` over the whole 3.2 M-row table**, re-evaluated per row. **Verified**; performance risk (High).
- **Retention is disabled.** Both `DELETE` statements are commented out with the note `/**** Deletion Stopped C/O Rashid/Shakil/Azhar 05-JUN-2023 ****/` (lines 49893, 49901). **Verified.** The table grows ~5,900 rows/day forever.
- `6,165` `GodownDetail` rows × 545 days ≈ 3.36 M — matches the 3,215,967 actual. **Verified.**
- **Who fires it is Unclear.** A `Manage , Job Schedule` right exists (`RightCode` 1664) but **no** `JobSchedule` table exists in this database. SQL Server Express has no SQL Agent. The precise 00:00:03 cadence points to an OS-level scheduled task or the `mdsys.exe` helper. **Unclear — must be confirmed before cut-over or the daily snapshot silently stops.**

### 2.5 Layer 5 — Titles and saved filters

**`ReportTitles`** (**Verified**, 6 rows) overrides the printed caption, keyed by the **menu path string**:

| ReportId | ReportMenu | ReportTitle |
|---:|---|---|
| 1 | `Reports , Daily Reports , Sale , Sale Detail` | `a` |
| 2 | `Reports , Daily Reports , Sale , Sale Summary` | `Daily Sale Summary` |
| 3 | `Reports , Daily Reports , Sale , Sale Detail Inv. Wise (Delivery Challan)` | `Daily Sale Detail` |
| 4 | `Reports , Sales Reports , Customer Sales , Summary(Format7)` | `Customer Wise Sales Summary` |
| 5 | `Reports , Purchase Reports , Purchase Order , Purchase Order (Format-4)` | `Purchase Order` |
| 6 | `Reports , Accounts Reports , Summary Reports , Sale Person Collection Plan Report` | `Sale Person Collection Plan Report` |

Two defects (**Verified**): row 1's title is the literal string `a` (a typo that ships to the printed page); rows 3–6 reference menu paths that **do not exist** in the deployed `Rights` table (`… Sale Detail Inv. Wise (Delivery Challan)`, `Summary(Format7)`, `Purchase Order (Format-4)`, `Summary Reports , Sale Person Collection Plan Report`) — i.e. orphaned overrides. Joining by free-text menu path rather than `RightCode` is the root cause.

**`ReportFilter`** (**Verified**, 2 rows) stores named DataWindow filter expressions keyed by DataWindow name; managed by `w_save_reportfilter` / `w_view_reportfilter` (**Verified**, window names in `reportviewer.pbd`). Both stored rows are the same filter (`qty>0` / ` qty  > 0`), one with a blank `FilterName` — i.e. an accidental duplicate.

### 2.6 Layer 6 — Output & export

**Verified** from `reportviewer.pbd` strings and the DLL inventory.

| Action | Implementation | Evidence |
|---|---|---|
| Preview | `DataWindow.Print.Preview=yes`, `DataWindow.Print.Preview.Rulers`, `Window.Print.Preview.Zoom=` ; windows `w_preview_invoices`, `w_preview_invoices2`, control `dw_preview` | Verified — literal strings in `reportviewer.pbd` |
| Print | `m_preview`, right `5217 Print Report` | Verified |
| Save As (native) | `wf_saveas` / `m_saveas` / `cb_saveas`, PowerScript `SaveAs!` | Verified |
| **Save As Excel** | `wf_saveasexcel` / `m_saveasexcel` / `cb_saveexcel` / `f_saveasexcel`; menu caption `Save as &Excel`, tooltip `Save this report as Microsoft Excel worksheet`; engine `dw2xls.pbd` → `uf_save_dw_as_excel.fun`, `uf_save_ds_as_excel.fun`, `n_xls_workbook_v97.udo`, `pb2xls.dll` (260 KB, 2019) | Verified |
| **Save As PDF** | `wf_saveaspdf` / `m_saveaspdf`; PowerBuilder NativePDF runtime `tp15_pdf.dll` (+ `tp15.dll`, `tp15_rtf.dll`, `tp15_htm.dll`, `tp15_doc.dll`, `tp15_dox.dll`, `tp15_css.dll`, `tp4ole15.ocx`) | Verified (files) / Strongly Inferred (that `wf_saveaspdf` calls NativePDF rather than a distiller) |
| PSR (PowerBuilder report file) | `dw2xls_tmp.psr`, `as_psr_name`; viewer library `psrviewer.pbd` with `dw_report`, `dw_control` | Verified |
| Crystal Reports | `w_crystal_report_viewer` window + `Application/Reports/rptPrintCheque.rpt` (9,728 bytes) | Verified — a **single** Crystal report, for cheque printing only |
| Graphs | right `651 Reports , Rights , Generate Graph`; `graphcomponents.pbd` (2.53 MB) with `dw_graph`, `d_arg_linestyle`, `dw_linestyle` | Verified |
| Excel interop (alternative path) | `pbDWExcel12Interop125.dll` | Verified (file present); use is **Unclear** |

**Export entitlement (Verified):**

| Right | Code | ADMINISTRATOR (grp 2) | SHIFT INCHARGE (grp 11) | SALES OFFICER (grp 12) | REMOTE (grp 5) |
|---|---:|:--:|:--:|:--:|:--:|
| `Reports , Rights , Print Report` | 5217 | ✅ | ✅ | ✅ | ❌ |
| `Reports , Rights , Save As` | 637 | ✅ | ❌ | ❌ | ❌ |
| `Reports , Rights , Save As Excel` | 638 | ✅ | ❌ | ❌ | ❌ |

---

# 3. Who can run what — roles

**Verified** from `Groups`, `UserGroups`, `GroupRights`, `Users`.

| Group | Name | Users | Report menu rights granted | Character of access |
|---:|---|---|---:|---|
| 2 | ADMINISTRATOR | `ADMIN` | **240** (all) | Everything, incl. Excel/Save-As |
| 11 | SHIFT INCHARGE | `DR SAIRA`, `SHAZIB` | **43** | Daily sale/return/purchase/PO headers, stock-in-hand family, narcotics registers, stock & sales, category-wise sale & return, purchase reports, all re-printing. Print only. |
| 12 | SALES OFFICER | `RAEES KHAN`, `ZUBAIR ARIF`, `HAMMAD`, `HAMID ALI`, `ALI`, `FARYAD` | **37** | Same stock + purchase set, **but no sales-value reports and no Daily Sale detail/summary**. Print only. |
| 5 | REMOTE | — (no users) | **1** (`Reports` root only) | Dormant |

**Notable (Verified):** the SALES OFFICER group is denied every sales-*value* report — they may see stock and purchases but not sale totals, margins, or discounts. SHIFT INCHARGE gets sales summaries but not gross-profit or aging. This is a deliberate, meaningful separation of duties that the rebuild must preserve.

**Narcotics is a first-class concern (Verified):** both non-admin groups are granted `Stock Register for Norcotix Items`, `Stock Register(Narcotics Format2)` and `Norcotics Stock Register-Generic Type Wise` — a regulatory register, not an analytics report.

---

# 4. Deployment reality check — which dimensions actually work

**Verified** by direct query of the live lookup tables.

| Dimension | Rows | Contents | Reports depending on it |
|---|---:|---|---|
| `ItemCategory` | 7 | MEDICINES, NARCOTICS, CONSUMER, COUNSELING, DIAGNOSTIC, MILK, DR KHALID MUGHAL | **Live** — the primary grouping |
| `ItemClass` | 12 | DEFAULT CLASS, EXPENSIVE PRODUCTS, CONSUMER, CASHIER, DIAGNOSTIC, FRIDGE, COOL BOX, PAMPERS, NARCOTICS, MILKS, DR KHALID MUGHAL, DERMATOLOGY | **Live** |
| `Manufacturer` | 838 | real vendors | **Live** — the highest-cardinality live dimension |
| `Users` | 9 | ADMIN + 8 staff | **Live** — "User Wise" reports work |
| `Godown` | 1 | ` GODOWN1` | Degenerate — all Godown Reports return one column |
| `Area` | 1 | `DEFAULT AREA` | **Dead** |
| `SubArea` | 1 | `SUB DEFAULT AREA` | **Dead** |
| `Region` | 1 | `Testing` | **Dead** (and the single row is a test artefact) |
| `Zone` | 0 | — | **Dead** — zonal reports return nothing |
| `SalesMan` | 1 | `***` | **Dead** |
| `CustomerCategory` | 1 | `DEFAULT CATEGORY` | **Dead** |
| `Customer` | 2 | walk-in (CustCode 19, 291,359 invoices) + 1 other (2 invoices) | **Degenerate** — customer-wise analytics meaningless |

**Data-volume context (Verified):** `SaleLedger` 291,334 (all `Posted='Y'`, zero unposted), `SaleDetail` 620,619, `SRLedger` 30,695, `SRDetail` 44,563, `PurLedger` 6,417 (1 unposted), `PurDetail` 113,082, `PRLedger` 634, `PRDetail` 2,481, `VirtualGl` 1,015,581, `GodownDetail` 6,165 (6,164 carry expiry), `Item` 30,050. Date range `2025-01-01 → 2026-07-31`.

**Empty-source reports (Verified, Broken/Incomplete at this site):** `GLHeader`=0, `GLDetail`=0 (no manual vouchers), `StockLedger`=0, `SaleInvDetail`=0, `IssueDetail`=0, `ReceiptDetail`=0, `DueSatisfyDetail`=0, `QuotationHeader`=0, `SaleOrderHeader`=0, `BillSummary`=0.

**Tax data shape (Verified):** `SaleDetail.UnitSalesTax > 0` on **41,814** rows; `SaleDetail.GSTPerc > 0` on **0** rows; `SaleLedger.InvGSTPerc1 > 0` on **0** rows. The site uses a **fixed per-unit sales tax**, not percentage GST. Every report formula that adds a `GSTPerc`-based term therefore contributes zero here — but the term must still be ported, because the product supports both.

---

# 5. THE CATALOG

Each group below documents the reports **deployed at Fazal Din PP19** first, then notes what the product ships but this site does not use. Columns:

- **Report** — menu path as stored in `Rights.RightName`
- **Purpose / Filters / Source / Formula** — evidence-cited
- **Role** — which group can run it (A = ADMINISTRATOR, S = SHIFT INCHARGE, O = SALES OFFICER)
- **Risk** — a report that *recomputes* from transactions can disagree with one that *reads a snapshot*; flagged where it matters
- **Recommended viz** — proposal for the React rebuild (**never** an existing feature)

Export options are the same for every report and are not repeated per-row: **Preview / Print (all roles), Save As + Save As Excel (ADMINISTRATOR only), PDF via `wf_saveaspdf`.** `Evidence: reportviewer.pbd → wf_preview | wf_saveas | wf_saveasexcel | wf_saveaspdf; GroupRights 637/638/5217`

---

## 5.1 SALES

### 5.1.1 Deployed — Daily Sales (menu `5,1,1,*` and `5,1,2,*`)

| Report | RightCode | Purpose | Filters (Strongly Inferred from `w_arg_*`) | Data source | Role | Recommended viz |
|---|---:|---|---|---|:--:|---|
| Daily Reports ▸ Sale ▸ **Sale Detail** | 28 | Line-level list of the day's sales | sdate, ldate (+ invoice range) | DW-embedded over `SaleLedger`⋈`SaleDetail` — **no proc**; layouts `d_dailysalesdetail`, `d_salesdetail` | A, S | Virtualised data grid, server-paginated, sticky invoice grouping |
| … ▸ **Sale Detail (Format 2)** | 972 | Same, alternate layout | same | `d_dailysalesdetail_format2` | A, S | Column-preset switch on the same grid |
| … ▸ **Sale Detail Inv. Wise (with diff. col.)** | 1168 | Invoice-major with variance column | same | `d_dailysalesdetail_invwise` | A, S | Master-detail grid |
| … ▸ **Detail Inv. Wise** | 440 | Delivery-challan style | same | `d_deliverychallan*` (22 variants in `reports.pbd`) | A, S | Printable document view |
| … ▸ **Sale Summary** | 29 | Day totals | sdate, ldate | `d_dailysalessummery*` (28 variants) | A, S | KPI row + bar chart by hour |
| … ▸ **Sale Summary – Invoice Wise** | 1176 | One row per invoice | sdate, ldate | `d_dailysalessummery_invwise` | A, S | Grid + total footer |
| … ▸ Sale Summary Inv.Wise | 207 | duplicate-ish variant | sdate, ldate | as above | A, S | fold into the above |
| … ▸ **Sale Summary Inv.Wise, Cust Wise** | 387 | Invoice summary grouped by customer | sdate, ldate, cust | as above | A, S | **Low value here** — 2 customers |
| … ▸ **Sale Summary Machine and Invoice Range Wise** | 1630 | Per POS terminal + invoice range | sdate, ldate, machinename, sinvcode..linvcode (`w_arg_machinename_sinv_linv`) | `SP_MachineWiseSaleAndReturn_CrossTab` (line 39038) + `d_machinewise_categorywise`/`2` | A | **Grouped bar: terminal × category**; till-reconciliation KPI cards |
| … ▸ **Refused Sales Detail** | 1040 | Items a customer asked for and was refused/not stocked | sdate, ldate | `d_refusedsale_age`; `RefusedSale*` tables | A, S | **Lost-sales table + Pareto bar** — high commercial value |
| Sale Return ▸ **Detail** / **Summary** / **Summary Inv.Wise** / **Detail Inv.Wise** | 31, 32, 208, 344 | Returns register | sdate, ldate | `d_dailysalesreturnsummery`, `d_dailysrdetail_patientwise` | A, S | Grid + return-rate KPI |
| **Header Wise Transaction Summary** | 1076 | Totals per `SaleLedger.HeaderNo` (invoice series) | sdate, ldate, header | `fn_GetHeaderWiseSaleSummary` (line 390) | A | Stacked bar by series — **but see risk** |

**Risk — Header Wise Transaction Summary (Medium).** `SaleLedger.HeaderNo` has exactly **one** distinct value (`1`) across all 291,361 invoices (**Verified**). The report is structurally dead here.

### 5.1.2 Deployed — Sales analytics (menu `5,3,*`)

| Report | RightCode | Purpose | Filters | Data source & formula | Role | Recommended viz |
|---|---:|---|---|---|:--:|---|
| Customer Sales ▸ **Customer Wise Detail / Summary** | 111, 112 | Sales by customer | sdate, ldate, cust | `d_customerwisesalesdetail` (18 variants), `d_customerwisesalessummery` (20) | A | Table; **degenerate here (2 customers)** |
| Customer Sales ▸ **Invoice Summary** | 246 | One row per invoice | sdate, ldate | `d_invdata*` (48 objects) | A | Grid |
| Customer Sales ▸ **Hourly Graph** | 117 | Sales by hour of day | sdate, ldate | DW graph (`graphcomponents.pbd`) | A | **Hour-of-day heatmap (7×24)** — genuinely useful for staffing |
| **Hourly Sales Graph** | 116 | Same at store level | sdate, ldate | DW graph | A | as above |
| Customer Sales ▸ **Days Summary** | 134 | Per-day totals over a range | sdate, ldate | `d_dayssalessummery` | A | Line chart + 7-day moving average |
| Customer Sales ▸ **Monthly Net Sales** | 1075 | Net sales by month | sdate, ldate | `SP_MonthlyNetSaleSummary @Type='CUSTOMER'` (line 39705) | A | Column chart by month |
| Customer Sales ▸ **Invoice Wise Profit Margin Detail** | 205 | Margin per invoice | sdate, ldate | **Strongly Inferred** DW over `SaleDetail.AvgPrice` | A | Scatter: invoice value × margin %; colour = below-cost |
| Customer Sales ▸ **Customer Wise Item Summary** | 212 | Item mix per customer | sdate, ldate, cust | DW-embedded | A | Treemap |
| Customer Sales ▸ **Customer Category Wise Sales** family (7 leaves) | 832, 833, 1008, 1120, 1625, 1723, 1760 | Summary / Detail / Net Sales & Volume / Customer Wise Summary / Net Sales / **Output Sales Tax** / **Customer Wise Gross Profit** | sdate, ldate, customercat, area | `SP_CUSTCATWISESALES` (18885), `SP_CUSTCATWISESALESDETAIL` (19048), `SP_CUSTCATWISESALESDETAIL_CROSSTAB` (19261) | A | **Dead dimension** (1 category) except *Output Sales Tax* and *Customer Wise Gross Profit* |
| Customer Sales ▸ **Customer Category Wise Net Sales** | 802 | as above | same | `SP_CUSTCATWISESALES` | A | — |
| Customer Sales ▸ **Customer Wise Category Net Sales** | 951 | Customer × item-category pivot | sdate, ldate | `SP_CustGroup_ItemGroup_NetSale_CrossTab` (line 19588; params `@CustGroupCode, @ItemGroupCode, @startdate, @enddate`) | A | Pivot/heatmap |
| Customer Sales ▸ **Claimable for Allowed Customers** | 1712 | Manufacturer claim/rebate eligibility | sdate, ldate, manf | DW; `w_selectformat_manfwise_claimablereport` | A | Table + claim-value KPI |
| Customer Sales ▸ **Customer NTN Wise Sales Tax Report** | 1716 | FBR: sales by customer tax number | sdate, ldate | DW over `SaleLedger`/`Customer` NTN | A | Statutory table, fixed layout |
| Customer Sales ▸ **Customer Wise Advance Tax** | 1729 | Advance income tax on sales | sdate, ldate | DW | A | Statutory table |
| **Category Wise ▸ Sale And Return** | 123 | Sales, returns, net, and **both tax legs** per item category | `@ad_date`, `@ad_ldate` | **`sp_SaleAndReturnCategoryWise` (line 47162)** — see formula §6.1 | A, S | **KPI row + stacked bar (sale/return) + net line** |
| Category Wise ▸ **Sales** | 220 | Category sales | sdate, ldate | `sp_SaleAndReturnCategoryWise_wrt_SaleCat` (47237) | A, S | Donut + table |
| Category Wise ▸ **Net Sale** | 281 | Net of returns | sdate, ldate | as above | A | Bar |
| Category Wise ▸ **Gross Profit** | 271 | GP by category | sdate, ldate | **Strongly Inferred** DW using `SaleDetail.AvgPrice` | A | Bar + GP% labels |
| Category Wise ▸ **Monthly Sale** | 263 | Category × month | sdate, ldate, grouping | `SP_MONTHLYSALES` (39824) / `SP_MONTHLYSALESSUMMARY` (40194) | A | **Heatmap category × month** |
| Category Wise ▸ **Item Category Wise Monthly Sales** | 1017 | as above, item detail | sdate, ldate | `SP_MONTHLYSALES` | A | Drill-down grid |
| Category Wise ▸ **Category Wise Day Net Sale** | 1732 | Category × day | sdate, ldate | DW | A | Small-multiples line chart |
| Category Wise ▸ **Item Wise Sale Discounts Detail** | 415 | Discount given per item | sdate, ldate | `d_item_sales_and_discount` | A | Table + discount-% distribution histogram |
| **Class Wise** | 287 | Sales by `ItemClass` | sdate, ldate | `sp_SaleAndReturnClassWise` (47297), `sp_SaleAndReturnClassWise_invrange` (47355), `SP_MONTHLYSALESCLASSWISE` (40136) | A | Bar |
| **Manufacturer Wise ▸ Sales / Sales Detail / Net Sales** | 124, 395, 448 | Sales by manufacturer | sdate, ldate, manfs | `SP_MONTHLYSALES_MANFWISE` (39894) + DW | A | **Pareto (top-20 manufacturers)** — the highest-cardinality live dimension |
| Manufacturer Wise ▸ **Sales And Return Summary** | 1210 | Sale + return per manufacturer | sdate, ldate, manfs | DW | A | Diverging bar |
| Manufacturer Wise ▸ **CNIC/NTN Registered Customers** | 1676 | FBR customer-identity compliance | sdate, ldate | DW | A | Compliance table + % coverage KPI |
| **Item Sales/Discount** | 897 | Item-level sales & discount | sdate, ldate | `d_item_sales_and_discount` | A | Grid |
| Item Wise ▸ **Item Sale and Return Activity** | 817 | Movement per item | sdate, ldate, items | `d_itemsaleandreturnactivity`, `d_itemsaleandreturn_summary` | A | Sparkline column in item grid |
| Item Wise ▸ **Item Wise Net Sales** | 1172 | Net sales per item | sdate, ldate | `sp_itemactivity` (line 38157) | A | Ranked table |
| **Slow/Fast moving Items** (+ Summary) | 129, 130 | Velocity classification | sdate, ldate, cat/class | `d_slowmovitemssummary_manf` | A | **Quadrant scatter: velocity × margin** |
| **Dead Item List** | 1435 | Items with no sale in period | sdate, ldate | DW | A | Table + capital-tied-up KPI |
| **Net Sale Summary** | 195 | Overall net sale | sdate, ldate | `d_netsale_summary` … `_summary6` | A | KPI card |
| **Monthly Net Sales Summary** | 1291 | Month series | sdate, ldate | `SP_MonthlyNetSaleSummary` (39705) | A | Line + YoY overlay |
| **Daily Sale Summary with Profit (Day wise grouping)** | 1140 | Day totals **with GP** | sdate, ldate | `SP_DailyIncomeStatement_With_GP_Summary` (20846) / `…2` (21147) | A | **Combo: bars = net sale, line = GP%** |
| Sales Summary Reports ▸ **Month Wise Gross Profit** | 1761 | GP by month | sdate, ldate | as above | A | Combo chart |
| **Sale/Return Summary Inv. Type Wise** | 914 | By sale category/type | sdate, ldate, saletype | `w_selectformat_saleinvtypewisereport` | A | Stacked bar |
| **Sales Tax Report** | 1725 | FBR output tax | sdate, ldate | DW + `SaleDetail.UnitSalesTax` | A | Statutory table |
| User Wise ▸ **Sales** | 128 | Sales per cashier | sdate, ldate | `d_userwise*` (11 objects) | A | **Leaderboard bar** |
| User Wise ▸ **Invoice Graph** | 118 | Invoice count per user | sdate, ldate | DW graph | A | Bar |
| User Wise ▸ **Category Summary** | 218 | User × category | sdate, ldate | DW | A | Heatmap |
| User Wise ▸ **Discount Report** | 269 | Discount granted per user | sdate, ldate | DW | A | **Box-plot per user — discount-abuse control** |
| User Wise ▸ **Net Cash** | 1321 | Cash collected per user | sdate, ldate | DW | A | KPI per user + variance |
| User Wise ▸ **Sales Commission** | 1333 | Commission calc | sdate, ldate | DW; `Item.CommissionPerUnit`, `Item.CommissionPerc` | A | Table |
| User Wise ▸ **User Wise Sales Summary** | 1367 | Totals per user | sdate, ldate | DW | A | Table |
| Area/Region/Zone ▸ **Area Wise Monthly Sales Comparison** | 1678 | Area × month | sdate, ldate, areas | `SP_AreaWise_ComparativeMonthSales` (line 7117) | A | **Dead** (1 area) |
| Sales Man Wise ▸ **Sales Person Wise Customer/Item Net Sales** | 1744 | Rep performance | sdate, ldate, sman | `SP_ITEMNETSALE_SMANWISE_BREAKUP` (38375) | A | **Dead** (1 salesman `***`) |
| Sales Man Wise ▸ **Sales Person Wise Monthly Net Sales** | 1746 | as above | same | `SP_MONTHLYSALES_SMANWISE` (39960) | A | **Dead** |
| Sales Man Wise ▸ **Sales Person/Customer Wise Manufacturer Net Sales** | 1747 | as above | same | `SP_SALESMAN_AREASALES_CROSSTAB` (47765) | A | **Dead** |

### 5.1.3 Shipped but NOT deployed here — sales (selection)

**Verified** from `Rightsclone`: the `Reports , Sales Reports` subtree has **229 leaf reports** in the master vs **58** deployed. Not-deployed families include: Area/Sub-area/Zone/Region cross-tabs (`SP_AREAWISESALES` 7216, `SP_SUBAREASALES` 49954, `SP_SUBAREASALES_CROSSTAB` 50085, `SP_ZONALAREASALES` 61540, `SP_ZONALAREASALES_CROSSTAB` 61680, `SP_REGIONWISESALES` 46213, `SP_REGIONAREASALES` 46049), `Net Sale Graph` (203, 196), `Monthly Sales Graph` (183), `Item Wise ▸ Graphs ▸ Monthly Sales and Closing Stock` (324, backed by `SP_MONTHLYSALESANDSTOCK_ITEMWISE` line 40015), `SP_YEARLYSALESSUMMARY` (61422), `sp_yearly_sale_summary_monthwise_groping` (61350), `SP_CustomerNetSaleMonthSummary` (20238), `SP_DateWiseSaleBreakup` (21347).

> **These exist in the product.** If Fazal Din ever opens a second branch, adds sales reps, or segments customers, they become live. The rebuild should port the *capability*, not necessarily the 229 screens.

---

## 5.2 PURCHASE

### 5.2.1 Deployed (menu `5,1,4,*`, `5,1,5,*`, `5,1,23,*`, `5,4,*`, `5,14,*`)

| Report | RightCode | Purpose | Filters | Data source & formula | Role | Recommended viz |
|---|---:|---|---|---|:--:|---|
| Daily ▸ Purchase ▸ **Purchase Detail** | 34 | GRN lines for the day | sdate, ldate | DW over `PurLedger`⋈`PurDetail`; `d_purchase*` (45 objects) | A, S | Grid |
| Daily ▸ Purchase ▸ **Purchase Summary** / **(Format2)** | 35, 329 | Day totals per supplier | sdate, ldate | DW | A, S | Table + KPI |
| Daily ▸ Purchase Return ▸ **Detail** / **Summary** | 37, 38 | Returns to supplier | sdate, ldate | DW; `d_godown_pr_detail` | A, S | Grid |
| Daily ▸ Purchase Order ▸ **Purchase Order Summary** | 1079 | Open/closed POs | sdate, ldate | DW; `d_supplyorder*` (12) | A, S | Table + status chips |
| Daily ▸ Purchase Order ▸ **P/O Based Purchase Disparity** | 1125 | PO vs actual receipt variance | sdate, ldate | DW | A | **Diverging bar: ordered vs received per item** |
| **Periodic Purchases** | 53 | Purchases over a range | sdate, ldate | DW | A, S, O | Line chart |
| **Day Summary** | 256 | Purchases per day | sdate, ldate | DW | A, S, O | Bar |
| **Net Purchase Summary** | 1082 | Purchases − returns | sdate, ldate | `d_netpurchase*` (8) | A, S, O | KPI + bar |
| **Purchase Order** | 148 | PO print/list | sdate, ldate, supp | `d_supplyorder*`; `ReportTitles` id 5 targets `Purchase Order (Format-4)` | A, S, O | Document view |
| **Purchase Order Manf. Wise** | 947 | PO by manufacturer | sdate, ldate, manf | DW | A, O | Table |
| SupplierWise ▸ **SupplierWise Detail** | 171 | Purchases per supplier | sdate, ldate, supp | `d_supplierwise*` (8) | A, O | Grid |
| **Supplier Wise Net Purchase** | 197 | Net per supplier | sdate, ldate | DW | A, S, O | **Pareto bar (top suppliers)** |
| Supplier Wise ▸ **Advance Income Tax** | 1730 | Withheld income tax per supplier | sdate, ldate | DW | A | Statutory table |
| ManufacturerWise ▸ **ManufacturerWise Detail** | 173 | Purchases per manufacturer | sdate, ldate, manf | DW | A, S, O | Grid |
| ManufacturerWise ▸ **Monthly Stock Movement** | 1745 | In/out by month per manufacturer | sdate, ldate, manf | `SP_ItemStockMovementAtAvgPrice` (line 38515) | A | **Waterfall: opening → in → out → closing** |
| **Date Wise Purchase Graph** | 184 | Purchases trend | sdate, ldate | DW graph | A, S, O | Line |
| **Category Wise Purchase** | 221 | Purchases per item category | `@ad_date`, `@ad_ldate` | **`sp_PurAndReturnCategoryWise` (line 45522)** — see §6.2 | A, S, O | Donut + table |
| Supplier Category Wise ▸ **Input Sales Tax Report** | 1724 | FBR input tax | sdate, ldate | DW | A | Statutory table |
| **Withholding Tax Deduction** | 1671 | WHT register | sdate, ldate | `d_whtaxdeductionreport`, `…2/3/4/6` (5 layouts) | A | Statutory table |
| **Supplier/Manufacturer Wise G/P** | 1714 | Gross profit attributable to a supplier/manufacturer | sdate, ldate | **Strongly Inferred** DW using `SaleDetail.AvgPrice` | A | **Bubble: purchase value × GP% × volume** |
| Purchase Return Reports ▸ Supplier Purchase Returns ▸ **Detail** / **Summary** | 297, 298 | Returns per supplier | sdate, ldate, supp | DW | A | Grid + return-rate KPI |

**Also present as a proc but not on the deployed menu:** `sp_purchase_rate_comparison` (line 45599; params `@start_date, @end_date, @purchase_category CHAR(1), @ReportGrouping, @GroupList`) — compares purchase rates across suppliers. **Verified** proc exists; **Missing** from the deployed menu. High commercial value — see §10 recommendations.

### 5.2.2 Shipped but not deployed — purchase

`Rightsclone` `Reports , Purchase Reports` has **36** leaves vs **15** deployed. Also `sp_PostedPurAndReturnCategoryWise` (line 41436) — a posted-only variant of the category-wise purchase report, **Deprecated** in favour of / duplicated by `sp_PurAndReturnCategoryWise`.

---

## 5.3 INVENTORY / STOCK

### 5.3.1 Deployed — Stock Reports (menu `5,2,*`)

| Report | RightCode | Purpose | Filters | Data source & formula | Role | Recommended viz |
|---|---:|---|---|---|:--:|---|
| Stock in Hand ▸ **Manufacturer Wise** / **(Format2)** | 140, 896 | Current stock valued, grouped by manufacturer | grouping=`M`, GroupList, ZeroRows, Pricetype | `SP_GodownWiseStockInHand` (line 32937) + DW `d_stockinhand*` (89 objects) | A, S, O | **Treemap by manufacturer, size = value** |
| Stock in Hand ▸ **Category Wise** | 141 | grouping=`C` | same | same | A, S, O | Treemap / bar |
| Stock in Hand ▸ **Class Wise** | 242 | grouping=`L` | same | same | A, S, O | Bar |
| Stock in Hand ▸ **Other Stock Report** | 152 | alternate layout | same | same | A, S, O | Grid |
| Stock in Hand ▸ **Stock Quantity Format** | 1142 | Qty only, no value | same | same | A, S, O | Grid |
| Stock in Hand ▸ **Supplier Manufacturer Association** | 1068 | Which supplier supplies which manufacturer's stock | grouping, manf | DW | A, S, O | Sankey / matrix |
| Stock in Hand ▸ **Stock in Hand – Audit Purpose** | 1269 | Count-sheet layout | grouping, GroupList | DW `d_manf_cat_class_pack_auditstockinhand` (**the DataWindow named in `ReportFilter`**) | A, S, O | Printable count sheet + variance entry |
| Stock in Hand ▸ **Batch, Priority Wise** | 259 | Stock by batch & FEFO priority | grouping, godown | DW over `GodownDetail` (batch, expiry, priority) | A | Grid grouped by batch |
| Stock in Hand ▸ **Batch, Priority Wise – Audit Purposes** | 1788 | count-sheet variant | same | DW | A | Count sheet |
| Stock in Hand ▸ **Back Date** | 326 | **Stock as at a past date** | asondate | **`StockReport` snapshot** (3.2 M rows, 545 days); `w_selectstockreport_inbackdate` | A, S, O | Date-picker + grid; **see risk below** |
| **Expiry Report** | 45 | Items expiring within N days | grouping, days, godown; `w_selectformat_expiryreport` | DW over `GodownDetail.Expiry` (6,164 of 6,165 rows populated) | A | **Bucketed bar: <30 / 30-60 / 60-90 / 90-180 d, value at risk** |
| **Expiry Report (Classwise)** | 388 | as above by class | grouping=`L` | DW | A | as above |
| **Reorder Level Report** | 46 | Below `Item.ReorderLevel` | grouping | DW over `Item.ReorderLevel`, `ReorderQty` | A | **Gauge column: on-hand vs reorder point** |
| **Minimum Level Report** | 464 | Below `Item.MinQty` | grouping; `w_selectformat_minlevelreport` | DW | A | as above |
| **Optimum Level Report** | 272 | vs `Item.OptimumLevel` | grouping | DW | A | as above |
| **Reorder/Optimum Level Report** | 826 | combined | grouping | DW | A | Combined table with suggested order qty |
| **Stock and Sales** | 255 | Stock alongside period sales (cover/DOH) | sdate, ldate, cat/class/manf | DW `d_stockandsale*` (26 objects); `w_arg_cat_class_stockandsale` | A, S, O | **Scatter: days-of-cover × sales velocity** |
| **Stock Register** | 47 | Item movement ledger | item, sdate, ldate, godown | See risk — `sp_StockRegister` is **Broken** | A | Running-balance ledger table |
| **Item Stock Register Summary** | 168 | Summarised movement | same | `d_itemstockregister_summary` | A | Table |
| **Stock Register for Norcotix Items** | 194 | **Narcotics statutory register** | sdate, ldate | DW filtered on `Item.AntiNorCotix` | A, S, O | **Immutable, sequential register — print-exact** |
| **Stock Register (Narcotics Format2)** | 379 | alt layout | same | DW | A, S, O | as above |
| **Norcotics Stock Register – Generic Type Wise** | 1689 | by generic | same | DW; `d_arg_genericitem` | A, S, O | as above |
| **Daily Stock IN/OUT** | 1032 | Movement in/out per day | sdate, ldate, grouping, code | **`sp_stock_inout` (line 48931)** — see §6.4 | A | **Waterfall per item** |
| **Stock IN/OUT (Date Wise)** | 1131 | as above by date | same | `sp_stock_inout` | A | Stacked bar in/out |
| **Item Activity** | 303 | Full per-item activity | sdate, ldate | **`sp_itemactivity` (line 38157)** — sale/satisfy/return/purchase/PR qty+value | A | Item drill-down page |
| **Stock Management Report** | 1670 | Consolidated stock health | grouping | DW | A | Dashboard-style page |

### 5.3.2 Deployed — Godown Reports (menu `5,13,*`)

| Report | RightCode | Purpose | Source | Role | Note |
|---|---:|---|---|:--:|---|
| **Godown Wise Stock in Hand (Audit Format2)** | 1677 | Count sheet per warehouse | `SP_GodownWiseStockInHand` + `d_godown*` | A | **1 godown → single group** |
| **Allowed Godown Wise Stock in Hand** | 1711 | Restricted to the user's `GroupAllowedGodown` | same + `GroupAllowedGodown` | A | Access-scoped |
| **Godown Wise Stock – With Batch Expiry Details** | 1733 | Batch + expiry per godown | DW over `GodownDetail` | A | Merge with Expiry Report in rebuild |
| **Customer Associated Godown Stock** | 1734 | Stock reserved to a customer | DW | A | Dormant (2 customers) |

### 5.3.3 Deployed — Item Reports (menu `5,12,*`) — the audit trail

**Verified:** all five History reports are backed by **`dbo.ItemLog`** — a **139-column full row-image audit table with 109,473 rows** capturing every change to `Item` (`LogDate`, `UserCode`, `ChangeReason`, `Module`, plus every business column: `SalePrice`, `PurPrice`, `AvgPrice`, `SaleDiscPerc`, `ReorderLevel`, …).

| Report | RightCode | Purpose | Source | Role | Recommended viz |
|---|---:|---|---|:--:|---|
| History ▸ **Sale Price Difference** | 277 | Price changed vs baseline | `ItemLog` + `d_itemsalepricedifference`, `d_itemlabels_saleprice_diff` | A | Before/after diff table |
| History ▸ **Item Basic Data Changes** | 419 | Any master-data edit | `ItemLog` | A | **Audit timeline with field-level diff** |
| History ▸ **Item Sale Price Changes** | 485 | Price history | `ItemLog.SalePrice`, `NewSalePrice` | A | **Step line chart per item** |
| History ▸ **New Item(s) Created/Defined** | 1044 | New SKUs in period | `ItemLog` + `d_newitem_created_report` | A | Table + count KPI |
| History ▸ **Item Name Changes** | 1795 | Renames | `ItemLog.Name` + `d_itemnamechanges` | A | Diff table |
| Stock Adjustments ▸ **Stock Adjustments Detail** | 412 | Adjustment lines | `AdjHeader` (1,539) ⋈ `AdjDetail` (11,181) | A | Table + reason breakdown |
| **Deleted Sale Items Log** | 1518 | Lines removed from an invoice | `d_deletedsaleitemsreport`; `SP_Preserve_DeletedSaleItemsLog` | A | **Fraud-control table — one row per deletion, with user** |

### 5.3.4 Deployed — Adjustment (menu `5,1,14,*`)

| Report | RightCode | Source | Role |
|---|---:|---|:--:|
| Adjustment Summary / Detail | 267, 268 | `AdjHeader`⋈`AdjDetail`; `sp_PostAdjLedger` for posting | A |
| Adjustment Summary/Detail Inv.Wise | 444, 445 | as above | A |
| Adjustment Summary/Detail (combined) | 1121 | as above | A |
| Item Wise Adjustment Summary | 1263 | as above | A |

**Recommended viz:** adjustment reason Pareto + monthly shrinkage-value trend + per-user adjustment volume (control report).

### 5.3.5 Stock risks

| # | Risk | Severity | Evidence |
|---|---|---|---|
| S1 | **`sp_StockRegister` is a hard-coded prototype, not a report.** It contains literal `PD.icode = 5412`, `PD.GCode = 1`, `PL.postdate between '1/1/2000' and '10/10/2000'`, and `itemname = (Select item.name from item where icode = 5412)`. | **Broken/Incomplete — High** | `db_modules_full.sql` lines 49510–49560 |
| S2 | **`dbo.StockLedger` is empty (0 rows)** although `SP_STOCKLEDGER` exists to populate it incrementally (dedup by `utn` per document type). | **Broken/Incomplete — Critical** (it is the input to `sp_IncomeStatement`) | `table_rowcounts.tsv` `StockLedger 0`; `SP_STOCKLEDGER` at line 49058 |
| S3 | **Snapshot vs recompute divergence.** "Stock in Hand ▸ Back Date" reads the **`StockReport` snapshot** (`AvgPrice` frozen at 00:00:03 that day); "Stock in Hand ▸ Manufacturer Wise" **recomputes live** from `GodownDetail`⋈`Item` at *today's* `AvgPrice`. Running both for "today" gives different valuations. | **High** | `SP_StockReport` line 49907 vs `SP_GodownWiseStockInHand` line 33301 |
| S4 | **`StockReport` retention disabled** — purge statements commented out 2023-06-05. Table grows ~5,900 rows/day unbounded (already 3.2 M). | **Medium** | lines 49893, 49901 |
| S5 | **`SP_STOCKLEDGER` takes `TABLOCKX`** (`SELECT COUNT(*) FROM STOCKLEDGER WITH (TABLOCKX)`) — a full table-exclusive lock for the whole ETL. | **Medium** | line 49578 |
| S6 | **`SP_StockReport` idempotence guard is O(n) per row** — a correlated `NOT IN` scanning 3.2 M rows. | **Medium** | line 49923 |
| S7 | Stock-in-hand valuation **excludes inactive items** (`I.active = 1`) but the audit count sheets are used for physical stock-take — inactive items holding stock would be invisible. | **Medium** | `SP_GodownWiseStockInHand` line 33357 |

---

## 5.4 FINANCIAL / ACCOUNTING

### 5.4.1 Deployed (menu `5,5,*`) — only 3 leaves

**Verified:** `Rightsclone` has **76** leaf reports under `Reports , Accounts Reports`; **only 3** are deployed.

| Report | RightCode | Purpose | Filters | Data source & formula | Role |
|---|---:|---|---|---|:--:|
| Ledger Reports ▸ **Account Ledger** | 58 | Account statement with opening balance + movements | `@ad_StartDate`, `@ad_EndDate` | **`sp_AccountsLedger` (line 3137)** → calls `sp_AccountsBalance` (2691) → reads back `ReportData`; sources `VirtualGl`; account roles resolved from `dbo.global` (`GT_PurchaseAccount`, `GT_CashACC`, `GT_SalesACC`, `GT_SalesReturnACC`, `GT_PurchaseReturnsAccount`, `GT_AdvanceSalesTaxACC`, `GT_EquityACC`, `GT_RevenueFromServices`) | A |
| Aging Analysis ▸ **Aging Analysis Summary – Customer Wise** | 1720 | AR aging | `@Type='C'`, `@l_date`, `@interval`, `@limit` | **`sp_Aging_CustomerWise` (line 5200)** — see §5.5 | A |
| Purchase Invoice Based Accounting ▸ Detail Reports ▸ **Purchase Invoice Accounting Detail** | 1680 | Per-invoice accounting entries | sdate, ldate | DW over `VirtualGl` filtered by `InvoiceType`/`DocumentType` | A |

### 5.4.2 Shipped but NOT deployed — the whole financial statement suite

**Verified.** `financialreports.pbd` (273 KB) contains exactly six DataWindows:
`d_balancesheet`, `d_balancesheet2`, `d_incomstatement`, `d_trialbalance`, `d_trialbalance_activity2`, `d_trialbalance_activity3`
with parameter windows `w_arg_balancesheet`, `w_arg_ason`, `w_arg_catacc_period`, `w_arg_catacc_period_functionalarea`.

**Balance Sheet, Trial Balance and the GL Income Statement therefore EXIST in the product but are NOT on this deployment's menu.** This is a *deployment* decision, not a product gap. **Verified.**

### 5.4.3 The profit-and-loss engines — three of them, and they disagree

| Engine | Object | Basis | Status here |
|---|---|---|---|
| **A. GL periodic income statement** | `sp_IncomeStatement` (line 34158), `sp_IncomeStatment` (34873 — note the typo'd duplicate, 852 lines) | `VirtualGl` movements by `CategoryAccounts` + inventory delta from `StockLedger` | **Broken/Incomplete** — see below |
| **B. Transaction-level daily GP** | `SP_DailyIncomeStatement_With_GP_Summary` (20846), `…_Summary2` (21147) | `SaleDetail.AvgPrice` snapshot cost | **Working** — this is what the business uses |
| **C. SMS daily KPI push** | `VIEW_SMS_DailySalesAndReturnSummary` | `SaleDetail.AvgPrice` / `SRDetail.AvgPrice` | **Working** |

#### Engine A — why it is broken here (Verified, Critical)

`sp_IncomeStatement` builds `COST OF SALES` as:

```sql
value1 = (SELECT ISNULL(SUM(ISNULL(v.debit,0) - ISNULL(v.credit,0)),0) FROM virtualgl v
          WHERE v.acccode IN (SELECT acccode FROM accounts WHERE subcode IN
                (SELECT subacccode FROM subaccounts WHERE catacccode = @ln_DirectExpensesCat))
            AND v.date >= @ad_SDate AND v.date <= @ad_EDate)
      + (SELECT ROUND(ISNULL(SUM(ISNULL(newavgprice*newstock,0)),0),0)
         FROM stockledger WHERE date < @ad_SDate AND ... @InvSys = 'P' ...)   -- opening inventory
      - (SELECT ROUND(ISNULL(SUM(ISNULL(newavgprice*newstock,0)),0),0)
         FROM stockledger WHERE date <= @ad_EDate AND ... @InvSys = 'P' ...)  -- closing inventory
```
`Evidence: dbo.sp_IncomeStatement, db_modules_full.sql lines 34555–34576`

and Gross Profit as the running sum of what is already in `ReportData`:

```sql
name1 = 'GROSS PROFIT/LOSS',
value1 = (SELECT ISNULL(SUM(ISNULL(value1,0)),0) FROM reportdata)
```
`Evidence: same proc, lines 34587–34599`

Live facts (**all Verified**):

| Fact | Value | Query |
|---|---|---|
| `Fn_GetPreference('InventorySystemUsed')` | **`P`** (periodic) | live DB |
| `dbo.StockLedger` row count | **0** | `table_rowcounts.tsv` |
| `VirtualGl` rows on AccCode 9 `COST OF GOODS SOLD ACCOUNT` | **0** | GL activity query |
| `VirtualGl` on AccCode 1 `PURCHASE ACCOUNT` | Dr 193,566,768 over 6,416 entries | GL activity query |
| `SubAccounts.CatAccCode` for sub 1 `PURCHASES`, sub 12 `COST OF SALES`, sub 14 `PURCHASES RETURNS` | **9 = DIRECT EXPENSES** | live DB |

**Therefore:** both inventory terms are 0, and Cost of Sales collapses to *Purchases − Purchase Returns*. Gross Profit becomes *Sales − Purchases*, with **no opening/closing inventory adjustment at all**. For a pharmacy holding ~PKR-millions of stock this is materially wrong in any period where stock levels move.

**→ This is the single largest accounting risk in the reporting layer. It is on the "requires accountant validation" list (§8, item 1) and the "must not be copied forward" list (§10).**

#### Engine B — the working GP (Verified)

```sql
Cost = SUM((SD.LooseQty + SD.BonusQty) * SD.AvgPrice)
...
Amt = ROUND(SUM(R.Sales + R.Ret + R.CGS), 0)     -- Ret and CGS carried as negatives
Sales = ROUND(SUM(CASE S.TYPE WHEN 'S' THEN
          S.itemvalue - (S.flatdisc * (S.itemvalue /
            CASE S.grossamt WHEN 0 THEN 1 ELSE S.grossamt END))
        ELSE 0 END), 0)
```
`Evidence: dbo.SP_DailyIncomeStatement_With_GP_Summary, db_modules_full.sql lines 21199–21264`

Key mechanics (**Verified**):
- **Invoice-level flat discount is allocated to lines pro-rata by line value** (`flatdisc * itemvalue / grossamt`), with a divide-by-zero guard.
- **Bonus quantity is costed but not revenued** — `Cost` includes `BonusQty`, `ItemValue` uses `LooseQty` only. Correct behaviour for "buy 10 get 1 free": the free unit consumes inventory at cost and earns no revenue.
- Sale returns are handled symmetrically with the sign flipped and `srprice` in place of `saleprice`.
- `@ReportType` is documented as `'M'` medical store / `'H'` hospital / `'B'` both — **but the code branches on `'S'` and `'A'`** (`IF @ReportType='S' OR @ReportType='A'`). **Verified.** The header comment contradicts the code. **Risk (Medium): callers guided by the comment pass a value that produces no rows.**

#### Engine C — the SMS daily KPI (Verified)

```sql
NetSales    = SUM(Sales - SR)
CGS         = ROUND(SUM(Cost),2)
GrossProfit = ROUND(SUM(Sales - SR - Cost), 2)
GPRate      = ROUND(GrossProfit / CASE WHEN SUM(Sales-SR)=0 THEN 1 ELSE SUM(Sales-SR) END * 100, 2)
```
`Evidence: dbo.VIEW_SMS_DailySalesAndReturnSummary`

Also emits `TotalSales`, `SaleInvoices`, `SalesReturn`, `SaleReturnInvoices`. **Risk (Low-Medium):** the four component subqueries are combined with `UNION` (deduplicating) rather than `UNION ALL`; if two legs ever produce identical tuples one is silently dropped.

Sibling SMS report views (**Verified**): `VIEW_SMS_DailyHeaderWiseNetSalesSummary` (via `fn_GetHeaderWiseSaleSummary`, line 390), `VIEW_SMS_ManufacturerMonthlyNetSaleToDate` (via `fn_GetManfWiseNetSaleToDate`, line 590), `VIEW_SMS_ZonalSaleAndStock_CatWise_ToDate` (via `fn_Get_ZonalSaleAndStock_CatWise_ToDate`; **dormant** — `Zone` has 0 rows).

### 5.4.4 Other accounting report procs present in the DB

| Object | Line | Purpose | Deployed? |
|---|---:|---|---|
| `sp_AccountsBalance` | 2691 | All-account balances as at a date | Indirect (called by ledger) |
| `sp_AccountsLedger1` | 3310 | 1,120-line expanded ledger variant | **Unclear** — no matching menu leaf |
| `sp_CustomersBalance` | 20303 | Customer balances | Not deployed |
| `sp_SuppliersBalance` | 50534 | Supplier balances | Not deployed |
| `sp_SingleCustomerBalance` | 48765 | One customer | Not deployed |
| `sp_CustomerTransactionStatus` | 20483 | Customer activity status | Not deployed |
| `sp_SupplierTransactionStatus` | 50709 | Supplier activity status | Not deployed |
| `sp_OtherAccTransactionStatus` | 40659 | Other accounts | Not deployed |
| `sp_Customer_Sale_Accounts` | 19765 | Customer↔sale account map | Not deployed |
| `SP_GetOverDueBlanceList` / `SP_GetCustomerOverDueBlanceList` | 31704 / 30948 | Overdue lists | Not deployed |
| `sp_DailyLedger_LPLedger` | 21275 | **Returns a result set directly (no scratch table)** — per-customer item ledger with `@datetype` switch over `OriginalDate` / `Date` / `BillingDate` | Not deployed |
| `sp_CRS_IncomeStatement` | 13895 | 664-line CRS/multi-branch income statement | Not deployed (CRS partially deployed) |

**`sp_DailyLedger_LPLedger` is architecturally the odd one out and worth noting (Verified):** it is the only report proc that `SELECT`s its result directly instead of staging in `ReportData`. It also uses `SaleInvDetail`, which has **0 rows** here → returns empty. **Broken/Incomplete at this deployment.**

---

## 5.5 RECEIVABLES / AGING

### 5.5.1 The aging family — 9 procs, 1 deployed

**Verified.** `agingreports.pbd` (404 KB) holds exactly 8 DataWindows: `d_aging`, `d_aging2`, `d_aging_old`, `d_aging_salesman`, `d_aging_subarea`, `d_agingbased_epi`, `d_agingdetail`, `d_sum_value1`. Parameter windows: `w_arg_aging`, `w_arg_aging_customerwise`, `w_arg_aging_salesman`, `w_arg_aging_subarea`, `w_arg_agingbased_epi`, `w_arg_agingdetail`, `w_arg_agingdetail_saleperson`.

| Proc | Line | Signature | Purpose | Deployed |
|---|---:|---|---|---|
| `sp_Aging` | 4554 | `@Type CHAR(1), @l_date, @interval INT, @limit INT` | Base AR/AP aging, bucketed | via 1720 |
| `sp_Aging_CustomerWise` | 5200 | `+ @AccountList VARCHAR(8000)` | Filtered to selected customers | **✅ 1720** |
| `sp_AgingDetail` | 6019 | `+ @Code INT` | Drill into one account | Not deployed |
| `sp_Aging_Account` | 4747 | `+ @AccCode INT` | Single account | Not deployed |
| `sp_Aging_Cummulative` | 4970 | same as base | Cumulative buckets | Not deployed |
| `sp_Aging_Per_Invoice` | 5385 | `@SaleInvCode INT` | Aging of one invoice | Not deployed |
| `SP_Aging_SalesManWise` | 5622 | `@l_date, @interval, @limit` | By sales rep | Not deployed (**dead dimension**) |
| `SP_Aging_SubAreaWise` | 5743 | same | By sub-area | Not deployed (**dead dimension**) |
| `sp_AgingDetail_SalePersonWise` | 6215 | `+ @Code INT` | Rep drill-down | Not deployed |
| `sp_AgingBasedEPI` | 5864 | — | Aging-based expiry/payment intimation | Not deployed |

### 5.5.2 How aging is computed (Verified — this is the decisive logic)

**Step 1 — build the bucket ladder** from `@interval` and `@limit`:

```sql
SELECT @StartLimit = 0
WHILE @StartLimit <= @limit
BEGIN
  SELECT @EndLimit = @StartLimit + CASE @StartLimit WHEN 0 THEN 0 ELSE @interval - 1 END
  SELECT @EndLimit = CASE WHEN @EndLimit > @limit THEN @limit ELSE @EndLimit END
  INSERT INTO #lt_interval (LowerLimit, UpperLimit) VALUES (@StartLimit, @EndLimit)
  SELECT @StartLimit = @EndLimit + 1
END
INSERT INTO #lt_interval (LowerLimit, UpperLimit) VALUES (@StartLimit, 99999999)
```
`Evidence: dbo.sp_Aging, db_modules_full.sql lines 4809–4822` — note bucket 0 is "Current (0 days)" exactly, then `@interval`-wide buckets, then an open-ended final bucket.

**Step 2 — pull open items and total payments, by `@Type`:**

```sql
IF @type = 'C'   -- Customers (receivables)
  INSERT INTO #lt_amt SELECT AccCode, Date, Amount=Debit, Paid=0,
      DaysOld=DATEDIFF(day, date, @l_date)
  FROM VirtualGL WHERE Date <= @l_Date AND Debit > 0
    AND AccCode IN (SELECT CUSTCODE FROM CUSTOMER) ORDER BY AccCode, Date, Debit
  INSERT INTO #lt_pmt SELECT AccCode, Amount=SUM(Credit) FROM VirtualGL
  WHERE Date <= @l_Date AND Credit > 0 AND AccCode IN (SELECT CUSTCODE FROM CUSTOMER) GROUP BY AccCode

IF @type = 'S'   -- Suppliers (payables): Credit is the open item, Debit is the payment
```
`Evidence: dbo.sp_Aging, lines 4824–4859`

**Step 3 — FIFO application via a cursor**, oldest invoice first:

```sql
DECLARE C1 CURSOR FOR SELECT * FROM #lt_amt ORDER BY AccCode, Date, Amount
...
UPDATE #lt_amt SET Paid = Paid + CASE WHEN @Amt >= @Pmt THEN @Pmt ELSE @Amt END WHERE RowID = @RowID
SELECT @Pmt = @Pmt - (SELECT CASE WHEN @Amt >= @Pmt THEN @Pmt ELSE @Amt END)
UPDATE #lt_Pmt SET Amount = @Pmt WHERE AccCode = @AccCode
...
DELETE #lt_amt WHERE Amount - Paid = 0
```
`Evidence: dbo.sp_Aging, lines 4861–4888`

**Step 4 — bucket and emit:**

```sql
Value1 = SUM(Amount - Paid),
Code2  = (SELECT MAX(LowerLimit) FROM #lt_interval
          WHERE l.daysold >= lowerlimit AND l.daysold <= upperlimit)
```
`Evidence: dbo.sp_Aging, lines 4900–4903`

**Semantics summary (Verified):**
- Aging is **unapplied-FIFO**: payments are *not* matched to specific invoices in the data; the report *simulates* matching, oldest first, at report time.
- Buckets are keyed on the **transaction date**, not a due date — there is no credit-terms/due-date concept in this computation.
- Bucket labelling is **dead code**: the `UPDATE ReportData SET Name6 = …'Days Old'` block that would produce human labels is entirely commented out (lines 4947–4960). The DataWindow must reconstruct labels from `Code2`. **Deprecated / Broken-ish (Low).**

### 5.5.3 Aging risks

| # | Risk | Severity | Evidence |
|---|---|---|---|
| R1 | **Row-by-row cursor over the whole open-item set.** On a real credit book this is O(n) round-trips inside SQL Server. | Medium (High if credit sales ever start) | lines 4861–4886 |
| R2 | **No due-date / credit-terms input.** Aging measures document age, not overdue age. | **High — accounting semantics** | lines 4827, 4846 |
| R3 | **Structurally dormant here.** `Customer` = 2 rows; `SaleLedger` has 291,359 invoices on `CustCode=19` (walk-in cash) and 2 on `CustCode=22`. Cash retail ⇒ essentially no receivables. | Informational | live data |
| R4 | Supplier aging (`@Type='S'`) **is** meaningful — `Supplier` = 235, and `VirtualGl` shows large credit balances per supplier (e.g. MULLER & PHIPS Cr 24,171,609). **Yet no supplier-aging report is deployed.** | **Medium — a real reporting gap** | GL activity query; deployed-rights list |

---

## 5.6 MANAGEMENT / DASHBOARD / MONITORING

### 5.6.1 What exists in the product (Verified)

| Feature | Menu path | RightCode | `IndicesString` | Deployed here? |
|---|---|---:|---|---|
| **Dashboard** | `Manage , Dashboard` (+ 11 tabs: Summary, Inventory, Sales, Purchase, Issue, Receipt, Adjustment, Transfers, Services, Accounts, CRS) | 1706 (+ 5225–5235, 5254) | `8,42,` | **❌ NOT deployed** |
| **Transaction Activity Monitor** | `Manage , Transaction Activity Monitor` (+ 24 sub-rights) | 1123 (+ 652–671, 684, 685, 703, 5156) | `8,12,` | **❌ NOT deployed** |
| **Session Monitor** | `Manage , Session Monitor` | 1292 | `8,23,` | **✅ deployed** |
| **Cashier Activity Window** | `Manage , Cashier Management , Cashier Activity Window` (+ 7 sub-rights incl. `Show Print Preview`, `Supervise All [F9]`, `Show Totals`) | 1346 | `8,26,2,` | **✅ deployed** |
| **Generate Graph** (in-report) | `Reports , Rights , Generate Graph` | 651 | *(blank — `Object='W'`)* | Not granted to any group |
| **Open Powersoft Report Viewer** | `Reports , Open Powersoft Report Viewer` | — | `5,22,` | ❌ (product only) |

**`dashboard.pbd` contents (Verified, 851 KB, 91 DataWindows):** `d_dailysalesgraph`, `d_dailypurchasesgraph`, `d_dailyreceiptgraph`, `d_dailyissuegraph`, `d_dailyadjustmentgraph`, `d_daily_igt_graph`, `d_dailyservicegraph`, `d_top10sellingitemsgraph`, `d_dashboard_categoryinventorybeakup`, `d_dashboard_expirydaysinventorybeakup`, `d_dashboard_godowninventorybeakup`, `d_dashboard_dumpedinventory`, `d_dashboard_custcat_salesanalysis`, `d_dashboard_suppcat_puranalysis`, `d_dashboard_accounts_census`, `d_dashboard_transsummary`, plus a full `*_drilldown` set (18 objects) and CRS variants.

**This is important for the rebuild:** the vendor already shipped a full KPI dashboard with drill-downs — expiry-bucket inventory breakup, top-10 sellers, dumped (dead) inventory, category inventory breakup — and **Fazal Din never turned it on**. The modern rebuild's dashboard is therefore not a new idea to the users; it is a shipped-but-unused capability.

**`graphcomponents.pbd` (2.53 MB) — Activity Monitor (Verified):** `d_activitymonitorlist`, `d_activitymonitor_statistics`, `d_activitymonitor_timeperiod`, `d_conectionmonitorlist`/`2`, `d_connectionmonitor_timeperiod`, plus per-customer print layouts (`d_khyber_…`, `d_bilal_…`, `d_zainmedicine_…`, `d_maxburger_…`, `d_hajichargha_…`, `d_alkausar_…`, `d_bambinostore_…`, `d_alharmainlights_…`). **Evidence of a heavily customer-forked codebase** — at least 8 named customers have bespoke layouts compiled into the shipped binary.

### 5.6.2 Management reports proper

**`managementreports.pbd` is 34,816 bytes and contains ZERO DataWindow objects** (**Verified**). `mgmtcomp.pbd` is **0 bytes** (**Verified**). The "Management Reports" library is an empty shell.

**Finding (Verified, Missing):** there is **no management-reporting layer** in this product beyond the (undeployed) Dashboard. Executive reporting is done by running operational reports and reading the totals.

---

## 5.7 OPERATIONAL

### 5.7.1 Re-printing (menu `5,8,*`) — 8 deployed

| Report | RightCode | Purpose | Role |
|---|---:|---|:--:|
| **RePrinting Sale** | 178 | Reprint a sale invoice | A, S, O |
| **Sale (with summary reports)** | 261 | Invoice + attached summaries | A, S, O |
| **Sale (with header wise summaries)** | 943 | Invoice + per-series summaries | A, S, O |
| **Sale(format2)** / **Sale Format(3)** / **Sale Format(4)** | 487, 860, 913 | Alternate invoice layouts | A, S, O |
| **Selected Sales and Summaries** | 1726 | Batch reprint of a selection | A |
| **Purchase** | 260 | Reprint a purchase document | A, S, O |

**Evidence:** `saleprintouts.pbd`, `purchaseprintouts.pbd` (9.69 MB), `salereturnprintouts.pbd` (6.04 MB); `QRCodeGenLibrary.dll` (2021) — **Strongly Inferred** to render the FBR digital-invoice QR code on the reprint. FBR lookup tables are seeded (`FBR_DI_DocType`=2, `FBR_DI_Scenario`=28, `FBR_DI_TransactionType`=26, `FBR_DI_UOM`=43) and `SP_FiscalizeSaleInvoice` exists.

**Risk (High — compliance):** a reprint of a fiscalised invoice must reproduce the *original* fiscal payload, not recompute it. Whether it does is **Unclear** (logic is in the compiled DataWindow).

### 5.7.2 Listings (menu `5,6,*`) — 7 deployed

| Report | RightCode | Source | Role | Recommended viz |
|---|---:|---|:--:|---|
| **Items List** | 65 | `Item` (30,050 rows); `d_itemlist*` (25 objects) | A | Server-paginated grid w/ faceted filters |
| **Supplier List** | 64 | `Supplier` (235) | A | Grid |
| **Manufacturer List** | 68 | `Manufacturer` (838) | A | Grid |
| Customers List ▸ **Category Wise Sale History** | 1059 | `Customer` + sales | A | Dormant (2 customers) |
| Customers List ▸ **Customer List Category Wise** | 1135 | `Customer` | A | Dormant |
| **Group Rights List** | 970 | `Rights` ⋈ `GroupRights` | A | **Permission matrix heatmap** |
| **GroupWise Users List** | 1057 | `Users` ⋈ `UserGroups` ⋈ `Groups` | A | Table |
| Sale Person Scope ▸ **Manufacturer/Sub Area Wise Sales Person Conflict** | 1673 | Territory overlap detection | A | Dormant (dead dimensions) |

### 5.7.3 Labels & barcodes

**Verified.** `labels.pbd` (252 KB): `d_itemslabel`, `d_itemslabel2`, `d_itemslabel3`, `d_itemslabel3_2`, `d_itemlabels_4`, `d_customerlabels`, `d_customerlabels_custwise`, `d_barcode_customerlabels`, `d_supplierlabels`. `barcodecomponents.pbd` (5.17 MB) + `barcodefunctions.pbd` (3.3 MB). Menu section `Reports , Labels` (`5,7,`) has 4 leaves in the master; **not deployed** here. `Reports , BarCode Printing` (`5,11,`) has 3 leaves; **not deployed**.

### 5.7.4 Data-export utilities (menu `5,16,*`) — 11 deployed

**Verified.** These sit under `Reports , Special Reports` but are **not reports** — they are per-pharma-company data feeds:

`Data Export Utility-` **Global Pharma** (1710), **Pharma Link** (1715), **Next Pharma** (1717), **Bosch/Linz** (1719), **Sci Life Pharma** (1722), **Clinix** (1728), **Otsuka** (1731), **Libra** (1739), **Racket** (1743), **Masood Homoeo** (1786), **Neutro Pharma** (1802).

`specialreports.pbd` (4.88 MB) holds 127 DataWindows. `Reports , Special Reports` has **68** leaves in the vendor master vs **11** deployed.

**Business meaning (Strongly Inferred):** pharmaceutical manufacturers require sell-out/stock data from retail partners to compute rebates and claims. Each partner has a bespoke file format. **These 11 exports are contractual obligations and must be reproduced byte-compatibly in the rebuild** — this is a hard requirement, not a nice-to-have.

**Risk (High):** the export file formats are defined **only inside the compiled DataWindows**. They cannot be recovered from the database. Sample output files must be collected from the customer before the rebuild.

### 5.7.5 Sales Order / other operational (deployed)

| Report | RightCode | Note |
|---|---:|---|
| Sales Order Reports ▸ **Sale Order-Supplier Wise Order Estimates** | 1685 | `SaleOrderHeader` = 0 rows → **dormant** |
| Sales Order Reports ▸ **Sale Order based Sales Disparity** | 1686 | dormant |
| Sales Order Reports ▸ **Sale Order Items Not Sold** | 1687 | dormant |
| Daily ▸ Quotation ▸ **Detail** / **Summary** | 308, 309 | `QuotationHeader` = 0 → **dormant** |
| Issue Reports ▸ Issue Summary ▸ **Issue Based Receipts** | 1787 | `IssueDetail` = 0 → **dormant** |
| Issue Reports ▸ Recipient Wise ▸ **Receipt/Issue Summary** | 1691 | dormant |

---

## 5.8 Non-pharmacy verticals — present, mostly not used

**Verified.** These sections exist in the deployed `Rights` (so the menu items appear) but the underlying business is not run here.

| Section | Master leaves | Deployed leaves | Deployed items | Status here |
|---|---:|---:|---|---|
| CRS Reports (`5,26,`) | 30 | 12 | CRS Sales GP Summary; CRS Stock & Sales (Manf/Cat); Consolidated Stock Position; CRS Item Stock Register; CRS Stock Management; CRS Invoice Search; CRS Customer/Supplier/Accounts Ledger; CRS Customer/Supplier/Account Balances | **Unclear** whether a CRS (central/branch consolidation) peer exists. `SP_CRS_*` procs number ~45. |
| Patient Reports (`5,10,`) | 35 | 2 | Patient Transaction Status; Doctor/Patient Wise Net Service Report | Hospital vertical — **dormant** |
| Service Reports (`5,15,`) | 24 | 1 | Supplier Wise Purchase of Services | **dormant** |
| Student Reports (`5,28,`) | 17 | 2 | Grade/Branch Wise Student Strength; Data Export Utility-Bank Format | School vertical — **dormant** |
| Employee Reports (`5,30,`) | 5 | 1 | Payroll ▸ Pay Slip Re-Printing | **dormant** |
| Production Reports (`5,34,`) | 2 | 1 | Production Note ▸ Wastage Summary Report | **dormant** |
| Guest Reports (`5,27,`) | 5 | 0 | — | Hotel vertical |
| Receipt / Issue / Attendance / Passport / Loyalty / Installment / Refused-Sales / Sales-Template / User / Data-Import / Product / Customer-Site Reports | 3+12+2+1+1+2+2+1+1+1+1+3 | 2 | — | Mostly other verticals |

**This matters:** 5 of the ~20 deployed sections and 8 of the 197 deployed leaves belong to verticals this pharmacy does not run. They are menu noise and should be dropped from the rebuild scope.

---

# 6. Formula appendix — the decisive SQL

## 6.1 Category-wise Sale & Return (the last report actually run here)

**Verified.** The 7 rows currently sitting in `ReportData` are exactly this report's output — names `MEDICINES / NARCOTICS / CONSUMER / COUNSELING / DIAGNOSTIC / MILK / DR KHALID MUGHAL` match `ItemCategory` exactly, and the column mapping matches the proc.

```sql
insert into reportdata(code1,name1,value1,value2,value4,value5)
select A.icatcode,
  catname   = (select name from itemcategory where icatcode=A.icatcode),
  salevalue = (select ISNULL(SUM(SD.looseqty * (SD.saleprice - SD.itemflatdisc)
                          * (1 - (.01 * SD.discperc))),0) ...),
  srvalue   = (select ISNULL(SUM(SRD.looseqty * SRD.srprice
                          * (1 - (.01 * SRD.discperc))),0) ...),
  saletax   = (select ISNULL(SUM(SD.looseqty * SD.UnitSalesTax)
                    + SUM(ROUND(SD.looseqty * (SD.saleprice - SD.itemflatdisc)
                          * (1 - (.01 * SD.discperc)) * SD.GSTPerc * 0.01, 2)),0) ...),
  returntax = (... symmetric on srdetail ...)
from (select distinct item.icatcode from saledetail,saleledger,item where ... 
      union select distinct item.icatcode from srdetail,srledger,item where ...) as A

update reportdata set value3 = value1 - value2
commit
```
`Evidence: dbo.sp_SaleAndReturnCategoryWise, db_modules_full.sql lines 47162–47236`

Column map: `value1` = sale value, `value2` = return value, `value3` = net, `value4` = sale tax, `value5` = return tax.

Live residue (**Verified**, `SELECT * FROM ReportData`):

| Category | Sale | Return | Net | Sale tax | Return tax |
|---|---:|---:|---:|---:|---:|
| MEDICINES | 7,624,638.20 | 683,645.75 | 6,940,992.45 | 172,786.10 | 16,515.12 |
| NARCOTICS | 192,479.38 | 16,068.13 | 176,411.25 | 0.00 | 0.00 |
| CONSUMER | 162,462.87 | 20,055.87 | 142,407.00 | 8,620.10 | 928.03 |
| COUNSELING | 8,144.85 | 387.84 | 7,757.01 | 0.00 | 0.00 |
| DIAGNOSTIC | 137,855.00 | 11,850.00 | 126,005.00 | 0.00 | 0.00 |
| MILK | 23,846.18 | 0.00 | 23,846.18 | 4,203.82 | 0.00 |
| DR KHALID MUGHAL | 535,506.83 | 41,851.50 | 493,655.33 | 0.00 | 0.00 |

**Defects (all Verified):**
1. **No `posted = 'Y'` filter** on either the sale or the return leg — unposted documents would be included. (Benign here: 0 unposted sales; not benign in general.)
2. **Invoice-level discount (`SaleLedger.DiscPerc`) is ignored** — unlike `SP_MONTHLYSALES` which multiplies by `(1 - sl.discperc * 0.01)`. **This report over-states sales whenever an invoice-level discount is given.** Severity **High** for cross-report reconciliation.
3. `commit` with **no matching `BEGIN TRANSACTION`** — relies on implicit-transaction mode; will raise error 3902 if autocommit is on.
4. `saletax` and `returntax` write to `value4`/`value5`, but `value3 = value1 - value2` is computed **after** and applies to every row including any left over from a partially-failed prior run (there is no `WHERE`).

## 6.2 Category-wise Purchase & Return

```sql
purvalue = SUM(ROUND(((PD.looseqty + PD.packqty) * PD.purprice) * (1 - (.01 * PD.discperc)), 2))
prvalue  = SUM(ROUND(((PRD.looseqty + PRD.packqty) * PRD.prprice) * (1 - (.01 * PRD.discperc)), 2))
...
update reportdata set value3 = value1 - value2
```
`Evidence: dbo.sp_PurAndReturnCategoryWise, db_modules_full.sql lines 45522–45598`

**Defect (Verified, High):** `(PD.looseqty + PD.packqty)` adds **loose units and pack units without multiplying packs by `PackUnits`**. Every other proc in the system writes `looseqty + packqty * packunits` (e.g. `SP_MONTHLYSALES` line 39847, `SP_STOCKLEDGER` line 49591). **This purchase-value figure is understated for any item bought in packs.** It also lacks a `posted = 'Y'` filter.

## 6.3 Monthly Sales — the canonical sales-value formula

```sql
qty   = sum(sd.looseqty + CASE @ai_bonus WHEN 0 THEN 0 ELSE sd.bonusqty END + sd.packqty * sd.packunits),
value = sum((sd.looseqty + sd.packqty * sd.packunits) *
            (sd.saleprice - sd.itemflatdisc) * (1 - sd.discperc * 0.01) * (1 - sl.discperc * 0.01))
```
`Evidence: dbo.SP_MONTHLYSALES, db_modules_full.sql lines 39847–39849`

**This is the reference implementation.** It correctly: converts packs to units; subtracts the item-level flat discount from the unit price; applies the line discount %; applies the invoice discount %; and **excludes bonus quantity from value** while optionally including it in quantity.

Three-leg `UNION ALL` structure (**Verified**), used by nearly every sales proc:
1. `saleledger ⋈ saledetail` where `posted='Y'` — inventory-impacting sales
2. `saleledger ⋈ saleinvdetail` where `impactinventory='N' AND posted='Y'` — **non-inventory (service/pass-through) sales**
3. `srledger ⋈ srdetail` where `posted='Y'`, quantities and values **negated**, gated on `@ai_returns = 1`

**Note (Verified):** `SaleInvDetail` has **0 rows** here, so leg 2 always contributes nothing at this deployment.

**Bug in a sibling (Verified, Medium):** `SP_MONTHLYSALES_SMANWISE` (line 39960) leg 2 reads `FROM saleledger sl, saledetail sd WHERE sl.impactinventory='N'` — it queries `saledetail` where every other proc queries `saleinvdetail`. **This double-counts** any `impactinventory='N'` invoice that also has `saledetail` rows.

Date bucketing across the whole family is a **string-built month key** (**Verified**):
```sql
DATE = LTRIM(RTRIM(MONTH(DATE))) + '-01-' + RTRIM(LTRIM(DATENAME(YEAR, DATE)))
```
i.e. `'7-01-2026'` — **culture- and `DATEFORMAT`-dependent**. **Risk (Medium):** on a server with a non-US default language this produces wrong months or conversion errors.

## 6.4 Stock IN/OUT

`sp_stock_inout` (line 48931; `@s_date, @l_date, @l_code INT, @ls_grouping CHAR`) emits 11 measures per item into `value1..value11`:

| Slot | Measure | Source | Notes |
|---|---|---|---|
| value1 | sale price / pack unit | `Item.saleprice / packunits` | |
| value2 | purchase price / pack unit | `Item.purprice / packunits` | |
| value3 | **sale qty** | `saledetail.looseqty` where `saledetail.due IS NULL` | excludes due/credit-hold lines |
| value4 | **sale-return qty** | `srdetail.looseqty` | |
| value5 | **purchase qty** | `CASE purcatcode IN (3,7,8) THEN looseqty+bonusqty ELSE (packqty+bonusqty)*packunits END`, `posted='Y'`, on `postdate` | |
| value6 | **purchase-return qty** | `prdetail.looseqty + bonusqty` | |
| value7 | **adjustment increase** | `adjdetail.looseqty` where `adjcatcode = 1` | |
| value8 | **adjustment decrease** | `adjdetail.looseqty` where `adjcatcode = 2` | |
| value9 | **issue qty** | `issuedetail.qty` | 0 rows here |
| value10 | **receipt qty** | `receiptdetail.qty`, `posted='Y'` | 0 rows here |
| value11 | **due-satisfy qty** | `duesatisfydetail.duesatisfyqty` | 0 rows here |

`Evidence: db_modules_full.sql lines 48931–49044`

**Verified anomalies:** the proc creates and drops a throw-away temp table `#lt_test` that is never used; sale qty uses `looseqty` only (no `packqty * packunits`) while purchase qty does the conversion — the two columns are in **different units** for pack-sold items. **Risk (High) — the in/out columns do not net.**

The same document-type set appears in `SP_MONTHLYSALESANDSTOCK_ITEMWISE` (line 40015) as the definitive **closing-stock roll-forward** (**Verified**, lines 40049–40106):

> `+ purchase (packs×units for purcatcode 1,2; loose for 3,7,8)` `− purchase return` `− sale (where due IS NULL)` `+ sale return` `− due-satisfy` `− issue` `+ receipt` `± adjustment (adjcatcode 1 = +, 2 = −)`

**This eight-document roll-forward is the authoritative stock equation and must be ported exactly.**

## 6.5 Godown-wise stock valuation

```sql
Value1 = CASE @Pricetype WHEN 1 THEN ROUND(I.SalePrice / I.PackUnits, 2)
                         WHEN 2 THEN ROUND(I.PurPrice  / I.PackUnits, 2)
                         WHEN 3 THEN ROUND(I.AvgPrice, 2) END,
Value3 = ISNULL(SUM(GD.CurrQty), 0),
Value4 = ISNULL(ROUND(CAST(SUM(GD.CurrQty) AS FLOAT) / CAST(I.packUnits AS FLOAT), 2), 0),
Value5 = ISNULL(SUM(GD.CurrQty), 0) * (that same CASE)
```
`Evidence: dbo.SP_GodownWiseStockInHand, db_modules_full.sql lines 33319–33330`

**Verified notes:** `AvgPrice` is already per unit (not divided by `PackUnits`) whereas Sale/Purchase price are per pack — a subtle but correct asymmetry that must be preserved. `I.PackUnits` is used as a divisor **without a zero guard** in `Value1/Value2/Value4` (a `packunits = 0` item raises divide-by-zero). **Risk (Medium).**

## 6.6 Monthly net sale summary — the `@Type` switch

`SP_MonthlyNetSaleSummary` (line 39705) is one proc serving **seven** reports via `@Type` (**Verified**):

| `@Type` value | Groups by | Name resolved from |
|---|---|---|
| `OVERALL NET SALES` | (none) | literal |
| `HEADER` | `SaleLedger.HeaderNo` | `'Header No.:' + STR(code)` |
| `SALE PERSON` | `SaleLedger.SManCode` | `SalesMan.Name` |
| `CUSTOMER` | `SaleLedger.CustCode` | `Accounts.Name` |
| `AREA` | `Customer.AreaCode` | `Area.Name` |
| `SUBAREA` | `Customer.SubAreaCode` | `SubArea.Name` |
| `CUSTOMER CATEGORY` | `Customer.CustCatCode` | `CustomerCategory.Name` |
| `USER` | `SaleLedger.SalesManCode` | `Users.UserName` |

Net = `SUM(SaleLedger.InvTotal) − SUM(SRLedger.InvTotal)` by month.

**Defects (Verified):**
- **No `Posted = 'Y'` filter** anywhere in this proc — unlike `SP_MONTHLYSALES`. **Two "net sales" reports in the same product use different populations. Risk: High.**
- Uses the pre-computed header total `InvTotal` rather than recomputing from detail — faster, but will not agree with `SP_MONTHLYSALES` if `InvTotal` was ever stale.
- Note `SManCode` (for `SALE PERSON`) and `SalesManCode` (for `USER`) are **two different columns** on `SaleLedger` — the first is the sales rep, the second is the operating user. Easy to confuse.

## 6.7 Salesman collection plan & receipts

`SP_SalesMan_CollectionPlan` (line 47999; `@Date, @SalesManCode SMALLINT, @OverDueDays INT`) — collection targets per rep.
`SP_SALESMANWISE_RECEIPTS` (line 48178; `@month INT, @year INT, @smanlist VARCHAR(8000)`) — a month × rep receipts cross-tab, built by `LEFT OUTER JOIN` of the rep list against a day list from `udf_DaysOfMonthList(@month, @year)` so that zero-days still appear:

```sql
FROM Customer C, GlDetail D, GlHeader H
WHERE H.VochCatCode IN (2, 4) AND H.GlVochCode = D.GlVochCode AND D.AccCode = C.CustCode
  AND month(h.date) = @month AND year(h.date) = @year
```
`Evidence: db_modules_full.sql lines 48208–48220`

**Broken/Incomplete here (Verified):** `GlHeader` = **0 rows** and `GlDetail` = **0 rows** — no manual vouchers exist. Both procs return empty. Also **dead dimension** (`SalesMan` = 1).

## 6.8 Item stock movement at average price

`SP_ItemStockMovementAtAvgPrice` (line 38515; `@ar_startdate, @ar_enddate, @ReportGrouping, @GroupList`) builds an `@Tab_Avg` table of `(Date, ICode, NewAvgPrice)` from **four** posting sources — `PurLedger/PurDetail` (`PostDate`), `SrLedger/SrDetail` (`PostDate`), `ReceiptHeader/ReceiptDetail` (`PostDate`), `AdjHeader/AdjDetail` (`PostedDate`) — all filtered `Posted='Y'`, then writes 18 value slots to `ReportData`. **Verified.**

**Gap (Verified, Medium):** sales and purchase-returns are **not** sources of `NewAvgPrice` here. Under weighted-average costing that is correct (issues don't change average cost), but it means the report's "average price at date X" is a *step function* of purchase/receipt/adjustment events only, and can lag the `Item.AvgPrice` used by the stock-in-hand reports.

---

# 7. Dead, broken, deprecated and dormant

| # | Object / Report | Classification | Evidence |
|---|---|---|---|
| D1 | `sp_StockRegister` (line 49510) | **Broken/Incomplete** — hard-coded `icode=5412`, `GCode=1`, dates `1/1/2000`–`10/10/2000` | lines 49510–49560 |
| D2 | `dbo.StockLedger` (0 rows) + `SP_STOCKLEDGER` never run | **Missing data** — breaks `sp_IncomeStatement` | rowcounts; line 49058 |
| D3 | `sp_IncomeStatement` COGS | **Broken/Incomplete** at this deployment | §5.4.3 |
| D4 | `sp_IncomeStatment` (line 34873, 852 lines) — the typo'd near-duplicate of `sp_IncomeStatement` | **Deprecated / duplicate** | both procs present |
| D5 | `sp_AccountsLedger1` (line 3310, 1,120 lines) vs `sp_AccountsLedger` (line 3137, 194 lines) | **Deprecated / duplicate** | both present, no menu leaf for the "1" variant |
| D6 | `sp_PostedPurAndReturnCategoryWise` (41436) vs `sp_PurAndReturnCategoryWise` (45522) | **Deprecated / duplicate** | both present |
| D7 | `SP_UPDATE_TOTAL_CrossTab_ReportData` vs `…2` | **Duplicate with silent semantic difference** | lines 55910 / 55939 |
| D8 | `sp_Aging` bucket-label `UPDATE` block | **Dead code** (commented out) | lines 4947–4960 |
| D9 | `sp_stock_inout` `#lt_test` temp table | **Dead code** — created and dropped, never used | lines 48932, 49044 |
| D10 | `sp_test1` — uses `ReportData` | **Debug artefact left in production** | present in object catalogue |
| D11 | `sp_executelocal` — uses `ReportData` | Generic RPC buffer reuse; **Risk** if it can execute arbitrary SQL | present in object catalogue |
| D12 | `SP_SALESMANWISE_RECEIPTS`, `SP_SalesMan_CollectionPlan` | **Dormant** — `GlHeader`/`GlDetail` empty, `SalesMan`=1 | rowcounts |
| D13 | `sp_DailyLedger_LPLedger` | **Dormant** — reads `SaleInvDetail` (0 rows) | rowcounts |
| D14 | All Area/SubArea/Zone/Region/SalesMan/CustomerCategory cross-tabs | **Dormant** — single-member or empty dimensions | dimension query |
| D15 | Quotation, Sale Order, Issue, Receipt, Due-Satisfy, Bill Summary report families | **Dormant** — source tables empty | rowcounts |
| D16 | Patient / Service / Student / Guest / Employee / Production report sections | **Dormant** — other verticals | §5.8 |
| D17 | `managementreports.pbd` (0 DataWindows), `mgmtcomp.pbd` (0 bytes) | **Missing** — empty library | file inspection |
| D18 | `ReportTitles` rows 3–6 | **Orphaned** — menu paths not in `Rights` | §2.5 |
| D19 | `ReportTitles` row 1 title = `"a"` | **Data defect** — a typo printed on the report | §2.5 |
| D20 | `ReportFilter` duplicate row with blank `FilterName` | **Data defect** | §2.5 |
| D21 | `Region` = 1 row named `Testing` | **Test data in production** | dimension query |
| D22 | `Dashboard` (right 1706) and `Transaction Activity Monitor` (right 1123) | **Shipped but not deployed** — full KPI suite unused | §5.6 |
| D23 | Balance Sheet / Trial Balance / Income Statement DataWindows | **Shipped but not deployed** | `financialreports.pbd` |

---

# 8. Requires accountant validation

These are accounting-semantics questions I will **not** guess at. Each must be answered by the client's accountant **before** the corresponding logic is ported.

1. **Income Statement Cost of Sales.** With `InventorySystemUsed='P'`, `StockLedger` empty and no COGS GL postings, the GL Income Statement reports *Sales − Purchases* as gross profit. **Is the business aware? Which number do they file/report on — this one, or `SP_DailyIncomeStatement_With_GP_Summary`?** (§5.4.3)
2. **Which gross profit is authoritative?** GL-periodic (Engine A) vs `SaleDetail.AvgPrice` transaction-level (Engine B) vs the SMS daily push (Engine C). They will not agree. (§5.4.3)
3. **Invoice-level discount in category reports.** `sp_SaleAndReturnCategoryWise` ignores `SaleLedger.DiscPerc`; `SP_MONTHLYSALES` applies it. **Which is the intended sales figure for category analysis?** (§6.1)
4. **Purchase value with packs.** `sp_PurAndReturnCategoryWise` computes `(looseqty + packqty) * purprice` without `* packunits`. **Confirm this is a bug and that historical category-purchase figures are understated.** (§6.2)
5. **Posted vs unposted.** `SP_MonthlyNetSaleSummary` and both category-wise procs omit `Posted='Y'`; `SP_MONTHLYSALES` requires it. **Which population defines "sales" for management reporting?** (§6.6)
6. **Bonus quantity.** Costed but not revenued in the GP engine; optionally included in quantity via `@ai_bonus`. **Confirm this is the intended margin treatment for bonus stock.** (§5.4.3)
7. **Aging basis.** Buckets are computed on **document date**, not due date; payments are applied FIFO at report time, not matched in the data. **Confirm this matches the credit policy** (currently moot — cash retail — but must be right before any credit business starts). (§5.5.2)
8. **`@Pricetype` semantics.** Meaning differs between procs (1 = Sale in one, 1 = Actual in another). **Define one canonical valuation vocabulary.** (§2.2)
9. **`AvgPrice` recomputation.** Historical `SaleDetail.AvgPrice` is a frozen snapshot. **Confirm that historical reports must reproduce the frozen cost, not a recomputed one** (`SP_Update_ItemHistoricalCost_In_Sale_And_Return` exists and could have rewritten history — its run history is **Unclear**).
10. **Sales tax composition.** `UnitSalesTax` (per-unit, 41,814 rows) is used; `GSTPerc` (0 rows) is not. **Confirm which tax legs must appear in the FBR statutory reports.**
11. **Fiscal invoice reprints.** Must a reprint reproduce the original FBR payload verbatim? (§5.7.1)
12. **Stock roll-forward completeness.** The 8-document equation in `SP_MONTHLYSALESANDSTOCK_ITEMWISE` — **confirm no ninth document type (e.g. inter-godown transfer) is missing** given `Transfer` tables exist.

---

# 9. Risk register

| # | Risk | Area | Severity | Evidence |
|---|---|---|---|---|
| **1** | **`ReportData` / `CrossTab_ReportData` are global, session-less scratch tables `DELETE`d at the start of every report.** Concurrent users overwrite each other silently — no error, just wrong numbers. | Architecture | **Critical** | `table_columns.tsv` (no session column); `DELETE ReportData` at the head of 87 objects |
| **2** | **Nested scratch dependency:** `sp_AccountsLedger` → `sp_AccountsBalance` → `ReportData` → read back. A concurrent report between the two statements blanks the opening balances. | Architecture | **Critical** | lines 3137–3200 |
| **3** | **GL Income Statement produces a wrong gross profit** (no inventory adjustment; `StockLedger` empty; `InventorySystemUsed='P'`). | Accounting | **Critical** | §5.4.3 |
| **4** | **Report SQL for ~75% of deployed reports exists only in compiled `.pbd` files** and cannot be recovered from the database. | Migration | **Critical** | 197 deployed leaves vs ~40 proc-backed |
| **5** | **11 partner data-export formats are contractual and undocumented** — layouts live in `specialreports.pbd` only. | Migration / commercial | **Critical** | §5.7.4 |
| **6** | **`sp_PurAndReturnCategoryWise` omits `* packunits`** — purchase values understated for pack-bought items. | Correctness | **High** | §6.2 |
| **7** | **`sp_SaleAndReturnCategoryWise` ignores invoice-level discount** — sales overstated vs `SP_MONTHLYSALES`. | Correctness | **High** | §6.1 |
| **8** | **Inconsistent `Posted='Y'` filtering across "net sales" reports.** | Correctness | **High** | §6.6 |
| **9** | **`SP_MONTHLYSALES_SMANWISE` reads `saledetail` in the `impactinventory='N'` leg** where siblings read `saleinvdetail` → double count. | Correctness | **High** | line 39988 |
| **10** | **`sp_stock_inout` mixes units** — sale qty in loose units, purchase qty in pack-converted units. Columns do not net. | Correctness | **High** | §6.4 |
| **11** | **Snapshot-vs-recompute divergence** between `StockReport`-backed and live-recomputed stock reports. | Correctness | **High** | §5.3.5 S3 |
| **12** | **`sp_StockRegister` is a hard-coded prototype** shipped in production. | Correctness | **High** | §5.3.5 S1 |
| **13** | **Culture-dependent month keys** (`'7-01-2026'` string arithmetic) across the whole monthly-sales family. | Correctness / portability | **Medium-High** | §6.3 |
| **14** | **`@Pricetype` means different things in different procs.** | Correctness | **High** | §2.2 |
| **15** | **Cross-tab hard limit of 13 columns**, worked around by paging into `Code2` and per-column `EXECUTE()` dynamic SQL. | Architecture | **Medium** | §2.4 |
| **16** | **Dynamic SQL built by string concatenation of `@colname`** (a dimension member's name) — SQL-injection surface if any lookup name contains a quote. | Security | **Medium-High** | line 50201 |
| **17** | **`StockReport` retention disabled since 2023-06-05**; +5,900 rows/day forever. | Operations | **Medium** | lines 49893, 49901 |
| **18** | **`SP_StockReport` idempotence guard is a correlated `NOT IN` over 3.2 M rows**; `SP_STOCKLEDGER` takes `TABLOCKX`. | Performance | **Medium** | lines 49578, 49923 |
| **19** | **Aging uses a row-by-row cursor.** | Performance | **Medium** | lines 4861–4886 |
| **20** | **Snapshot job trigger is unidentified** — no `JobSchedule` table, no SQL Agent on Express. If it is an OS task, cut-over will silently stop the daily snapshot. | Operations | **High** | §2.4 pattern 4c |
| **21** | **`SaleDetail.AvgPrice` history could be rewritten** by `SP_Update_ItemHistoricalCost_In_Sale_And_Return`, retroactively changing every historical GP report. | Auditability | **High** | proc exists in catalogue |
| **22** | **Export privilege is all-or-nothing and admin-only.** Any analyst needing Excel must be made ADMINISTRATOR — which grants all 240 report rights plus everything else. | Security / governance | **High** | §2.6 |
| **23** | **Menu-tree index collisions** (`5,`, `5,3,2,`, `5,3,11,`) and a malformed index (`5, 6,8,`) ship from the vendor. | Data integrity | **Medium** | §2.1 |
| **24** | **`ReportTitles` joins on a free-text menu path**; 4 of 6 rows are orphaned and one title is the typo `"a"`. | Data integrity | **Low-Medium** | §2.5 |
| **25** | **`ReportData` doubles as a generic RPC buffer** for ~18 non-report procs (`SP_GetVersionInfo`, `SP_CheckPacketCounters`, `sp_executelocal`, sync procs). A background sync can wipe a user's report mid-render. | Architecture | **High** | object scan of the 87 |
| **26** | **`commit` without `BEGIN TRANSACTION`** in `sp_SaleAndReturnCategoryWise` and `sp_PurAndReturnCategoryWise`. | Correctness | **Medium** | lines 47735, 46093 |
| **27** | **`PackUnits` used as a divisor with no zero-guard** in stock valuation. | Correctness | **Medium** | §6.5 |
| **28** | **`SP_DailyIncomeStatement_With_GP_Summary` header comment contradicts its code** (`'M'/'H'/'B'` documented vs `'S'/'A'` implemented). | Correctness | **Medium** | line 21179 vs 21190 |
| **29** | **Stock-in-hand excludes `Item.active = 0`** yet the same layouts are used as physical count sheets. | Correctness | **Medium** | line 33357 |
| **30** | **`VIEW_SMS_DailySalesAndReturnSummary` uses `UNION` not `UNION ALL`** — identical tuples silently dropped. | Correctness | **Low-Medium** | view body |
| **31** | **Only one Crystal Reports artefact** (`rptPrintCheque.rpt`) — a second, undocumented reporting runtime for a single report. | Migration | **Low** | §E9 |
| **32** | **Customer-specific layouts compiled into the shared binary** (≥8 named customers in `graphcomponents.pbd`). Fazal Din's binary carries other customers' report definitions. | Governance | **Medium** | §5.6.1 |

---

# 10. Modernization: report → visualization mapping

> **Everything in this section is `Recommended` — a proposal for the new Node/React/MySQL system. None of it exists today.**

## 10.1 Architectural replacements (Recommended)

| Legacy mechanism | Problem | Recommended replacement |
|---|---|---|
| `ReportData` / `CrossTab_ReportData` global scratch tables | Not concurrency-safe (Risk 1, 2, 25) | **Delete the concept entirely.** Report endpoints return JSON from a single parameterised query or CTE. No server-side staging. If a materialised intermediate is genuinely needed, use a per-request temp table or a session-scoped table with a `request_id` PK. |
| Dynamic-SQL cross-tab with 13-column pages | Column limit, injection surface, dynamic SQL | **Pivot in React.** Return long/tidy rows `(rowKey, colKey, qty, value)`; pivot client-side with an unlimited-column virtualised grid + horizontal scroll. |
| `SP_UPDATE_TOTAL_CrossTab_ReportData` / `…2` | Two procs, silent semantic difference | Compute totals in the same query as a `GROUPING SETS` / `WITH ROLLUP`, or in the client. One definition. |
| DataWindow-embedded SQL | Unrecoverable, untestable, unversioned | **A versioned SQL/query module per report** in the repo, with a golden-output regression test per report. |
| `w_arg_*` × 1,080 hand-built parameter windows | Unmaintainable | **One declarative filter schema per report** (JSON), rendered by a single generic `<ReportFilters>` component. ~15 filter primitives cover all 1,080. |
| `w_selectformat_*` × 357 | 357 windows for "pick a layout" | **Column presets + saved views** on one grid component. |
| `ReportTitles` keyed by free-text menu path | Orphans, typos | Title lives in the report definition; i18n-ready. |
| `ReportFilter` keyed by DataWindow name | Only 2 rows ever used | **Per-user saved views** (filters + columns + sort + chart type), shareable. |
| Excel export as an admin-only privilege | Blocks analysts (Risk 22) | **Fine-grained export right per report group**, decoupled from full admin. Server-side XLSX/CSV/PDF generation with an audit log row per export. |
| `StockReport` daily snapshot via unidentified job | Silent-failure risk (Risk 20) | **A named, monitored job** with a heartbeat table and an alert if a day is missed. Keep the snapshot pattern — it is genuinely valuable — but make its liveness observable. |

## 10.2 Canonical metric layer (Recommended)

The single highest-value modernization action is to **define each metric exactly once** and make every report consume that definition. Today `net sales` has at least four incompatible implementations.

| Canonical metric | Definition to standardise on | Source of truth today |
|---|---|---|
| `sale_line_value` | `(looseqty + packqty*packunits) * (saleprice - itemflatdisc) * (1 - discperc/100) * (1 - invoice_discperc/100)` | `SP_MONTHLYSALES` lines 39848–39849 — **the reference** |
| `sale_line_qty` | `looseqty + packqty*packunits [+ bonusqty if requested]` | same, line 39847 |
| `return_line_value` | same shape with `srprice`, sign-negated | same, lines 39878–39879 |
| `cogs` | `SUM((looseqty + bonusqty) * saledetail.avgprice)` — the **frozen** snapshot cost | `SP_DailyIncomeStatement_With_GP_Summary` line 21219 |
| `gross_profit` | `net_sales − cogs` | `VIEW_SMS_DailySalesAndReturnSummary` |
| `gp_rate` | `gross_profit / NULLIF(net_sales,0) * 100` | same |
| `invoice_flat_disc_allocation` | `flatdisc * line_value / NULLIF(invoice_gross,0)` | line 21209 |
| `stock_on_hand` | 8-document roll-forward | `SP_MONTHLYSALESANDSTOCK_ITEMWISE` lines 40049–40106 |
| `stock_value` | `qty * {sale|purchase|avg} price`, with an explicit named basis (never a magic integer) | `SP_GodownWiseStockInHand` lines 33319–33330 |
| `sales_tax` | `SUM(looseqty * unitsalestax) + SUM(ROUND(line_value * gstperc/100, 2))` + invoice-level `invgstperc1` leg | `sp_SaleAndReturnCategoryWise` line 47699; `SP_DateWiseSaleBreakup` lines 21730–21737 |
| `days_of_cover` | `stock_on_hand / NULLIF(avg_daily_sale_qty, 0)` | **New** — Recommended |

**Every one of the 30+ formula defects catalogued in §6 and §9 disappears the moment there is one definition.**

## 10.3 Report → visualization map

**Recommended** for the React rebuild. Grouped by the seven required categories.

### Sales

| Legacy report(s) | Consolidates | Recommended primary visual | Secondary |
|---|---|---|---|
| Daily Sale Detail ×4 formats + Detail Inv.Wise | 5 → 1 | Virtualised transaction grid, invoice-grouped, server-paginated, column presets | Row drawer with full invoice |
| Daily Sale Summary ×4 | 4 → 1 | KPI strip (net sales, invoices, avg basket, GP%) + hour-of-day bar | Sparkline vs prior period |
| Days Summary, Monthly Net Sales, Monthly Net Sales Summary, Month Wise GP | 4 → 1 | **Combo chart**: bars = net sales, line = GP% ; toggle day/week/month | YoY overlay, 7-day MA |
| Hourly Sales Graph, Customer Hourly Graph | 2 → 1 | **Day-of-week × hour heatmap** | Staffing overlay |
| Category Wise: Sale And Return, Sales, Net Sale, GP, Monthly Sale, Day Net Sale, Item Category Monthly | 7 → 1 | **Category explorer**: donut (mix) + stacked bar (sale/return) + heatmap (category × month), all cross-filtered | Drill to item |
| Manufacturer Wise: Sales, Sales Detail, Net Sales, Sale & Return Summary | 4 → 1 | **Pareto bar (top-20 of 838 manufacturers)** with cumulative % line | Long tail table |
| Class Wise | 1 | Bar | — |
| Slow/Fast Moving ×2, Dead Item List | 3 → 1 | **Quadrant scatter: sales velocity (x) × margin % (y), bubble = stock value**; dead items in the origin quadrant | Ranked table |
| Item Sale & Return Activity, Item Wise Net Sales, Item Sales/Discount | 3 → 1 | **Item page**: sparkline trend, movement waterfall, price history, current stock | — |
| User Wise: Sales, Invoice Graph, Category Summary, Net Cash, User Wise Summary | 5 → 1 | **Cashier leaderboard** — bar per user with net sales, invoices, avg basket | Drill to that user's day |
| User Wise Discount Report | 1 | **Box-plot of discount % per user** + outlier table | Control/exception report |
| User Wise Sales Commission | 1 | Table + payout KPI | — |
| Refused Sales Detail | 1 | **Lost-sales Pareto** + estimated lost revenue KPI | Feed into reorder suggestions |
| Invoice Wise Profit Margin Detail | 1 | **Scatter: invoice value × margin %**, red band for below-cost | Exception list |
| Sale Summary Machine & Invoice Range Wise | 1 | **Terminal × category grouped bar** + till reconciliation cards | — |
| Sales Tax / Output Sales Tax / Customer NTN Wise / CNIC-NTN Registered | 4 | **Statutory tables — fixed layout, no charts**, PDF-exact | Coverage % KPI |

### Purchase

| Legacy report(s) | Recommended visual |
|---|---|
| Purchase Detail / Summary ×3 | Virtualised grid + KPI strip |
| Periodic Purchases, Day Summary, Date Wise Purchase Graph, Net Purchase Summary | **Single trend chart** (bars = purchases, line = net of returns), period toggle |
| Supplier Wise Detail / Net Purchase, Purchase Return by supplier | **Supplier Pareto** + return-rate column; drill to supplier page |
| ManufacturerWise Detail, PO Manf. Wise | Grouped bar |
| Monthly Stock Movement | **Waterfall: opening → purchases → returns → sales → adjustments → closing** |
| Category Wise Purchase | Donut + table (with the `packunits` bug fixed) |
| P/O Based Purchase Disparity | **Diverging bar: ordered vs received per line**, variance-sorted |
| Supplier/Manufacturer Wise G/P | **Bubble: purchase value × GP% × units** |
| WHT Deduction ×5 layouts, Input Sales Tax, Advance Income Tax | Statutory tables, fixed layout |
| *(not currently deployed)* `sp_purchase_rate_comparison` | **Recommended to surface: price-per-unit comparison across suppliers over time — line chart per item, one series per supplier.** High margin-recovery value. |

### Inventory / Stock

| Legacy report(s) | Recommended visual |
|---|---|
| Stock in Hand ×10 variants (Manf/Cat/Class/Other/Qty/Supplier-assoc/Audit/Batch ×2/Back Date) | **One Stock Explorer**: treemap (value by chosen dimension) + virtualised grid + as-at date picker (snapshot-backed) + "value at" basis selector |
| Godown Wise Stock ×4 | Same explorer with a Godown facet (single warehouse today, multi-ready) |
| Expiry Report, Expiry (Classwise), Godown Stock with Batch Expiry | **Expiry bucket bar: <30 / 30-60 / 60-90 / 90-180 / >180 days, height = value at risk**, click to batch list |
| Reorder / Minimum / Optimum / Reorder-Optimum Level ×4 | **One replenishment board**: gauge bar per item (on-hand vs min/reorder/optimum), suggested order qty, sortable by urgency |
| Stock and Sales | **Scatter: days-of-cover × sales velocity**, bubble = value; over/under-stock quadrants |
| Daily Stock IN/OUT, Stock IN/OUT (Date Wise), Item Activity | **Movement waterfall per item** + stacked in/out bar by day |
| Stock Register, Item Stock Register Summary | **Running-balance ledger table** (rebuilt correctly — the legacy proc is broken) |
| Narcotics registers ×3 | **Statutory sequential register — print-exact, immutable, tamper-evident**; no charts |
| Stock Management Report | Inventory health dashboard page |
| Adjustment reports ×6 | **Reason Pareto + monthly shrinkage-value trend + per-user adjustment volume** (control report) |
| Item History ×5 (`ItemLog`) | **Audit timeline with field-level diffs**; price history as a **step line chart** |
| Deleted Sale Items Log | **Exception grid** — user, timestamp, invoice, item, value; alertable |

### Financial / Accounting

| Legacy report(s) | Recommended visual |
|---|---|
| Account Ledger | Ledger grid with running balance + opening/closing cards |
| Purchase Invoice Accounting Detail | Grid + drill to GL entries |
| Income Statement *(shipped, not deployed, and broken)* | **Rebuild from scratch** on the canonical metric layer: revenue → COGS → gross profit → opex → net, as a **stepped waterfall** + period-comparison table. **Do not port the legacy formula.** |
| Trial Balance *(shipped, not deployed)* | Grid with Dr/Cr totals and an out-of-balance banner |
| Balance Sheet *(shipped, not deployed)* | Two-column statement + composition donuts |
| Daily Income Statement with GP ×2 | **Daily P&L strip**: net sales, CGS, GP, GP% — with a 30-day trend line |
| SMS daily KPI push | **Keep the concept**: a scheduled daily digest (email/WhatsApp/push) with the same six KPIs |

### Receivables / Aging

| Legacy report(s) | Recommended visual |
|---|---|
| Aging Analysis Summary – Customer Wise (+ the 8 undeployed variants) | **Stacked horizontal bar per account across buckets**, sorted by total exposure; click to invoice-level FIFO detail |
| *(gap)* Supplier aging | **Recommended new report** — `Supplier` = 235 with large credit balances and no aging report exists. Same visual, payables side. |
| Aging Per Invoice | Invoice detail drawer with the FIFO application shown explicitly |
| Salesman Collection Plan / Receipts | Only if reps are introduced; otherwise drop |

### Management / Dashboard

| Legacy | Recommended visual |
|---|---|
| Dashboard (shipped, never enabled) — 11 tabs, 91 DataWindows | **Build it.** Landing page: today's net sales / GP% / invoices / avg basket, sales trend, top-10 sellers, expiry-value-at-risk, dead-stock value, reorder-urgent count, adjustment exceptions. Every tile drills to the underlying grid. |
| Transaction Activity Monitor (shipped, never enabled) | **Live activity feed** (WebSocket/SSE): recent transactions with user, terminal, value; anomaly highlighting |
| Session Monitor / Cashier Activity Window (deployed) | **Live sessions table** + per-cashier till status |
| *(gap)* | **Recommended: exception dashboard** — below-cost sales, discount outliers, deleted lines, negative stock, expiring narcotics, unposted documents |

### Operational

| Legacy | Recommended |
|---|---|
| Re-printing ×8 formats | **One document renderer** with a template selector; fiscal reprints replay the **stored** FBR payload verbatim (never recomputed) |
| Listings ×7 | Master-data grids with faceted filters and inline export |
| Labels / barcodes | Label designer + batch print queue |
| **11 partner Data Export Utilities** | **Port as scheduled, versioned export jobs** with per-partner format modules, a run log, and a re-send capability. **Collect sample files from the customer first — the formats are not recoverable from the DB.** |
| Group Rights List | **Permission matrix heatmap** (roles × report groups) |

## 10.4 Suggested rebuild scope & phasing (Recommended)

| Phase | Scope | Report count | Rationale |
|---|---|---:|---|
| **P0 — Foundations** | Metric layer, filter schema, grid/chart/export components, saved views, RBAC, export audit | 0 | Everything else depends on it |
| **P1 — Daily operations** | Daily sale detail/summary, sale return, purchase detail/summary, re-prints, stock-in-hand explorer, expiry, reorder board, narcotics registers | ~25 | Covers every SHIFT INCHARGE and SALES OFFICER need (their combined entitlement is 43 + 37 rights, heavily overlapping) |
| **P2 — Commercial analytics** | Category/manufacturer/class explorers, GP reports, user-wise, slow-fast/dead stock, stock & sales, item history, adjustments, refused sales | ~35 | The ADMIN analytics core |
| **P3 — Statutory & partner** | All FBR/tax reports, WHT, narcotics compliance, **11 partner export utilities** | ~20 | Contractual + regulatory; needs the customer's sample files |
| **P4 — Financial** | Account ledger, aging (customer **and** supplier), rebuilt Income Statement / Trial Balance / Balance Sheet on the canonical metric layer | ~10 | Blocked on §8 accountant validation |
| **P5 — Dashboard & monitoring** | KPI dashboard, exception dashboard, live activity feed, daily digest | ~5 pages | Replaces the never-enabled legacy dashboard |
| **Explicitly out of scope** | Area/Region/Zone/SubArea/SalesMan/CustomerCategory cross-tabs; Patient/Service/Student/Guest/Employee/Production sections; Quotation/Sale-Order/Issue/Receipt families; CRS (pending a decision) | ~130 of 197 | Dead dimensions or dormant verticals at this deployment |

**Net effect:** **197 legacy menu leaves → roughly 95 modern screens**, of which ~30 are consolidated explorers replacing 3–10 legacy variants each. Confidence in this scoping: **Medium-High** — it depends on confirming (a) whether CRS is live, (b) the exact partner export formats, and (c) the §8 accounting answers.

---

# 11. Appendix A — the 197 deployed report leaves

Grouped by menu section, with `RightCode` and tree index. **Verified** — `SELECT RightCode, IndicesString, RightName FROM Rights WHERE RightName LIKE 'Reports%' …` filtered to leaf nodes.

| Section | Deployed leaves | Master leaves | Coverage |
|---|---:|---:|---:|
| Sales Reports (`5,3,`) | 58 | 229 | 25% |
| Daily Reports (`5,1,`) | 30 | 72 | 42% |
| Stock Reports (`5,2,`) | 27 | 59 | 46% |
| Purchase Reports (`5,4,`) | 15 | 36 | 42% |
| CRS Reports (`5,26,`) | 12 | 30 | 40% |
| Special Reports (`5,16,`) | 11 | 68 | 16% |
| RePrinting (`5,8,`) | 8 | 24 | 33% |
| Listing (`5,6,`) | 7 (+1 malformed) | 25 | 28% |
| Item Reports (`5,12,`) | 7 | 11 | 64% |
| Godown Reports (`5,13,`) | 4 | 20 | 20% |
| Sales Order Reports (`5,20,`) | 3 | 7 | 43% |
| **Accounts Reports (`5,5,`)** | **3** | **76** | **4%** |
| Student Reports (`5,28,`) | 2 | 17 | 12% |
| Purchase Return Reports (`5,14,`) | 2 | 3 | 67% |
| Issue Reports (`5,18,`) | 2 | 12 | 17% |
| Patient Reports (`5,10,`) | 2 | 35 | 6% |
| Service Reports (`5,15,`) | 1 | 24 | 4% |
| Employee Reports (`5,30,`) | 1 | 5 | 20% |
| Production Reports (`5,34,`) | 1 | 2 | 50% |
| **Total** | **197** | **792** | **25%** |

**Sections in the master with ZERO deployment here (Verified):** Labels (`5,7,`, 4), BarCode Printing (`5,11,`, 3), Customer Site Reports (`5,17,`, 3), Receipt Reports (`5,19,`, 3), Attendance (`5,21,`, 2), Open Powersoft Report Viewer (`5,22,`, 1), Sales Template (`5,23,`, 1), User Reports (`5,24,`, 1), Refused Sales Reports (`5,25,`, 2), Guest Reports (`5,27,`, 5), Loyalty (`5,29,`, 1), Installment (`5,31,`, 2), Data Import (`5,32,`, 1), Passport (`5,33,`, 1), Product Reports (`5,35,`, 1), Sales Return Reports (`5,9,`, 5).

*(The complete 197-row list with full menu paths is reproduced inline in §5 by group; the raw extract is available from the live DB with the query in Appendix C.)*

---

# 12. Appendix B — report-producing DB objects, with line references

All line numbers refer to `C:/Users/Admin/AppData/Local/Temp/claude/E--Pharma-Software/6817c053-0a3d-471f-ae16-ab90c079cc3d/scratchpad/db_modules_full.sql`.

## Sales

| Line | Object | Params |
|---:|---|---|
| 39824 | `SP_MONTHLYSALES` | `@ar_startdate, @ar_enddate, @ai_pricetype, @ai_returns, @ai_bonus, @ai_allcust, @ai_custcode` |
| 39894 | `SP_MONTHLYSALES_MANFWISE` | `@ar_startdate, @ar_enddate` |
| 39960 | `SP_MONTHLYSALES_SMANWISE` | `@ar_startdate, @ar_enddate, @ar_smancode` |
| 40015 | `SP_MONTHLYSALESANDSTOCK_ITEMWISE` | `@ar_startdate, @ar_enddate, @ar_icode` |
| 40136 | `SP_MONTHLYSALESCLASSWISE` | `@ar_startdate, @ar_enddate, @as_IsActualPrice` |
| 40194 | `SP_MONTHLYSALESSUMMARY` | `@ar_startdate, @ar_enddate, @ReportGrouping, @GroupList` |
| 61422 | `SP_YEARLYSALESSUMMARY` | `@ar_startdate, @ar_enddate, @ReportGrouping, @GroupList` |
| 61350 | `sp_yearly_sale_summary_monthwise_groping` | `@dt_year` (returns result set) |
| 39705 | `SP_MonthlyNetSaleSummary` | `@Type, @StartDate, @EndDate` |
| 20238 | `SP_CustomerNetSaleMonthSummary` | `@ar_startdate, @ar_enddate` |
| 21347 | `SP_DateWiseSaleBreakup` | `@ai_custcode, @ad_startdate, @ad_enddate, @ai_days, @ad_discperc` |
| 47162 | `sp_SaleAndReturnCategoryWise` | `@ad_date, @ad_ldate` |
| 47237 | `sp_SaleAndReturnCategoryWise_wrt_SaleCat` | `@ad_date, @ad_ldate` |
| 47297 | `sp_SaleAndReturnClassWise` | `@ad_date, @ad_ldate` |
| 47355 | `sp_SaleAndReturnClassWise_invrange` | `@ad_date, @ad_ldate` |
| 47097 | `sp_SaleAndReturnCatClassWise` | `@ad_date, @ad_ldate` |
| 38157 | `sp_itemactivity` | `@s_date, @l_date` |
| 39038 | `SP_MachineWiseSaleAndReturn_CrossTab` | `@StartDate, @EndDate` |
| 19588 | `SP_CustGroup_ItemGroup_NetSale_CrossTab` | `@CustGroupCode, @ItemGroupCode, @startdate, @enddate` |
| 38375 | `SP_ITEMNETSALE_SMANWISE_BREAKUP` | `@ar_startdate, @ar_enddate` |
| 390 | `fn_GetHeaderWiseSaleSummary` | `(date)` |
| 590 | `fn_GetManfWiseNetSaleToDate` | `(date)` |

## Sales — territory (dormant here)

| Line | Object | Params |
|---:|---|---|
| 7216 | `SP_AREAWISESALES` | `@StartDate, @EndDate, @RegionCode, @ReportGrouping, @GroupList, @ZeroRows, @Pricetype, @IncludeBonus, @IncludeReturns` |
| 7117 | `SP_AreaWise_ComparativeMonthSales` | — |
| 49954 | `SP_SUBAREASALES` | `@ar_startdate, @ar_enddate, @ReportGrouping, @GroupList, @SubAreaList` |
| 50085 | `SP_SUBAREASALES_CROSSTAB` | `@startdate, @enddate, @ReportGrouping, @GroupList, @Pricetype, @TotCol, @SubAreaList, @onlysalearea, @MergeBonus` |
| 61540 | `SP_ZONALAREASALES` | `@ar_zonecode, @ar_startdate, @ar_enddate, @ReportGrouping, @GroupList, @Pricetype` |
| 61680 | `SP_ZONALAREASALES_CROSSTAB` | — |
| 46213 | `SP_REGIONWISESALES` | `@ar_startdate, @ar_enddate, @ReportGrouping, @GroupList, @RegionList` |
| 46049 | `SP_REGIONAREASALES` | `@ar_regcode, @ar_startdate, @ar_enddate, @ReportGrouping, @GroupList, @pricetype, @includebonus` |
| 18885 | `SP_CUSTCATWISESALES` | `@ar_startdate, @ar_enddate, @ReportGrouping, @GroupList, @CustCatList, @AreaList, @ZeroRows` |
| 19048 | `SP_CUSTCATWISESALESDETAIL` | same |
| 19261 | `SP_CUSTCATWISESALESDETAIL_CROSSTAB` | same |
| 47765 | `SP_SALESMAN_AREASALES_CROSSTAB` | `@Salesmancode, @startdate, @enddate, @ReportGrouping, @GroupList, @Pricetype, @TotCol` |
| 47999 | `SP_SalesMan_CollectionPlan` | `@Date, @SalesManCode, @OverDueDays` |
| 48178 | `SP_SALESMANWISE_RECEIPTS` | `@month, @year, @smanlist` |

## Purchase

| Line | Object | Params |
|---:|---|---|
| 45522 | `sp_PurAndReturnCategoryWise` | `@ad_date, @ad_ldate` |
| 41436 | `sp_PostedPurAndReturnCategoryWise` | *(deprecated duplicate)* |
| 45599 | `sp_purchase_rate_comparison` | `@start_date, @end_date, @purchase_category, @ReportGrouping, @GroupList` |

## Inventory / Stock

| Line | Object | Params |
|---:|---|---|
| 49885 | `SP_StockReport` | `@DailyReportDays, @ArchiveReportDays` — **snapshot ETL** |
| 49058 | `SP_STOCKLEDGER` | *(none)* — **ETL, never run here** |
| 32937 | `SP_GodownWiseStockInHand` | `@ReportGrouping, @GroupList, @ZeroRows, @Pricetype` |
| 38515 | `SP_ItemStockMovementAtAvgPrice` | `@ar_startdate, @ar_enddate, @ReportGrouping, @GroupList` |
| 49510 | `sp_StockRegister` | *(none)* — **Broken, hard-coded** |
| 48931 | `sp_stock_inout` | `@s_date, @l_date, @l_code, @ls_grouping` |
| 49315 | `sp_stockmovementcatwise` | `@s_date, @l_date, @l_catcode` |
| 49420 | `sp_stockmovementclasswise` | — |
| 31100 | `SP_GetGodownConsumption` | — |

## Financial / Accounting

| Line | Object | Params |
|---:|---|---|
| 34158 | `sp_IncomeStatement` | `@ad_SDate, @ad_EDate, @ac_level` |
| 34873 | `sp_IncomeStatment` | *(deprecated typo duplicate, 852 lines)* |
| 20846 | `SP_DailyIncomeStatement_With_GP_Summary` | `@StartDate, @EndDate, @ReportType, @Accounts` |
| 21147 | `SP_DailyIncomeStatement_With_GP_Summary2` | `@StartDate, @EndDate, @Accounts` |
| 13895 | `sp_CRS_IncomeStatement` | *(664 lines)* |
| 3137 | `sp_AccountsLedger` | `@ad_StartDate, @ad_EndDate` |
| 3310 | `sp_AccountsLedger1` | *(1,120 lines, deprecated)* |
| 2691 | `sp_AccountsBalance` | `@Date` |
| 20303 | `sp_CustomersBalance` | — |
| 50534 | `sp_SuppliersBalance` | — |
| 48765 | `sp_SingleCustomerBalance` | — |
| 21275 | `sp_DailyLedger_LPLedger` | `@custcode, @datetype, @start_date, @end_date, @caption` — **returns result set directly** |
| 20483 / 50709 / 40659 | `sp_CustomerTransactionStatus` / `sp_SupplierTransactionStatus` / `sp_OtherAccTransactionStatus` | — |
| 30948 / 31704 | `SP_GetCustomerOverDueBlanceList` / `SP_GetOverDueBlanceList` | — |
| 19765 | `sp_Customer_Sale_Accounts` | — |

## Aging

| Line | Object | Params |
|---:|---|---|
| 4554 | `sp_Aging` | `@Type, @l_date, @interval, @limit` |
| 5200 | `sp_Aging_CustomerWise` | `+ @AccountList` — **the only deployed one** |
| 6019 | `sp_AgingDetail` | `+ @Code` |
| 4747 | `sp_Aging_Account` | `+ @AccCode` |
| 4970 | `sp_Aging_Cummulative` | — |
| 5385 | `sp_Aging_Per_Invoice` | `@SaleInvCode` |
| 5622 | `SP_Aging_SalesManWise` | — |
| 5743 | `SP_Aging_SubAreaWise` | — |
| 6215 | `sp_AgingDetail_SalePersonWise` | `+ @Code` |
| 5864 | `sp_AgingBasedEPI` | — |

## Cross-tab infrastructure

| Line | Object |
|---:|---|
| 55910 | `SP_UPDATE_TOTAL_CrossTab_ReportData` |
| 55939 | `SP_UPDATE_TOTAL_CrossTab_ReportData2` |
| — | `udf_StringToTabl(csv, delim)`, `udf_selectitems(@grouping, @list)`, `udf_DaysOfMonthList(@month, @year)`, `udf_openingstock`, `udf_GodownOpeningStock`, `udf_openingstocksingleitem`, `udf_GetSummaryAccountList`, `udf_salesmanscopebased_weekdaylist` |

## SMS-delivered report views (all Verified)

`VIEW_SMS_DailySalesAndReturnSummary`, `VIEW_SMS_DailyHeaderWiseNetSalesSummary`, `VIEW_SMS_ManufacturerMonthlyNetSaleToDate`, `VIEW_SMS_ZonalSaleAndStock_CatWise_ToDate`, `VIEW_SMS_Zone_SaleAndStock_CatWise_ToDate` — plus 20 transactional-notification views (`VIEW_SMS_SaleInvInfo`, `…CustomerReceiptAcknowledgement`, `…SupplierPaymentInfo`, etc.).

---

# 13. Appendix C — reproducible evidence queries

All read-only. Run against `Server=localhost\SQLEXPRESS;Database=FazalDinPP19DataBaseV2`.

```sql
-- A. The deployed report menu, leaves only (197 rows)
;WITH R AS (
  SELECT DISTINCT RightCode, RTRIM(IndicesString) ix, RightName
  FROM Rights WHERE RightName LIKE 'Reports%' AND IndicesString LIKE '5,%')
SELECT a.RightCode, a.ix, a.RightName FROM R a
WHERE NOT EXISTS (SELECT 1 FROM R b WHERE b.ix <> a.ix AND b.ix LIKE a.ix + '%')
ORDER BY a.ix;

-- B. The vendor master report menu, leaves only (792 rows) -- swap Rights -> Rightsclone

-- C. Report entitlement by role
SELECT g.GroupCode, gr.GroupName, COUNT(*) AS ReportRights
FROM GroupRights g
JOIN Rights r ON r.RightCode = g.RightCode
JOIN Groups gr ON gr.GroupCode = g.GroupCode
WHERE r.RightName LIKE 'Reports%' AND g.Status = 1
GROUP BY g.GroupCode, gr.GroupName ORDER BY 1;

-- D. Export/print privileges
SELECT g.RightCode, r.RightName, g.GroupCode, g.Status
FROM GroupRights g JOIN Rights r ON r.RightCode = g.RightCode
WHERE g.RightCode IN (637, 638, 5217) ORDER BY g.RightCode, g.GroupCode;

-- E. Menu-tree integrity defects
SELECT RTRIM(IndicesString) ix, COUNT(*) n, MIN(RightName), MAX(RightName)
FROM Rights WHERE RightName LIKE 'Reports%' AND LEN(RTRIM(IndicesString)) > 0
GROUP BY RTRIM(IndicesString) HAVING COUNT(*) > 1;

-- F. Reporting dimension cardinality (proves dead dimensions)
SELECT 'Area' d, COUNT(*) n FROM Area
UNION ALL SELECT 'SubArea', COUNT(*) FROM SubArea
UNION ALL SELECT 'Region', COUNT(*) FROM Region
UNION ALL SELECT 'Zone', COUNT(*) FROM Zone
UNION ALL SELECT 'SalesMan', COUNT(*) FROM SalesMan
UNION ALL SELECT 'CustomerCategory', COUNT(*) FROM CustomerCategory
UNION ALL SELECT 'Customer', COUNT(*) FROM Customer
UNION ALL SELECT 'Godown', COUNT(*) FROM Godown
UNION ALL SELECT 'ItemCategory', COUNT(*) FROM ItemCategory
UNION ALL SELECT 'ItemClass', COUNT(*) FROM ItemClass
UNION ALL SELECT 'Manufacturer', COUNT(*) FROM Manufacturer;

-- G. Income-statement breakage proof
SELECT dbo.Fn_GetPreference('InventorySystemUsed') AS InvSys,
       (SELECT COUNT(*) FROM StockLedger)  AS StockLedgerRows,
       (SELECT COUNT(*) FROM VirtualGl WHERE AccCode = 9) AS COGS_GL_Rows;

-- H. Snapshot cadence & retention
SELECT COUNT(*) rows, COUNT(DISTINCT CONVERT(date, Date)) days,
       MIN(Date) firstSnap, MAX(Date) lastSnap FROM StockReport;

-- I. What report ran last (residue in the global scratch table)
SELECT * FROM ReportData;
SELECT * FROM CrossTab_ReportData;
SELECT * FROM ReportTitles;
SELECT * FROM ReportFilter;
```

**PowerShell shell used for all of the above (read-only):**

```powershell
$cs="Server=localhost\SQLEXPRESS;Database=FazalDinPP19DataBaseV2;User ID=sa;Password=<redacted>;TrustServerCertificate=True"
$conn=New-Object System.Data.SqlClient.SqlConnection $cs; $conn.Open()
$c=$conn.CreateCommand(); $c.CommandText="<query>"; $r=$c.ExecuteReader()
while($r.Read()){ ... }; $conn.Close()
```

**PBD string extraction (read-only, UTF-16LE — PowerBuilder 12.5 stores object names as Unicode):**

```python
import re
u16 = re.compile(rb'(?:[ -~]\x00){5,}')
data = open('reports.pbd','rb').read()
names = {m.group().decode('utf-16-le','ignore').strip().lower() for m in u16.finditer(data)}
# then filter tokens matching ^d_ / ^dw_ / ^w_
```

---

## Document control

| | |
|---|---|
| **Scope covered** | Report inventory, menu/entitlement model, parameter model, data-acquisition patterns, per-report catalogue (Sales / Purchase / Inventory / Financial / Aging / Management / Operational), formulas, dead & broken objects, risk register, accountant-validation list, modernization mapping |
| **Not covered here** | Posting logic (see `07-accounting-logic.md`), inventory costing internals (`08-inventory-logic.md`), permissions model in depth (`09-roles-permissions.md`), sales/purchase workflows (`05a`, `05b`) |
| **Biggest open item** | The SQL for ~75% of deployed reports is inside compiled `.pbd` files and is **not recoverable from the database**. Before the rebuild, capture a printed/Excel sample of every one of the 197 deployed reports, run for a known period, as the regression baseline. |
| **Second biggest** | The 11 partner Data Export Utility formats are contractual and undocumented — sample output files must be obtained from the customer. |
