# 08 — Inventory & Stock Engine: Complete Logic Analysis

| | |
|---|---|
| **Document** | `08-inventory-logic.md` — Inventory / Stock Engine Analysis |
| **System under analysis** | WASEELA ABUZAR V3 (vendor "Abuzar"/"Waseela"), deployment **Fazal Din PP19** — retail pharmacy |
| **Analysis stage** | Stage 3 — Domain deep-dive (business logic reconstruction from database artefacts) |
| **Date of analysis** | 2026-08-01 |
| **Analyst basis** | Compiled PowerBuilder 12.5 client + SQL Server 2019 Express database. **No application source code exists** — the authoritative business logic recoverable from artefacts is the SQL Server programmable objects, schema, and live data. |

## Evidence sources used

| Source | What was used from it |
|---|---|
| `…/scratchpad/db_modules_full.sql` (2.48 MB, 762 objects) | Full source of every stored procedure, function, view and trigger. All proc quotes in this document are verbatim from this file; line numbers cited are line numbers **within this file**. |
| `…/scratchpad/table_columns.tsv` (11,414 cols) | Column names, data types, precision/scale, nullability, defaults |
| `…/scratchpad/table_rowcounts.tsv` | Used-vs-dormant determination |
| `…/scratchpad/foreign_keys.tsv`, `primary_keys.tsv` | Referential model |
| **Live database** `FazalDinPP19DataBaseV2` on `localhost\SQLEXPRESS` | Read-only SELECT/metadata queries to confirm real data shapes, row counts, distributions, index/constraint definitions, and to **empirically validate the costing formula against 113,561 historical purchase lines** |
| `E:/Pharma Software/extracted_scripts.sql` | Cross-check on DDL |

## Evidence-label legend

Every material claim below carries exactly one label:

| Label | Meaning |
|---|---|
| **Verified** | Read directly in procedure/function/trigger source, schema metadata, or confirmed by a live-database query. Evidence pointer given. |
| **Strongly Inferred** | Not stated in one place, but multiple independent pieces of evidence converge. Reasoning given. |
| **Unclear** | Evidence is ambiguous or the logic lives in the compiled binary. |
| **Missing** | The capability is absent from the product. |
| **Deprecated** | Present but explicitly disabled, commented out, or superseded. |
| **Broken/Incomplete** | Present but defective or half-implemented. |
| **Recommended** | A proposal for the **new** system. **Not an existing feature.** |

> **Rule applied throughout:** an empty table proves the feature is **not used at this deployment**. It does **not** prove the feature is absent from the product. The two are distinguished explicitly everywhere below.

---

# 1. Headline conclusion

**Verified.** The inventory engine is a **single-warehouse, whole-unit, perpetual, moving-weighted-average-cost** system whose *only* authoritative stock balance is the table **`GodownDetail`** — a live balance table keyed `(GCode, ICode, Batch, Expiry)`. Everything else that looks like a stock store is either a **derived daily snapshot** (`StockReport`, 3.2 M rows, write-only, never read by SQL), a **rebuild scratchpad** (`StockLedger`, currently 0 rows), or a **denormalised cache that is not maintained** (`Item.TotalPieces`, `Item.TransitStock` — both zero for all 30,050 items).

**Verified.** The **costing method is definitively a moving (perpetual) weighted average at item level, not batch level and not FIFO**, computed as

```
NewAvgPrice = ROUND( ( StockBefore × AvgPriceBefore + QtyIn × UnitCostIn ) / ( StockBefore + QtyIn ), 5 )
```

This was validated against the live database: for the 10,173 purchase lines posted in 2026 with `UpdateAvgPriceWithNetRate = 'Y'`, the stored `PurDetail.NewAvgPrice` matches this formula **100.0 %** of the time (exact to 5 decimal places).

**Verified.** The engine ships a **complete batch/expiry subsystem** (batch priority, FEFO/FIFO/LIFO re-prioritisation, batch locking, batch pricing, expiry intimation documents) — and **this deployment does not use it**. 96.1 % of `GodownDetail` rows carry the sentinel batch `'.'`, 99.1 % carry the sentinel expiry `2030-12-12`, `ItemBatches` = 0 rows, `ItemBatchPricing` = 0 rows, `ExpiryIntimation` = 0 rows. **For a retail pharmacy this is the single most serious functional gap in the system.**

**Verified.** **The real posting logic for the four everyday documents — Sale, Purchase, Sale Return, Purchase Return — is NOT in SQL.** It lives in the compiled PowerBuilder client, which drives stock by calling small atomic SQL procedures (`SP_GetItemAvgPrice`, `SP_UpdateItemAvgPrice`, `SP_GetItemStockBatch`, `SP_SaleUpdateItemStockBatch`, `SP_UpdateGodownDetail`, `SP_DeleteItemStockBatch`, `sp_maxutn`). The SQL "post" procedures (`sp_PostAdjLedger`, `sp_PostIssueLedger`, `sp_PostTransferHeader`) only flip a `Posted='Y'` flag. **This is the central risk to the rebuild: roughly half of the inventory rules are only observable indirectly, through their effects on data.**

---

# 2. Where the inventory logic actually lives

## 2.1 The split

| Layer | What it owns | Evidence |
|---|---|---|
| **Compiled PowerBuilder client** (`abuzar.exe` + 122 `.pbd`) | Sale posting, Purchase posting, Sale-Return posting, Purchase-Return posting, batch allocation for those documents, all expiry validation, batch locking enforcement, negative-margin checks, the daily `SP_StockReport` invocation | **Verified by absence**: no SQL object calls `SP_SaleUpdateItemStockBatch` for the interactive sale path (only automation procs: `sp_GenerateSale_From_SaleOrder`, `sp_GenerateAutoSale`, `sp_Generate_Sale_From_PendingQuotations`, `sp_GenerateIssue`, `sp_PostStockAdjustment`, `sp_PostItemConversion`, `sp_SatisfyDueInBulk`, `sp_PostInstallment`, `sp_Translate_ChildeServer_Sale`, `sp_AutoIssueConsumableItem`, `sp_GenerateMarkedSaleFromTemplate`, `sp_GenerateSale_From_PreSales`) — **none of these has any rows at this deployment.** |
| **SQL Server stored procedures** | Stock adjustment posting, item conversion, production issue/receipt, inter-godown transfer migration, opening-stock reconstruction, stock-ledger rebuild, daily snapshot, all repair/verification, all reporting | Read directly from `db_modules_full.sql` |
| **SQL Server schema** | Concurrency (`PK_GodownDetail` clustered on `GCode, ICode, Batch, Expiry`), precision (`numeric(15,4)` qty / `numeric(15,5)` cost), row-level optimistic locking pattern | `sys.indexes`, `INFORMATION_SCHEMA.COLUMNS` |
| **Triggers** | Only timestamp maintenance. **No stock logic in any trigger.** | `Trig_GodownDetail_AfterUpdate_LastUpdated` (line 64679), `Trig_Item_AfterUpdate_UpdateLastUpdate_TimeStamp` (line 64698) — both only set a `LastUpdated`/`LastUpdate` column |

**Verified.** There are **10 triggers in the entire database** and **not one** performs an inventory calculation.
`Evidence: db_modules_full.sql lines 64660–64920 — the only two touching inventory tables set timestamps only.`

## 2.2 The atomic stock-mutation primitives

These six procedures are the complete write surface for `GodownDetail`. Every stock movement in the system, from any module, ultimately goes through one of them.

| Procedure | Line | Signature | Semantics |
|---|---|---|---|
| `SP_UpdateGodownDetail` | 56815 | `@GCode, @ICode, @Batch, @Expiry, @QTY` | **Delta.** `SET CurrQty = CurrQty + @qty`. If no row matched → inserts a new batch row with a computed `Priority`. |
| `SP_UpdateItemStockBatch` | 57045 | `@GCode, @ICode, @Batch, @Expiry, @NewQty, @ManfDate` | **Absolute set.** `SET CurrQty = @NewQty`. If no row matched → inserts. |
| `SP_SaleUpdateItemStockBatch` | 48237 | `@GCode, @ICode, @Batch, @Expiry, @NewQty, @OldQty` | **Absolute set with optimistic concurrency.** `WHERE … AND CurrQty = @OldQty`. Raises *"Not enough stock available"* if 0 rows affected. **This is the system's only concurrency control on stock.** |
| `SP_DeleteItemStockBatch` | 22940 | `@GCode, @ICode, @Batch, @Expiry, @OldQty` | Deletes the batch row (used when a batch is drawn to exactly zero), also optimistic (`AND CurrQty = @OldQty`). |
| `SP_InsertItemStock` | 37708 | `@GCode, @ICode, @Batch, @Expiry, @QTY` | Inserts a batch row **with no `CurrQty`** (relies on the column default). Used to pre-create a batch. |
| `SP_LockBatch` | 38846 | `… @LockBatch, @LockReasonCode` | Sets `GodownDetail.Locked` / `LockReasonCode`. |

**Verified — the optimistic-lock pattern.** `SP_SaleUpdateItemStockBatch` is the only guard against lost updates:

```sql
Update GodownDetail Set CurrQty = @NewQty
Where GCode=@GCode and ICode=@ICode and Batch=@Batch and Expiry=@Expiry
  and GodownDetail.CurrQty = @OldQty
IF @@RowCount = 0 OR @@Error <> 0
   RAISERROR('Not enough stock available for the item (%s) …')
```
`Evidence: db_modules_full.sql:48237 (SP_SaleUpdateItemStockBatch)`

**Broken/Incomplete.** `SP_UpdateGodownDetail` and `SP_UpdateItemStockBatch` have **no** optimistic check — two concurrent callers can silently overwrite each other. See §17 and §25.

---

# 3. Which table is the truth? — GodownDetail vs Item vs StockReport vs StockLedger

## 3.1 Verdict table

| Candidate | Rows (live) | Role | Authoritative? | Evidence |
|---|---|---|---|---|
| **`GodownDetail`** | **6,164** | Live batch-level balance | **YES — sole source of truth** | Every stock read proc selects `SUM(GodownDetail.CurrQty)`: `SP_GetItemStockAll` (31499), `SP_GetItemStockTotal` (31584), `SP_GetItemStockBatch` (31518), `SP_GetItemStockInAllowedGodown` (31554), `SP_GetItemStock_For_ConsideredGodowns` (31479), `Fn_GetItemStockInGodowns` (578), `VIEW_WaseelaMini_StockSummary` (65962) |
| `Item.TotalPieces` | 30,050 items, **all = 0** | Intended denormalised "pieces in hand" cache | **NO — dead** | `SP_GetItemTotalPiecesInHand` (31600) reads it; `SP_UpdateItemTotalPiecesInHand` (57216) maintains it. Live query: `SUM(CASE WHEN TotalPieces<>0 …) = 0` |
| `Item.TransitStock` | 30,050 items, **all = 0** | Goods on order but not received | **NO — disabled** | `SP_UpdateTransitStock` (57551) is gated on preference `AutoUpdateTransitStock`, which is `'N'` at this deployment |
| **`StockReport`** | **3,215,967** | **Daily point-in-time snapshot** | **NO — derived, read-only history** | See §20 |
| **`StockLedger`** | **0** | Rebuild scratchpad for the movement ledger | **NO — transient** | See §21 |
| `ItemBatches` | **0** | Batch cost register | **NO — not used here** | See §10.4 |

## 3.2 `GodownDetail` — full definition

**Verified.**

| # | Column | Type | Null | Default | Meaning |
|---|---|---|---|---|---|
| 1 | `GCode` | `smallint` | NO | | Godown (warehouse). PK part 1. |
| 2 | `ICode` | `int` | NO | | Item. PK part 2. FK `GDICodeFK → Item`. |
| 3 | `CurrQty` | `numeric(15,4)` | NO | | **The stock balance, in loose units (not packs).** |
| 4 | `Batch` | `varchar(100)` | NO | | PK part 3. Sentinel `'.'` when unknown. |
| 5 | `Expiry` | `datetime` | NO | | PK part 4. Sentinel `2030-12-12` when unknown. |
| 6 | `Priority` | `tinyint` | NO | `(10)` | Batch consumption rank — **lower is consumed first**. |
| 7 | `ManfDate` | `datetime` | YES | | Manufacture date (optional). |
| 8 | `Locked` | `char(1)` | NO | `('N')` | Quarantine flag. |
| 9 | `LockReasonCode` | `smallint` | NO | `(1)` | FK-ish to `LockReason` (1 = GENERAL — the only row). |
| 10 | `LastUpdated` | `datetime` | NO | `getdate()` | Maintained by `Trig_GodownDetail_AfterUpdate_LastUpdated`. |

Indexes (**Verified** via `sys.indexes`):

| Index | Type | Unique | Columns |
|---|---|---|---|
| `PK_GodownDetail` | CLUSTERED | Yes | `GCode, ICode, Batch, Expiry` |
| `I_GDITS` | NONCLUSTERED | No | `GCode, ICode` |

**Verified. There are ZERO `CHECK` constraints on `GodownDetail`, `Item`, `PurDetail`, `SaleDetail`, `AdjDetail`, `SRDetail`, `PRDetail`, `StockReport` or `ItemBatches`.**
`Evidence: SELECT … FROM sys.check_constraints c JOIN sys.tables t … WHERE t.name IN (…) → 0 rows.`
Consequence: negative stock, negative cost, and zero-quantity orphan rows are prevented **only** by procedural code.

## 3.3 Live shape of `GodownDetail` (2026-08-01)

**Verified.**

| Measure | Value |
|---|---|
| Rows | 6,164 |
| Distinct items with stock | 6,012 (of 30,050 masters = 20 %) |
| Distinct godowns | **1** |
| Distinct batch values | 62 |
| Rows with `CurrQty < 0` | **0** |
| Rows with `CurrQty = 0` | **0** |
| Rows with fractional `CurrQty` | **0** |
| Total units on hand | 214,737 |
| Min / Max `CurrQty` | 1 / 18,816 |
| `Priority` values present | **`10` only (all 6,164 rows)** |
| `Locked = 'Y'` | 104 rows (1,556 units, PKR 83,661 at cost) |

Items by number of batch rows: 5,862 items have exactly 1 row, 148 have 2, 2 have 3. **Batch-level granularity is effectively absent.**

---

# 4. Stock movement rules — the complete catalogue

## 4.1 Document types and sign convention

**Verified.** The canonical list is the `SP_STOCKLEDGER` rebuild procedure, which enumerates every document class that touches stock.
`Evidence: db_modules_full.sql:49058 (SP_STOCKLEDGER) — nine INSERT blocks, one per document type.`

| Code | Document | Header / Detail | Direction | Qty formula written to the ledger | Rows at this deployment |
|---|---|---|---|---|---|
| `PV` | Purchase | `PurLedger` / `PurDetail` | **+** | `PurCatCode IN (1,2)` → `PackQty × PackUnits`; else `LooseQty`. Bonus: `PurCatCode IN (1,2)` → `BonusQty × PackUnits`; else `BonusQty` | 113,082 detail rows |
| `PR` | Purchase Return | `PRLedger` / `PRDetail` | **−** | `LooseQty + PackQty × PackUnits`; bonus `BonusQty` (**never × PackUnits**) | 2,481 |
| `SV` | Sale | `SaleLedger` / `SaleDetail` | **−** (only when `Due IS NULL`) | `LooseQty + PackQty × PackUnits`; bonus `BonusQty` | 620,525 |
| `SR` | Sale Return | `SRLedger` / `SRDetail` | **+** | `LooseQty + PackQty × PackUnits`; bonus `BonusQty` | 44,563 |
| `RV` | Receipt (production output / goods receipt) | `ReceiptHeader` / `ReceiptDetail` | **+** | `Qty` | **0** |
| `IV` | Issue (consumption to department/production) | `IssueHeader` / `IssueDetail` | **−** | `Qty` | **0** |
| `AI` | Adjustment Increase (`AdjCatCode = 1`) | `AdjHeader` / `AdjDetail` | **+** | `LooseQty` | 4,381 posted detail rows |
| `AD` | Adjustment Decrease (`AdjCatCode = 2`) | `AdjHeader` / `AdjDetail` | **−** | `LooseQty` | 7,274 posted detail rows |
| `DS` | Due Satisfy (deliver a previously-owed sale line) | `DueSatisfyHeader` / `DueSatisfyDetail` | **−** | `DueSatisfyQty` | **0** |
| *(no code)* | Inter-Godown Transfer | `THeader` / `TDetail` | **− source / + destination** | `Qty` | **0** |

**Verified — asymmetry in bonus handling is real, not a transcription artefact.** In `SP_STOCKLEDGER` the purchase block multiplies bonus by `PackUnits` for pack purchases:

```sql
bonus = isnull(case pl.purcatcode
        when 1 THEN bonusqty * packunits
        when 2 THEN bonusqty * packunits
        else bonusqty end, 0)
```
but the purchase-**return** block does not:
```sql
qty = pd.looseqty + pd.packqty * pd.packunits,
bonus = pd.bonusqty,
```
`Evidence: db_modules_full.sql:49058 SP_STOCKLEDGER, purchase block vs purchase-return block.`

**Risk (High):** a bonus quantity received as packs and returned as packs will be **under-reversed by a factor of `PackUnits`**. At this deployment only 807 purchase lines carry a non-zero bonus, so exposure is small, but the rule is defective and must not be carried forward.

## 4.2 Purchase categories

**Verified** (live `PurCategory`):

| `PurCatCode` | Name | Qty semantics | Invoices at this deployment |
|---|---|---|---|
| 1 | Normal Purchase Cash | pack-based (`× PackUnits`) | 0 |
| **2** | **Normal Purchase Credit** | pack-based (`× PackUnits`) | **6,396 (99.6 %)** |
| 3 | Opening Purchase | loose-based | 1 |
| 4 | Normal Purchase Return Cash | — | 0 |
| 5 | Normal Purchase Return Credit | — | 0 |
| 6 | Opening Purchase Return | — | 0 |
| 7 | Loose Purchase Cash | loose-based | 0 |
| 8 | Loose Purchase Credit | loose-based | 22 |

**Verified.** Adjustment categories are exactly two: `1 = STOCK ADJUSTMENT-INCREASE`, `2 = STOCK ADJUSTMENT-DECREASE`. There is **no** reason/cause dimension on `AdjHeader` (only a free-text `Remarks`). See §15.

## 4.3 The universal balance identity

**Verified.** The system's own definition of "stock should be" is embedded in `sp_AutoStockVerification` (line 8830) and `SP_RepairBatchWiseCorruptedStock` (line 46516). Restated:

```
SUM(GodownDetail.CurrQty) for an item
  =  Σ Purchase(PackQty×PackUnits + BonusQty×PackUnits)   [PurCatCode 1,2, Posted='Y']
   + Σ Purchase(LooseQty + BonusQty)                      [PurCatCode 3,7,8, Posted='Y']
   − Σ PurchaseReturn(LooseQty + BonusQty)                [no Posted filter!]
   − Σ Sale(LooseQty + BonusQty)   where Due IS NULL      [no Posted filter!]
   + Σ SaleReturn(LooseQty + BonusQty)                    [no Posted filter!]
   − Σ Issue(Qty)
   + Σ Receipt(Qty)                                       [Posted='Y']
   + Σ AdjIncrease(LooseQty)                              [Posted='Y', AdjCatCode=1]
   − Σ AdjDecrease(LooseQty)                              [Posted='Y', AdjCatCode=2]
   − Σ DueSatisfy(DueSatisfyQty)
   (+ transfers in − transfers out, per godown, in SP_RepairBatchWiseCorruptedStock only)
```

**Verified — live reconciliation result.** Executing this identity against the production database on 2026-08-01 returns **0 mismatched items**. Stock is currently internally consistent.
`Evidence: live query replicating sp_AutoStockVerification's HAVING clause → Mismatched = 0.`

**Note the asymmetric `Posted` filters (Broken/Incomplete).** Purchases, receipts and adjustments are counted only when `Posted='Y'`, but sales, sale-returns and purchase-returns are counted **regardless of posting status**. This is internally consistent *only because* the client decrements `GodownDetail` at **save** time for sales, not at post time — but it means the verification procedure would report false mismatches on any deployment where sales are saved-then-posted with a delay.

---

# 5. Quantity calculations — formulas

## 5.1 The pack/loose model

**Verified.** `Item.PackUnits smallint NOT NULL` is the number of loose units in one pack. All balances are stored in **loose units**.

Live distribution of `PackUnits` (top 10 of 30,050 items):

| PackUnits | Items | Interpretation |
|---|---|---|
| 1 | 14,673 | Sold as a single unit (bottle, tube, device) |
| 10 | 4,094 | Strip of 10 |
| 20 | 2,539 | 2×10 blister |
| 30 | 2,415 | 3×10 blister |
| 14 | 2,343 | 2×7 blister |
| 100 | 733 | Bulk |
| 5, 12, 50, 28 | 636 / 597 / 290 / 285 | |

**Verified — the defensive divisor idiom appears everywhere:**
```sql
CASE WHEN PackUnits <= 0 THEN 1 ELSE PackUnits END      -- SP_Add_ItemBatches_From_Purchase (4463)
Case When @packunits Is Null Then 1 When @packunits = 0 Then 1 Else @packunits End   -- sp_PostStockAdjustment (44607)
CASE i.packunits WHEN 0 THEN 1 ELSE i.packunits END     -- udf_openingstock (64439)
```

## 5.2 Price-basis conventions (critical, easy to get wrong)

**Verified by live sampling** of `SaleDetail` and by the report procedures:

| Column | Basis | Evidence |
|---|---|---|
| `Item.SalePrice`, `Item.PurPrice`, `Item.RecentPurPrice` | **Per pack** | `SP_GodownWiseStockInHand` (32937): `Value1 = Round(I.SalePrice / I.PackUnits, 2)` |
| `Item.AvgPrice` | **Per loose unit** | Same proc: `WHEN 3 THEN Round(I.AvgPrice, 2)` — no division |
| `SaleDetail.SalePrice`, `SaleDetail.Rate` | **Per loose unit** | Live sample: ICode 23953, PackUnits 14, `SalePrice = 29.93`, `PackPrice = 419.00` (= 29.93 × 14) |
| `SaleDetail.PackPrice` | **Per pack** | same |
| `PurDetail.PurPrice`, `PurDetail.NetRate` | **Per pack** | `SP_Add_ItemBatches_From_Purchase`: `CostPrice = Round(NetRate / PackUnits, 5)` |
| `PurDetail.AvgPrice`, `NewAvgPrice` | **Per loose unit** | Formula validation §8.3 |

**Risk (Critical for migration):** mixing these bases silently produces valuation errors of exactly `PackUnits×`. Three live items already exhibit precisely this corruption — see §25.2.

## 5.3 Quantity aggregation formulas by module

**Verified.** Consolidated from `SP_STOCKLEDGER` (49058), `sp_ItemOpeningStock` (38378), `sp_GodownItemOpeningStock` (32811), `udf_openingstock` (64439), `udf_GodownOpeningStock` (64305), `SP_ItemStockMovementAtAvgPrice` (38515).

| Movement | Quantity expression | Value expression (for valuation reports) |
|---|---|---|
| Purchase (`PurCatCode` 1,2) | `(PackQty + BonusQty) × PackUnits` | `(PackQty + LooseQty + BonusQty) × NetRate` |
| Purchase (`PurCatCode` 3,7,8) | `LooseQty + BonusQty` | as above |
| Purchase Return | `LooseQty + BonusQty + PackQty × PackUnits` | `(LooseQty + BonusQty) × PRDetail.AvgPrice` |
| Sale (`Due IS NULL`) | `LooseQty + BonusQty` | `(LooseQty + BonusQty) × SaleDetail.AvgPrice` |
| Sale Return, referencing a sale | `LooseQty + BonusQty` | `(LooseQty + BonusQty) × SRDetail.AvgPrice` |
| Sale Return, **free-standing** (`saleinvcode ≤ 0`) | `LooseQty + BonusQty` | `qty × SRPrice × (1 − DiscPerc/100) × (1 − InvDiscPerc/100)` |
| Issue | `Qty` | `Qty × IssueDetail.AvgPrice` |
| Receipt | `Qty` | `Qty × ReceiptDetail.AvgPrice` |
| Adjustment ± | `LooseQty` | `LooseQty × AdjDetail.AvgPrice` |
| Due Satisfy | `DueSatisfyQty` | `DueSatisfyQty × AvgPrice` |
| Transfer | `TDetail.Qty` | (not valued — internal move) |

**Note the free-standing sale-return exception (Verified):**
```sql
value = sum((sd.looseqty + sd.bonusqty) *
  CASE WHEN sl.saleinvcode > 0 THEN sd.AvgPrice
       ELSE sd.srprice * (1 - sd.discperc*0.01) * (1 - sl.discperc*0.01) END)
```
`Evidence: db_modules_full.sql:38515 SP_ItemStockMovementAtAvgPrice, 'SR' block.`
A return not linked to an original invoice is valued at its **selling** price, not at cost. This inflates the credited inventory value on any customer-goodwill return. **Requires accountant validation.**

---

# 6. Warehouse / godown behaviour

## 6.1 This deployment

**Verified.** `Godown` has exactly **one** row:

| GCode | Name | Location | GodownGroupCode | AutoSatisfyDue | ConsiderStockInPO | LocalGodownName |
|---|---|---|---|---|---|---|
| 1 | ` GODOWN1` | (blank) | 1 | `N` | `Y` | ` GODOWN1` |

Preference `Multigodown = 'N'`.
`Evidence: SELECT * FROM Godown → 1 row; SELECT PrefValue FROM SoftwarePreferences WHERE Name='Multigodown' → 'N'.`

## 6.2 The multi-godown machinery that exists but is inert

**Verified.** The product implements per-user-group godown scoping:

| Object | Line | Behaviour |
|---|---|---|
| `fn_GetGodown(@GroupCode,@Module)` | 337 | `SELECT TOP 1 GCode FROM GroupAllowedGodown WHERE GroupCode=… AND Module=… ORDER BY Priority, GCode` — the default godown for a user group in a module |
| `fn_GetAvailableGodown(@GroupCode,@Module)` | 62093 | Table-valued: the ordered list of allowed godowns |
| `SP_GetItemStockInAllowedGodown(@ICode,@GroupCode,@Strategy,@Module,@QTY OUT)` | 31554 | `@Strategy = 2` → **all** godowns; otherwise only godowns in `GroupAllowedGodown` |
| `SP_GetItemStock_For_ConsideredGodowns` | 31479 | Sums only godowns with `Godown.ConsiderStockINPO='Y'` — used for purchase-order suggestion |
| `Fn_GetItemStockInGodowns(@icode,@sgcode,@lgcode)` | 578 | Range-based sum |

`GroupAllowedGodown` live content: 33 rows, mapping user groups {2, 5, 11, 12} × modules {1..8, 15} → **godown 1**, all with `Priority = 10`.

Module numbers referenced in code: `8 = Transfer` (`sp_PostTransferHeader`), `Adjustment` and `Issue` resolved by name from the `Module` table.

**Verified.** Godown-selection preferences at this deployment:

| Preference | Value | Meaning (from proc usage / naming) |
|---|---|---|
| `SaleGodownOption` | `1` | *(consumed by the client only — no SQL reference)* |
| `PurchaseGodownOption` | `2` | *(client only)* |
| `TransferGodownOption` | `3` | *(client only)* |
| `restrictsalefromsinglegodown` | `N` | (client only) |
| `autoselectlastgodowninsale` | `N` | (client only) |
| `autoselectlastrowgodowninpur` | `Y` | (client only) |

**Unclear.** The precise meaning of the `1/2/3` godown-option codes is not derivable from SQL; the strings appear nowhere in `db_modules_full.sql`. Since `Multigodown='N'` and only one godown exists, this is not material to the rebuild — but it must be recorded as unresolved.

---

# 7. Batch selection order (allocation) — the FEFO rule

## 7.1 The universal ordering

**Verified.** Every outbound batch-consumption cursor in the entire database uses the identical ordering:

```sql
Select batch, expiry, Currqty
From   godowndetail
Where  godowndetail.gcode = @gcode and godowndetail.icode = @icode
Order by priority, expiry, Currqty
```

Occurrences (all **Verified**, `db_modules_full.sql` line numbers): 25799, 25868, 27354, 27629, 27862, 29452, 41713, 42059, 44819, 48362, 53217, 54473, 55007. One variant adds a leading `gcode` (line 28115, `sp_GenerateMarkedSaleFromTemplate`).

**Allocation rule (Verified):**
1. Lowest `Priority` first (a `tinyint`, 0–255)
2. then **earliest `Expiry`** (First-Expired-First-Out)
3. then **smallest `CurrQty`** (deliberately drains small remainders first, minimising orphan fragments)

Consumption loop (**Verified**, `sp_PostStockAdjustment` 44607, identical in `sp_GenerateIssue` 27470 and `sp_PostItemConversion` 41829):
```sql
Set @batchqty = @currqty
IF @batchqty >= @ReqQty Set @delqty = @reqqty ELSE Set @delqty = @batchqty
Set @reqqty = @reqqty - @delqty
…
Set @newqty = @currqty - @delqty
IF @newqty > 0  Execute sp_SaleUpdateItemStockBatch @gcode,@icode,@batch,@expiry,@newqty,@currqty
ELSE            Execute sp_DeleteItemStockBatch     @gcode,@icode,@batch,@expiry,@delqty
```
→ **A batch row drawn to exactly zero is DELETED, not left at zero.** This is confirmed empirically: `GodownDetail` has 0 rows with `CurrQty = 0`.

## 7.2 `Locked` is not honoured by any SQL allocation

**Verified — Broken/Incomplete.** `GodownDetail.Locked` appears in exactly **two** functional places in the entire SQL corpus: `SP_LockBatch` (which sets it, line 38846) and the CRS replication procedures (which copy it, lines 15451/16231). **No `SELECT … FROM GodownDetail` used for allocation filters on `Locked`.**
`Evidence: grep -i "locked" db_modules_full.sql → 8 hits, none in an allocation WHERE clause.`

At this deployment 104 batch rows (1,556 units, PKR 83,661 at cost) are `Locked='Y'`. If any SQL-side automation path (adjustment decrease, issue, conversion, transfer) were used, **it would consume locked stock silently.** Enforcement exists only in the compiled client.

## 7.3 The `InventoryMovementMethod` preference

**Verified.** Three modes, defined identically in `SP_UpdateGodownDetail` (56815), `SP_InsertItemStock` (37708), `SP_UpdateItemStockBatch` (57045), and implemented globally by `SP_RePrioritizeStockBatches` (46755) / `SP_GroupWise_RePrioritizeStockBatches` (33102):

| `@Method` | Name in code | New-batch priority assignment | Global re-prioritisation |
|---|---|---|---|
| **1** | *Equal Priority / Shortest expiry First* | `Priority = 10` for every new batch | `UPDATE GodownDetail SET Priority = 10` (everything equal → the `expiry` tiebreak in the cursor makes this pure **FEFO**) |
| 2 | *FIFO* | `Priority = MAX(Priority for the item) + 1` (clamped at 255, with a global shift-down when saturated) | Default 9; then walk each item's batches ordered by earliest `MIN(InDate)` and assign `Priority` 1,2,3… capped at 8 |
| 3 | *LIFO* | `Priority = MIN(Priority for the item) − 1` (clamped at 0, global shift-up when saturated) | Default 30; then walk each item's batches ordered by latest `MAX(InDate) DESC` and assign 11,12,13… capped at 29 |

`InDate` in modes 2/3 is derived from a `UNION ALL` over **`PurLedger.PostDate`, `SRLedger.PostDate`, `ReceiptHeader.PostDate`, and `AdjHeader.Date` (AdjCatCode=1)** — i.e. every inbound document class.

**Verified — this deployment runs Method 1 (FEFO).**
`Evidence: SoftwarePreferences.inventorymovementmethod = '1'; live GodownDetail shows Priority = 10 on all 6,164 rows with zero variance.`

**Broken/Incomplete — priority saturation.** In FIFO mode, the priority band is only 1–8 (8 distinct positions). An item with more than 8 live batches has its 9th and later batches **all clamped to 8**, after which the `expiry` tiebreak silently takes over. FIFO therefore degrades into FEFO beyond 8 batches. Same defect in LIFO (band 11–29, 19 positions).
`Evidence: SP_RePrioritizeStockBatches: "IF @Priority > 8 SET @Priority = 8" / "IF @Priority > 29 SET @Priority = 29".`

---

# 8. **Costing method — DEFINITIVE**

## 8.1 Verdict

**Verified. The costing method is PERPETUAL MOVING WEIGHTED AVERAGE, maintained at ITEM level (`Item.AvgPrice`), recomputed on every inbound movement. It is NOT FIFO. It is NOT LIFO. It is NOT batch-specific.**

Supporting facts:

1. `Item.AvgPrice numeric(15,5) NOT NULL` is the single cost carrier. `SP_GetItemAvgPrice` (31381) reads it **`WITH (UPDLOCK HOLDLOCK)`** — i.e. it is treated as a serialisable resource during posting. `SP_UpdateItemAvgPrice` (56913) is a one-line `UPDATE Item SET AvgPrice = @AvgPrice`.
2. Every outbound document stamps the *then-current* `Item.AvgPrice` onto its own detail row (`SaleDetail.AvgPrice`, `SRDetail.AvgPrice`, `PRDetail.AvgPrice`, `AdjDetail.AvgPrice`, `IssueDetail.AvgPrice`) — the historical COGS record.
3. The batch-cost facility (`ItemBatches.CostPrice`, `SP_Get_ItemBatch_CostPrice`) exists but is **not populated at this deployment** (0 rows) and the preference `maintainbatchwiseitemcostonposting = 'N'`.

## 8.2 The formula, quoted verbatim

**Verified.** The identical expression appears in five procedures:

```sql
SET @NewAvgPrice = ISNULL((SELECT
      ROUND( ((@TotStock * @hold_avgprice) + (@givenqty * @price))
             / (@givenqty + @TotStock), 5) ), 0)
```

| Occurrence | Procedure | Line |
|---|---|---|
| 1 | `sp_GenerateReceipt` | 28821 |
| 2 | `sp_GenerateReceipt_On_ProdunctionNote` (uses `@NetRate` in place of `@price`) | 29030 |
| 3 | `sp_PostItemConversion` | 41934 |
| 4 | `sp_PostReceipt_From_Production` | 42789 |
| 5 | `sp_PostStockAdjustment` | 44703 |

with, in every case:
- `@hold_avgprice` ← `EXEC sp_GetItemAvgPrice @icode, @hold_avgprice OUTPUT` (i.e. `Item.AvgPrice`)
- `@TotStock` ← `EXEC sp_GetItemStockAll @ICode, @TotStock OUTPUT` (i.e. `SUM(GodownDetail.CurrQty)` **across all godowns**)
- `@givenqty` = the incoming quantity in **loose units**
- `@price` = the incoming **unit** cost

A second, equivalent expression appears in the data-migration path:
```sql
NewAvgPrice = ((@AvgPrice * @Stock) + (@ItemCost))
              / CASE @Qty + @Stock WHEN 0 THEN 1 ELSE (@Qty + @Stock) END
```
`Evidence: db_modules_full.sql:53631 (SP_TransferPurchaseInvoices).`

## 8.3 Empirical validation against 113,561 live purchase lines

**Verified.** I reconstructed the formula in T-SQL and compared it to the stored `PurDetail.NewAvgPrice`:

```
Predicted = ROUND( ( CurrStock × AvgPrice
                   + QtyIn × ROUND(NetRate / PackUnits, 5) )
                 / ( CurrStock + QtyIn ), 5 )
   where QtyIn = (PackQty + BonusQty) × PackUnits   for PurCatCode 1,2
```

| Segment | Lines | Exact matches (≤ 0.00002) | Match rate |
|---|---|---|---|
| 2026, `PurLedger.UpdateAvgPriceWithNetRate = 'Y'` | 10,173 | 10,173 | **100.00 %** |
| 2026, flag = `'N'` | 24,099 | 20,989 | 87.1 % |
| 2025, flag = `'N'` | 72,798 | 63,715 | 87.5 % |
| **All posted purchase lines** | **113,561** | **94,927** | **83.6 %** |

The 100 % match on the flag-`'Y'` population is decisive: **the formula and the rounding are exactly right.**

**Verified — why the flag-`'N'` rows differ.** Sampling shows the cost basis for `'N'` rows is the **gross purchase price**, not the stored `NetRate`:

| PurInvCode | ICode | PackQty | PackUnits | NetRate | PurPrice | CurrStock | AvgPrice | **NewAvgPrice** |
|---|---|---|---|---|---|---|---|---|
| 5672 | 25482 | 3 | 1 | 331.49 | **280.93** | **0** | 765.00 | **280.93** |
| 5669 | 25511 | 1 | 1 | 1528.20 | **1269.18** | **0** | 1269.18 | **1269.18** |

With `CurrStock = 0`, the weighted average collapses to the incoming unit cost — and the result equals `PurPrice`, **not** `NetRate`. On rows where the client recomputes the net rate internally (e.g. ICode 312: `NetRate = 348.46870`, `NewAvgPrice = 348.46842`) the residual is ≤ 0.0003, i.e. a recomputation-precision difference, not a different formula.

**Conclusion (Verified):**
```
UnitCostIn = ROUND( (UpdateAvgPriceWithNetRate = 'Y' ? NetRate : PurPrice) / PackUnits , 5 )
NewAvgPrice = ROUND( (StockBefore × AvgPriceBefore + QtyIn × UnitCostIn)
                     / (StockBefore + QtyIn), 5 )
Item.AvgPrice ← NewAvgPrice
```

Preference at this deployment: `updateavgpricewithnetrate = 'Y'` (so **`NetRate` is the current basis**), but the per-invoice column `PurLedger.UpdateAvgPriceWithNetRate` overrides it and historically has been `'N'` for the majority of invoices.

**Risk (High):** the cost basis has changed mid-history. Any period-over-period margin comparison spanning the switch is not comparable.

## 8.4 Which documents move the average — the preference matrix

**Verified** from live `SoftwarePreferences`:

| Document | Preference | Value here | Effect |
|---|---|---|---|
| **Purchase** | *(implicit — always)* | — | **Recomputes** the weighted average |
| Purchase Return | `pr_updateavgprice` | **`N`** | Does **not** touch `Item.AvgPrice`; the return is valued at the current average (`PRDetail.AvgPrice`) |
| **Sale** | *(never)* | — | Stamps `SaleDetail.AvgPrice` = current `Item.AvgPrice`. Never changes it. |
| Sale Return | `updateavgpriceinsr` | **`N`** | Does **not** recompute. `SRDetail.NewAvgPrice` = `SRDetail.AvgPrice` on 43,225 of 44,579 rows (**97.0 %**, live query) |
| **Adjustment Increase** | `UpdAvgPriceInAdjInc` | **`Y`** | **Recomputes.** `sp_PostStockAdjustment` line 44703 |
| Adjustment Decrease | *(never)* | — | `SET @NewAvgPrice = @hold_avgprice` — explicitly unchanged (line 44847) |
| Receipt | `updavgpriceinreceipt` | **`Y`** | Recomputes (`sp_GenerateReceipt` 28821) |
| Item Conversion | `UpdAvgPriceInAdjInc` (reused) | `Y` | Recomputes on the increase leg |
| Transfer | — | — | No cost effect (single-item, intra-company) |

**Verified — the adjustment-increase cost basis is peculiar.** In `sp_PostStockAdjustment`:
```sql
IF @hold_avgprice Is Null Or @hold_avgprice = 0
    Set @price = @purprice / @packunits
Else
    Set @price = Cast( @hold_avgprice As Numeric(8,2) )
```
`Evidence: db_modules_full.sql:44607, ~line 44690.`
So an adjustment **increase** is normally costed **at the item's own existing average, truncated to `numeric(8,2)`**. Consequences:
- The average is essentially unchanged by a stock-increase adjustment (correct behaviour for a *count correction*), **except** for the rounding: `Cast(… As Numeric(8,2))` loses 3 decimal places and **overflows for any average ≥ 1,000,000**.
- If the current average is 0 (new item), it falls back to `PurPrice / PackUnits`.

**Risk (Medium):** `Numeric(8,2)` caps at 999,999.99. Any item with an average cost above that (data-entry error territory — and this database already contains a PKR 25,122 average that should be PKR 26) will cause an **arithmetic overflow error** on adjustment posting.

## 8.5 Historical cost — `ItemCostHistory` and `Fn_GetItemCostHistory`

**Verified — Deprecated at this deployment (0 rows).**

`Fn_GetItemCostHistory(@ICode, @Date)` (line 441) returns the average cost effective at a date, using a curious nearest-neighbour rule:

```sql
SELECT AvgPrice FROM ItemCostHistory
WHERE ICode = @ICode AND Date IN
  (SELECT MAX(T.Date) FROM
     ( SELECT MAX(Date) FROM ItemCostHistory WHERE ICode=@ICode AND Date <= @Date
       UNION ALL
       SELECT MIN(Date) FROM ItemCostHistory WHERE ICode=@ICode AND Date >  @Date ) T)
```

It takes the **later** of (last cost on/before the date) and (first cost after the date) — i.e. **when a cost record exists after the requested date, that FUTURE cost wins.** This is not a point-in-time lookup; it is a look-ahead.

`SP_Update_ItemHistoricalCost_In_Sale_And_Return(@DBName)` (line 55846) then **retro-writes** that value over `SaleDetail.AvgPrice` and `SRDetail.AvgPrice` for the entire history, via dynamic SQL against an arbitrary database name:

```sql
SET @Qry = N'UPDATE ' + @DBName + '.DBO.SaleDetail
             SET AvgPrice = ISNULL((SELECT DBO.Fn_GetItemCostHistory(D.ICode, S.Date)), AvgPrice)
             FROM ' + @DBName + '.DBO.SaleLedger S, ' + @DBName + '.DBO.SaleDetail D
             WHERE S.SaleInvCode = D.SaleInvCode '
```

**Risk (Critical if ever run).** This procedure rewrites 620,525 historical COGS values in one statement, with no transaction, no backup, no audit, and a **look-ahead** cost rule. It would restate every historical gross-margin figure. `ItemCostHistory` is empty here, so it has evidently never been used — but the procedure is live and callable.

---

# 9. Inventory valuation

## 9.1 Valuation bases available

**Verified.** `PriceType` (live, 8 rows) defines the selectable valuation/pricing bases; `SP_GodownWiseStockInHand` (32937) accepts `@PriceType` of 1/2/3:

| Code | Name | Column | Basis |
|---|---|---|---|
| 1 | Sale Price 1 | `Item.SalePrice / PackUnits` | Retail |
| 2 | Sale Price 2 | `Item.SalePrice2` | |
| 3 | Sale Price 3 | `Item.SalePrice3` | |
| 4 | Purchase Price | `Item.PurPrice / PackUnits` | Last list price |
| 5 | Recent Purchase Price | `Item.RecentPurPrice / PackUnits` | Most recent invoice price |
| 6 | **Average Price** | `Item.AvgPrice` | **Cost — the accounting basis** |
| 7 | Sale Price 4 | `Item.SalePrice4` | |
| 8 | Sale Price 5 | `Item.SalePrice5` | |

Valuation expression (**Verified**, `SP_GodownWiseStockInHand`):
```sql
Value5 = ISNULL(SUM(GD.CurrQty),0) *
   Case @Pricetype
     WHEN 1 THEN Round(I.SalePrice / I.PackUnits, 2)
     WHEN 2 THEN Round(I.PurPrice  / I.PackUnits, 2)
     WHEN 3 THEN Round(I.AvgPrice, 2) END
```
Note the local `@Pricetype` in this proc is 1=Sale, **2=Purchase**, 3=Average — a *different* mapping from the `PriceType` table. **Unclear** which mapping the client passes; the report proc's own header comment documents `1 Sale/Trade, 2 Purchase, 3 Average`.

## 9.2 Live valuation (2026-08-01)

**Verified.**

| Basis | Value (PKR) |
|---|---|
| Units on hand | 214,737 |
| **At average cost (`Item.AvgPrice`)** | **12,011,533** |
| At retail (`SalePrice / PackUnits`) | 12,352,339 |
| At recent purchase price | 11,693,438 |

**Verified — but PKR 1,798,138 (15.0 %) of the cost figure is provably corrupt.** Excluding three items whose `AvgPrice` is inconsistent with their `SalePrice` by orders of magnitude:

| Basis | Excl. ICode 23363, 27867, 7769 |
|---|---|
| Cost value | **10,222,268** |
| Retail value | 12,338,054 |
| Implied gross margin | **17.2 %** — consistent with the 16.7 % realised margin measured on 2026 sales |

Realised 2026 performance (**Verified**, 196,298 sale lines, `Due IS NULL`):

| | PKR |
|---|---|
| Revenue (`LooseQty × Rate × (1 − DiscPerc)`) | 74,328,611 |
| COGS (`LooseQty × SaleDetail.AvgPrice`) | 61,938,286 |
| **Gross profit** | **12,390,325 (16.7 %)** |

Only **10 of 196,298** 2026 sale lines were sold below stamped cost. Preferences `saleavgpricecheck = 'N'` and `allowsalepricegreaterthanavgprice = 'Y'` mean no block is enforced, but in practice below-cost selling is negligible.

Stock-on-hand margin distribution (**Verified**, at item level):

| Bucket | Items | Units | Cost value (PKR) |
|---|---|---|---|
| 40 %+ markup | 324 | 33,289 | 467,587 |
| 15–40 % | 5,276 | 174,154 | 8,088,196 |
| 5–15 % | 528 | 5,275 | 1,569,831 |
| 0–5 % | 20 | 1,519 | 87,780 |
| **Cost > retail (impossible)** | **16** | **500** | **1,798,138** |

## 9.3 The historical valuation series

**Verified.** `StockReport` provides a restatable daily inventory valuation because it stores both `Stock` and the `AvgPrice` current on that day. Sample (live, `SUM(Stock × AvgPrice)`):

| Date | Cost value (PKR) |
|---|---|
| 2026-07-31 | 11,970,476 |
| 2026-07-22 | 12,184,415 |
| 2026-07-11 | 12,187,674 |
| 2026-07-03 | 12,391,143 |
| 2026-07-01 | 12,245,941 |

This is the **only** historical inventory-value series in the system. It exists for 545 days (2025-01-01 → 2026-07-31) with a 32-day gap. **It is the single most valuable derived asset to preserve during migration.**

---

# 10. Batch & expiry tracking

## 10.1 What the product implements

**Verified.** A full batch subsystem exists:

| Capability | Object | Line | Status here |
|---|---|---|---|
| Batch is part of the stock PK | `PK_GodownDetail (GCode, ICode, Batch, Expiry)` | schema | **Active** (but almost always sentinel values) |
| Batch cost register populated from purchase | `SP_Add_ItemBatches_From_Purchase` → `ItemBatches` | 4463 | **Not used** (0 rows) |
| Per-batch cost lookup | `SP_Get_ItemBatch_CostPrice` → `MAX(ItemBatches.CostPrice)` | 29659 | Dead (source empty) |
| Per-batch sale price | `ItemBatchPricing`; `Update_ItemBatchPrices` (61897), `SP_Update_ItemBatchSalePrice` (55829) | | **Not used** (0 rows); pref `applybatchwisepricing='N'` |
| Batch quarantine / lock | `SP_LockBatch`; `GodownDetail.Locked` | 38846 | 104 rows locked — but never enforced in SQL (§7.2) |
| Batch priority re-computation (FEFO/FIFO/LIFO) | `SP_RePrioritizeStockBatches` (46755), `SP_GroupWise_RePrioritizeStockBatches` (33102) | | Available; FEFO mode active |
| Expiry intimation documents (return-to-supplier workflow) | `ExpiryIntimation` / `ExpiryIntimationDetail`; `sp_ConsolidatedExpiryIntimation` (11526), `sp_ExtractExpiryIntimation` (24018) | | **Not used** (0 rows) |
| Expiry intimation export to Dropbox / DataCarry | `SP_DB_PushExpiryIntimationToDropBox` (22147), `sp_ExpiryIntimationList_From_DropBox` (23965), `sp_ExpiryIntimation_From_DataCarryDB` (23952) | | Not used |

`SP_Add_ItemBatches_From_Purchase` — the batch cost capture, **Verified**:
```sql
INSERT INTO DBO.ItemBatches (Date, ICode, GCode, Batch, Expiry, Qty, PackUnits,
                             CostPrice, PurPrice, SalePrice, AvgPrice, NewAvgPrice, CurrStock)
SELECT Date=GETDATE(), ICode, GCode, Batch, Expiry,
  Qty = CASE WHEN PackQty > 0 THEN (PackQty + BonusQty) * PackUnits ELSE LooseQty + BonusQty END,
  PackUnits,
  CostPrice = Round(NetRate / CASE WHEN PackUnits <= 0 THEN 1 ELSE PackUnits END, 5),
  PurPrice, SalePrice, AvgPrice, NewAvgPrice, CurrStock
FROM PurDetail WHERE PurInvCode = @PurInvCode
```

## 10.2 What is actually happening at Fazal Din PP19

**Verified — the batch/expiry subsystem is effectively switched off.**

| Measure | Live value |
|---|---|
| `GodownDetail` rows with batch `'.'` (the `defaultbatch` sentinel) | **5,924 / 6,164 = 96.1 %** |
| `GodownDetail` rows with expiry `2030-12-12` (the `DefaultExpiry` sentinel) | **6,106 / 6,164 = 99.1 %** |
| `GodownDetail` rows with a **genuine** future expiry | **1** (`2026-10-01`, 3 units) |
| `PurDetail` rows with batch `'.'` | 110,948 / 113,564 = **97.7 %** |
| `PurDetail` rows with expiry `2030-12-12` | 113,452 / 113,564 = **99.9 %** |
| `SaleDetail` rows with batch `'.'` | 609,055 / 620,619 = **98.1 %** |
| Distinct batch strings ever used in stock | 62 — and they are junk: `A`, `01`, `02`, `B`, `1`, `03`, `C`, `2`, `0`, `\`, `asd`, `AA`, `04`, `S` |
| `ItemBatches` | **0 rows** |
| `ItemBatchPricing` | **0 rows** |
| `ExpiryIntimation` / `Detail` | **0 rows** |

Governing preferences (**Verified**, live `SoftwarePreferences`):

| Preference | Value |
|---|---|
| `defaultbatch` | `.` |
| `DefaultExpiry` | `2030-12-12 00:00:00` |
| `purbatch` / `purexpiry` | `Y` / `Y` (prompt on purchase) |
| `saleinvbatch` | `N` |
| `salecheckexpiry` | **`N`** — *no expiry check at point of sale* |
| `applybatchwisepricing` | `N` |
| `maintainbatchwiseitemcostonposting` | `N` |
| `LockBatchOnPurPosting` | `Y` |
| `overwritebatchonpurposting` | `N` |
| `acceptfutureexpirydays` | `90` |
| `saleexpirydays` | `100` |
| `expiry` | `365` |
| `ConfirmExpiry` (per item, `Item.ConfirmExpiry`) | — |

**Verified.** None of `salecheckexpiry`, `saleexpirydays`, `acceptfutureexpirydays`, `ItemCategory.SaleExpiryDays`, `applybatchwisepricing`, `LockBatchOnPurPosting`, or `BatchAllocation_InSale` is referenced **anywhere** in the 762 SQL objects.
`Evidence: grep -c -i "<name>" db_modules_full.sql → 0 for each.`
**All expiry enforcement is client-side only.**

## 10.3 The `2022-12-12` expiry cohort — a sentinel, not real expiry

**Verified — important nuance.** 57 `GodownDetail` rows carry `Expiry = 2022-12-12`, holding 416 units valued at PKR 318,588. These are **not** genuinely expired goods; `2022-12-12` was the **previous** value of the `DefaultExpiry` preference (the pattern `12/12/YYYY` matches the current `2030-12-12` sentinel and the `2012-12-12` sentinel used by `SP_AutoCreatePricePolicy`). They are stock rows created before the sentinel was rolled forward.

Top rows (**Verified**):

| ICode | Item | Batch | Expiry | Qty | AvgPrice | Value |
|---|---|---|---|---|---|---|
| 23363 | MBER TBE G11 | `.` | 2022-12-12 | 7 | 25,122.708 | 175,859 |
| 25323 | TYGACIL 50MG INJ | `.` | 2022-12-12 | 9 | 4,000.00 | 36,000 |
| 26228 | KIDNEX 20ML DROPS | `.` | 2022-12-12 | 37 | 450.00 | 16,650 |
| 20220 | MENOGON INJ | `.` | 2022-12-12 | 9 | 1,120.760 | 10,087 |

Any report that filters `Expiry < GETDATE()` will present these as expired. **They are unaged sentinel rows, and their true expiry is unknown.**

## 10.4 Verdict on batch/expiry

**Verified. A retail pharmacy holding 214,737 units of medicine has NO usable expiry data.** The product supports it; the deployment does not use it. Consequences:
- No expiry alerting is possible from this data.
- Return-to-supplier for short-dated stock cannot be driven from the system.
- The FEFO allocation rule is a no-op: with 99.1 % of rows sharing the identical sentinel expiry and 100 % sharing `Priority = 10`, the effective allocation order collapses to **smallest-remaining-quantity-first**, which is arbitrary from a shelf-life standpoint.
- Regulatory batch traceability (recall handling) is **not achievable** from stored data.

---

# 11. Reservations, due quantities and "available to sell"

## 11.1 The Due mechanism

**Verified.** The system's reservation concept is the **"Due" sale line** — a sold-but-not-delivered line. `SaleDetail.Due char(1) NULL` carries the state.

| Object | Line | Behaviour |
|---|---|---|
| `Fn_GetItemDueQty(@saleinvcode,@icode,@salerowid)` | 467 | `SELECT looseqty … WHERE Due = 'D'` — due qty on one sale line |
| `Fn_GetItemDueQtyOnAllInv(@icode)` | 483 | `SUM(looseqty) … WHERE Due = 'D'` — total outstanding due for an item |
| `Fn_GetItemDueSatisfiedQty(@saleinvcode,@icode,@salerowid)` | 494 | `SUM(duesatisfyqty)` from `DueSatisfyHeader ⋈ DueSatisfyDetail` |
| `SP_GetItemStock_Exc_PendingDue(@GCode,@ICode,@QTY OUT)` | 31457 | Available-to-promise (below) |

**Verified — the available-to-promise formula:**
```sql
@qty = SUM(GodownDetail.CurrQty for GCode,ICode)
     - (  SUM(SaleDetail.LooseQty + BonusQty)  where Due IN ('X','D','S')
        - SUM(DueDeleteDetail.DeletedQty)
        - SUM(DueSatisfyDetail.DueSatisfyQty) )
```
`Evidence: db_modules_full.sql:31457 SP_GetItemStock_Exc_PendingDue.`

Due states observed in code: `'D'` = due/outstanding, `'S'` = satisfied, `'X'` = (a third state; **Unclear** — appears only in this proc's `IN ('X','D','S')` filter and is never set anywhere in SQL).

**Note the subtraction of `DueDeleteDetail.DeletedQty` is NOT godown-scoped** (`WHERE DD.icode=@ICode` only), while the other two terms are. In a multi-godown deployment this would over-credit availability. Irrelevant here (one godown) but a latent bug.

## 11.2 Not used at this deployment

**Verified.**

| Table | Rows |
|---|---|
| `SaleDetail` rows with `Due IS NOT NULL` | **0** of 620,619 |
| `DueSatisfyHeader` / `DueSatisfyDetail` | 0 / 0 |
| `DueDeleteDetail` | 0 |

Preferences: `dueitem = 'Y'`, `allowdueinbasicdata = 'N'`, `ExcPendingDueInCurrStock = 'N'`, `autoduesatisfyonpurpost = 'N'`, `showpendingdueininquirywind = 'N'`.

**Verified. There is NO other reservation, allocation, hold, or soft-commit mechanism in the system.** Sale orders (`SaleOrderHeader/Detail`) exist as tables but hold no rows, and in any case the SQL path `sp_GenerateSale_From_SaleOrder` (29296) *consumes* stock at generation time rather than reserving it. **A cash-and-carry retail pharmacy with a single till has no need for reservations, which is why the feature is dark.**

---

# 12. Transfers (inter-godown)

**Verified — Not used at this deployment.** `THeader` = 0 rows, `TDetail` = 0 rows, `TransferRequisitionHeader/Detail` = 0 rows.

## 12.1 What exists

| Object | Line | Behaviour |
|---|---|---|
| `sp_PostTransferHeader(@sInv,@lInv,@strategy,@groupcode)` | 45261 | **Flag flip only.** `UPDATE THeader SET posted='Y', postdate=GetDate() WHERE TransCode BETWEEN … AND Posted='N' AND SGCode IN (…allowed godowns for module 8…)`. **It moves no stock.** |
| `SP_TransferInterGodownTransfers` | 53062 | The real mover — a **data-migration** procedure that replays legacy transfers, decrementing the source with the standard batch cursor and incrementing the destination via `SP_UpdateGodownDetail` |
| `SP_GetItemReqQtyForTransfer` | 31423 | Suggests transfer quantity |
| `sp_UpdateTransitStock(@mode,@icode,@qty)` | 57551 | Maintains `Item.TransitStock`; gated on `AutoUpdateTransitStock` (= `'N'` here) so it is a no-op |
| `SP_CRS_Push_Transfers` | 16242 | Multi-site replication |

**Verified — the transfer stock movement** (`SP_TransferInterGodownTransfers`, ~line 53207):
```sql
IF @QTY <= @SourceStock
BEGIN
  DECLARE tran3 CURSOR FOR
    SELECT batch, expiry, Currqty FROM godowndetail
    WHERE gcode=@SGCode and icode=@ICode ORDER BY priority, expiry, Currqty
  …
  SET @NewStock = @BatchStock - @TQty
  IF @NewStock > 0  UPDATE GodownDetail SET CurrQty=@NewStock WHERE CURRENT OF tran3
  ELSE IF @NewStock = 0  DELETE GodownDetail WHERE CURRENT OF tran3
  … then SP_UpdateGodownDetail @DGCode, @ICode, @Batch, @Expiry, +@TQty
END
```
Guard: `IF @QTY <= @SourceStock` — a pre-check, then a cursor with **no per-batch guard**. Batch identity is preserved across the move.

Preferences: `allowbatchwisetrasnfer = 'N'` (sic — misspelled in the data), `allowinsufficientstockitemsintransfer = 'N'`, `ShowSourceStockInTransfer = 'Y'`, `ShowTargetStockInTransfer = 'Y'`.

**Verified.** Transfers have **no cost impact** — no `AvgPrice` recomputation appears in the transfer path. Correct for a single-legal-entity move.

---

# 13. Adjustments — the most heavily used inventory function after sale/purchase

## 13.1 The two-stage buffer model

**Verified.** Physical stock-taking is a **buffer → post** workflow:

1. Operator enters counted quantities into `AdjBufferHeader` / `AdjBufferDetail` (`ICode`, `StockInHand`, `StockOnShelf`).
2. `sp_PostStockAdjustment(@adjbuffercode, @usercode, @headerno, @serverdate)` (line 44607) splits the buffer into **two** documents:
   - lines where `StockOnShelf − StockInHand > 0` → one `AdjHeader` with `AdjCatCode = 1` (increase)
   - lines where `StockOnShelf − StockInHand ≤ 0` and `<> 0` → one `AdjHeader` with `AdjCatCode = 2` (decrease)
3. Both are inserted **already posted** (`Posted='Y'`, `PostedDate=@serverdate`) — there is no approval step.
4. The buffer header is stamped `Posted='Y'` with the two generated `AdjIncCode`/`AdjDecCode`.

Idempotency guard (**Verified**):
```sql
Set @rt_code = (Select count(*) From AdjBufferHeader Where AdjBufferCode = @adjbuffercode And Posted = 'Y')
IF @rt_code > 0 Return 0
```

Remarks propagation (**Verified**): `@remarks = convert(varchar(10),@adjbuffercode) + ' , ' + AdjBufferHeader.Remarks`. Live sample confirms remarks look like `"1063 ,  "` — i.e. **the reason field is empty in practice**.

## 13.2 Increase leg

**Verified.**
- All increased quantity is placed into the **default batch** `(@defaultbatch, @defaultexpiry)` — i.e. `('.', 2030-12-12)`. Batch identity is destroyed by a stock count.
- Costing: `@price = @hold_avgprice` cast to `Numeric(8,2)` (or `PurPrice/PackUnits` if the average is 0); `@NewAvgPrice` recomputed by the weighted-average formula because `UpdAvgPriceInAdjInc = 'Y'`.
- `AdjDetail.CurrStock` records `SP_GetItemStockAll` (**all godowns**, not the adjusted godown).

## 13.3 Decrease leg

**Verified.**
- Guard: `IF @totalqty >= @givenqty` where `@totalqty = SUM(currqty) FROM godowndetail WHERE gcode=@gcode AND icode=@icode`. Otherwise: `RaisError('Not enough stock for item (%s) to decrease for Stock Adjusment : %d')`.
- Consumes batches with the standard `ORDER BY priority, expiry, Currqty` cursor.
- Costing: `SET @NewAvgPrice = @hold_avgprice` — **explicitly unchanged**. Value released = `LooseQty × AvgPrice`.

## 13.4 Live usage — this is a large, unexplained shrinkage channel

**Verified.**

| | Documents | Detail rows | Units | Value at cost (PKR) |
|---|---|---|---|---|
| Adjustment **Increase** (`AdjCatCode=1`) | 824 (612 in 2025, 212 in 2026) | 4,381 | 63,495 | **2,540,188** |
| Adjustment **Decrease** (`AdjCatCode=2`) | 718 (547 in 2025, 171 in 2026) | 7,274 | 78,886 | **2,830,682** |
| **Net** | 1,542 | 11,655 | **−15,391 units** | **−290,494** |

Also: `AdjBufferHeader` = 1,061, `AdjBufferDetail` = 12,270.

**Risk (High).** Over ~19 months the pharmacy has written PKR 2.83 M **out** and PKR 2.54 M **in** through stock adjustments, with a **net inventory write-down of PKR 290,494** — and there is **no reason code, no approval workflow, and no differentiated GL treatment**. `AdjCategory` has exactly two rows (increase / decrease). Damage, theft, expiry write-off, counting error and data-entry correction are all indistinguishable in the data.

---

# 14. Returns

## 14.1 Sale Return (customer → us)

**Verified.**

| Aspect | Behaviour | Evidence |
|---|---|---|
| Tables | `SRLedger` / `SRDetail` (44,563 detail rows) | rowcounts |
| Stock effect | **+** `LooseQty + PackQty × PackUnits + BonusQty` | `SP_STOCKLEDGER` 'SR' block |
| Batch destination | The batch/expiry recorded on the `SRDetail` row | `SP_STOCKLEDGER` selects `sd.batch, sd.expiry` |
| Cost effect | **None** — `updateavgpriceinsr = 'N'`; `SRDetail.NewAvgPrice = SRDetail.AvgPrice` on 97.0 % of rows (live) | preference + live query |
| Valuation | at `SRDetail.AvgPrice` if linked to a sale; **at selling price** if free-standing (§5.3) | `SP_ItemStockMovementAtAvgPrice` |
| Preferences | `batchinsr='Y'`, `expiryinsr='Y'`, `allowsamebatchreturnmultipletimes='Y'`, `showpurchasebatchinpr='N'` | live |
| Allocation helper | `SP_AllocateSaleReturn` (6365), `SP_BatchWiseSaleReturn_IssueBased` (8975), `SP_Change_SaleReturn` (9537) | |
| Trigger | `Trig_SrLedger_AfterInsert_UpdateTotalOfSaleReturnsInSaleLedger` (64879) — maintains a running return total on the originating sale | |

**Risk (Medium):** `allowsamebatchreturnmultipletimes = 'Y'` combined with no over-return check in SQL means a customer can return more than was sold on a given line. No SQL constraint prevents it.

## 14.2 Purchase Return (us → supplier)

**Verified.**

| Aspect | Behaviour | Evidence |
|---|---|---|
| Tables | `PRLedger` / `PRDetail` (2,481 detail rows) | rowcounts |
| Stock effect | **−** `LooseQty + PackQty × PackUnits`, bonus `BonusQty` (**not** × `PackUnits`) | `SP_STOCKLEDGER` 'PR' block — see §4.1 defect |
| Cost effect | **None** — `pr_updateavgprice = 'N'` | preference |
| Price floor | `AllowPRBelowAvgPrice = 'Y'` — returns below cost are permitted | preference |
| `PRDetail.AvgPrice` | Snapshot of `Item.AvgPrice` at return time. Live: matches the *current* `Item.AvgPrice` on only 1,093 of 2,481 rows, confirming it is a **historical snapshot**, not a live join | live query |
| Stock-ledger `Posted` filter | The `PR` block in `SP_STOCKLEDGER` filters `pl.posted='Y'`, but `sp_AutoStockVerification` and `SP_RepairBatchWiseCorruptedStock` **do not** | code comparison |

**Risk (Medium):** the inconsistent `Posted` filtering between the rebuild engine and the verification engine means the two disagree about unposted purchase returns.

---

# 15. Damaged & expired goods

**Verified — there is NO dedicated damaged-goods, scrap, write-off, or expiry-disposal document type in this system.**

| Candidate | Verdict |
|---|---|
| `AdjCategory` | Only `1 = INCREASE`, `2 = DECREASE`. No damage/expiry/theft categories. |
| `ExpiryIntimation` / `ExpiryIntimationDetail` | Exists (a *return-to-supplier notification* workflow, not a write-off). **0 rows** here. |
| `ItemAlert` codes | `HOLDED ITEM` (code 5) marks an item as unsellable — but it is an **item-master** flag, not a stock disposition. Only **1 item** carries it. |
| `GodownDetail.Locked` | The only per-batch quarantine. 104 rows locked, reason code 1 = `GENERAL`. `LockReason` has exactly **one** row. Never enforced in SQL. |
| Damaged-goods GL account | None found in the inventory path. |

**Verified — the only mechanism available is Adjustment Decrease (`AdjCatCode = 2`)**, which:
- releases inventory at the item's average cost,
- carries a free-text `Remarks` that in practice contains only the buffer code,
- posts **immediately** with no approval,
- is indistinguishable from a counting correction.

**Expiry intimation workflow (Verified, unused).** `sp_ConsolidatedExpiryIntimation` (11526) merges several intimations into one (grouping by `ICode, Batch, Expiry`, `Qty = SUM`, other attributes `MAX`); `sp_ExtractExpiryIntimation` (24018) splits one out by item group or by supplier (`GroupType='S' AND GroupList='S'` → items from `ItemSuppliers WHERE SuppCode=@AccCode`). Both draw a serial number from `IntimationType.COUNTER` under `WITH (UPDLOCK HOLDLOCK)`. Neither touches stock — they are **paperwork documents only**.

**Risk (Critical for a pharmacy).** Expired-stock destruction is a regulated event. This system provides no auditable expiry write-off path, no destruction certificate, no batch traceability, and no segregation of expired stock from sellable stock. The 104 locked rows are the closest thing to quarantine, and nothing in the database prevents them being sold.

---

# 16. Issues, receipts, production and conversions

**Verified — all zero rows at this deployment.** Documented for completeness because the code paths exist and are reachable.

| Module | Header / Detail | Rows | Posting proc | Stock effect |
|---|---|---|---|---|
| Issue (consumption) | `IssueHeader` / `IssueDetail` | 0 / 0 | `sp_PostIssueLedger` (41808) — **flag flip only**; the mover is `sp_GenerateIssue` (27470) | − `Qty`, batch cursor `priority, expiry, Currqty` |
| Issue Requisition | `IssueReqHeader` | 0 | `sp_PostIssueReq` (41820) — flag flip only | none |
| Receipt (goods in) | `ReceiptHeader` / `ReceiptDetail` | 0 / 0 | `sp_GenerateReceipt` (28672), `sp_PostReceipt_From_Production` (42678) | + `Qty`, **recomputes average** |
| Production | `ProdHeader` / `ProdDetail` / `ProdBuffer` / `ProdNote` | 0 | `sp_PostProduction` (42476), `sp_Finalize_Production` (24362) | Issues components, receipts output |
| Recipe / BOM | `Recipe` | **0** | consumed by `sp_GenerateIssue` — picks the **lowest-`Priority` recipe** per resulted item | |
| Item Conversion | `ItemConversionHeader` / `Detail` / `Effect` | 0 / 0 / **2** | `sp_PostItemConversion` (41829) | Generates a paired Adj-Increase + Adj-Decrease |

**Verified — `ItemConversionEffect` lookup (the only populated part):** `1 = INCREASE`, `2 = DECREASE`. `sp_PostItemConversion` reads `ItemConversionHeader.ItemConversionEffectCode` and swaps which side (header item vs detail items) is increased:
- `@effect = 1` → increase the **header** item, decrease the **detail** items (assembly: many → one)
- `@effect = 2` → increase the **detail** items, decrease the **header** item (breaking a pack: one → many)

It then writes two real `AdjHeader` rows (`AdjCatCode` 1 and 2) so that the conversion appears in the normal adjustment audit trail. **This is the only "bill-of-materials-lite" capability, and it is unused here.**

**Verified — `sp_GenerateIssue` has a genuine negative-stock guard:**
```sql
Set @totalqty = (Select IsNull(Sum(currqty),0) From godowndetail where gcode=@gcode and icode=@icode)
IF @totalqty >= @givenqty
Begin  … consume …  End
Else
Begin
  RaisError( 'Not enough stock for item (%s) to decrease for Issue No. : %d', 16, 1, @itemname, @Code )
  Set @continue = -1
End
```

---

# 17. Negative-stock behaviour — **conclusive**

## 17.1 What guards exist

**Verified.**

| Guard | Location | Strength |
|---|---|---|
| Pre-check `IF @totalqty >= @givenqty` before a consumption cursor | `sp_PostStockAdjustment` (44607), `sp_GenerateIssue` (27470), `sp_PostItemConversion` (41829), `SP_TransferInterGodownTransfers` (53062, as `IF @QTY <= @SourceStock`) | **Effective within a single call, but read-then-write with no lock — racy** |
| Optimistic row check `AND CurrQty = @OldQty` | `SP_SaleUpdateItemStockBatch` (48237), `SP_DeleteItemStockBatch` (22940) | Detects a **concurrent change** to that batch; does **not** check the sign of the new value |
| Explicit sign check | `SP_UpdateItemTotalPiecesInHand` (57216): `IF @IncDec < 0 AND @CurrentTotalPieces < @TotalPieces → RAISERROR('Not Enough pieces available…')` | The **only** true sign guard in the system — and it protects `Item.TotalPieces`, which is **zero for all 30,050 items** |
| `CHECK` constraint | **none** | — |
| Trigger | **none** | — |

## 17.2 The holes

**Verified — Broken/Incomplete.**

**(a) `SP_UpdateGodownDetail` will write a negative balance without error.**
```sql
Update GodownDetail Set CurrQty = CurrQty + @qty Where GCode=… ICode=… Batch=… Expiry=…
Select @rowsaffected = @@RowCount, @err = @@Error
IF @rowsaffected = 0 AND @err = 0    -- row didn't exist → INSERT a new batch
Begin … Insert GodownDetail (…) Values (@GCode,@ICode,@Batch,@Expiry,@Qty,@Priority) … End
ELSE IF @rowsaffected <> 1 OR @err <> 0
Begin … RAISERROR('Not enough stock available for the item …') … End
Return 0
```
`Evidence: db_modules_full.sql:56815.`
If the row exists, `@rowsaffected = 1` and the procedure returns **0 (success)** regardless of the resulting value. Passing `@qty = −100` against a balance of 5 produces `CurrQty = −95` **silently**. The `'Not enough stock available'` message is misleading — it fires only when the update affects a number of rows other than 0 or 1, which the composite PK makes impossible.

Worse: when the row does **not** exist, a negative `@qty` **inserts a new batch row with a negative `CurrQty`**.

**(b) `SP_UpdateItemStockBatch` sets an absolute caller-supplied value with no sign check.**
`Evidence: db_modules_full.sql:57045 — Update GodownDetail Set CurrQty = @NewQty Where …`

**(c) `SP_SaleUpdateItemStockBatch` likewise writes `@NewQty` verbatim.** Its optimistic check only compares the *previous* value.

**(d) The pre-checks are TOCTOU-racy.** `SELECT SUM(currqty)` → decide → cursor → update is not atomic and takes no lock. Two simultaneous decrements each passing the same pre-check will both proceed. The per-batch optimistic check in `SP_SaleUpdateItemStockBatch` catches this **only if both hit the same batch row**.

## 17.3 Empirical state

**Verified.** `SELECT SUM(CASE WHEN CurrQty<0 THEN 1 ELSE 0 END) FROM GodownDetail → 0`. `SELECT SUM(CASE WHEN balancestock<0 THEN 1 ELSE 0 END) FROM SaleDetail → 0`.

**Conclusion (Verified).** *Negative stock is not currently present, and the interactive client evidently enforces sufficiency — but the database layer provides no such guarantee, and three of the four stock-mutation primitives will write a negative balance on request without raising an error.* On a single-till pharmacy the practical exposure is low; on any multi-user rebuild it is a defect that must not be reproduced.

---

# 18. Reorder behaviour

## 18.1 The fields

**Verified.** `Item` carries five reorder-related integers plus a flag:

| Column | Type | Maintained by | Live state (30,050 items) |
|---|---|---|---|
| `MinQty` | `int NOT NULL` | `SP_Update_Item_MinQty` (55760) | **11,894 items > 0** |
| `ReorderQty` | `int NOT NULL` | `SP_Update_Item_ReorderQty` (55806) | **0 items > 0** |
| `OptimumQty` | `int NOT NULL` | `SP_Update_Item_OptimumQty` (55783) | **0 items > 0** |
| `ReorderLevel` | `int NULL` | *(no proc found)* | **0 items > 0** |
| `OptimumLevel` | `int NULL` | *(no proc found)* | not populated |
| `GReorderQty`, `GOptimumQty` | `int NULL` | *(no proc found)* | godown-level variants, unused |
| `GeneratePO` | `char(1) NOT NULL` | — | **`'Y'` for all 30,052 rows** (default, meaningless) |

All three maintenance procedures are trivial single-column updates with an identical shape:
```sql
UPDATE DBO.Item SET MinQty = ISNULL(@Qty, 0) WHERE DBO.Item.ICode = @ICode
Select @rowcount = @@RowCount, @err = @@Error
IF @rowcount <> 1 AND @err <> 0    -- NOTE: AND, not OR
   RAISERROR('Unable to update minimum qty. for item = %s', 16, 1, @itemname)
```
**Broken/Incomplete:** the error test uses `AND` where `OR` is intended — a failed update (`@rowcount = 0`, `@err = 0`) is reported as success. The same defect is present in all three procedures.

## 18.2 What actually computes a reorder suggestion

**Verified.** There is **no** SQL procedure that computes a reorder point, an EOQ, a lead-time buffer, or a min/max replenishment quantity. `SP_Update_Item_*` only *store* values supplied by the caller. The calculation, if any, is in the compiled client.

Related preference: `promptifsourcestockreachesreorderlevel = 'N'`.

## 18.3 `ItemAlert` — the only active "attention" mechanism

**Verified.** `ItemAlertType` (4 rows) × `ItemAlert` (5 rows) provide a per-item behavioural alert at point-of-sale:

| `ItemAlertCode` | Type | Name | Alert text | Items carrying it |
|---|---|---|---|---|
| 1 | 1 SILENT/MUTE | NO ALERT/NO ACTION | | **29,785** |
| 2 | 2 INFORMATION | INFANT ITEM | "…Sales person should educate customer about its usage" | 3 |
| 3 | 2 INFORMATION | SENSITIVE ITEM | "…Must be handled with care and packed accordingly" | **249** |
| 4 | 3 PERMISSION/QUESTION | SHORT ITEM | "…marked as short/emergency. Needs to be sold in controlled quantity. Proceed Y/N?" | 14 |
| 5 | 4 PROHIBITION/VIOLATION | HOLDED ITEM | "…tagged as holded item. It Can not be sold in any case." | **1** |

`BGColor` is a Windows COLORREF integer (16777215 = white, 65280 = green, 65535 = yellow, 255 = red). Enforcement is entirely client-side; no SQL object reads `ItemAlertCode`.

**Verdict (Verified). Reorder management is effectively NON-FUNCTIONAL at this deployment:** `ReorderQty`, `OptimumQty` and `ReorderLevel` are all zero for every one of 30,050 items. Only `MinQty` is populated (11,894 items) and no SQL logic consumes it.

---

# 19. Opening stock

**Verified.** Five objects reconstruct an as-at-date balance by replaying every movement:

| Object | Line | Scope | Includes transfers? | Notes |
|---|---|---|---|---|
| `sp_ItemOpeningStock(@date,@gcode,@icode,@qty OUT)` | 38378 | **All godowns** (every `gcode` filter is commented out) | Computes them but **omits them from the total** | `@l_godownqty = pur + saleret − issue − purret − sale − satisfy + receipt + adj` |
| `sp_GodownItemOpeningStock(…)` | 32811 | Single godown | **Yes** (`+ transferIn − transferOut`) | Otherwise identical |
| `udf_openingstock(@date,@grouping,@list,@pricetype)` | 64439 | All godowns, item-set | No | Table-valued; returns qty **and value** |
| `udf_GodownOpeningStock(@gcode,@date,…)` | 64305 | Single godown, item-set | **Yes** | Table-valued, qty + value |
| `udf_openingstocksingleitem(@date,@icode)` | 1623 | All godowns, one item | No | Also tracks `openingdue` separately |

**Verified — the `@l_gcode` parameter of `sp_ItemOpeningStock` is accepted and then ignored for every movement class except transfers.** Every godown predicate in the procedure is commented out:
```sql
/* purdetail.gcode = @l_gcode and */
/* saledetail.gcode = @l_gcode and */
```
It nonetheless *uses* `@l_gcode` for the (unused) transfer terms. **Broken/Incomplete** — in a multi-godown deployment this returns company-wide opening stock while claiming to be godown-specific. Harmless with one godown.

**Verified — `Posted` filtering is inconsistent across these five objects.** `sp_ItemOpeningStock` filters purchases on `posted='Y'` but has `/* prledger.posted = 'Y' and */` and `/* saleledger.posted = 'Y' and */` commented out. `udf_openingstock` filters `posted='Y'` on purchase, purchase-return, sale-return, receipt and adjustment — but **not** on sale. `SP_ItemStockMovementAtAvgPrice` (38515) filters `sl.posted='Y'` on sale in the *movement* block but **not** in the *opening* block. Different reports will therefore give different opening balances for the same date.

**Risk (High):** three different "opening stock" answers are obtainable for the same item/date depending on which report is run.

**Verified.** Opening balances were originally seeded via `PurCatCode = 3` (*Opening Purchase*) — 1 invoice exists — and via the legacy migration procedures `sp_init_opening_pur` (36387), `OldSheerazConvert` (1830), `SheerazConvert` (2150).

---

# 20. `StockReport` — the daily snapshot (3,215,967 rows)

## 20.1 What it is: **a daily point-in-time snapshot, written once per calendar day**

**Verified conclusively.**

`SP_StockReport(@DailyReportDays, @ArchiveReportDays)` (line 49885):
```sql
INSERT INTO StockReport (Date, GCode, ICode, Stock, PurchasePrice, SalePrice,
                         AvgPrice, RecentPurchasePrice, PackUnits)
SELECT
    Date  = GETDATE(),
    Gcode = Gd.GCode,
    ICode = Gd.ICode,
    Stock = SUM(Gd.CurrQty),
    PurchasePrice = I.PurPrice,
    SalePrice     = I.SalePrice,
    AvPrice       = I.AvgPrice,
    RecentPurchasePrice = I.RecentPurPrice,
    PackUnits     = I.PackUnits
FROM GodownDetail Gd, Item I
WHERE Gd.ICode = I.ICode AND
      CONVERT(VARCHAR(100), GETDATE(), 101) NOT IN
        (SELECT DISTINCT CONVERT(VARCHAR(100), Date, 101) FROM STOCKREPORT)
GROUP BY Gd.GCode, Gd.ICode, I.PurPrice, I.SalePrice, I.AvgPrice, I.RecentPurPrice, I.PackUnits
```

Therefore:
- It is a **snapshot**, not a ledger — it stores balances, never movements.
- It **collapses batches**: `SUM(Gd.CurrQty) GROUP BY GCode, ICode`. Batch granularity is lost.
- It is **idempotent per day** via the `NOT IN (SELECT DISTINCT CONVERT(…,101) …)` guard — an all-or-nothing test evaluated once for the whole statement.
- `GETDATE()` in a `SELECT` list is evaluated **once per statement**, so all rows of a day share an identical timestamp.

## 20.2 Live confirmation

**Verified.**

| Question | Answer |
|---|---|
| Date range | **2025-01-01 18:00:02 → 2026-07-31 00:00:03** |
| Rows | 3,215,967 |
| Distinct calendar days present | **545** |
| Missing days in range | **32** — a contiguous block from **2025-12-08 to 2026-01-08** |
| Rows per recent day | 5,912 – 6,010 |
| Distinct timestamps per day | **exactly 1** |
| Duplicate `(date, GCode, ICode)` | **0** — one row per item per day, confirmed |
| Distinct godowns | 1 |
| Time of day | Hour 00 on 521 days; hour 08 on 20 days; hour 18/10/22/02 on one day each |

**Strongly Inferred.** The snapshot is produced by a **scheduled task running at/just after midnight** (hour 00:00:0x on 96 % of days), because SQL Server **Express has no SQL Agent** and no SQL object anywhere calls `SP_StockReport`. The 20 days at hour 08 are almost certainly days the task missed and the snapshot was taken at first login. The 32-day gap is a period when the task was not running.

## 20.3 Who reads it: **nobody, in SQL**

**Verified.** Across all 762 programmable objects, `StockReport` appears in exactly **7 lines**:
- 1 header + 5 lines inside `SP_StockReport` itself (2 of which are commented-out `DELETE`s)
- 1 `truncate table stockreport` inside `sp_init_delete_table` (line 36212 — the new-year/new-database reset)

**There is no `SELECT … FROM StockReport` anywhere in the database.** It is consumed exclusively by PowerBuilder DataWindows in the compiled client.

## 20.4 The disabled purge

**Deprecated.** Both retention `DELETE`s are commented out with a dated authorisation:
```sql
/**** Deletion Stopped C/O Rashid/Shakil/Azhar 05-JUN-2023  ****/
--DELETE StockReport WHERE DATE <= GETDATE() - @DailyReportDays AND DATEPART(dy, DATE) NOT IN (1, 10, 20)
/**** Deletion Stopped C/O Rashid/Shakil/Azhar 05-JUN-2023  ****/
--DELETE StockReport WHERE DATE <= GETDATE() - @ArchiveReportDays
```
The original design retained daily snapshots for `@DailyReportDays`, kept the 1st/10th/20th day-of-year rows longer, then purged everything past `@ArchiveReportDays`. **Since 2023-06-05 nothing is purged**, which is why the table has grown to 3.2 M rows. The two parameters are now inert.

## 20.5 Performance characteristics

**Verified.**

| | |
|---|---|
| Physical structure | **HEAP** (no clustered index) |
| Only index | `IDX_StockReport_Date` nonclustered on `Date` |
| Daily insert | ~6,000 rows |
| Daily guard query | `CONVERT(VARCHAR(100), Date, 101)` is **non-sargable** → forces a full scan of the 3.2 M-row heap **every day** |

**Risk (Medium):** the daily snapshot job performs a full heap scan; growth is unbounded at ~2.2 M rows/year.

## 20.6 Value to the business

**Verified.** `StockReport` is the **only** historical record of:
- stock quantity per item per day, and
- the average cost, purchase price, retail price and recent purchase price **as they stood on that day**.

It therefore permits accurate historical inventory valuation, stock-ageing analysis, and days-of-cover computation. It is **irreplaceable** — none of it can be recomputed from movement tables, because `Item.AvgPrice`, `SalePrice` etc. are overwritten in place with no history (`ItemCostHistory` is empty; `ItemLog` is a change-log, not a daily series).

---

# 21. `StockLedger` and the rebuild engine

## 21.1 What it is

**Verified. `StockLedger` is a transient rebuild scratchpad, not a live ledger. It currently holds 0 rows.**

Three procedures form the engine:

| Procedure | Line | Role |
|---|---|---|
| `SP_UpdateStockLedger(@PurgeStockLedger, @UpdateBaseTable)` | 57490 | Orchestrator: optionally `TRUNCATE TABLE StockLedger`, then `EXEC SP_StockLedger`, then loop every distinct `ICode` calling `UpdateItemStockLedger` |
| `SP_STOCKLEDGER` | 49058 | **Extractor.** Takes `SELECT COUNT(*) FROM STOCKLEDGER WITH (TABLOCKX)` to serialise, then nine `INSERT … WHERE NOT EXISTS (… st.utn …)` blocks that pull every posted movement into a unified shape |
| `SP_UpdateItemStockLedger(@ICode, @UpdateBaseTable)` | 57133 | **Running-balance recomputation.** A `Static Forward_Only` cursor over one item's ledger `ORDER BY UTN`, walking `@PrevStock` forward through each document |

## 21.2 The running-balance algorithm

**Verified.** Per item, ordered by `UTN` (a global monotonic transaction number from `sp_maxutn`):

```
inbound  (PV, RV, SR, AI):   NewStock = PrevStock + Qty + Bonus
outbound (PR, SV, IV, DS, AD): NewStock = PrevStock − Qty − Bonus
                              except SV with Due IS NOT NULL → NewStock = PrevStock (no movement)
```

For the **first** row of an item, if it is an inbound document, `@PrevStock` is seeded from the stored `newstock` rather than recomputed:
```sql
IF @counter=1 AND (@documenttype='PV' OR @documenttype='RV' OR @documenttype='SR' OR @documenttype='AI')
    SET @PrevStock = @newstock
```

**Verified — the `@UpdateBaseTable='Y'` mode rewrites the source documents.** This is a destructive back-fill:

| Document type | Column rewritten |
|---|---|
| `SV` | `SaleDetail.BalanceStock` |
| `PR` | `PRDetail.BalanceStock` |
| `IV` | `IssueDetail.BalanceStock` |
| `DS` | `DueSatisfyDetail.BalanceStock` |
| `AD` / `AI` | `AdjDetail.CurrStock` |
| `PV` | `PurDetail.CurrStock` |
| `RV` | `ReceiptDetail.CurrStock` |
| `SR` | `SRDetail.CurrStock` |

**Risk (Critical if run with `@UpdateBaseTable='Y'`).** `PurDetail.CurrStock` is a **direct input to the historical average-cost calculation** (§8.3). Rewriting it retroactively changes the provenance of every `NewAvgPrice` in the database and would invalidate the costing audit trail. There is no transaction wrapper, no backup, and a `Print` statement per row (`Print 'Row ID = ' + STR(@RowID)`) betraying that this is an interactive maintenance tool, not production code.

## 21.3 Performance

**Verified.** Cursor-per-item over a cursor-per-row, driven by a `WHILE` loop over a table variable, with `Print` per iteration. Reconstructing 30,050 items × ~800 K movements this way is an hours-long, single-threaded operation.

---

# 22. Decimal precision

## 22.1 Declared precision

**Verified** from `INFORMATION_SCHEMA.COLUMNS`:

| Concept | Type | Where |
|---|---|---|
| Stock quantity | `numeric(15,4)` | `GodownDetail.CurrQty`, `StockReport.Stock`, `StockLedger.Qty/Bonus/Stock/NewStock`, `SaleDetail.LooseQty/BonusQty/balancestock`, `PurDetail.PackQty/LooseQty/BonusQty/CurrStock`, `SRDetail`, `PRDetail`, `AdjDetail.LooseQty`, `TDetail.Qty`, `Item.TransitStock` |
| Pack quantity (sale only) | `int` | `SaleDetail.PackQty`, `SRDetail.PackQty` — **inconsistent with `PurDetail.PackQty numeric(15,4)`** |
| **Average / unit cost** | **`numeric(15,5)`** | `Item.AvgPrice`, `PurDetail.AvgPrice/NewAvgPrice`, `SaleDetail.AvgPrice`, `SRDetail.AvgPrice/NewAvgPrice`, `PRDetail.AvgPrice`, `AdjDetail.AvgPrice/NewAvgPrice`, `ItemBatches.CostPrice/AvgPrice/NewAvgPrice`, `ItemCostHistory.AvgPrice`, `StockReport.AvgPrice` |
| Selling / purchase price | `numeric(12,2)` | `Item.SalePrice`, `Item.PurPrice`, `Item.RecentPurPrice`, `SaleDetail.SalePrice/Rate` |
| Net purchase rate | `numeric(15,5)` | `PurDetail.NetRate` |
| Pack price | `numeric(15,5)` | `SaleDetail.PackPrice` |
| `StockReport.RecentPurchasePrice` | `numeric(15,5)` | **note:** the source `Item.RecentPurPrice` is `numeric(12,2)` — widened on snapshot |
| Percentages | `numeric(5,2)` | `DiscPerc`, `GSTPerc`, etc. |

## 22.2 Effective precision — quantities are forced to whole numbers

**Verified.** `ColumnPreferences` has exactly one row: `ColumnName = 'Qty'`, `ColPrecision = 0`.

`SP_GodownDetail_RepairForZeroDecimal` (line 32784) acts on this:
```sql
SET @ColPrec = ISNULL((SELECT ColPrecision FROM ColumnPreferences WHERE ColumnName='Qty' AND ColPrecision=0), 0)
IF @ColPrec = 0
BEGIN
  SET @GD_Err_Rows = (SELECT COUNT(ICode) FROM GodownDetail WHERE CurrQty <> CAST(CurrQty AS INT))
  IF @GD_Err_Rows > 0
  BEGIN
    UPDATE GodownDetail SET CurrQty = ROUND(CurrQty, 0) WHERE CurrQty <> CAST(CurrQty AS INT)
    DELETE GodownDetail WHERE CurrQty = 0
    UPDATE SaleDetail SET LooseQty = ROUND(LooseQty,0) …   -- and BonusQty
    UPDATE SRDetail   SET LooseQty = ROUND(LooseQty,0) …   -- and BonusQty
    UPDATE AdjDetail  SET LooseQty = ROUND(LooseQty,0)
    UPDATE TDetail    SET Qty      = ROUND(Qty,0)
    UPDATE DueSatisfyDetail SET DueSatisfyQty = ROUND(DueSatisfyQty,0)
    UPDATE PurDetail  SET LooseQty/PackQty/BonusQty = ROUND(…,0)
  END
END
```

**Verified — it has been effective.** Live: `SUM(CASE WHEN CurrQty <> CAST(CurrQty AS INT) THEN 1 ELSE 0 END) = 0` and `SUM(CASE WHEN CurrQty = 0 …) = 0`.

**Risk (High).** `ROUND(CurrQty, 0)` uses **banker's-neutral half-away-from-zero** rounding. A batch holding 0.5 units becomes 1 (stock created from nothing); a batch holding 0.4 becomes 0 and is then **deleted** (stock destroyed). No log, no adjustment document, no GL entry. This procedure silently manufactures and destroys inventory.

## 22.3 Rounding in the costing path

**Verified.**

| Step | Rounding |
|---|---|
| Incoming unit cost | `Round(NetRate / PackUnits, 5)` — 5 dp |
| New average | `ROUND( … , 5)` — 5 dp |
| Adjustment-increase cost basis | `Cast(@hold_avgprice As Numeric(8,2))` — **truncated to 2 dp, max 999,999.99** |
| Report valuation | `Round(I.AvgPrice, 2)` |
| Report unit price | `Round(I.SalePrice / I.PackUnits, 2)` |
| Price policy | `ROUND( …, 2)` |

**Risk (Medium):** an item with `PackUnits = 30` and a pack cost of PKR 1,000 has a unit cost of 33.33333; the 5-dp average accumulates a rounding residue of up to 0.000005 per unit. Over 214,737 units the aggregate error is negligible (< PKR 2), but the `Numeric(8,2)` cast in the adjustment path is a hard truncation of 3 decimal places on a value that is otherwise carried at 5.

`Item.AreaVolume numeric(16,8)` and `Item.ForeignPrice numeric(15,5)` are the highest-precision fields in the item master; both are unused here.

---

# 23. Item master structure

## 23.1 Scale

**Verified.**

| Table | Rows | Purpose |
|---|---|---|
| `Item` | **30,050** (28,893 `Active=1`) | Item master — **135 columns** |
| `ItemSuppliers` | 22,246 | Item ↔ supplier, with `Priority`, `Rate`, `DiscPerc`, `SaleQty`, `BonusQty`, `days` (lead time) |
| `Manufacturer` | 838 | |
| `ItemClass` (`ICCode`) | 12 | Physical/handling class |
| `ItemCategory` (`ICatCode`) | 7 | Regulatory/commercial category |
| `ItemPacking` (`PackCode`) | **1** (`.`) | Effectively unused |
| `GenericItem` (`GenericCode`) | **1** (`DEFAULT GENERIC NAME`) | **Generic-name mapping is NOT used** |
| `MeasuringUnit` | **1** (`GENERAL`, factor 1.0) | Unused |
| `ItemGroup` | **0** | Unused |
| `AlternateItemAlias` | **0** | Unused |
| `ItemLog` | **109,473** | Full-row change log (see §23.4) |
| `PricePolicy` / `PricePolicyDetail` | 30,052 / 30,052 | One auto-generated stub per item (see §24) |

## 23.2 The 135 columns — functional grouping

**Verified.** The `Item` table is a union of every vertical the product has ever served. Grouped:

| Group | Columns | Used here? |
|---|---|---|
| Identity | `ICode` (PK, int), `CustomICode` varchar(75), `Name` varchar(60), `ShortName`, `LocalItemName` nvarchar(255), `RegdNo` | Yes (`CustomICode` = barcode/alias) |
| Classification | `ICCode`, `ICatCode`, `PackCode`, `ManfCode`, `GenericCode`, `ItemTypeCode`, `MeasureUnitCode`, `ItemDesignCode` | `ICCode`, `ICatCode`, `ManfCode` used |
| Packing | `PackUnits` smallint, `PackingDesc` varchar(50), `PackingFactor numeric(9,3)`, `PackCapacity numeric(12,4)`, `PackingCost`, `LoosePack` | `PackUnits`, `PackingDesc` used |
| Pricing | `SalePrice`, `SalePrice2..5`, `RetailPrice`, `PurPrice`, `RecentPurPrice`, `RecentPurPrice2..5`, `AlternatePurPrice`, `MinSalePrice`, `DiscountedSalePrice`, `DiscountedPurPrice`, `ForeignPrice`, `SalePriceChangeMargin` | `SalePrice`, `PurPrice`, `RecentPurPrice` used |
| **Costing** | **`AvgPrice numeric(15,5)`** | **Yes — the cost carrier** |
| Discount | `SaleDiscPerc`, `SaleDiscPerc2..5`, `PurDiscPerc`, `FlatDisc`, `PurFlatDisc`, `MaxSaleDiscPerc`, `RedemptionDiscPerc`, `ClaimableDiscperc`, `LockSalePrice`, `LockDiscPerc`, `AllowSalePriceBelowAvgPrice` | Partially |
| Tax | `SalesTax`, `PackSalesTax`, `PackPurTax`, `GSTPerc1/2`, `Taxable`, `SalesTaxScheduleCode`, `PCTCode` | FBR-related |
| **Inventory control** | **`ReorderQty`, `OptimumQty`, `ReorderLevel`, `OptimumLevel`, `GReorderQty`, `GOptimumQty`, `MinQty`, `TotalPieces`, `TransitStock`, `QtyUsed`, `GeneratePO`, `Gcode`** | **Only `MinQty` populated** |
| Pharmacy behaviour | `Prescribed`, `Refrigrated`, `AntiNorCotix`, `Restricted`, `PrintExpiry`, `ConfirmExpiry`, `PrintItemBatch`, `Ingredients1/2`, `AllowDue`, `AllowSaleInDecimalQty`, `UpperSaleQtyLimit`, `CheckUpperSaleQtyLimit`, `PrefferedSaleQty` | Partly (see below) |
| Alerts / policy | `ItemAlertCode`, `BonusPolicyCode`, `DiscountPolicyCode`, `LoyaltyItem` | `ItemAlertCode` used |
| Commission | `CommissionPerUnit`, `CommissionPerc` | |
| Physical | `UnitWeight`, `Length`, `Width`, `Thickness`, `AreaVolume`, `Sheets` | Unused |
| **Apparel vertical (dormant)** | `ISizeCode`, `IStyleCode`, `IColourCode`, `ISleeveCode`, `IYarnCode`, `IFabricCode`, `IBrandCode`, `ItemColourCode2`, `ItemThicknessCode`, `ItemThicknessCode2`, `SizeDescription`, `ModelDescription`, `TypeDescription` | **Dead** |
| **Auto-parts vertical (dormant)** | `IPartCode`, `OldPartCode`, `ItemYear` | **Dead** |
| **Person-like vertical (dormant)** | `Gender`, `Nationality`, `BirthDate`, `IssueDate`, `ExpiryDate` | **Dead** |
| Audit | `UserCode`, `LastUpdate`, `OriginalDate`, `ChangeReason`, `Module`, `HeaderNo` | `LastUpdate` maintained by trigger |

## 23.3 Live pharmacy-relevant distributions

**Verified.**

| Attribute | Distribution |
|---|---|
| `Active` | 28,893 active / 1,157 inactive |
| `Refrigrated = 1` | **76 items** (57 not prescribed, 19 prescribed) |
| `Prescribed = 1` | **31 items** — essentially unused despite being a pharmacy |
| `ItemAlertCode` | 29,785 = "no alert"; 249 = SENSITIVE; 14 = SHORT; 3 = INFANT; 1 = HOLDED |
| `ICatCode` | 1 MEDICINES 26,501 · 3 CONSUMER 3,093 · 2 NARCOTICS 203 · 5 DIAGNOSTIC 89 · 7 DR KHALID MUGHAL 75 · 4 COUNSELING 52 · 6 MILK 39 |
| `ICCode` | 1 DEFAULT 26,884 · 3 CONSUMER 1,129 · 2 EXPENSIVE 632 · 11 MILKS 373 · 9 NARCOTICS 233 · 5 DIAGNOSTIC 212 · 13 DERMATOLOGY 149 · 6 FRIDGE 144 |
| `SalePrice = 0` | 288 active items |
| `RecentPurPrice = 0` | 15,916 active items (never purchased) |
| `AvgPrice = 0` **with stock on hand** | **0 items** — good |

`ItemCategory` also carries `SaleExpiryDays` (MEDICINES 10, NARCOTICS 10, CONSUMER/DIAGNOSTIC/MILK/DR KHALID 90, COUNSELING 0) — **Verified never referenced in SQL**; client-side only.

## 23.4 `ItemLog` — the item change audit

**Verified.** `ItemLog` is a **full-width shadow of `Item`** (all 135 columns) plus three extra leading columns: `ItemRowID bigint`, `LogDate datetime`, `NewSalePrice numeric`, `Stock int`.

| | |
|---|---|
| Rows | **110,329** |
| Date range | 2025-01-01 18:53 → 2026-07-31 16:41 |
| Distinct items logged | **7,231** |

**Strongly Inferred.** It is a **price-change / master-data audit trail** written by the client (no trigger or procedure in SQL writes it), capturing the item's complete prior state plus the new sale price and the stock at that moment. ~110 K changes over 19 months ≈ 190/day, consistent with routine MRP updates in the Pakistani pharmaceutical market.

---

# 24. Pricing, discount and bonus policies

## 24.1 Price policy — present, auto-generated, and **inert**

**Verified.**

- `PricePolicy` (30,052 rows) and `PricePolicyDetail` (30,052 rows) — **exactly one policy and one slab per item.**
- They were mass-generated by `SP_AutoCreatePricePolicy` (line 7413):
```sql
INSERT INTO PricePolicy (PricePolicyCode, Name, ICode)
SELECT PricePolicyCode, Name = LTRIM(RTRIM(STR(ICode,10))) + '.', ICode FROM #lt_pricepolicy
INSERT INTO PricePolicyDetail (PricePolicyCode, QtyLimit, Price, ExpiryDate)
SELECT P.PricePolicyCode, QtyLimit=0, I.SalePrice, '2012-12-12' FROM #lt_pricepolicy P, Item I …
```
- **Every one of the 30,052 detail rows has `ExpiryDate = 2012-12-12` and a single `QtyLimit = 0` slab.**
`Evidence: SELECT ExpiryDate, COUNT(*), COUNT(DISTINCT QtyLimit) FROM PricePolicyDetail GROUP BY ExpiryDate → one group.`

`SP_GetPricePolicyBased_ItemPrice` (31831) filters `ExpiryDate >= CAST(CONVERT(VARCHAR(20), GETDATE(), 101) AS DATETIME)` — with every row expired since 2012, **the procedure returns `NULL` for every item, every time.**

**Verdict: Deprecated / Broken. The price-policy engine is dead weight — 60,104 rows of pure noise.**

**Verified — the policy price formula (for reference), including right-based gating:**
```sql
@GetPrice        = right 5070
@GetItemFlatDisc = right 5071
@GetItemDiscPerc = right 5072
Price = ROUND( ( (IF right5070 THEN D.Price/@PackUnits ELSE Item.SalePrice/@PackUnits)
                 − (IF right5071 THEN D.ItemFlatDisc ELSE 0) )
               × (1 − (IF right5072 THEN D.DiscPerc ELSE 0) × 0.01), 2 )
```
Slab selection: the **greatest `QtyLimit` ≤ `@QtySold`** among unexpired slabs (implemented via a `MIN(QtyLimit) ≥ qty UNION MAX(QtyLimit) ≤ qty` then `T.QtyLimit <= @QtySold`).

## 24.2 Discount and bonus policies — **not used**

**Verified.** `DiscountPolicy`, `DiscountPolicyDetail`, `BonusPolicy`, `BonusPolicyDetail` all have **0 rows**. `Item.DiscountPolicyCode` and `Item.BonusPolicyCode` are nullable and unpopulated, so `SP_GetDiscountPolicyBased_ItemDiscount` (30990) and `SP_GetBonusPolicyBased_ItemBonusQty` (30892) both short-circuit to `NULL`.

Bonus formula, for reference (**Verified**, line 30892):
```sql
BonusQty = CAST( (@QtySold / CASE WHEN SaleQty <> 0 THEN SaleQty ELSE 1 END) AS INT) * BonusQty
```
i.e. integer "buy `SaleQty` get `BonusQty`" slabs, with an expiry-dated slab table.

## 24.3 Batch-wise pricing — **not used**

**Verified.** `ItemBatchPricing` = 0 rows; preference `applybatchwisepricing = 'N'`; `updatebatchsalepriceonpurposting = 'N'`. `Update_ItemBatchPrices` (61897) back-fills the table from `GodownDetail` using `MAX(PurDetail.SalePrice)` for the batch, falling back to `Item.SalePrice`; its `NOT IN` predicate concatenates `STR(ICode,10) + Batch + CONVERT(varchar(100), Expiry, 121)` — a non-sargable string key over the whole table. Never run here.

## 24.4 `SP_MakePriceChanges` — a schema-altering utility, not a pricing routine

**Verified — Broken/Misnamed.** Despite its name, `SP_MakePriceChanges` (line 39264) reads the `PriceChanges` table (8 live rows) and executes `ALTER TABLE … DROP CONSTRAINT`, `UPDATE … SET col = 0.00 WHERE col IS NULL`, `ALTER TABLE … ALTER COLUMN col <newtype>`, `ALTER TABLE … ADD CONSTRAINT DF_… DEFAULT (0)` via dynamic SQL. Live `PriceChanges` content targets `Qty` columns on service tables, widening them to `NUMERIC(10,2)`.

**Risk (High):** a DDL-mutation procedure reachable from the application, driven by a data table, with no transaction and no validation. It has nothing to do with prices.

---

# 25. Known integrity risks — with evidence of historical corruption

## 25.1 The repair toolkit is itself the evidence

**Verified.** A product does not ship five stock-repair procedures and a dedicated corruption table unless corruption has occurred repeatedly.

| Object | Line | What it repairs | Destructiveness |
|---|---|---|---|
| `sp_AutoStockVerification` | 8830 | **Detects only.** Inserts every item whose `SUM(GodownDetail.CurrQty)` ≠ replayed movement total into `items_corrupted` | Safe |
| `SP_RepairBatchWiseCorruptedStock` | 46516 | **Destructive.** For each godown: finds mismatched items, then `DELETE FROM GodownDetail WHERE ICode IN (…) AND GCode = @GCode` and re-inserts **one single row per item** with the computed net quantity, batch = `(SELECT Batch FROM PurDetail WHERE PurUtn = MAX(PurUtn) for the item)`, expiry = `MIN(GodownDetail.Expiry)` or the last purchase expiry or `'12/12/2010'`, `Priority = 10` | **Collapses all batches of the item into one and destroys batch history** |
| `SP_GodownDetail_RepairForZeroDecimal` | 32784 | Rounds all quantities to integers, deletes zero rows | **Silently creates/destroys stock** (§22.2) |
| `SP_RepairDB` | 46712 | Wraps `DBCC CHECKDB(… , REPAIR_FAST \| REPAIR_REBUILD \| REPAIR_ALLOW_DATA_LOSS)` and logs into `DBCC_History` / `DBRepairLog` | **`REPAIR_ALLOW_DATA_LOSS` is exposed as `@Option = 3`** |
| `SP_Repair_NetRate_RPP` | 46370 | Repairs `NetRate` / recent purchase price | — |

**Verified — `SP_RepairBatchWiseCorruptedStock` writes only rows where `Value1 > 0`:**
```sql
INSERT INTO GodownDetail (GCode, ICode, CurrQty, Batch, Expiry, Priority, ManfDate)
SELECT Code2, Code1, Value1, …, Date1, 10, Null
FROM ReportData WHERE Value1 > 0
```
An item whose replayed movement total is **negative** has its `GodownDetail` rows **deleted and not replaced** — the item silently disappears from stock.

## 25.2 Documented corruption events

**Verified.** `items_corrupted` holds three real detections:

| Detected | ICode | Item | Stock in hand | Stock should be | Delta |
|---|---|---|---|---|---|
| 2025-02-26 00:00:04 | 26328 | AZOBAR 15ML SYP | 0 | 1 | −1 |
| 2025-02-26 00:00:04 | 11328 | CIPOTIC D EAR DROP | 4 | 5 | −1 |
| 2025-02-26 00:00:04 | 3388 | PANADOL DROPS 30ML | 15 | 16 | −1 |

All three at the same timestamp — a single verification run on 2025-02-26 that found three items each one unit short. Small, but proof that the balance identity has broken in production. **Live re-run on 2026-08-01 finds 0 mismatches** (§4.3), so the drift was repaired.

## 25.3 Active cost corruption — PKR 1.79 M of phantom inventory value

**Verified.** Sixteen stocked items have `AvgPrice` exceeding their unit retail price. Three of them account for 99.6 % of the exposure and are unmistakably **pack-vs-unit basis errors**:

| ICode | Item | Qty | PackUnits | `SalePrice` (pack) | Unit retail | **`AvgPrice`** (should be per unit) | `RecentPurPrice` | Overstatement (PKR) |
|---|---|---|---|---|---|---|---|---|
| 23363 | MBER TBE G11 | 30 + 7 | 1 | 26.00 | 26.00 | **25,122.708** | 25,302.00 | ~929,540 |
| 27867 | LCYTE 450MG TAB | 364 | 60 | 1,850.00 | 30.83 | **1,817.550** | 71,500.20 | ~650,366 |
| 7769 | ATHETER 30 | 30 | 1 | 70.00 | 70.00 | **6,604.530** | 6,604.53 | ~196,036 |
| | | | | | | | **Total** | **≈ 1,775,942** |

In each case the average cost equals the **pack** price while the balance is counted in **loose units** — the `/ PackUnits` divisor was lost (ICode 27867: `RecentPurPrice = 71,500.20` for a 60-tablet pack = 1,191.67/tablet, yet `AvgPrice = 1,817.55` and retail is 30.83/tablet — a two-order-of-magnitude error).

**Impact:** reported inventory value is **PKR 12,011,533**; the defensible value is **PKR 10,222,268**. **The balance sheet overstates inventory by ~15 %.** Every gross-margin figure involving these three items is wrong.

**Requires accountant validation.**

## 25.4 Consolidated risk register

| # | Risk | Severity | Evidence |
|---|---|---|---|
| 1 | **No expiry data.** 99.1 % of stock rows carry the sentinel expiry `2030-12-12`; `ExpiryIntimation` empty; `salecheckexpiry='N'`. A pharmacy cannot detect, quarantine or recall short-dated stock. | **Critical** | Live `GodownDetail` expiry distribution; preferences |
| 2 | **No batch traceability.** 96.1 % of rows use batch `'.'`; 62 distinct batch strings, several of them junk (`\`, `asd`). Regulatory recall is impossible. | **Critical** | Live `GodownDetail` batch distribution |
| 3 | **Cost basis corruption:** 16 items, PKR 1.79 M (15 % of inventory value) valued above retail, from pack/unit confusion | **Critical** | §25.2 |
| 4 | **Half the inventory logic is in a compiled binary with no source.** Sale, purchase, sale-return and purchase-return posting cannot be read. | **Critical** | §2.1 |
| 5 | `SP_Update_ItemHistoricalCost_In_Sale_And_Return` can retro-rewrite 620 K COGS values with a *look-ahead* cost rule, un-transacted, against an arbitrary database name | **Critical** | §8.5 |
| 6 | `SP_RepairBatchWiseCorruptedStock` deletes and rebuilds `GodownDetail`, collapsing all batches to one and dropping items with negative computed stock | **High** | §25.1 |
| 7 | `SP_UpdateGodownDetail`, `SP_UpdateItemStockBatch`, `SP_SaleUpdateItemStockBatch` will all write a negative `CurrQty` without error; zero `CHECK` constraints | **High** | §17.2 |
| 8 | Read-then-write with no lock in every consumption path (TOCTOU) | **High** | §17.2(d) |
| 9 | `SP_GodownDetail_RepairForZeroDecimal` creates/destroys stock by rounding, with no audit | **High** | §22.2 |
| 10 | **Adjustments are the shrinkage channel and carry no reason code.** Net −15,391 units / −PKR 290,494 over 19 months, no approval, no categorisation | **High** | §13.4 |
| 11 | Three inconsistent "opening stock" implementations with different `Posted` filters and different godown scoping | **High** | §19 |
| 12 | Purchase-return bonus quantity is not multiplied by `PackUnits` while the purchase is — asymmetric reversal | **High** | §4.1 |
| 13 | Cost basis silently switched from `PurPrice` to `NetRate` mid-history (`UpdateAvgPriceWithNetRate`) | **High** | §8.3 |
| 14 | `SP_MakePriceChanges` executes `ALTER TABLE` DDL from application-reachable data | **High** | §24.4 |
| 15 | `GodownDetail.Locked` (104 rows) is never enforced by SQL — locked stock is sellable from any SQL path | **Medium** | §7.2 |
| 16 | `Numeric(8,2)` cast in the adjustment cost path overflows above PKR 999,999.99 — and one item already has `AvgPrice = 25,122.71` heading that way | **Medium** | §8.4 |
| 17 | FIFO/LIFO priority bands saturate at 8 / 19 batches, silently degrading to FEFO | **Medium** | §7.3 |
| 18 | `StockReport` unbounded growth (retention `DELETE`s disabled 2023-06-05); heap with a non-sargable daily guard scan | **Medium** | §20.4–20.5 |
| 19 | 32-day gap in the daily snapshot (2025-12-08 → 2026-01-08) | **Medium** | §20.2 |
| 20 | `SP_Update_Item_MinQty/OptimumQty/ReorderQty` use `AND` where `OR` is intended — failures reported as success | **Medium** | §18.1 |
| 21 | Free-standing sale returns are valued at **selling** price, not cost, inflating credited inventory | **Medium** | §5.3 |
| 22 | `allowsamebatchreturnmultipletimes='Y'` with no over-return check | **Medium** | §14.1 |
| 23 | 30,052 dead `PricePolicy` + 30,052 dead `PricePolicyDetail` rows, all expired since 2012 | **Low** | §24.1 |
| 24 | `Item` has 135 columns of which ~40 belong to dormant apparel/auto-parts/person verticals | **Low** | §23.2 |
| 25 | `Item.TotalPieces`, `Item.TransitStock` are maintained-by-design but zero everywhere — dead denormalisation | **Low** | §3.1 |

---

# 26. Complete inventory preference matrix (live values)

**Verified** — every value below read from `dbo.SoftwarePreferences` on 2026-08-01. The **"Read by SQL?"** column is decisive for the rebuild: `No` means the rule exists **only** inside the compiled client.

| Preference | Value | Read by SQL? | Effect |
|---|---|---|---|
| `inventorymovementmethod` | **`1`** | **Yes** (`SP_UpdateGodownDetail`, `SP_InsertItemStock`, `SP_UpdateItemStockBatch`) | 1 = FEFO (equal priority), 2 = FIFO, 3 = LIFO |
| `inventorysystemused` | `P` | Yes (10 CRS/GL procs) | 'P' = perpetual |
| `Multigodown` | `N` | No | Single warehouse |
| `defaultbatch` | `.` | **Yes** (14 refs) | Sentinel batch |
| `DefaultExpiry` | `2030-12-12` | **Yes** (13 refs) | Sentinel expiry |
| `UpdAvgPriceInAdjInc` | **`Y`** | **Yes** (`sp_PostStockAdjustment`, `sp_PostItemConversion`) | Adjustment-increase recomputes the average |
| `updavgpriceinreceipt` | `Y` | Yes (`sp_GenerateReceipt`) | Receipt recomputes the average |
| `updateavgpricewithnetrate` | **`Y`** | Yes (column on `PurLedger`) | Cost basis = `NetRate` (vs `PurPrice`) |
| `pr_updateavgprice` | `N` | No | Purchase return does not change cost |
| `updateavgpriceinsr` | `N` | No | Sale return does not change cost |
| `maintainbatchwiseitemcostonposting` | `N` | **No** | Batch costing off |
| `applybatchwisepricing` | `N` | **No** | Batch pricing off |
| `AutoUpdateTransitStock` | `N` | Yes (`sp_UpdateTransitStock`) | Transit stock disabled |
| `LockBatchOnPurPosting` | `Y` | **No** | Client-side batch lock on purchase |
| `overwritebatchonpurposting` | `N` | No | |
| `replacebatchwithpurinvonposting` | `N` | No | |
| `updatebatchsalepriceonpurposting` | `N` | No | |
| `BatchAllocation_InSale` | `A` | **No** | **Unclear** — value `A` has no SQL referent |
| `salecheckexpiry` | **`N`** | **No** | **No expiry check at point of sale** |
| `saleexpirydays` | `100` | No | |
| `acceptfutureexpirydays` | `90` | No | |
| `expiry` | `365` | No | |
| `saleinvbatch` / `askbatchinsaleorder` / `askexpiryinsaleorder` | `N`/`N`/`N` | No | |
| `purbatch` / `purexpiry` | `Y`/`Y` | No | Prompt batch & expiry on purchase |
| `batchinsr` / `expiryinsr` | `Y`/`Y` | No | |
| `showbatchinadj` / `showexpiryinadj` | `Y`/`Y` | No | |
| `allowsamebatchreturnmultipletimes` | `Y` | No | |
| `ExcPendingDueInCurrStock` | `N` | **No** | Available-to-promise does not net off dues |
| `allowdueinbasicdata` / `dueitem` | `N` / `Y` | No | |
| `autoduesatisfyonpurpost` | `N` | No | |
| `saleavgpricecheck` | `N` | No | No below-cost block |
| `allowsalepricegreaterthanavgprice` | `Y` | No | |
| `AllowPRBelowAvgPrice` | `Y` | No | |
| `allow_negative_margin_on_pur_saving` | `Y` | No | |
| `PackStock` | `N` | **No** | Stock shown in loose units |
| `promptifsourcestockreachesreorderlevel` | `N` | No | Reorder prompting off |
| `allowbatchwisetrasnfer` *(sic)* | `N` | No | |
| `allowinsufficientstockitemsintransfer` | `N` | No | |
| `restrictsalefromsinglegodown` | `N` | No | |
| `SaleGodownOption` / `PurchaseGodownOption` / `TransferGodownOption` | `1` / `2` / `3` | **No** | **Unclear** semantics |
| `syncstockfromparentserver` | `N` | Yes | Multi-site sync off |
| `showstockinpricechecker` / `showtotstockininquirywind` | `Y` / `Y` | No | |

---

# 27. Requires accountant validation

The following cannot be settled from code and data alone. Each materially affects reported profit or inventory value.

| # | Question | Why it matters |
|---|---|---|
| 1 | Is a **moving weighted average at item level** the intended and accepted costing policy, or was batch-specific costing intended (the `ItemBatches` machinery exists but is off)? | Determines whether the entire cost history is policy-compliant |
| 2 | Was the mid-history switch of cost basis from `PurPrice` to `NetRate` (`UpdateAvgPriceWithNetRate`) an **authorised accounting-policy change**? Was it disclosed? | Comparability of period-over-period margins |
| 3 | Are **bonus (free) goods** correctly costed at **zero** by being folded into `QtyIn`, thereby diluting the average? Should they instead be received at zero cost with no dilution? | The formula includes `BonusQty` in the denominator, so free goods **lower** the average — an accepted method, but it must be the chosen one |
| 4 | Should a **stock-increase adjustment** be costed at the item's existing average (current behaviour) or at replacement cost? | Current behaviour makes count-up adjustments cost-neutral |
| 5 | Should a **free-standing sale return** be credited at **selling price** (current behaviour) or at cost? | Directly inflates inventory value on goodwill returns |
| 6 | What is the correct treatment of the **PKR 290,494 net adjustment write-down** over 19 months? Is it shrinkage, damage, expiry, or counting error? The data cannot distinguish them. | GL classification and tax deductibility |
| 7 | **The PKR 1.79 M cost overstatement on 3 items** — should it be restated as a prior-period error, and over which periods? | Balance-sheet restatement |
| 8 | The 57 rows with expiry `2022-12-12` (PKR 318,588) — are these genuinely expired goods requiring write-off, or sentinel rows? | Provision for obsolete stock |
| 9 | Should **`SP_Update_ItemHistoricalCost_In_Sale_And_Return`** ever be run? It would restate every historical COGS figure using a look-ahead cost. | Retrospective restatement of all reported margins |
| 10 | Which of the three **opening-stock implementations** is the sanctioned one for statutory reporting? | Different answers for the same date |
| 11 | Is the **`Locked` flag** intended to remove stock from sellable inventory for valuation purposes (104 rows, PKR 83,661)? | Net realisable value |

---

# 28. Modernization notes for the Node / React / MySQL rebuild

> Everything in this section is **Recommended** — a proposal for the new system. **None of it describes existing behaviour.**

## 28.1 Data model

**Recommended.** Replace the single mutable balance table with an **append-only movement ledger plus a derived balance**:

```
stock_movement (id BIGINT PK, occurred_at, posted_at, doc_type, doc_id, doc_line_id,
                warehouse_id, item_id, batch_id NULL, qty_delta DECIMAL(18,4),
                unit_cost DECIMAL(18,5), created_by, reversal_of_id NULL)
stock_balance  (warehouse_id, item_id, batch_id, qty DECIMAL(18,4),  -- materialised, rebuildable
                PRIMARY KEY (warehouse_id, item_id, batch_id))
item_cost_snapshot (item_id, effective_from, avg_cost DECIMAL(18,5), qty_on_hand,
                    source_movement_id)   -- immutable, append-only
```
Rationale: `GodownDetail` is destructively updated in place, which is exactly why five repair procedures exist. An immutable ledger makes `sp_AutoStockVerification` unnecessary — the balance is *by construction* the sum of the ledger.

**Recommended.** Make batch a **first-class entity** with real attributes (`batch_no`, `expiry_date NOT NULL`, `manufactured_on`, `supplier_id`, `received_on`, `status ENUM('available','quarantined','expired','recalled')`) rather than a `varchar(100)` component of a composite primary key holding `'.'`.

**Recommended.** Reduce `Item`'s 135 columns to a pharmacy-focused core (~35 columns) plus an `item_attribute` EAV or JSON column for the long tail. Drop the apparel (`ISizeCode`, `IYarnCode`, `ISleeveCode`, …), auto-parts (`IPartCode`, `ItemYear`) and person (`Gender`, `Nationality`, `BirthDate`) column groups outright.

## 28.2 Costing

**Recommended.** Reimplement the **moving weighted average** exactly as validated in §8.3 — it is a defensible method, the business understands it, and 100 % of the flag-`'Y'` history reproduces from it. Do **not** silently switch to FIFO during migration; that would restate history.

**Recommended.**
- Store cost as `DECIMAL(18,5)`, never cast down. Eliminate the `Numeric(8,2)` truncation in the adjustment path.
- Make the cost basis (`net rate` vs `gross price`) an explicit, versioned, per-period setting — never a per-invoice column that can silently vary.
- Persist **every** average-cost change into an immutable `item_cost_snapshot`, so that historical COGS is a *lookup*, never a recomputation. This retires `Fn_GetItemCostHistory`'s look-ahead defect and makes `SP_Update_ItemHistoricalCost_In_Sale_And_Return` structurally impossible.
- Guard: reject any receipt whose computed unit cost differs from the item's current average by more than a configurable factor (e.g. 10×) pending supervisor approval. **This one control would have prevented all three PKR 1.79 M corruptions.**

## 28.3 Batch & expiry — the highest-value functional upgrade

**Recommended.**
- Make `expiry_date` **mandatory and validated** (`> received_on`, `< received_on + N years`) on every goods receipt. No sentinel dates.
- Enforce FEFO in the allocation query, and **exclude** `status <> 'available'` batches — in the **database/service layer**, not in the UI.
- Add a batch-expiry dashboard with 30/60/90/180-day buckets and a supplier-return workflow. The existing `ExpiryIntimation` document design is a reasonable template (consolidate → extract-by-supplier → post) and can be carried forward.
- Add a recall/lot-trace query: *given a batch, list every sale invoice that dispensed it.* This is currently impossible and is a regulatory requirement.

**Note:** migrating the 6,164 existing `GodownDetail` rows will produce 6,106 rows with an unknown expiry. **Recommended** approach: import them into a dedicated `batch_status = 'unknown_expiry'` state and require a physical stock-take to resolve, rather than fabricating dates.

## 28.4 Integrity and concurrency

**Recommended.**
- `CHECK (qty >= 0)` on the balance table — the current schema has **zero** check constraints.
- Do all stock decrements inside a single transaction with `SELECT … FOR UPDATE` on the batch rows, replacing the TOCTOU pre-check + optimistic-compare pattern.
- Never round quantities destructively. If whole-unit quantities are the policy, enforce `DECIMAL(18,0)` at write time and reject fractions — do not silently `ROUND()` existing balances.
- Every stock movement must be reversible by a **compensating movement**, never by an in-place edit or a `DELETE`.

## 28.5 Adjustments and shrinkage control

**Recommended.**
- Replace the two-value `AdjCategory` with a proper **reason taxonomy**: `count_correction`, `damage`, `expiry_writeoff`, `theft`, `sample`, `internal_use`, `data_entry_error`, each mapped to its own GL account.
- Require an **approval step** for adjustments above a value threshold. Today `sp_PostStockAdjustment` inserts `Posted='Y'` immediately with no approval.
- Preserve batch identity on adjustment increases; today everything lands in the `'.'` default batch, destroying traceability.
- Report shrinkage as a first-class KPI (currently PKR 290,494 net over 19 months, invisible).

## 28.6 The daily snapshot

**Recommended.** **Preserve all 3,215,967 `StockReport` rows.** They are the only historical inventory-value series and cannot be reconstructed. Migrate into a partitioned `stock_snapshot_daily` table (MySQL `PARTITION BY RANGE (TO_DAYS(snapshot_date))`), add a proper primary key `(snapshot_date, warehouse_id, item_id)`, and record the 32-day gap explicitly as a known data-quality annotation.

Going forward, **Recommended**: derive daily balances from the movement ledger rather than snapshotting, and keep the snapshot only as a materialised performance view with a documented retention policy — not as a table that grows by 2.2 M rows/year with its purge commented out.

## 28.7 Reorder management

**Recommended.** Build this properly; it does not exist today (`ReorderQty` = 0 for all 30,050 items). With 620 K sale lines over 19 months, the data supports genuine demand-based replenishment: per-item velocity, lead time (already captured in `ItemSuppliers.days`), safety stock, and a coverage-days target. `ItemSuppliers` (22,246 rows with `Priority`, `Rate`, `DiscPerc`, `SaleQty`, `BonusQty`, `days`) is a good foundation for supplier selection.

## 28.8 Migration sequencing

**Recommended.**
1. **Freeze and reconcile** — run the §4.3 balance identity; it currently returns 0 mismatches. Migrate only from a reconciled state.
2. **Quarantine the 16 cost-corrupt items** and resolve them with the accountant *before* migration, so the opening balance is clean.
3. Migrate `Item` → `item` (+ `item_attribute`), `GodownDetail` → `stock_balance` + synthetic opening `stock_movement` rows, `Manufacturer`, `ItemCategory`, `ItemClass`, `ItemSuppliers`, `ItemAlert*`.
4. Migrate transactional history (`PurLedger/Detail`, `SaleLedger/Detail`, `SRLedger/Detail`, `PRLedger/Detail`, `AdjHeader/Detail`) as read-only ledger records with their **stamped historical `AvgPrice` preserved verbatim** — do not recompute.
5. Migrate `StockReport` and `ItemLog` as historical archives.
6. **Do not migrate**: `StockLedger` (empty scratchpad), `PricePolicy`/`PricePolicyDetail` (60,104 dead rows), `AdjBufferHeader/Detail` (working scratch), all 0-row dormant modules (issues, receipts, production, recipes, conversions, transfers, due-satisfy, expiry intimation, batch pricing, item batches, cost history, discount/bonus policy) — **but preserve their *design* as documented above, because several represent real requirements the pharmacy will need once expiry management is switched on.**

---

# 29. Unknowns and evidence gaps

| # | Unknown | Why it matters | Why it could not be resolved |
|---|---|---|---|
| 1 | The **exact sale-posting algorithm**: how the client chooses batches, whether it filters `Locked`, whether it validates expiry, and in what transaction scope it decrements stock | This is the single highest-volume inventory operation (620,525 lines). Everything about it is inferred from its effects. | No SQL object implements it; the logic is in compiled PowerBuilder `.pbd` files with no source |
| 2 | The **exact purchase-posting algorithm**, in particular how `NetRate` is computed from invoice discount, flat discount, tax, and misc charges | The 12.4 % of historical rows that do not reproduce from the stored `NetRate` (§8.3) prove the client recomputes it differently | Same — compiled binary |
| 3 | Meaning of `BatchAllocation_InSale = 'A'` | Governs sale batch allocation; `'A'` presumably means "Automatic", but the alternatives are unknown | Zero SQL references |
| 4 | Meaning of `SaleGodownOption=1`, `PurchaseGodownOption=2`, `TransferGodownOption=3` | Godown-selection strategy per module | Zero SQL references |
| 5 | Meaning of `SaleDetail.Due = 'X'` (vs `'D'` due, `'S'` satisfied) | Affects the available-to-promise formula | Referenced only in `SP_GetItemStock_Exc_PendingDue`'s `IN ('X','D','S')`; never assigned anywhere in SQL; 0 rows in data |
| 6 | Whether `SP_StockReport` is invoked by a Windows Scheduled Task, the app at first login, or a wrapper utility | Determines how to reproduce the snapshot and explains the 32-day gap | No SQL Agent on Express; no SQL object calls it; timing (hour 00 on 96 % of days) only supports the inference |
| 7 | Root cause of the **32-day snapshot gap (2025-12-08 → 2026-01-08)** | Historical valuation is unavailable for that month | Not recorded anywhere in the database |
| 8 | Whether `SP_RepairBatchWiseCorruptedStock` has ever been executed on this database | It collapses batch history; if it ran, the low batch diversity may be *its* doing rather than data-entry practice | `DBRepairLog` records only `SP_RepairDB` runs; there is no execution log for the batch repair |
| 9 | The correct `AvgPrice` for the 16 cost-corrupt items | PKR 1.79 M of balance-sheet exposure | Requires physical/commercial knowledge; the data is internally inconsistent |
| 10 | Which `@Pricetype` mapping the client passes to `SP_GodownWiseStockInHand` (the proc's local 1/2/3 differs from the `PriceType` table's 1..8) | A mis-mapped call would value stock at purchase price while labelling it "sale price" | Client-side |
| 11 | Whether the `2022-12-12` expiry cohort represents genuinely expired goods | PKR 318,588 potential write-off | The value is a former default sentinel; true expiry is unrecoverable |
| 12 | Whether `LockReason` was ever intended to carry more than `GENERAL` | 104 locked batches have no stated reason | Only one row exists |

---

## Appendix A — Object index (line numbers in `db_modules_full.sql`)

| Object | Line | Object | Line |
|---|---|---|---|
| `Fn_GetItemCostHistory` | 441 | `sp_PostAdjLedger` | 41262 |
| `Fn_GetItemDueQty` | 467 | `sp_PostIssueLedger` | 41808 |
| `Fn_GetItemDueQtyOnAllInv` | 483 | `sp_PostIssueReq` | 41820 |
| `Fn_GetItemDueSatisfiedQty` | 494 | `sp_PostItemConversion` | 41829 |
| `Fn_GetItemStockInGodowns` | 578 | `sp_PostProduction` | 42476 |
| `fn_GetGodown` | 337 | `sp_PostReceipt_From_Production` | 42678 |
| `udf_openingstocksingleitem` | 1623 | `sp_PostSaleLedger` | 42843 |
| `SP_Add_ItemBatches_From_Purchase` | 4463 | `sp_PostStockAdjustment` | 44607 |
| `SP_AutoCreatePricePolicy` | 7413 | `sp_PostTransferHeader` | 45261 |
| `sp_AutoStockVerification` | 8830 | `SP_Repair_NetRate_RPP` | 46370 |
| `SP_CheckUnpostedTransactionOfAnItem` | 10514 | `SP_RepairBatchWiseCorruptedStock` | 46516 |
| `sp_ConsolidatedExpiryIntimation` | 11526 | `SP_RepairDB` | 46712 |
| `sp_DeleteItemStockBatch` | 22940 | `SP_RePrioritizeStockBatches` | 46755 |
| `sp_ExtractExpiryIntimation` | 24018 | `sp_SaleUpdateItemStockBatch` | 48237 |
| `sp_GenerateIssue` | 27470 | `sp_stock_inout` | 48931 |
| `sp_GenerateReceipt` | 28672 | `SP_STOCKLEDGER` | 49058 |
| `SP_Get_ItemBatch_CostPrice` | 29659 | `sp_StockRegister` | 49510 |
| `SP_GetBonusPolicyBased_ItemBonusQty` | 30892 | `SP_StockReport` | 49885 |
| `SP_GetDiscountPolicyBased_ItemDiscount` | 30990 | `SP_TransferInterGodownTransfers` | 53062 |
| `sp_GetItemAvgPrice` | 31381 | `SP_TransferPurchaseInvoices` | 53457 |
| `sp_GetItemAvgPriceForSale` | 31408 | `SP_Update_Item_MinQty` | 55760 |
| `SP_GetItemStock_Exc_PendingDue` | 31457 | `SP_Update_Item_OptimumQty` | 55783 |
| `SP_GetItemStock_For_ConsideredGodowns` | 31479 | `SP_Update_Item_ReorderQty` | 55806 |
| `sp_GetItemStockAll` | 31499 | `SP_Update_ItemBatchSalePrice` | 55829 |
| `sp_GetItemStockBatch` | 31518 | `SP_Update_ItemHistoricalCost_In_Sale_And_Return` | 55846 |
| `sp_GetItemStockInAllowedGodown` | 31554 | `sp_UpdateGodownDetail` | 56815 |
| `sp_GetItemStockTotal` | 31584 | `sp_UpdateItemAvgPrice` | 56913 |
| `SP_GetItemTotalPiecesInHand` | 31600 | `sp_UpdateItemStockBatch` | 57045 |
| `SP_GetPricePolicyBased_ItemPrice` | 31831 | `SP_UpdateItemStockLedger` | 57133 |
| `SP_GodownDetail_RepairForZeroDecimal` | 32784 | `SP_UpdateItemTotalPiecesInHand` | 57216 |
| `sp_GodownItemOpeningStock` | 32811 | `SP_UpdateStockLedger` | 57490 |
| `SP_GodownWiseStockInHand` | 32937 | `sp_UpdateTransitStock` | 57551 |
| `SP_GroupWise_RePrioritizeStockBatches` | 33102 | `Update_ItemBatchPrices` | 61897 |
| `sp_init_delete_table` | 35861 | `fn_GetAvailableGodown` | 62093 |
| `sp_InsertItemStock` | 37708 | `udf_GodownOpeningStock` | 64305 |
| `sp_itemactivity` | 38157 | `udf_openingstock` | 64439 |
| `sp_ItemOpeningStock` | 38378 | `Trig_GodownDetail_AfterUpdate_LastUpdated` | 64679 |
| `SP_ItemStockMovementAtAvgPrice` | 38515 | `Trig_Item_AfterUpdate_UpdateLastUpdate_TimeStamp` | 64698 |
| `SP_LockBatch` | 38846 | `VIEW_WaseelaMini_Stock` | 65942 |
| `SP_MakePriceChanges` | 39264 | `VIEW_WaseelaMini_StockSummary` | 65962 |

---

*End of `08-inventory-logic.md`. Prepared 2026-08-01 from the live `FazalDinPP19DataBaseV2` database (read-only) and the complete extracted source of all 762 SQL Server programmable objects. Every "Verified" claim above is traceable to a named object and line number, a named schema object, or a reproducible SELECT query.*
