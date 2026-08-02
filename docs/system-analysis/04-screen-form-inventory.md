# 04 — Screen / Form Inventory (Recovered from Compiled UI)

**System:** WASEELA ABUZAR V3 — vendor *Abuzar Consultancy* / product family *Waseela* — deployment **"Fazal Din PP19"** (retail pharmacy)
**Analysis stage:** Stage 04 — Presentation-layer (UI) reconstruction
**Document status:** Deliverable for modernization programme (Node / React / MySQL rebuild)
**Prepared from:** read-only binary string recovery + live read-only SQL Server metadata queries. **No file in `E:/Pharma Software` and no row in the database was modified.**

---

## Evidence Sources Used

| # | Source | What it gave us |
|---|--------|-----------------|
| E1 | `E:/Pharma Software/V2_AbuzarSoftware/Application/*.pbd` — **120 compiled PowerBuilder 12.5 libraries** (verified count; the working brief said 122 — the directory contains exactly 120 `.pbd` plus `abuzar.exe`, `mdsys.exe` and 90 support DLL/OCX/WAV/BMP files) | Object catalogue (windows, DataWindows, menus, user objects, structures), embedded SQL, UI label text, validation messages, keyboard-shortcut text, device model lists |
| E2 | Derived string corpus: `…/scratchpad/pbdstr/*.txt` (120 files, ASCII + UTF‑16LE runs ≥5 chars) | 5,283,020 UTF‑16 string occurrences; 12,470 recovered `SELECT` fragments; 4,385 distinct colon-terminated field labels; 2,880 distinct validation/error strings |
| E3 | Derived catalogues: `…/scratchpad/pbd_defined_objects.tsv` (11,587 rows), `pbd_summary.tsv`, `win_clean.tsv` (2,066 windows), `menu_items_max.txt` (1,761 menu items) | Per-library object inventory |
| E4 | **Live DB** `FazalDinPP19DataBaseV2` (read-only `SELECT`): `dbo.Module`, `dbo.Rights`, `dbo.Rightsclone`, `dbo.GroupRights`, `dbo.Groups`, `dbo.Users`, `dbo.StartupRight`, `dbo.SpecialRight`, `dbo.SoftwarePreferences`, `dbo.PreferencesCategory`, `dbo.PreferencesSubCategory`, `dbo.SaleCategory`, `dbo.SaleType`, `dbo.Godown` | **Independent corroboration** of menu tree, module names, role rights, and — critically — the *live, per-field visibility configuration* of the Sale screen |
| E5 | `…/scratchpad/table_columns.tsv` (11,414 columns), `table_rowcounts.tsv` (762 tables) | Cross-referencing recovered `Table.Column` tokens against the real schema; proving used-vs-dormant screens |
| E6 | `E:/Pharma Software/ABUZAR_V2_RECOVERY_JOURNAL.md` | Environment ground truth |

**Recovery technique (all read-only):** each `.pbd` was read as a byte array, decoded Latin‑1, and scanned with two regexes — `[\x20-\x7E]{5,}` (ASCII runs) and `(?:[\x20-\x7E]\x00){5,}` (UTF‑16LE runs). PowerBuilder stores object-catalogue entries with type suffixes (`.win`, `.dwo`, `.men`, `.udo`, `.str`, `.fun`, `.apl`, `.pro`), embedded DataWindow `SELECT` text and label/validation literals in UTF‑16LE — all of which survive compilation. Script bytecode, control geometry (x/y/width/height), tab order and per-control colours do **not** survive as readable text.

---

## Evidence-Label Legend (used on every material claim)

| Label | Meaning |
|---|---|
| **Verified** | Read directly from a PBD object-catalogue entry, an embedded literal, live schema, or live data. Reproducible. |
| **Strongly Inferred** | Multiple converging pieces of evidence (e.g. recovered window name + recovered SQL + matching schema table + matching `dbo.Rights` entry) but not literally stated anywhere. |
| **Unclear** | Evidence is ambiguous or insufficient. |
| **Missing** | Expected but not present in any evidence source. |
| **Deprecated** | Present but superseded by a newer object in the same library. |
| **Broken/Incomplete** | Present and evidently non-functional or half-built. |
| **Recommended** | A proposal for the NEW system. **Never an existing feature.** |

> **Rule applied throughout:** an *empty table* is evidence that a feature is **not used at this deployment**, not evidence that the feature does not exist in the product. The two are separated explicitly in §11.

---

# 1. Executive Summary of the Screen Layer

**Verified.** The application's presentation layer consists of:

| Object type | Count | Distributed across |
|---|---:|---|
| **Windows (`.win`) — i.e. screens/dialogs** | **2,066** | 75 of 120 libraries |
| DataWindow objects (`.dwo`) — grids, forms, print layouts | **8,747** (8,735 distinct names) | 102 libraries |
| Menus (`.men`) | 156 | 40 libraries |
| Visual/non-visual user objects (`.udo`) | 100 | 10 libraries |
| Global functions (`.fun`) | 460 | 12 libraries |
| Structures (`.str`) | 54 | 22 libraries |
| Application objects (`.apl`) | 2 — `traderappv1.apl`, `remote_datawindow_appl.apl` | `abuzarapp.pbd`, `pbdwr125.pbd` |

*Evidence: `…/scratchpad/pbd_defined_objects.tsv`; e.g. `salewin` → `w_sale.win`, `w_sale_popup.win`, `w_saleinvgroup.win`, `w_installmentsale.win`, `w_salebalanceqty_slip.win`, `m_salemenu.men`, `d_saledetail.dwo`.*

**The PowerBuilder application object is named `traderappv1`** — i.e. this pharmacy system is a *skin* over a generic trading/distribution product. **Verified** (`abuzarapp.pbd` → `traderappv1.apl`).

**Classification of the 2,066 windows** (**Strongly Inferred** from naming convention, corroborated by contents):

| Class | Count | Naming rule | Example |
|---|---:|---|---|
| Report **parameter/argument dialogs** | **838** | `w_arg_*` | `w_arg_customers_sdate_ldate_salecriteria` |
| Transaction & general windows | 876 | everything else | `w_sale`, `w_purchase`, `w_adjwindow` |
| **Master-data entry forms** | 237 | `*_form`, `*_form_popup` | `w_item_form`, `w_customer_form` |
| Search / selection popups | 35 | `w_popup_*` | `w_popup_responsivesearch_selection` |
| Edit / modify dialogs | 27 | `w_edit*`, `w_modify*`, `*_update` | `w_editpostedinvoice` |
| Read-only viewers | 15 | `w_view_*`, `w_preview*` | `w_view_saleheader` |
| "Copy-from" dialogs | 14 | `w_copy*` | `w_copysaleinvoicefrom` |
| Report windows | 13 | contain `report` | `w_cashiershiftreport` |
| List/browse windows | 11 | `*_list` | `w_purpayment_list` |

**The single most important structural fact: 838 of 2,066 windows (41%) are report-parameter dialogs, and a further ~3,200 DataWindows are client-branded print layouts.** The application is, by object count, primarily a *reporting and printing* system with a comparatively small transactional core.

---

# 2. Recovery Coverage — What We Got, What We Did Not

**This section is deliberately blunt. Do not treat this document as a pixel-accurate UI spec.**

| UI aspect | Recovery | Confidence |
|---|---|---|
| **Complete list of screen (window) names** | ✅ ~100% | **Verified** — read from the PBD object-catalogue entry table, which is uncompressed |
| Complete list of DataWindow (grid/form/report) names | ✅ ~100% | **Verified** |
| Complete list of menu object names | ✅ 100% (156 menus); 1,761 distinct menu *item* names | **Verified** for objects; menu item names are **Strongly Inferred** (PB derives item names from item text) |
| Which library each screen lives in | ✅ 100% | **Verified** |
| Data binding — which tables/columns a screen reads/writes | ✅ High (12,470 recovered `SELECT` fragments, cross-checked against 11,414 real columns) | **Verified** where the fragment is complete; **Strongly Inferred** where truncated |
| Field **labels** (captions) | ✅ 4,385 distinct captions recovered | **Strongly Inferred**, and **Verified** for the Sale screen (corroborated by `dbo.SoftwarePreferences.Caption`) |
| **Validation rules & error messages** | ✅ 2,880 distinct strings | **Verified** (literal strings) |
| Keyboard shortcuts | ✅ ~70 distinct | **Verified** (literals + `dbo.Rights.RightName`) |
| **Control geometry** — x, y, width, height, layout | ❌ **0%** | **Missing** — compiled binary; would require a PBD decompiler |
| **Tab order** | ❌ 0% | **Missing** |
| Per-control **fonts and sizes** | ⚠️ Typefaces only (Arial 16,762; Times New Roman 9,735; Arial Narrow 7,302; Tahoma 3,470; Verdana 125; Jameel Noori Nastaleeq 57 (Urdu); MS Sans Serif 33; Calibri 12; Courier New 7). **Point sizes not recoverable.** | **Verified** (typefaces) / **Missing** (sizes) |
| Per-control **colours** | ⚠️ Only where written as a DataWindow expression (see §9.3) | **Verified** for the recovered expressions; **Missing** for static control colours |
| Event script logic | ❌ 0% (bytecode) | **Missing** — the authoritative behaviour is the 762 DB programmable objects (see docs 05a/05b/07/08) |
| Screenshots of the running UI | ❌ Not attempted (out of scope for this read-only pass) | **Missing** |

**Bottom line: the *inventory* of the UI is essentially complete and trustworthy. The *appearance* of the UI is not recovered.** Where this document describes layout it says so explicitly and labels it **Strongly Inferred** or **Unclear**.

---

# 3. Application Shell — Startup, Login, Frame

**Library:** `abuzarapp.pbd` (3.95 MB) — 26 windows, 51 DataWindows, 1 menu (`m_main.men`), 1 application object.
*Evidence: `pbd_defined_objects.tsv` rows `abuzarapp\ttraderappv1.apl`, `abuzarapp\tm_main.men`, `abuzarapp\tw_login.win`, …*

| Screen | Object | Purpose (label) | Evidence |
|---|---|---|---|
| Splash / logo | `w_logo`, `w_bkg` | Startup splash; `Logo.bmp`, `logo_1.bmp`, `Welcome.Wav`, `GoodBYE.wav` present in the Application folder | **Verified** (objects + asset files) |
| Startup sequencer | `w_startup` | Runs startup checks; `dbo.StartupRight` (5 rows) drives what auto-runs at launch | **Verified** — live: `1 B Manual Backup Y`, `2 B Auto Client Backup Y`, `3 B Auto Startup Backup Y`, `4 R Exipry Report d_expiryreport Y`, `5 R Re-Order Level Report d_reorderlevelreport Y` |
| **Login** | `w_login`, `w_login1` | User/password. Message on failure: *"Either User name does not exist or User is marked InActive."*, *"Please enter a valid user/password"* | **Verified** (literals in `abuzarapp.txt`) |
| MDI frame | `w_main` + `m_main` | Main application frame carrying the whole menu bar | **Verified** (objects); layout **Missing** |
| Licence activation | `w_activation`, `w_administrator_key`, `w_startuprightsmodification_key`, `w_backupinfo_for_verificatioin` | Licence key entry — strings `Activation Key`, `Administrator Key`, `&Renew License`, `+systemkey`, `+ue_enterkey` | **Verified** |
| DB utilities | `w_dbbackup1`, `w_autorecovery`, `w_checkdb`, `w_dbmsinfo`, `w_backupinfo` | Backup / integrity / restore | **Verified** |
| Access & security | `w_access`, `w_module_password`, `w_special_rights_password` | Per-module and "special right" password gates | **Verified** |
| Preferences entry points | `w_newpreferences`, `w_oldpreferences` (in `components`), `w_pointofsalepreferences`, `w_pointofsalesettings`, `w_autopricingsettings`, `w_godownsettings` | Settings screens | **Verified** |
| Legal | `w_disclaimerwindow`, `w_about` | Disclaimer text recovered: *"…waseela application in order to safeguard the user's interest from potential data loss or any other such clamity."* / *"Abuzar Consultancy will not stand responsible/liable for any such potential/ac…"* | **Verified** (literals, including the original spelling error "clamity") |

### 3.1 Security observations at the shell layer

| Finding | Label | Evidence |
|---|---|---|
| App user passwords are **plaintext** in `dbo.Users.Password` | **Verified** | Live: `1\|ADMIN\|pakistan9080`, `2\|RAEES KHAN\|1`, `3\|DR SAIRA\|55`, `4\|ZUBAIR ARIF\|z0`, `5\|SHAZIB\|25` |
| Passwords are trivially weak (`1`, `55`, `z0`, `25`) | **Verified** | same query |
| A second, hard-coded "special rights" password gate exists | **Verified** | `dbo.SpecialRight` → all four rows share `RightPwd = 'spcadminsecrets'`; all currently `Enable = 'N'`. Rights: *Modify Posted Sales / Sales Return / Purchases / Purchase Return* |
| Database **backup media password is hard-coded in the binary** | **Verified** | `abuzarapp.txt`: `With PASSWORD = 'alfia`, `With RECOVERY, REPLACE, PASSWORD = 'alfia`, `With INIT, MEDIAPASSWORD = `, `', MEDIAPASSWORD = 'alcia` |
| The vendor's **other clients' names, cities and addresses are compiled into `abuzarapp.pbd`** | **Strongly Inferred** | 271× `Lahore`, 70× `Green Plus Pharmacie`, 68× `Islamabad`, plus dozens of pharmacy trade names and industrial-estate addresses adjacent to `LCkeycode.U` licence strings. Consistent with an embedded licence/keycode table. |
| Third-party **customer account names appear inside `components.pbd`** (e.g. `M/S. FAUJI FOUNDATION HOSPITAL 163`, `AGA KHAN HOSPITAL`, `ALI AKBAR SPINNING MILLS LTD.`) although this deployment's `dbo.Customer` has only **2 rows** | **Strongly Inferred** (data leak) | Strings present in `components.txt`; live `Customer` rowcount = 2, so these are certainly **not** Fazal Din's data. Most likely residual dropdown/sample data captured at build time from another site. |

---

# 4. The Menu Tree (Navigation Model)

The menu bar is compiled into `m_main.men`. Menu **item text** did not survive as readable strings, but two independent sources reconstruct the tree:

1. **`dbo.Rightsclone` (2,122 rows)** — a persisted snapshot of the *full product* menu tree, with `LevelIndex` (depth) and `IndicesString` (the menu path as comma-separated indices). **Verified.**
2. **`dbo.Rights` (486 rows)** — the *currently configured* right set at this deployment. **Verified.**
3. 1,761 maximal `m_*` object names recovered from the PBDs (PowerBuilder derives menu item names from item text, so `m_areawisesalessummary` ⇒ menu item "Area Wise Sales Summary"). **Strongly Inferred.**

### 4.1 Top-level menu bar — full product (from `Rightsclone`) — **Verified**

| Index | Menu | 2nd-level items in product |
|---|---|---:|
| 2 | **Purchase** | 22 |
| 3 | **Sales** | 31 |
| 4 | **Transactions** | 11 |
| 5 | **Reports** | 35 |
| 6 | **Basic Data** | 50 |
| 7 | **Maintenance** | 55 |
| 8 | **Manage** | 44 |
| 9 | **E‑Prescription** | 4 |
| 10 | **Patient Management** | 11 |
| 11 | **Activities** | 4 |

*Evidence: `SELECT IndicesString, LevelIndex, MenuName FROM dbo.Rightsclone WHERE LevelIndex IN (1,2)`.*

### 4.2 Top-level menu — **as configured at Fazal Din PP19** (from `Rights`) — **Verified**

Only **7** of the 10 top-level menus have configured rights: `Purchase`, `Sales`, `Reports`, `Basic Data`, `Maintenance`, `Manage` (index 2,3,5,6,7,8). **`Transactions` (4), `E‑Prescription` (9), `Patient Management` (10) and `Activities` (11) have no rights rows** at this site.
**Unclear:** whether the corresponding menus are *hidden* or merely *unrestricted*. The `Rights` table drives the permission-assignment UI, not necessarily menu visibility; §11 uses row counts, not this table, to determine actual use.

### 4.3 `Sales` sub-menu — full product — **Verified**

`Retail Sale` · `Whole Sale` · `Sale Return` · `Open Sale Return` · `Satisfy Sales Due Items` · `Delete Due` · `Quotation` · `Service In Sale` · `Service Return` · `POS Sale` · `Service Order` · `In-Patient` · `Sale Return Allocation` · `Sale Invoice Marking` · `Sale Return Marking` · `Satisfy Sale Due DateWise` · `Proforma Sales Invoice` · `Sale Order` · `Cash On Invoices (Unposted)` · `Sales Return` · `Delivery Challan` · `Advanced Sale` · `Service Result` · `Item Inquiry Window` · `Sale Invoice Group` · `Expiry Intimation - Sale Based` · `Sale Invoice Deletion - In Bulk` · `Refused Sales` · `Packing Job` · `Installment Processing`

### 4.4 `Purchase` sub-menu — full product — **Verified**

`Purchases` · `Purchase Return` · `Opening Purchase` · `Purchases (Loose)` · `Goods Receiving Notes` · `Purchase Order` · `Purchase Return Allocation` · `Purchase Invoice Marking` · `Purchase Return Marking` · `Purchase Quotation` · `Advanced Purchases` · `Purchase Register` · `Proforma Purchase` · `Expiry Intimation - Purchase Based` · `Imported Purchases` · `Services` · `Item Cost History` · `Pre-Sales`

### 4.5 `Reports` sub-menu — 35 report families — **Verified**

`Daily Reports` · `Stock Report` · `Sales Reports` · `Purchase Reports` · `Accounts Reports` · `Listing` · `Lables` [sic] · `RePrinting` · `Sale Return` · `Patient Reports` · `BarCode Printing` · `Item Reports` · `Godown Reports` · `Purchase Return Reports` · `Service Reports` · `Special Reports` · `Customer Sitel Reports` [sic] · `Issue Reports` · `Receipt Reports` · `Sales Order Reports` · `Attendance Reports` · `Open Powersoft Report Viewer` · `Sales Template Reports` · `User Reports` · `Refused Sales Reports` · `CRS Reports` · `Guest Reports` · `Student Reports` · `Loyalty Reports` · `Employee Reports` · `Installment Reports` · `Data Import Reports` · `Passport Reports` · `Production Reports` · `Product Reports`

Reports go 5 levels deep. Example verified path (`IndicesString = 5,26,5,1,1,`): **Reports → CRS Reports → CRS Accounting Reports → CRS Ledger Reports → CRS Customer Ledger**.

### 4.6 `dbo.Module` — 57 named modules — **Verified**

`dbo.Module` (queried live) names the document/transaction types the UI can open. Modules 1–53 plus 101–104:

`SALES` · `SALES RETURN` · `PURCHASE` · `PURCHASE RETURN` · `ISSUE` · `RECEIPT` · `ADJUSTMENT` · `TRANSFER` · `ITEM` · `CASH SALE` · `CREDIT SALE` · `SALE ORDER` · `TRANSFER (TARGET)` · `PATIENT REGISTRATION` · `QUOTATION` · `PURCHASE ORDER` · `PRESCRIPTION` · `PATIENT PROFILE` · `VISIT APPOINTMENT` · `PATIENT VISIT` · `ADVANCED SALE` · `CASH SERVICE` · `CREDIT SERVICE` · `CUSTOMER` · `IN-PATIENT SALE` · `PROFORMA SALE` · `IN-PATIENT SERVICE` · `CASH SERVICE RETURN` · `CREDIT SERVICE RETURN` · `IN-PATIENT SERVICE RETURN` · `CASH SALE RETURN` · `CREDIT SALE RETURN` · `BUFFER SALE RETURN` · `IN-PATIENT SALE RETURN` · `POINT OF SALE` · `PATIENT ADMISSION` · `RECEIPT TRANSACTION` · `PAYMENT TRANSACTION` · `SALE TEMPLATE` · `ISSUE REQUEST` · `Service Basic Data` · `GUEST CHECK IN` · `Purchase Of Services` · `Purchase Return Of Services` · `A/C VOUCHERS` · `Customer License` · `Customer Site` · `Item Registration Request` · `Garments Basic Data Wizard` · `Installment Receipt` · `Sale Of Services` · `Sale Return Of Services` · `Change Item Price` · `Cash Receipt` · `Cash Receipt Against Sale` · `Cash Payment` · `Cash Payment Against Purchase`

This is direct corroboration that the same binary serves pharmacies, hospitals, schools (`Student`), hotels (`Guest`), garment factories (`Garments Basic Data Wizard`, `w_item_garments_wizard`) and vehicle dealers (`MotorVehicle`).

---

# 5. Screen Architecture Pattern

**Strongly Inferred, with strong DataWindow-name evidence.** Every transaction screen in this product follows one rigid pattern:

```
w_<txn>                              (the MDI sheet window)
├── dw_header   → d_<txn>header      (invoice header: date, party, refs)
├── dw_detail   → d_<txn>detail      (the line-item GRID — the workhorse)
├── dw_footer   → d_<txn>footer      (totals, discounts, misc charges)
├── dw_list     → d_<txn>list        (list of existing invoices, toggled by a "List" tab)
└── m_<txn>menu                      (a per-window menu replacing the frame menu)
```

*Evidence (Verified): `purchasecomponents` defines `d_normalpurchaseheader.dwo`, `d_normalpurchasedetail.dwo`, `d_prchasefooter.dwo` [sic — misspelled in the product], `d_normalpurchaselist.dwo`; `salereturncomponents` defines `d_retailsalereturn.dwo`, `d_retailsalereturndetail.dwo`, `d_salereturnfooter.dwo`, `d_retailsalereturnlist.dwo`; `adjustment` defines `d_adjheader/d_adjdetail/d_adjfooter/d_adjlist`; `receiptcomponents` defines `d_receiptheader/d_receiptdetail/d_receiptfooter/d_receiptinvlist`. Control names `dw_header`, `dw_detail`, `dw_footer`, `dw_list` recovered from `salewin.txt`.*

A parallel `_view` set exists for read-only display of posted documents: `d_saleheader_view`, `d_saledetail_view`, `d_salefooter_view`, `d_adjheader_view`, `d_receiptheader_view`, `d_duesatisfy_header_view`… **Verified.**

**Response (modal) windows** are segregated into dedicated libraries — `salerespwin.pbd` (77 windows), `multientryitemrespwin.pbd` (22), `purchaseresponsewin.pbd` (18), `accountsrespwin.pbd` (13). **This is the single strongest structural indicator of the modal-chain problem described in §9.2.** **Verified.**

---

# 6. Deep Dives — The 14 Screens That Matter

> Each deep dive gives: object, library, module, role, fields, actions, validation, tables, accessibility problems, mobile verdict, evidence.
> **Field lists below are the DataWindow's *bound columns*, recovered from embedded `SELECT` text. A bound column is not necessarily a visible control** — visibility for the Sale screen is separately **Verified** from `dbo.SoftwarePreferences` (§6.2.3).

---

## 6.1 `w_sale` — Sale Invoice (Retail / Wholesale / Credit) — **THE flagship screen**

| Attribute | Value |
|---|---|
| **Window object** | `w_sale.win` (+ `w_sale_popup.win`) |
| **Library** | `salewin.pbd` (9.35 MB) — 5 windows, 66 DataWindows, 3 menus, 10 structures |
| **Menu** | `m_salemenu.men` |
| **`dbo.Module`** | 1 `SALES`, 10 `CASH SALE`, 11 `CREDIT SALE`, 31 `CASH SALE RETURN`, 32 `CREDIT SALE RETURN` |
| **Menu path** | `Sales → Retail Sale` / `Sales → Whole Sale` (`Rightsclone` `3,1,` and `3,2,`) |
| **Primary role** | Cashier / Sales Officer (group 12), Shift Incharge (group 11) |
| **Live usage** | `SaleLedger` = **291,334** invoices; `SaleDetail` = **620,525** lines |

*Evidence: `pbd_defined_objects.tsv` → `salewin\tw_sale.win`; `dbo.Module` rows 1/10/11; `dbo.Rightsclone` `3,1,`→"Retail Sale".*

### 6.1.1 DataWindows composing the screen — **Verified**

| Control | DataWindow | Role |
|---|---|---|
| `dw_header` | `d_retailsaleheader` / `d_wholesaleheader` | Invoice header |
| `dw_detail` / `dw_saledetail` | `d_saledetail` / `d_retailsaledetail` / `d_wholesaledetail` | Line-item grid |
| `dw_footer` | `d_salefooter`, `d_salefooter2`, `d_wholesalefooter` | Totals & invoice-level discounts |
| `dw_list` | `d_salesinv_list`, `d_retailsaleinvlist`, `d_wholesaleinvlist`, `d_creditsaleinvlist_modified` | Invoice browse list |
| — | `d_saleinvoice_json` | FBR digital-invoice JSON payload builder |
| — | `d_saleinvlist_notfiscalized` | Un-fiscalized invoice worklist |
| — | `d_salecomments`, `d_saleinvmarking`, `d_salesetsheader/detail`, `d_positem`, `d_sale_recipedetail` | Sub-features |

### 6.1.2 Header fields (bound columns of `d_retailsaleheader`) — **Verified**

Recovered verbatim from the embedded `SELECT`:

```
saleledger.saleinvcode, saleledger.altersaleinvcode, saleledger.salecatcode,
saleledger.date, saleledger.billingdate, saleledger.custrefno, saleledger.remarks,
saleledger.custcode, saleledger.shiptocustomer, saleledger.salesmancode,
saleledger.headerno, users.username, saleledger.discperc, saleledger.flatdisc,
saleledger.misccharges, misccharges1..misccharges5, saleledger.salestax,
saleledger.posted, saleledger.postdate, customer.address1, customer.city, customer.phone,
customerbalance = 0, debitorcredit = ' ',
aliasname = (SELECT Accounts.AliasName FROM Accounts WHERE AccCode = SaleLedger.CustCode),
saleledger.headerinvno, saleledger.originaldate, saleledger.modifiedby, saleledger.sprice,
saleledger.quotationno, saleledger.postedby, saleledger.doctcode,
patientRegNo = (SELECT P.RegNo FROM Patient P WHERE P.PatientCode = saleledger.patientcode),
saleledger.patientcode, PatientBalance = 0.00,
PointsBalance = ISNULL((SELECT SUM(LCL.PointsDebit - LCL.PointsCredit)
                        FROM LoyaltyCardLedger LCL WHERE LCL.AccCode = SaleLedger.CustCode), 0),
GuestRegNo=…, SaleLedger.GuestCode, SaleLedger.GuestCheckInCode, GuestBalance,
StudentRegNo=…, SaleLedger.StudentCode, StudentBalance,
cashreceived, invGSTPerc1 = saleledger.InvGstPerc1, saleledger.gstno,
saleledger.PrintWaranty, saleledger.PrintBatch, saleledger.MessageCode, …
```

Additional bound header columns recovered from the DataWindow column table (each shown as `<col>` / `SaleLedger.<Col>`):
`wardcode`, `diseasecode`, `relationcode`, `itemdiscpercno`, `unreceivedbalance`, `admissioncode`, `printbalance`, `AccountFor`, `PaymentMode`, `PaymentAccCode`, `Amt`, `AmtBy`, `AmtDate`, `AmtReference`, `Outstandingamt`, `marked`, `deliveredby`, `prescode`, `pptcustcode`, `balance`, `impactinventory`, `saleordercode`, `salecomments1`, `salecomments2`, `saletypecode`, `recurringinvoice`, `recurringperiod`, `recurringagainst`, `ConsiderInPO`, `visitcode`, `duedate`, `SRBufferInvCode`, `CustRefNo5`, `SuppInvCode`, `GRN`, `GCCode`, `Vehicle`, `ShipTo`, `AssociatedPurInvCode`, `ModuleId`, `DocCode`, `GuaranteePersonCode`, `CashTendered`, `CashCharged`, `CashBack`, `cashacccode`, `CustLicNo`, `CustLicExpiry`, `saletypeinvno`, `custsitecode`, `currencycode`, `ConversionRate`, `PreviousReading`, `CurrentReading`, `NextChange`, `SourceSaleInvCode`.

**≈ 90 bound header columns.** **Verified.**

### 6.1.3 Line-item grid fields (`d_saledetail`) — **Verified**

Recovered verbatim (abridged; the full `SELECT` is a `GROUP BY` aggregate over `SaleDetail` joined to `Item`, `UNION ALL`-ed with a second branch for new rows):

| Column | Source / expression | Type (from schema) | Notes |
|---|---|---|---|
| `customicode` | `item.customicode` | varchar | Item barcode/short code |
| `AlternateCustomICode` | `SaleDetail.AlternateCustomICode` | varchar | |
| `itemname` | `item.name` | varchar | |
| `itemtypecode` | `item.itemtypecode` | | |
| `locksaleprice`, `lockdiscperc` | `dbo.item.*` | char | **Drives read-only state of Price / Disc% cells** |
| `AllowSaleInDecimalQty` | `dbo.item.AllowSaleInDecimalQty` | char | Drives decimal-qty validation |
| `stock`, `totalstock` | computed 0.0000, filled by script | numeric | |
| `QuickSearch` | `SPACE(100)` | | The type-ahead item search cell |
| `itempacking` | `(SELECT IP.Name FROM ItemPacking IP WHERE IP.Packcode = saledetail.icode)` | | |
| `packingdesc`, `qtysale`, `bonus` | `item.*` | | |
| `purprice`, `recentpurprice`, `avgprice`, `LatestNetRate` | computed | numeric | **Right-gated** — see §6.1.6 |
| `gcode` | `saledetail.gcode` | | Godown |
| `itemmetercode`, `itemmetername`, `meterreading` | `SaleDetail` + `ItemMeter` | | Utility-meter billing (unused here) |
| `PreDiscPerc` | `max(ROUND((Saledetail.itemflatdisc / CASE WHEN Saledetail.SalePrice > 0 THEN Saledetail.SalePrice ELSE 1 END) * 100, 2))` | | |
| `itemflatdisc`, `saleprice`, `rate`, `salestax`, `discperc`, `packunits`, `packqty`, `looseqty`, `bonusqty` | `saledetail.*` aggregates | numeric | Core money/qty columns |
| `Due`, `SatisfiedDate`, `DueQty` | `saledetail.*` | | Partial-delivery ("due") tracking |
| `SaleItemDescription`, `InsCode`, `DescICode`, `claimable`, `claimablediscperc` | `saledetail.*` | | Insurance/claim fields |
| `rowgroup`, `saleorderrowid`, `salerowid`, `issuerowid`, `RefusalSaleRowID`, `sourcesaleinvcode` | `saledetail.*` | | Cross-document links |
| `packprice`, `purunitrate`, `rppunitrate`, `BatchCost`, `alternatepurprice` | `saledetail.*` | | |
| `UnitWeight`, `PackingFactor`, `PackCapacity`, `AreaVolume`, `Length` | `item.*` | | Garments/tiles verticals |
| `RatePerLength` | `Round(max(saledetail.saleprice) / CASE WHEN Item.Length > 0 THEN Item.Length ELSE 1 END, 2)` | | |
| `PCS` | `ROUND(sum(saledetail.looseqty) / CASE WHEN item.AreaVolume IS NULL OR <= 0 THEN 1 ELSE item.AreaVolume END, 6)` | | |
| `Cartons` | string expression producing `"<cartons> : <remainder>"` | | |
| `gstperc`, `unitsalestax`, `ExtraTaxPerc` | `saledetail.*` / computed | | Pakistani tax columns |
| `CommissionPerUnit`, `CommissionPerc` | `saledetail.*` | | |
| `TotalPieces`, `PiecesInHand` | `saledetail.*` | | |
| `YourLotNo`, `YourExpiry`, `YourPacking` | `MAX(saledetail.*)` | | Supplier's batch data |

**≈ 70 bound grid columns.** **Verified.**

### 6.1.4 In-grid validation rules (DataWindow column validations) — **Verified, literal**

| Column | Validation expression / message |
|---|---|
| Extra Tax % | `'Extra Tax % value should be between 0 and 100'` |
| Discount % | `'Discount % value should be between 0 and 100'`, `'Discount (%) must be between 0 and 100'` |
| Claimable Disc.% | `'Claimable Discount % value should be between 0 and 100'` |
| Inv-level GST % | `'Inv. Level GST % should be between 0 and 100'` |
| Item Flat Disc | `'Item flat disc should be equal or greater than zero'` |
| Qty | `'Qty should be greater than zero'`, `'Quantity must be greater or Equal to zero'` |
| Bonus Qty | `'Bonus Qty should be greater than or equal to zero'` |
| Pack Qty / Pack Price | `'Pack Qty should be greater than or equal to zero'`, `'Pack Price must be greater or Equal to zero'` |
| Sale Price | `'Sale Price should be greater than zero'` |
| Misc charges | `'Miscellaneous Charges should be greater equal zero'` |
| Conversion Rate | `Real(GetText()) >= 0` → `"Conversion Rate Must be +ve."` |
| Recurring Period | `Real(GetText()) >= 0` → `'Please Enter Valid Period in Days'` |
| Length / Width | `'Length should be greater than zero'`, `'Width should be greater than zero'` |
| Invoice total | `'Invoice total can not be negative'` |

Note the **shipped typos** (present in the running product): `"Dsicount % value should be between 0 and 100"`, `"must be betweeen 0 and 100"`, `"Inv. Level Disc. % should be beteen 0 and 100"`. **Verified.**

### 6.1.5 Business-rule blocks raised from this screen — **Verified, literal**

| Message | What it enforces |
|---|---|
| `Item can not be sold, its Stock is Zero` | Stock gate |
| `Item Right Not Allowed To Sale Below Avg. Price` / `User/Group Not Allowed To Sale Below Avg. Price` | Margin floor, item-level and group-level |
| `Net Sale Price is exceeding Retail Price at Row ` | Ceiling check |
| `Total Recivable From Customer Exceeds Credit Limit` [sic] | Credit limit |
| `Kindly write reason for exceeding cautious limit in customer reference no. 2` | Soft credit limit → forces a free-text justification into `CustRefNo2` |
| `Cash Sale Walking Customer is not allowed in Credit Sales` | Cash/credit separation |
| `SalePrice is locked, you can not change it` / `Disc(%) is locked, you can not change it` | `Item.LockSalePrice` / `Item.LockDiscPerc` |
| `Sale Quantity In decimals is not allowed for this item` (+ Pack/Bonus variants) | `Item.AllowSaleInDecimalQty` |
| `Hence More than one sale godwon is not allowed on an invoice.` [sic] | One-warehouse-per-invoice |
| `Please select items of specific header only.` / `…specific godown only.` | Header/godown homogeneity |
| `Doctor is compulsory, Please select valid doctor` / `please type Doctor name in remarks` | Prescription capture |
| `Patient NIC does not exist. Please select a patient with valid nic` | Patient linkage |
| `Due not Allowed on this item.` | Partial-delivery gate |
| `Reason: Posted Sale Invoice can not be deleted` | Immutability of posted docs |
| `Can not Modify Deleted Sales Invoice` / `Can not print deleted sales invoice` | Soft-delete semantics |
| `Current user group does not have enough permissions w.r.t customer to make sale.` | Customer-scoped rights |
| `Please respect the upper limit imposed on sale of this item` | Narcotic/controlled-item cap |
| `Duplicate Item, please select some other item` | No duplicate line items |
| `Sale Invoice Can not be saved without a valid sale order Reference.` | SO enforcement |

### 6.1.6 Actions / commands — **Verified** (from `dbo.Rights` + recovered menu/button strings)

Buttons recovered: `cb_save`, `cb_print`, `cb_cancel`, `cb_retrieve`, `cb_filter`. Menu/label literals: `&Save And Return`, `Sa&ve and Print`, `Save &as Template`, `&Print`, `&Open ...`, `&View Header`, `Lis&t`, `De&tail`, `Quic&k Search`, `&Filter`, `Edit Sale Te&mplate`, `Post Sale Invoices &w.r.t Patient`.

Right-gated actions (all **Verified** rows of `dbo.Rights`, `Object='W'`):

| Right | Shortcut |
|---|---|
| Save Invoice | `Ctrl + S` |
| Save and Post | `Ctrl + Q` |
| Open / populate invoice | `Ctrl + G` |
| Show Item Purchase History | `Ctrl + H` |
| Show Godown Wise Stock | `F6` on Qty |
| Show Unit Qty Calculator | `F7` on Qty |
| Show Batch Sale Price Selection | `F8` on Qty |
| Show Qty/Rate/Value Calculator | `F9` on Qty |
| Digitalize Sale Invoice | `CTRL+SHIFT+D` |
| Update Digital Invoice Info | `CTRL+SHIFT+M` |
| Generate Sales From Pending Quotations | `CTRL+SHIFT+G` |
| Print Patient Labels | `CTRL+Shift+L` |
| Apply Customer Associated Quotation | `Alt+F8` |

Additional shortcut literals recovered from `salewin.pbd` (**Verified**): `Alt+E`, `Alt+U`, `Alt+F1`, `Alt+F2`, `Alt+F3`, `Alt+F6`, `Alt+F7`, `Alt+F9`, `Alt+F10`, `Alt+F11`, `Alt+F12`, `Ctrl+A`, `Ctrl+B`, `Ctrl+E`, `Ctrl+F1`, `Ctrl+F6`, `Ctrl+F9`, `Ctrl+F10`, `Ctrl+F11`, `Ctrl+F12`, `Ctrl+Ins`, `Ctrl+J`, `Ctrl+K`, `Ctrl+M`, `Ctrl+O`, `Ctrl+R`, `Ctrl+U`, `Ctrl+Y`, `Shift+F1`.

Further right-gated *display* toggles: Show Pre Disc. %, Show Net Amount Column In List Window, Display Price List In Sale, Display (PurchasePrice, RecentPurchasePrice, AvgPrice), Preview Sale Invoice Margin, Show Branch Wise Item Stock Position, Show Customer Wise Sale Detail Report, Show Refused Sale Entry Form, Attach Document(s), Show Document Gallery, Override Customer Credit Limit, Modify Sale Price Upward / Downward, Fiscalize Sale Invoice(s).

### 6.1.7 Related tables — **Verified** (recovered `Table.Column` tokens ∩ real schema)

| Table | Recovered refs |
|---|---:|
| `SaleLedger` | 1,082 |
| `SaleDetail` | 696 |
| `Item` | 511 |
| `InstallmentHeader` | 448 |
| `Accounts` | 80 |
| `Customer` | 66 |
| `IssueDetail` | 38 |
| `SaleLedgerModified` | 35 |
| `InstallmentDetail` | 27 |
| `SaleInvGroup` | 23 |
| `Patient` | 22 |
| `Users` / `SaleDetailModified` | 15 each |
| `SaleInvGroupDetail`, `GuaranteePerson` | 14 each |
| plus `Message`, `Salesman`, `InstallmentGuarantor`, `Groups`, `Guest`, `Student`, `SaleSetsHeader`, `Area`, `Supplier`, `PricePolicy`, `MotorVehicle`, `ItemSuppliers`, `GodownDetail` | ≤ 12 each |

### 6.1.8 Companion / modal windows launched from `w_sale`

`salewin.pbd` + `salerespwin.pbd` (77 modal windows). **Verified** object names:

`w_iteminfo` · `w_itemsalehistory` · `w_itempurchasehistory` · `w_previnvinfo` · `w_customerinfo` · `w_customerinfo_view` · `w_customercomment_view` · `w_discountcalculator` · `w_discountonretailcalculator` · `w_pricecalculator` · `w_qty_rate_value_calculator` · `w_unitqtycalculator` · `w_misccharges_breakup` · `w_set_misccharges` · `w_set_flatdiscamt` · `w_set_due_date` · `w_salecomments` · `w_saledocument` · `w_saledocument_gallery` · `w_salesets_form` · `w_salesmanpassword` · `w_salesmanpassword_invtype` · `w_special_rights_password` · `w_module_password` · `w_popup_godownselection` · `w_popup_areaselection` · `w_popup_batchselection` · `w_popup_itemselection` · `w_popup_editsaledetail` · `w_popup_saleitemdescription` · `w_view_godownwiseitemstock` · `w_view_saleheader` · `w_holdsaledetail` · `w_printer_copies` · `w_preview_invoices` · `w_refusedsale_form` · `w_savesaleastemplate` · `w_editpostedinvoice` · `w_cashierwindow` · `w_mastercashierwindow` · `w_due_itemlist` · `w_dueinfo` · `w_pendingdueinfo` · `w_installmentsale` · `w_installmentguarantor_form` · `w_installmentsecurity_form` · `w_crs_branch_itemstockposition` · `w_copysaleinvoicefrom` / `…2` / `…3` · `w_copyprescription` · `w_patientsearch` · `w_patientsearchresult` · `w_cnic_search` · `w_vehiclesearch` · `w_vehiclesearchresult` …

**This is the modal chain.** A single sale can require the cashier to traverse: item search popup → batch selection popup → godown selection popup → qty calculator → salesman password → user/password re-authentication → print copies dialog. **Strongly Inferred** (each window is Verified; the *chain* is inferred from the rights list and message text).

### 6.1.9 ★ Live, verified field visibility at Fazal Din PP19

**This is the highest-value evidence in this document.** `dbo.SoftwarePreferences` stores the actual per-field visibility of the Sale header/detail/footer DataWindows, joined to `PreferencesSubCategory` / `PreferencesCategory`. Queried live — **Verified**:

**Invoice Header Window Visibility**

| Field | Visible? |
|---|---|
| Customer Balance | **Yes** |
| Price # in Cash Sale | **Yes** |
| Reference No. 2 / 3 / 4 | No |
| Sales Person | No |
| Sale Category | No |
| Account For | No |
| Ask Header | No |
| Price # in Credit Sale | No |
| Item Disc. % | No |
| Message | No |
| Doctor | No |
| Agency | No |
| Vehicle | No |
| Ship To | No |
| Associated Purchase Inv. Code | No |
| Supplier Inv. Code | No |
| GRN | No |
| Guarantee Person | No |
| Sale Type | No |
| Item Image/Photo | No |
| Loyalty Points | No |
| Currency | No |
| Motor Vehicle | No |

**Item Detail Window Visibility**

| Field | Visible? |
|---|---|
| Disc. % On Cash Sale | **Yes** |
| Disc. % On Credit Sale | **Yes** |
| Item Unit Sales Tax | **Yes** |
| **Batch No** | **No** |
| **Expiry** | **No** |
| Alternate Alias Name, Pre-Discount %age, Item Flat Discount, Bonus Qty, Claimable Disc.%, Claimable Item, Item GST %, Location, Item Packing, Packing Description, Extra Tax %, Item Description, Purchase Price, Item Weight Per Unit, Packing Factor Per Unit, Print Warranted Invoice, Total Pieces, Item Meter, Width, Length, Pack Capacity, Area/Volume, Pack Coverage, PCS, Cartons, Rate/Length, Item Instruction, Lot No., A/U | No |

> **Material business finding (Verified):** at this *pharmacy*, the sale line grid shows **neither Batch No. nor Expiry**. Dispensing staff cannot see the expiry of what they are selling on the sale screen. (Batch/expiry are captured at Purchase and tracked in `StockReport`/`GodownDetail`; the sale screen simply does not surface them.) **This belongs on the "requires owner/pharmacist validation" list.**

**Invoice Footer Window Visibility:** `Inv. GST (%)` = No; `Show Price + Tax in Footer` = **Yes**.

**Focus Preferences (Verified):** `Cash Sale Initial Focus = detailwindow`; `Credit Sale Initial Focus = custcode`. On opening a cash sale the caret lands directly in the item grid — the whole workflow is keyboard-first.

**Initial Column Value (Verified):** Cash Sale Page Size = `Thermal Page`; Credit Sale Page Size = `Thermal Page`; Thermal Print Format = `Thermal (Sales Tax Schedule Format5) (12)`; QR Code Printing Method = `Use QRCodeGenLibrary - Offline`; Auto Post Cash Sale = **Yes**; Auto Post Credit Sale = **Yes**; Print Batch on Inv. = No; Print Balance on Inv. = No; Default Godown priority = 10; Validate Expiry = **No**; Expiry Day(s) = 100; Default Customer in Cash Sale = `<NULL>`.

**Sale "Other Functionality" flags currently ON (Verified):** Show Saving Message · **Ask User/Password in Cash Sale** · **Ask User/Password in Credit Sale** · Fetch Prices from Associated Quotation · Fetch Item Flat Disc. from Associated Quotation · Fetch Disc.% from Associated Quotation · Print Header On Sale Print · Allow Sale Price Greater Than Avg. Price · Allow Sale Price Below Recent Pur. Price · Allow Sale Price Above Retail Price · Allow Partial Cash Receipt in Sale · Allow Empty Item Description · Allow Un-Posted Sale Inv. Printing · Show Prompt On Inv. Population (Ctrl+G) · Preserve Deleted Sale Items Log · Retrieve Patient List · Apply S/Tax Before User Password.

> **`Ask User/Password in Cash Sale = Yes` means every single sale opens a modal credential dialog.** At 291,334 invoices that is 291,334 modal password entries. **Verified.**

### 6.1.10 Accessibility problems — `w_sale`

| # | Problem | Concrete evidence |
|---|---|---|
| A1 | **No accessible names anywhere.** The strings `accessiblename` and `accessibledescription` occur **0 times across all 120 PBDs**, while the enum type name `accessiblerole` occurs only in the PowerScript type-reference tables (10× in `salewin.pbd`, alongside `windowtype`, `borderstyle`, `fontcharset`). No control in the product sets an MSAA name or description. A screen reader would announce every field as an unlabelled edit box. | **Verified** (`grep -c accessiblename` = 0 over all extracts) |
| A2 | **Field labels are separate `text` objects, not programmatically associated with their inputs.** DataWindow label objects follow the `<column>_t` convention (`remarks_t`, `usercode_t`, `date_t`, `pofooter_t`, `batch_t`, `expiry_t`…). PowerBuilder has no label→control association mechanism equivalent to `<label for>`; the association is purely visual proximity. | **Verified** (label naming recovered from `abuzarapp.txt`, `salewin.txt`) |
| A3 | **Dense spreadsheet grid as the primary input surface.** `d_saledetail` binds ~70 columns in one grid. There is no alternative single-record view for the line item. | **Verified** (bound column list, §6.1.3) |
| A4 | **Colour-only status encoding.** Row background is set by DataWindow expressions with no text equivalent — e.g. `if(approved = 'N', RGB(255,255,255), RGB(255,150,150))`, `if(rejected = 'Y', RGB(255,50,50), …)`, `IF(UPPER(RetViaBillSummary)='Y', RGB(200,200,100), RGB(255,255,255))`, `if(netamount < totalofsalereturns, RGB(200,120,120), RGB(100,150,150))`. Pale pink vs white and khaki vs white fail contrast-based discrimination and are invisible to colour-blind users and screen readers. | **Verified** (literal expressions in `salewin.txt`, `salereturncomponents.txt`) |
| A5 | **Fixed typefaces, no OS font scaling.** Arial / Times New Roman / Arial Narrow / Tahoma hard-coded per control; **Arial Narrow used 7,302 times** — a condensed face chosen to cram columns, actively harmful for low-vision users. PowerBuilder classic windows do not honour Windows DPI/text scaling. | **Verified** (typeface counts); point sizes **Missing** |
| A6 | **Keyboard shortcuts are the primary UI and are undiscoverable.** ~30 distinct Ctrl/Alt/F-key combinations on this one screen (§6.1.6), several context-sensitive (`F6/F7/F8/F9` behave differently *when the caret is in the Qty cell*). There is no visible command surface for most of them; only 4 command buttons exist (`cb_save`, `cb_print`, `cb_cancel`, `cb_retrieve`). | **Verified** |
| A7 | **Modal chains.** 77 response windows in `salerespwin.pbd` alone. Modal dialogs stack (item search → batch select → calculator → password), each stealing focus, with `{Escape} To Exit` as the only documented dismissal. | **Verified** (window inventory + title literal in §6.16) |
| A8 | **Credential re-entry as a routine interaction.** `Ask User/Password in Cash Sale = Yes`. Users type a password (`1`, `55`, `z0`) into a modal on every invoice — forcing hand-off from the number pad, and normalising password sharing. | **Verified** |
| A9 | **Error handling is `MessageBox`-only.** All 2,880 recovered validation strings are message-box text. There is no inline error, no error summary, no `aria-live` analogue, no focus management back to the offending cell (recovered strings such as `Please Enter Valid Sale Qty in Row ` require the user to find the row manually). | **Verified** |
| A10 | **No status/progress semantics.** `setmicrohelp` (MDI micro-help line) is used in 47 libraries — a single-line status strip at the bottom of the frame, not announced by assistive tech. `tooltip` appears in only **4** of 120 libraries (`dashboard`, `graphcomponents`, `patientvaccinecomp`, `smscomponents`). Essentially no hover help. | **Verified** |
| A11 | **No responsive behaviour whatsoever.** Windows are fixed-size PowerBuilder classic windows with absolute control coordinates. Nothing reflows. | **Strongly Inferred** (PB 12.5 classic target; no layout-manager user objects found) |
| A12 | **English-only chrome with occasional Urdu print output.** `Jameel Noori Nastaleeq` (57 uses) and column names `Urdu Name`/`UrduName` exist, but they appear in *print* DataWindows, not screen chrome. `RightToLeft` appears in only 2 libraries (`barcodecomponents`, `dashboard`). No RTL screen support. | **Verified** |

### 6.1.11 Mobile impossibility — `w_sale`

**Verified/Strongly Inferred.** This screen cannot exist on a phone in its current form:

- ~90 header bound columns + ~70 grid columns + a footer of totals in one non-scrolling fixed window.
- Interaction model is **caret-in-cell + function keys**; there is no touch target model. `F6/F7/F8/F9` on a specific grid cell has no touch equivalent.
- 77 stacked modal response windows.
- Hardware coupling: thermal receipt printer, cash drawer COM port, LCD pole display COM port, barcode printer (§6.15).
- FBR fiscalization talks to a **localhost** service (`http://localhost:8524/api/IMSFiscal/Get`) and a fiscalization application on **port 9111** on the same machine — the screen assumes it *is* the POS terminal.
- Verdict: a mobile/tablet rebuild requires a **redesigned** dispensing flow (scan → confirm → tender), not a port.

---

## 6.2 `w_postsale` — Point of Sale (POS) Screen

| Attribute | Value |
|---|---|
| **Window** | `w_postsale.win` — **the only window in the library** |
| **Library** | `poscomponents.pbd` (2.83 MB) — 1 window, 4 DataWindows, 1 menu (`m_posmenu.men`) |
| **`dbo.Module`** | 35 `POINT OF SALE` |
| **Menu path** | `Sales → POS Sale` (`Rightsclone` `3,11,`) |
| **Role** | Counter cashier |

*Evidence: `pbd_defined_objects.tsv` → `poscomponents\tw_postsale.win`, `poscomponents\tm_posmenu.men`.*

**Tables (Verified, recovered refs ∩ schema):** `SaleLedger` 187 · `Item` 160 · `SaleDetail` 61 · `Customer` 22 · `Accounts` 12 · `Users` 6 · `GodownDetail` 4 · `Supplier`/`Message`/`Godown` 3 · `Salesman`/`Patient` 2.

**Live POS configuration (Verified, `dbo.SoftwarePreferences`):**

| Setting | Value |
|---|---|
| POS Detail: Item Discount %, Item Flat Discount, Item GST % | **Yes** |
| POS Detail: Item Unit Sales Tax | No |
| POS Footer: Misc. Charges, Invoice Discount %, Invoice Flat Discount | **Yes** |
| POS Footer: Invoice GST % | No |
| POS Header: Invoice Size, Sales Person, Loyalty Points, Delivered By | No |
| **Show Cashier Window** | **Yes** |
| **Ask User/Password In POS** | **Yes** |
| Reset Inv. Balance Field in Footer On Saving | **Yes** |
| Allow `CTRL+D` | **Yes** |
| POS List View Retrieval Limit | **1 day** (max 5) |
| Use Cash Drawer / Cash Drawer With Printer | **No** |
| Default Cash Drawer COM Port | 1 |
| Use LCD Display | **No** (default LCD COM port 2) |
| Use BarCode Printer | **No** |
| Prompt For Zero Stock | No |
| Sale Sets/Deals In POS | No |
| Must Save Invoice on Exit | No |

**Right (Verified):** `Sales , POS Sale , Rights , Save as Credit Invoice`.

**Accessibility:** identical A1–A12 profile to §6.1.10, plus:
- POS list view is capped at **1 day** of history — a hard, config-driven constraint on what the cashier can even see.
- `CTRL+D` is an undiscoverable, right-gated destructive/duplicate action (exact semantics **Unclear**).

**Mobile:** impossible as-is (same reasons as §6.1.11).

---

## 6.3 `w_purchase` — Purchase Invoice

| Attribute | Value |
|---|---|
| **Windows** | `w_purchase.win`, `w_modify_purinvces.win`, `w_goods_recieveable_note.win` [sic], `w_pur_exp_window.win`, `w_groupwisepurexptemp.win` |
| **Library** | `purchasecomponents.pbd` (5.04 MB) — 5 windows, 86 DataWindows |
| **`dbo.Module`** | 3 `PURCHASE` |
| **Menu path** | `Purchase → Purchases` / `Purchases (Loose)` / `Opening Purchase` (`2,3,` / `2,7,` / `2,5,`) |
| **Role** | Purchase officer / Sales Officer group (group 12 holds `Purchases (Pack) Modify` + `Posting`) |
| **Live usage** | `PurLedger` = **6,417**; `PurDetail` = **113,082** |

**Three purchase variants, each with its own header/detail/footer/list quad (Verified):**
- Pack purchase: `d_normalpurchaseheader` / `d_normalpurchasedetail` / `d_prchasefooter` / `d_normalpurchaselist`
- Loose purchase: `d_loosepurchaseheader` / `d_loosepurchasedetail` / `d_loosepurchaselist`
- Opening purchase: `d_openingpurchaseheader` / `d_openingpurchasedetail` / `d_openingpurchaselist`
- Posted (read-only): `d_posted_purchaseheader` / `d_posted_purchasedetail` / `d_posted_purchasefooter`

**Recovered field labels (Verified):** `A/c For:` · `Account For:` · `Alias/Code/No.` · `Alias Name:` · `Alternate Alias Name` · `Adv. Income Tax:` · `Advance Income Tax Val` · `Agency:` · `Amount (in words) :` · `Apply Item Discount %` · `Apply Item GST %` · `Area/Volume` · `Avg. Price:` · `Balance Amt.` · `Batch` · `Batch Sale Price` · `Bonus Qty` · `Bonus Ratio` · `Cartons` · `Category:` · `Checked By` · `COPY NO.` · `Con/Rate:` / `Conv. Rate:` · `Counter` · `Cr. Days:`.

**Tax rule tables bound to the purchase grid (Verified):** `GSTRules`, `ExtraTaxRule`, `AdditionalTaxRule`, `UnitSalesTaxRules`, `IncomeTaxRule`, `CustomDutyRule` — i.e. purchase pricing is driven by **six** separate Pakistani tax-rule lookups.

**Tables (Verified):** `Item` 719 · `PurLedger` 639 · `PurDetail` 340 · `SaleOrderHeader` 113 · `Accounts` 52 · `Supplier` 36 · `GroupAllowedGodown` 36 · `Users` 31 · `SaleOrderDetail` 31 · `GodownDetail` 31 · `Manufacturer` 21 · `PurchaseType` 11 · `Godown` 11 · `ItemPart` 10 · `PurOrderHeader` 9 · `ItemSuppliers` 7 · `PurExp` 5 · `GroupPurExpTemplate` 4 · `PurOrderDetail` 4 · `ItemCategory` 4.

**Validation (Verified, literal):** `Can not generate item FullCode` · `Batch Wise Stock Fetch Error:` · `Change Sale Price Alert` · `Column Validation` · `Bonus Qty Validation` · `Alternate Alias Name Validation` · `Create Validation` · `Purchase Price must be +ve` · `exceeds the purchase discount`.

**Rights (Verified):** Save and Posting · Modify Price/Values in Purchase · Show Price/Values in Purchase · Create New Item · Fetch Purchase Invoice From Other Sources · Attach Document(s) · Show Document Gallery · Show Invoice List · Show Item Purchase History `[Ctrl+H]` · **Allow Deviation From Previous Margin On Posting**.

**Preference-driven behaviour (Verified):** `AcceptFutureExpiryDays = 90`; `AskAmtOnPurchase`; `AutoDueSatisfyOnPurPost`; `AutoSelectLastRowGodownInPur`; `Auto Batch Generation`; `CopySalePriceInRetailPriceInPur`; `ApplyAdvanceIncomeTaxInPur`; `AlternateCustomICodeInPur`.

**Accessibility:** A1–A12. Additionally **A13 — the purchase grid carries six independent tax-rule columns plus batch, expiry, bonus, pack/loose quantities, purchase price, sale price and retail price on one row.** This is the densest grid in the product. **Strongly Inferred.**

**Mobile:** impossible; purchase entry is a bulk keyboard-driven data-entry task against a paper supplier invoice.

---

## 6.4 `w_salereturn` — Sale Return

| Attribute | Value |
|---|---|
| **Windows** | `w_salereturn`, `w_salereturninsale`, `w_salereturnbuffer`, `w_salereturnbuffer_popup`, `w_sreturnallocation`, `w_salereturn_activeitemlist`, `w_inpatientsalereturn`, `w_possiblebatchexpiry`, `w_possiblebatchexpiry_expiryintimation` |
| **Library** | `salereturncomponents.pbd` (7.76 MB) — 10 windows, 60 DataWindows, 3 menus |
| **`dbo.Module`** | 2 `SALES RETURN`, 31/32 cash/credit, 33 `BUFFER SALE RETURN` |
| **Menu path** | `Sales → Sale Return` (`3,4,`), `Sales → Open Sale Return` (`3,5,`) |
| **Live usage** | `SRLedger` = **30,695**; `SRDetail` = **44,563**; `SRBufferLedger` = **0** |

**Variants (Verified DataWindow quads):** retail (`d_retailsalereturn` / `…detail` / `d_salereturnfooter` / `d_retailsalereturnlist`), wholesale (`d_wholesalereturn…`), open (`d_openretailsalereturn…`, `d_openwholesalereturn…`), in-patient (`d_inpatientsalereturn…`), buffer (`d_salereturnbuffer_header/detail/footer/list`), allocation (`d_salereturnallocationheader/detail/list`), marking (`d_srinvmarking`, `d_srinvmarking_hidden`), fiscalization (`d_srinvoice_json`, `d_srinvlist_notfiscalized`).

**Tables (Verified):** `SRLedger` 977 · `SRDetail` 418 · `Item` 211 · `SRBufferLedger` 207 · `SaleLedger` 122 · `Customer` 100 · `Accounts` 98 · `SaleDetail` 74 · `SRBufferDetail` 53 · `Users` 39 · `SRAllocationHeader` 36 · `SRAllocationDetail` 33 · `DueSatisfyDetail` 31 · `Patient` 22 · `PatientAdmission` 20 · `Godown` 18.

**Rights (Verified):** Modify Sale Return Price · Modify Sale Return Item Discount% · Modify Sale Return SalePrice · Save Invoice `[Ctrl + S]` · Save and Post · Show Invoices In List · Fiscalize S/R Invoice(s) · View Invoice Level Discount(%)/Flat Discount/GST%/Misc. Charges in Footer.

**Notable (Verified):** `w_possiblebatchexpiry` — a return-time helper that guesses the batch/expiry of the returned item, because (per §6.1.9) **batch/expiry are not captured on the sale line**. This is a workaround screen for a data-model gap.

**Accessibility:** A1–A12. Additionally, the `d_salereturn*` grids reuse the sale-detail column set, so the same ~70-column density applies.

**Mobile:** impossible.

---

## 6.5 `w_purchasereturn` — Purchase Return

| Attribute | Value |
|---|---|
| **Windows** | `w_purchasereturn`, `w_modify_prinvoices`, `w_preturnallocation`, `w_itemprhistory` |
| **Library** | `prcomponents.pbd` (6.30 MB) — 4 windows, 63 DataWindows |
| **`dbo.Module`** | 4 `PURCHASE RETURN` |
| **Menu path** | `Purchase → Purchase Return` (`2,4,`) |
| **Live usage** | `PRLedger` = **634**; `PRDetail` = **2,481** |

**DataWindows (Verified):** `d_normalpurchasereturn(detail/footer/list)`, `d_openpurchasereturn(detail/footer/list)`, `d_openingpurchasereturn(list)`, `d_posted_openpurchasereturn(detail/footer)`, `d_preturnallocationdetail`, `d_prinvmarking`, `d_prinvmarking_hidden`, `d_prinvno`, `d_prinvoices_formarking`, `d_itemprhistory`.

**Rights (Verified):** Modify Disc. % · Modify Price · Modify Purchase Return · Post Purchase Return · Show Invoices In List · View Invoice Level Discount(%) / Flat Discount / Misc. Charges.

**Accessibility / mobile:** as §6.3.

---

## 6.6 `w_purchaseorder` — Purchase Order (auto-reorder engine)

| Attribute | Value |
|---|---|
| **Windows** | `w_purchaseorder`, `w_editpurchaseorderform`, `w_modify_purorderheader`, `w_view_poheader`, `w_item_po_history`, `w_popolicy_form`, `w_supp_manf_po_generate`, `w_select_purorder_reorderlevel`, `w_unposted_preturn_reminder_in_po`, `w_editpurquot_posted_purorder_form`, `w_purorder_policybased_supplierinfo` |
| **Library** | `pocomponents.pbd` (6.23 MB) — 11 windows, **122 DataWindows** |
| **`dbo.Module`** | 16 `PURCHASE ORDER` |
| **Menu path** | `Purchase → Purchase Order` (`2,11,`) |
| **Live usage** | `PurOrderHeader` = **2,810** |

**Reorder-computation DataWindows (Verified):** `d_dspodetail`, `d_dspodetail1`, `d_dspodetail_and`, `d_dspodetail_baseperiod`, `d_dspodetail_baseperiod_policybased`, `d_dspodetail_baseperiod_policybased_mt`, `d_dspodetail_godownwise_minqty`, `d_dspodetail_godownwise_minqty_and`, `d_dspodetail_policybased_manftypebased`, `d_ds_supp_manf_generate_po`, `d_purchaseorderdetail_baseperiod(_detail)`, `d_populate_purchase_po_disparity`, `d_po_policybased_supplierinfo`.

> **Strongly Inferred:** the PO screen has **at least 9 different reorder-quantity computation strategies**, selected by policy and by base period. The rules live in the DataWindow SQL, not in a stored procedure. This is a significant reverse-engineering burden for the rebuild.

**Rights (Verified):** Modify Purchase Order · Modify Rate · Modify Required Pack(s) Qty · Change Calculated Required Packs · Edit Minimum Qty. · Edit Optimum Qty. · Edit Reorder Qty. · Apply Customer Associated Quotation `(Alt+F8)`.

**Accessibility:** A1–A12 plus **A14 — the PO grid is a computed worksheet**: users override machine-computed reorder quantities inline with no explanation of how the number was derived and no undo. **Strongly Inferred.**

---

## 6.7 `w_item_form` — Item Master

| Attribute | Value |
|---|---|
| **Windows** | `w_item_form`, `w_item_form_popup`, `w_item_form2` (in `singleentryitem`), `w_item_basicdata_form`, `w_item_inquiry`, `w_item_part_form`, `w_master_item_part_form`, `w_itemgroup_form`, `w_itempriority_form`, `w_itemsuppliers_form(2)`, `w_itembatchpricing`, `w_itembatchlock_form`, `w_lockitembatches_form`, `w_itemcosthistory_form`, `w_godownitem_setting`, `w_itemallowedmeter`, `w_itemregrequest_form`, `w_passport_form(_popup)`, `w_update_item_in_activequotations`, `w_master_item_part_form_popup` |
| **Library** | `multientryitem.pbd` (18.17 MB — the 7th largest) — 22 windows, 50 DataWindows, **10 menus**, 2 structures |
| **`dbo.Module`** | 9 `ITEM`, 48 `Item Registration Request` |
| **Menu path** | `Basic Data → Item` (`6,9,`) |
| **Role** | Sales Officer group 12 has all item rights (**Verified**, `GroupRights`) |
| **Live usage** | `Item` = **30,050** rows |

**Recovered field labels (Verified — all colon-terminated captions in `multientryitem.pbd`):**
`Code:` · `Item Code:` · `Item Name:` · `Alias Name:` · `Name:` · `Description:` · `Desc.:` · `Item Type:` · `Manufact.:` / `Manufacturer:` · `Category :` · `Class:` · `Brand:` · `Packing:` · `Godown:` · `Location:` · `Price:` · `Sale Price:` · `Sales Price:` · `Pur/Price:` · `Purprice:` · `Avg Price:` · `Recent Pur Price:` · `Flat Disc.:` · `Sale Disc% 2:` · `Sale Disc% 3:` · `Sale Disc% 4:` · `Sale Disc% 5:` · `GST 1 (%) :` · `GST 2 (%) :` · `Pack Sales Tax:` · `Bonus Ratio:` · `ReOrder:` / `Reorder:` · `Min. Level:` · `Max Level:` · `Min. Qty:` · `Max. Qty:` · `Godown Order Qty:` · `Godown Optimum Qty:` · `Stock:` · `Total Stock:` · `Transit Stock:` · `Qty Used:` · `Lock SalePrice:` · `Lock DiscPerc:` · `Narcotics:` · `Prescribed:` · `Refrigrated:` [sic] · `Print Batch :` · `Part No.:` · `Old Part No.:` · `Master Part:` · `Application:` · `Item Year:` · `Size:` · `Size Description:` · `Colour:` · `Fabric:` · `Sleeve:` · `Style:` · `Yarn:` · `Start Date:` · `End Date:` · `Remarks:` · `Remarks for Pur. :`

> The Item form carries **garment-industry fields (Fabric, Sleeve, Style, Yarn, Colour, Size)** side by side with **pharmacy fields (Narcotics, Prescribed, Refrigerated, Print Batch)**. **Verified.** This is the clearest single artefact of the shared multi-vertical binary.

**Tables (Verified):** `Item` 448 · `GodownDetail` 142 · `ItemPart` 39 · `ItemSuppliers` 31 · `GroupAllowedGodown` 24 · `ItemInquiryDetail` 17 · `ItemBatchPricing` 17 · `Manufacturer` 16 · `ItemInquiry` 15 · `ItemPartInModel` 14 · `ItemPacking` 13 · `SaleDetail` 11 · `ItemClass` 11 · `ItemCategory` 11 · `PurLedger` 10 · `ItemGroup` 9 · `ItemAllowedMeter` 9 · `GodownItemSetting` 9 · `ItemCostHistory` 8 · `Godown` 8.

**Rights (Verified):** Add New Item · Modify Item Basic Data · Modify Item Alias Name · Modify Item Activeness · Modify Item Restriction · Assign Restricted Items · Show Item List · Show Sale Price · Show Purchase Price · Show Recent Purchase Price · Show Avg. Price · Show Flat Discount · Show Sale Discount % · Show Allow Sale Price Below AvgPrice.

**Companion lookup forms** (all in `singleentryitem.pbd`, 42 windows — **Verified**): `w_itemcategory_form`, `w_itemclass_form`, `w_itembrand_form`, `w_itempacking_form`, `w_measuringunit_form`, `w_manufacturer_form`, `w_manufacturercategory_form`, `w_manufacturertype_form`, `w_genericitem_form`, `w_genericitemtype_form`, `w_godown_form`, `w_godowngroup_form`, `w_salestaxschedule_form`, `w_pctcodes_form`, `w_categorysegment_form`, `w_itemalert_form`, `w_itemmeter_form`, `w_itemmeterlog`, `w_weighingscale_form`, `w_weighingscale_itemlist`, `w_model_form`, plus garment lookups `w_itemcolour_form`, `w_itemdesign_form`, `w_itemfabric_form`, `w_itemsize_form`, `w_itemsleeve_form`, `w_itemstyle_form`, `w_itemthickness_form`, `w_itemyarn_form`.

**Accessibility:** A1–A12 plus:
- **A15 — irrelevant fields are shown, not hidden.** A pharmacist sees Yarn/Sleeve/Fabric. Cognitive load is inflated by ~30% of dead fields. **Strongly Inferred** (fields exist in the form and in `Item`; unusable in pharmacy context).
- **A16 — flag fields are unlabelled Y/N cells.** `Narcotics:`, `Prescribed:`, `Refrigrated:`, `Lock SalePrice:` are single-character `Y`/`N` inputs with no on-screen explanation of consequence. **Strongly Inferred.**

**Mobile:** a read-only item lookup is feasible; the full maintenance form is not.

---

## 6.8 `w_customer_form` — Customer / Account Master

| Attribute | Value |
|---|---|
| **Windows** | `w_customer_form`, `w_customer_register`, `w_customer_update`, `w_customerinfo_view`, `w_customer_comment`, `w_customercomments`, `w_customercomment_view`, plus 44 satellite forms |
| **Library** | `custcomponents.pbd` (12.14 MB) — **51 windows**, 123 DataWindows, 5 menus |
| **`dbo.Module`** | 24 `CUSTOMER`, 46 `Customer License`, 47 `Customer Site` |
| **Menu path** | `Basic Data → Customer ..........` (`6,5,`) |
| **Live usage** | **`Customer` = 2 rows.** CustCode 19 = walk-in/cash customer carrying 291,359 invoices. |

**Recovered field labels (Verified):** `Code:` · `Alias Name:` · `A/c Name:` · `Full Name:` · `Father/Husband Name:` · `Address:` / `Address1:` / `Address2:` · `Block:` · `City:` · `City/County:` · `Country:` · `Area:` · `Area Name:` · `Cell#:` · `Fax No.:` · `Email:` / `Email Address:` · `CNIC No.:` · `Category:` · `Customer Group:` · `Customer Sector:` · `Customer Segment:` · `Credit Limit:` · `Critical Limit:` · `Current Balance:` · `DaysLimit:` · `Inv. Disc %:` · `Item Disc. %:` · `Item Category:` · `Allow In Cash Sale:` · `Allow In Credit Sale:` · `Consider Sale for P/O:` · `Assoc. Quot. (Sale):` · `Assoc. Quot. (P/O):` · `Assoc. Quot. (Sale/Issue):` · `Collection Policy:` · `Last Collection:` · `Last Sales:` · `Lic. # Issued:` · `Lic. Expiry:` · `Agency:` · `Bank:` · `Bank Address:` · `Card ID:` · `Adjusted Points:` · `Adjustment Type:` · `Age(Years):` · `Gender:` · `Degree:` · `Education:` · `Designation:` · `Institute:` · `Distance:` · `Ever Purchase On Inst.:` · `Inst. Company Name:` · `Desc. of Goods(Past Inst):` · `Active:` · `Alert:` · `Instruction:` · `Comments:`

**Satellite forms in the same library (all Verified window names):** `w_area_form`, `w_subarea_form`, `w_region_form`, `w_zone`, `w_county_form`, `w_custcategory_form`, `w_customergroup_form`, `w_custsector_form`, `w_custsegment_form`, `w_groupcustomercategory`, `w_custwiseitemcategory`, `w_custitemcat_disc_setting`, `w_custitemcatassociation_form`, `w_custitemcatwisediscountposition`, `w_customer_assoc_godown_form`, `w_custguaranteeperson_assoc_form`, `w_customer_guaranteeperson_search`, `w_custallowedservices`, `w_custservicetemplate`, `w_issuelicense_form`, `w_issuelicense_list`, `w_licensecategory_form`, `w_qualifiedperson_form`, `w_qualifiedpersongallary`, `w_qualifiedpersonimage(_rowid)`, `w_loyaltycard_form`, `w_loyaltyadjustment`, `w_loyaltyredemption_form`, `w_membershiprenewal_form`, `w_salesman_form`, `w_salesmanscope`, `w_spo_form`, `w_spoteam_form`, `w_spoteam_list`, `w_salepromotion_form`, `w_prospectivecustomer_form`, `w_zonecontactgroup_form`, `w_cnic_search`, `w_customersite_form_old` (**Deprecated**), `w_customer_detail_old` (**Deprecated**), `ww_custwiseitemcategory` / `ww_qualifiedperson_form` (double-`w` prefix — **Broken/Incomplete** or copy-paste artefacts).

**Tables (Verified):** `Customer` 772 · `Accounts` 209 · `QualifiedPerson` 84 · `SPO` 74 · `Area` 66 · `CustomerComments` 46 · `LoyaltyPointAdjustment` 45 · `LoyaltyRedemption` 43 · `SubArea` 36 · `SalePromotion` 36 · `CustomerServiceTemplate` 33 · `LoyaltyCard` 32 · `Zone` 30 · `Salesman` 29 · `ProspectiveCustomer` 29 · `CustomerCategory` 26 · `SalesTeam` 22 · `Region` 19 · `License` 16 · `CustomerSector` 16 · `County` 16 · `SPOTeam` 15 · `CustLog` 15.

**Rights (Verified):** Modify Customer Basic Data · Modify Customer Alias Name · Modify Customer Lisc. Expiry [sic].

> **Verified reality check:** the product ships a full CRM (zones, regions, areas, sub-areas, sales teams, SPOs, loyalty cards, promotions, prospective customers, guarantee persons, licences, qualified persons with photo galleries). **At Fazal Din PP19 the entire subsystem holds 2 customer rows.** All 51 windows are effectively dead weight at this site.

**Accessibility / mobile:** A1–A12; the form is a wide multi-tab record editor. A mobile "customer lookup" is feasible; the editor is not.

---

## 6.9 `w_adjwindow` — Stock Adjustment

| Attribute | Value |
|---|---|
| **Windows** | `w_adjwindow`, `w_adjincrease`, `w_adjbuffer`, `w_itemadjustmenthistory`, `w_itemconversion_form` |
| **Library** | `adjustment.pbd` (6.78 MB) — 5 windows, 38 DataWindows, 3 menus |
| **`dbo.Module`** | 7 `ADJUSTMENT` |
| **Menu path** | `Maintenance → Adjustment` (`7,6,`) with children `Increase` / `Decrease` / `Stock Adjustment` |
| **Live usage** | `AdjHeader` = **1,539**; `AdjBufferHeader` = **1,061** |

**DataWindows (Verified):** `d_adjheader` / `d_adjdetail` / `d_adjfooter` / `d_adjlist`; `d_adjheaderincrease` / `d_adjincreasedetail` / `d_adjincreaselist`; `d_adjbufferheader/detail/footer/list`; `d_adjinvno`; `d_itemconversionheader/detail/footer/list/printout`; `_view` variants for posted docs.

**Rights (Verified):** `Maintenance , Adjustment , Increase , Modify Price` · `Maintenance , Adjustment , Decrease , Modify Price` · `Maintenance , Adjustment , Stock Adjustment , Save and Posting`.

**Tables (Verified):** `Item` 176 · `AdjHeader` 151 · `AdjDetail` 101 · `AdjBufferHeader` 44 · `ItemConversionHeader` 34 · `Godown` 18 · `AdjBufferDetail` 16 · `Users` 11 · `ItemConversionDetail` 10 · `GodownDetail` 7.

**Accessibility:** A1–A12. **A17 — increase and decrease are two *different windows* (`w_adjincrease` vs `w_adjwindow`) with near-identical grids.** Direction is encoded in *which window you opened*, not in a visible field. **Strongly Inferred** (window names + separate DataWindow sets).

---

## 6.10 `w_transfer` — Inter-Godown Transfer

| Attribute | Value |
|---|---|
| **Windows** | `w_transfer`, `w_transfer_old` (**Deprecated**), `w_transferrequisition`, `w_transferrequisition_posted_form`, `w_transfer_itemlist`, `w_itemtransferhistory`, `w_sourcebasedtransfer_stockperc` |
| **Library** | `transfer.pbd` (6.56 MB) — 7 windows, **77 DataWindows** (of which ~40 are client-branded print layouts) |
| **`dbo.Module`** | 8 `TRANSFER`, 13 `TRANSFER (TARGET)` |
| **Menu path** | `Maintenance → Godown Preferences → InterGodown Transfer` (`7,19,`) |
| **Live usage** | **`THeader` = 0, `TDetail` = 0 — never used at this site** (single godown, §E4 `Godown` = 1 row) |

**Tables (Verified):** `THeader` 423 · `TDetail` 280 · `Item` 262 · `TransferRequisitionHeader` 55 · `GodownDetail` 39 · `Godown` 35 · `TransferRequisitionDetail` 34 · `Users` 26 · `GodownItemSetting` 16.

**Status:** **Verified — shipped, configured, never used.**

---

## 6.11 `w_voucher` — Accounting Voucher / Journal

| Attribute | Value |
|---|---|
| **Windows** | `w_voucher`, `w_voucher_old` (**Deprecated**, in `accountsext`), `w_journalvoucher`, `w_modify_voucher`, `w_modify_vouchers_old`, `w_vouchercategory`, `w_transactionwindow`, `w_transactiontype_form`, `w_summaryaccount_form`, `w_groupsummaryaccount_form`, `w_invoicemarking`, `w_purpayment_form`, `w_purpayment_list`, `w_purpayment_old`, `w_purpayment_for_purinvcode`, `w_soreceipt_form`, `w_soreceipt_history`, `w_installmentreceipt`, `w_installmentcancellation(_form)`, `w_agingintervals`, `w_fee_voucher` |
| **Library** | `accounts.pbd` (14.37 MB — 4th largest) — 19 windows, 142 DataWindows, 6 menus; plus `accountsext.pbd` (3), `accountsrespwin.pbd` (13) |
| **`dbo.Module`** | 45 `A/C VOUCHERS`, 37 `RECEIPT TRANSACTION`, 38 `PAYMENT TRANSACTION`, 101–104 cash receipt/payment |
| **Menu path** | `Transactions → Accounting Vouchers` (`4,12,`) |
| **Live usage** | **`GLHeader` = 0, `GLDetail` = 0, `TransactionHeader` = 0** — while `VirtualGl` holds **1,015,581** rows |

**Recovered labels (Verified):** `A/C Head:` · `A/c Head:` · `A/c Name:` · `A/c Balance:` · `Account Title:` · `Detail A/c:` · `Detail Account:` · `G/L Code:` / `GL Code:` · `Amount:` · `Base Amt:` · `Amount (in Words):` · `Amount Received Rs.:` · `Amount Received (in words):` · `Cash A/c:` · `Cash Tendered:` · `Cash Charged:` · `Cash Back:` · `C/Rate:` · `Conversion Rate:` · `Currency:` · `Deduction Amount:` · `Deductions:` · `Discount:` · `Fine:` · `Doc/Code:` · `Created Date:` · `Counter:` · `Comment:` · `Auto Increment Ref. No.:` · `Enforece Uniqueness in Ref. No.:` [sic] · `Ask Date in Transaction:` · `Ask Alias Name in Transation:` [sic] · `Ask Patient in Transaction:` · `Ask User Password in Transaction:` · `Auto Post:`

**Tables (Verified):** `GLDetail` 690 · `GLHeader` 583 · `Accounts` 272 · `VocherCategory` 228 [sic — misspelled table name in the real schema] · `Users` 102 · `PurLedger` 99 · `SOReceipt` 81 · `PurPayment` 66 · `SaleLedger` 64 · `ServiceHeader` 52 · `InstallmentReceipt` 50 · `ServicePurHeader` 39 · `TransactionHeader` 36 · `TransactionType` 28 · `InstallmentDetail` 28 · `PRLedger` 24 · `Patient` 24 · `Preferences` 18.

> **Critical accounting observation (Verified):** the manual voucher screens bind to `GLHeader`/`GLDetail`, both of which are **empty**, while the actual double-entry ledger `VirtualGl` has 1,015,581 rows populated by posting procedures. **This means every GL entry at Fazal Din PP19 is machine-generated from documents; no human has ever posted a manual journal here.** The voucher UI exists but is unused. *(Posting logic itself is out of scope for this document — see `07-accounting-logic.md`.)*
>
> **Requires accountant validation:** whether the absence of any manual-JV capability is intentional policy or an unconfigured module.

---

## 6.12 `w_receipt` — Goods Receipt

| Attribute | Value |
|---|---|
| **Windows** | `w_receipt`, `w_receiptcategory`, `w_groupitemwisereceiptexptemplate`, `w_populate_receipt_in_proformapurinv` |
| **Library** | `receiptcomponents.pbd` (4.82 MB) — 4 windows, 28 DataWindows |
| **`dbo.Module`** | 6 `RECEIPT` |
| **Menu path** | `Maintenance → Receipt` (`7,8,`) |
| **Live usage** | **`ReceiptHeader` = 0 — never used** |

**DataWindows (Verified):** `d_receiptheader` / `d_receiptdetail` / `d_receiptfooter` / `d_receiptinvlist` + `_view` variants + `d_receiptcategory_detail/list` + `d_receiptcategoryaccounts` + `d_receiptno`.
**Tables (Verified):** `ReceiptHeader` 174 · `ReceiptDetail` 167 · `Item` 102 · `ReceiptCategory` 31 · `IssueDetail` 12 · `Godown` 10 · `SubAccounts` 9 · `GodownDetail` 9.

---

## 6.13 `w_issue` — Stock Issue

| Attribute | Value |
|---|---|
| **Windows** | `w_issue`, `w_issuecategory`, `w_view_issueheader` (library `issuecomponents.pbd`); plus `w_issue_request`, `w_editissuereqform`, `w_edit_issue_posted`, `w_edit_customer_issue_posted`, `w_itemissuehistory`, `w_issuereq_issuepopulation_rejected`, `w_prodbuffer`, `w_production`, `w_prodnote_form`, `w_prodnote_list` (library `issuereq.pbd`) |
| **`dbo.Module`** | 5 `ISSUE`, 40 `ISSUE REQUEST` |
| **Menu path** | `Maintenance → Issue` (`7,7,`) |
| **Live usage** | **`IssueHeader` = 0 — never used** |

`issuecomponents.pbd` contains **73 DataWindows, of which ~60 are per-client issue-invoice print layouts** (e.g. `d_freesiaentp_issueinvreport`, `d_forlandmotors_issueprint_dc/gp/pc`, `d_dwatsonsuper_issueinvreport`). **Verified.**

---

## 6.14 `w_preferences` — Settings (the most consequential screen in the product)

| Attribute | Value |
|---|---|
| **Windows** | `w_preferences` + eight typed editors: `w_pref_get_text`, `w_pref_get_text2`, `w_pref_get_long`, `w_pref_get_decimal`, `w_pref_get_date`, `w_pref_get_datetime`, `w_pref_get_dropdown`, `w_pref_get_password`, `w_job_schedule` |
| **Library** | `preferences.pbd` (1.90 MB) — 10 windows, 111 DataWindows |
| **Menu path** | `Maintenance → Preference` (`7,2,`) |

**★ The Preferences screen is fully data-driven — Verified from live DB.** `dbo.SoftwarePreferences` (1,363 rows) is the screen definition:

| Column | Meaning |
|---|---|
| `Name` | Preference key (e.g. `acceptfutureexpirydays`) |
| `Caption` | The on-screen label (e.g. `Acceptable Future Expiry (days):`) |
| `PrefDataType` | `INT` / `VARCHAR` / `CHAR` |
| `PrefValue` / `PrefValue2` | Stored value / display value |
| `SubCatCode` → `PreferencesSubCategory` → `PreferencesCategory` | Two-level navigation tree |
| `FormOrder` | Ordering on the form |
| `ColWidth`, `decimals` | Rendering hints |
| **`UsedObject`** | **The editor window or DDDW to open** — literally `w_pref_get_long`, `w_pref_get_text`, `ddd_pref_yesno`, … |
| `Visible` | Y/N |
| `AssocPrefName`, `AssocRightCode` | Dependency on another preference / on a right |

*Evidence: `SELECT TOP 12 * FROM dbo.SoftwarePreferences` — e.g. `7180 | acceptfutureexpirydays | Acceptable Future Expiry (days): | INT | 90 | 90 | 270 | 7180 | 3 | 0 | w_pref_get_long | Y`.*

**Scale (Verified):**

| Metric | Value |
|---|---:|
| Preference rows | **1,363** |
| Visible (`Visible='Y'`) | **1,277** |
| Hidden | 86 |
| Categories (`PreferencesCategory`) | **37** |
| Sub-categories | **155** |
| Editor: `ddd_pref_yesno` (Yes/No dropdown) | **1,023** |
| Editor: `w_pref_get_text2` | 79 |
| Editor: `w_pref_get_long` | 61 |
| Editor: `w_pref_get_text` | 38 |
| Other typed dropdowns (`ddd_pref_*`) | ~160 across ~55 distinct dropdowns |

**Preferences per category (Verified, top 15):** Sale **325** · Service 232 · Purchase 170 · General 48 · Purchase Order 45 · Purchase Of Service 43 · Point of Sale 38 · Quotation 36 · Patient 34 · Accounts 33 · Issue 32 · Sale Return 32 · Receipt 28 · Cashier Job Activity 24 · Purchase Return 23.

**Sale sub-categories (Verified):** `Other Functionality` 134 · `Hidden General Preferences` 36 · `Item Detail Window Visibilty` [sic] 34 · `Invoice Header Window Visibilty` [sic] 25 · `Initial Column Value` 18 · `POS Other Functionaliy` [sic] 17 · `FBR Fiscalization Settings` 14 · `FBR Digital Invoicing` 13 · `Column Captions` 12 · `Full Page Warranty` 10 · …

Additionally, the legacy `dbo.Preferences` table (1 row) has **443 columns** — an older, wide-row preferences model still bound to `d_old_general1.dwo` (**Deprecated**, coexisting with the new model). **Verified.**

**Accessibility:**
- **A18 — 1,277 visible settings across a 2-level tree with no search.** No `search`/`filter` control was recovered on `w_preferences` (unlike `w_findwindow`/`gb_fliter` [sic] elsewhere). Finding a preference requires knowing its category. **Strongly Inferred.**
- **A19 — every boolean setting is a *dropdown*, not a checkbox** (1,023 × `ddd_pref_yesno`). Two clicks + a list for every yes/no. **Verified.**
- **A20 — editing a single preference opens a modal window** (`UsedObject = w_pref_get_*`). Changing ten settings = ten modal round-trips. **Verified.**

**Modernization impact:** this table is a *gift* — it is a machine-readable specification of 1,363 configurable behaviours, with captions, types, defaults, editors and right associations. **Recommended:** import it directly as the seed for the new system's settings model rather than re-deriving it.

---

## 6.15 Search & selection popups — the most-used interaction in the product

| Attribute | Value |
|---|---|
| **Library** | `components.pbd` (10.94 MB) — 36 windows, 22 user objects, 15 DataWindows |
| **Windows (Verified)** | `w_popup_forselection`, `w_popup_forselection2`, `w_popup_forselection_walias`, `w_popup_forselection_walias2`, `w_popup_itemsearch_criteria`, `w_popup_itemsearch_selection`, `w_popup_partialsearch_selection`, `w_popup_partialsearch_selection_acc`, `w_popup_responsivesearch_selection`, `w_popup_responsivesearch_selection_aa`, `w_popup_responsivesearch_alternatealias`, `w_popup_responsivesearch_contactcard`, `w_popup_comprehensicesearch_selection` [sic], `w_popup_comprehensicesearch_selection2`, `w_popup_textsearch_criteria`, `w_responsivesearch_batch`, `w_findwindow` |

**Recovered window titles (Verified, literal):**

> `Search Window [{F12/Double Click} to Finalize Your Selection or {Escape} To Exit]`
> `Comprehensive Search - [{F12/Double Click} to Finalize Selection or {Escape} To Exit]`

Other literals: `Item Search` · `Incremental Text Search` · `Filter Criteria` · `&Search` · `No Record(s) found matching with the …`
Controls: `ddlb_filter_column`, `ddlb_op`, `ddlb_sort`, `rb_ascending`, `rb_descending`, `gb_fliter` [sic], `gb_sort`, `st_find`, `cb_filter`.
Preference: `AutoResponsiveSearchWithAlternateAliasName` (**Verified**).

**Accessibility:**
- **A21 — the affordance is baked into the window *title bar***: "press F12 or double-click to finalize, Escape to exit". A title bar is not an accessible instruction surface, cannot be re-read on demand, and truncates on narrow windows. **Verified.**
- **A22 — `F12` and *double-click* are the only two commit gestures.** No visible OK/Cancel button pair was recovered on these popups. **Strongly Inferred.**
- **A23 — the filter builder (`column` + `operator` + `value` + `sort` + `asc/desc`) is a mini query language** exposed to counter staff with no validation feedback beyond `No Record(s) found matching with the …`. **Verified.**

---

## 6.16 Cashier management — `w_cashierjob`, `w_cashiershift`, `w_cashieractivitymonitor`

| Attribute | Value |
|---|---|
| **Library** | `cashierjob.pbd` (4.74 MB) — 10 windows, 35 DataWindows, 3 menus |
| **Windows (Verified)** | `w_cashierjob`, `w_cashiershift`, `w_cashiershift_closing`, `w_cashiershiftreport`, `w_cashieractivitymonitor`, `w_cashieractivity_for_a_job`, `w_cashier_creditsummary`, `w_cashieractivity_summarystatistics`, `w_cashierjobactivity_cashtendered`, `w_cashierjobactivity_changecategory` |
| **Menu path** | `Manage → Cashier Management` (`8,26,`) |
| **Rights (Verified)** | `Show Cash Tendered Window [F6]` · `Supervise Current [F7]` · `Supervise Selected [F8]` · `Supervise All [F9]` · `Change Category [F10]` · `Show Totals` · `Show Print Preview` |
| **Live usage** | **`CashierShift` = 0, `CashierActivity` = 0 — never used** (though `Show Cashier Window` in POS = Yes) |

**Accessibility:** the supervisor console is driven entirely by F6–F10 with no visible buttons for those actions. **Verified** (right names carry the key labels).

---

## 6.17 Report parameter dialogs (`w_arg_*`) — 838 screens, one pattern

| Attribute | Value |
|---|---|
| **Libraries** | `reports.pbd` (21.4 MB, **704 windows, 0 DataWindows**), `reports_cust.pbd` (145 windows), plus `w_arg_*` in `salerespwin`, `smscomponents`, `employee` |
| **Companion** | `reportformat.pbd` (287 windows, all `w_select_*` — output/format choosers), `reportdwarg.pbd` (309 DataWindows — the argument DataWindows), `reportviewer.pbd` (`w_reviewreport`, `w_crystal_report_viewer`, `w_papersize`, `w_save_reportfilter`, `w_view_reportfilter`, `w_preview_invoices`, `w_select`) |

**The naming *is* the specification (Verified).** Each `w_arg_*` window name enumerates its parameters:

| Window | Parameters implied |
|---|---|
| `w_arg_sdate` | start date |
| `w_arg_sinvcode_linvcode` | first invoice no. → last invoice no. |
| `w_arg_customers_sdate_ldate_salecriteria` | customer multi-select + date range + sale criteria |
| `w_arg_areas_sinv_linv_salecriteria` | area multi-select + invoice range + criteria |
| `w_arg_area_custcategory_date_limits` | area + customer category + date + limits |
| `w_arg_manufacturers_manfcatfilter` | manufacturer multi-select + category filter |
| `w_arg_allowedgodowns` | godown multi-select restricted by `GroupAllowedGodown` |
| `w_arg_batch_selection` | batch picker |
| `w_arg_pricetype_markup` | price type + markup |
| `w_arg_gstperc` | GST % |
| `w_arg_area_singleselection_posting` | area (single) + posted/unposted |

`reportformat.pbd`'s 287 `w_select_*` windows are *output shape* choosers: `w_select_argument_window`, `w_select_deselect_all`, `w_select_balancesheet`, `w_select_custbalance_format2`, `w_select_format_monthsale_manf`, `w_select_changediscmethod`, `w_select_cashierjob_voucher`, `w_select_crs_normal`, `w_select_area_customer`, `w_select_cust_custgroup`, …

**Accessibility:**
- **A24 — 838 near-identical modal parameter dialogs with no shared, learnable layout guarantee** (each is a hand-built window). **Strongly Inferred.**
- **A25 — multi-select is via a grid with a checkbox column (`w_select_deselect_all` exists as a helper).** No "select all matching" semantics; `You can not select more than 16 Zones.` is a hard, arbitrary cap surfaced only as an error. **Verified.**
- **A26 — report output is rendered into a fixed-width DataWindow print layout viewed in `w_reviewreport`**, i.e. a paginated page image, not a screen-readable table. Export is right-gated: `Reports , Rights , Print Report` / `Save As` / `Save As Excel`. **Verified.**

**Mobile:** running a report is conceivably mobile-friendly; *this* implementation is not (fixed page images, 16-item selection caps, modal chains).

---

## 6.18 `w_dashboard` — Dashboard

| Attribute | Value |
|---|---|
| **Library** | `dashboard.pbd` (851 KB) — 4 windows (`w_dashboard`, `w_dashboards`, `w_dashboard_drilldown`, `w_dashboard_zoomed`), 57 DataWindows |
| **Menu path** | `Manage → Dashboard` (`8,42,`) |
| **Preferences** | 10 rows under category `Dashboard` (**Verified**) |
| **Live usage** | No `*Dashboard*` tables exist in the schema (**Verified**, `INFORMATION_SCHEMA.TABLES` count = 0) — the dashboard queries base tables directly |

**Recovered panel titles (Verified, literal):** `Customer Sales Analysis` · `Customer Category Wise Sales Analysis` · `Customer Service Analysis` · `Customer Category Wise Services Analysis` · `Branch/Client Wise Sales` · `Branch/Client Wise Sales Share` · `Branch/Client Stock Position` · `Branch/Client Wise Inventory Share` · `Branch/Client Inventory Breakup` · `Dumped Inventory Analysis for ` · `Dumped Inventory Breakup` · `Dumped Inventory Items` · `Adjustment Category`.

`dashboard.pbd` is one of only 4 libraries that use `tooltip` and one of only 2 that reference `RightToLeft`. **Verified.**

---

# 7. Complete Library Inventory — all 120 `.pbd` files

Counts are **Verified** from the PBD object catalogue. "Purpose" is **Strongly Inferred** from object names + recovered SQL + `dbo.Module` / `Rightsclone` corroboration, except where marked.

| # | Library | Size | Win | DW | Men | Inferred purpose |
|---:|---|---:|---:|---:|---:|---|
| 1 | `sprntatod.pbd` | 44.0 MB | 0 | 648 | 0 | **S**ale **PR**i**NT**outs, invoice formats for clients **A→D**. Pure print-layout library. |
| 2 | `sprntotos.pbd` | 35.0 MB | 0 | 493 | 0 | Sale printouts, clients **O→S** |
| 3 | `sprntetok.pbd` | 30.1 MB | 0 | 443 | 0 | Sale printouts, clients **E→K** |
| 4 | `sprntlton.pbd` | 28.7 MB | 0 | 415 | 0 | Sale printouts, clients **L→N** |
| 5 | `reports.pbd` | 21.4 MB | **704** | 0 | 0 | Report **argument** windows (`w_arg_*`) — the largest window library |
| 6 | `sprntttoz.pbd` | 19.5 MB | 0 | 276 | 0 | Sale printouts, clients **T→Z** |
| 7 | `multientryitem.pbd` | 18.2 MB | 22 | 50 | 10 | **Item master** and all item sub-entities (§6.7) |
| 8 | `patientcomponents.pbd` | 16.4 MB | 52 | 171 | 6 | Patient registration / admission / ledger (**unused here** — `Patient` = 0) |
| 9 | `studentcomponents.pbd` | 15.8 MB | 32 | 124 | 7 | School/college student module (**unused** — `Student` = 0) |
| 10 | `accounts.pbd` | 14.4 MB | 19 | 142 | 6 | GL vouchers, payments, receipts, aging (§6.11) |
| 11 | `salereportscust.pbd` | 12.9 MB | 0 | 288 | 0 | Customer-wise sales report layouts |
| 12 | `multientry.pbd` | 12.7 MB | 17 | 62 | 7 | Multi-row master forms: currency, vehicle, recipe, product, survey, dispatch, cashier template, doctor duty roster |
| 13 | `custcomponents.pbd` | 12.1 MB | 51 | 123 | 5 | **Customer master + CRM** (§6.8) |
| 14 | `quotation.pbd` | 12.1 MB | 12 | 134 | 3 | Sale & purchase quotations, 8 quotation print formats, pre-sales |
| 15 | `components.pbd` | 10.9 MB | 36 | 15 | 4 | **Shared UI kit**: search popups, calculator, calendar, password, send-mail, DB error, entry primitives (§6.15) |
| 16 | `saleorder.pbd` | 10.6 MB | 26 | 96 | 3 | Sale orders, work orders, SO labels, SO→sale/PO population (**unused** — `SaleOrderHeader` = 0) |
| 17 | `stockreports.pbd` | 10.2 MB | 1 | 243 | 0 | Stock-in-hand / expiry / register / movement report layouts |
| 18 | `purchaseprintouts.pbd` | 10.2 MB | 0 | 126 | 0 | Purchase invoice print formats (per client) |
| 19 | `salereports.pbd` | 10.1 MB | 0 | 256 | 0 | Sales report layouts |
| 20 | `accountreports.pbd` | 9.5 MB | 0 | 197 | 0 | Ledger / balance / trial-balance / P&L layouts |
| 21 | `salewin.pbd` | 9.3 MB | 5 | 66 | 3 | **Sale invoice screen** (§6.1) + installment sale + invoice grouping |
| 22 | `servicemodules.pbd` | 8.7 MB | 13 | 42 | 4 | Service (lab/clinic) modules (**unused** — `ServiceHeader` = 0) |
| 23 | `patientvisitcomp.pbd` | 8.4 MB | 18 | 98 | 3 | Patient visit / prescription (unused) |
| 24 | `serviceresult.pbd` | 7.8 MB | 4 | 110 | 2 | Lab result entry & report layouts (unused) |
| 25 | `salereturncomponents.pbd` | 7.8 MB | 10 | 60 | 3 | **Sale return** (§6.4) |
| 26 | `singleentryitem.pbd` | 7.4 MB | 42 | 117 | 3 | Item lookup masters (category, class, brand, packing, manufacturer, godown, weighing scale, garment attributes) |
| 27 | `advancedpurchase.pbd` | 7.4 MB | 4 | 28 | 3 | Imported/advance purchase, purchase register, import-expense templates |
| 28 | `ipservices.pbd` | 7.1 MB | 3 | 30 | 3 | In-patient services (unused) |
| 29 | `adjustment.pbd` | 6.8 MB | 5 | 38 | 3 | **Stock adjustment + item conversion** (§6.9) |
| 30 | `servicecomponents.pbd` | 6.6 MB | 22 | 65 | 3 | Service master data: templates, components, samples, consumables (unused) |
| 31 | `employee.pbd` | 6.6 MB | 27 | 100 | 2 | HR: employee, attendance, payroll, biometric enrolment, fingerprint (unused) |
| 32 | `issuereq.pbd` | 6.6 MB | 10 | 36 | 3 | Issue requests, production notes, production buffer |
| 33 | `transfer.pbd` | 6.6 MB | 7 | 77 | 2 | **Inter-godown transfer** (§6.10) — unused |
| 34 | `issuecomponents.pbd` | 6.6 MB | 3 | 73 | 2 | **Stock issue** (§6.13) — unused |
| 35 | `templates.pbd` | 6.5 MB | 41 | 60 | 3 | Sale templates, copy-invoice-from dialogs, **DB repair tools** (`w_virtualgl_repair`, `w_stockledger_repair`, `w_sale_primarykeyfixer`), initialization wizards, rights modification |
| 36 | `servicepurcomponents.pbd` | 6.4 MB | 6 | 36 | 3 | Purchase of services (unused) |
| 37 | `salereturnprintouts.pbd` | 6.3 MB | 0 | 121 | 0 | Sale-return print formats (per client) |
| 38 | `prcomponents.pbd` | 6.3 MB | 4 | 63 | 2 | **Purchase return** (§6.5) |
| 39 | `pocomponents.pbd` | 6.2 MB | 11 | 122 | 1 | **Purchase order + reorder engine** (§6.6) |
| 40 | `purchase&returnreports.pbd` | 5.9 MB | 0 | 132 | 0 | Purchase & purchase-return report layouts *(catalogued as `purchasereturnreports` in the derived TSV due to `&` handling — same file)* |
| 41 | `proformasales.pbd` | 5.8 MB | 1 | 45 | 1 | Proforma sale invoice |
| 42 | `changeitemprice.pbd` | 5.7 MB | 14 | 40 | 3 | **Bulk price/discount/reorder maintenance**: 8 formula-driven repricing dialogs (§ below) |
| 43 | `barcodecomponents.pbd` | 5.4 MB | 5 | 105 | 2 | Barcode & QR label design/printing — ~45 client-specific label formats |
| 44 | `salereportssumm.pbd` | 5.2 MB | 0 | 125 | 0 | Summary sales report layouts |
| 45 | `specialreports.pbd` | 5.1 MB | 0 | 240 | 0 | **Data-export utilities to pharma distributors** — see §11.3 |
| 46 | `salerespwin.pbd` | 5.1 MB | **77** | 83 | 1 | **Sale-screen modal response windows** (§6.1.8) |
| 47 | `purchasecomponents.pbd` | 5.0 MB | 5 | 86 | 1 | **Purchase invoice** (§6.3) |
| 48 | `receiptcomponents.pbd` | 4.8 MB | 4 | 28 | 2 | **Goods receipt** (§6.12) — unused |
| 49 | `guestcomponents.pbd` | 4.8 MB | 12 | 40 | 2 | Hotel guest check-in/out, rooms, floors (unused) |
| 50 | `reports_cust.pbd` | 4.8 MB | 145 | 0 | 0 | Customer-scoped report argument windows |
| 51 | `cashierjob.pbd` | 4.7 MB | 10 | 35 | 3 | **Cashier shift/job management** (§6.16) — unused |
| 52 | `duecomponents.pbd` | 4.7 MB | 4 | 27 | 3 | Partial-delivery "due" tracking: satisfy, adjust, delete due |
| 53 | `reportviewer.pbd` | 4.4 MB | 8 | 4 | 2 | Report preview/print/export; includes `w_crystal_report_viewer` |
| 54 | `reportformat.pbd` | 4.3 MB | **287** | 0 | 0 | Report format/criteria selector windows (`w_select_*`) |
| 55 | `itemreports.pbd` | 4.0 MB | 0 | 92 | 0 | Item history / price-change / deleted-item-log report layouts |
| 56 | `abuzarapp.pbd` | 4.0 MB | 26 | 51 | 1 | **Application shell, login, licensing, main menu** (§3) |
| 57 | `notescomponents.pbd` | 3.9 MB | 2 | 26 | 2 | Notes / cheque printing (`w_printcheques`) |
| 58 | `patientreports.pbd` | 3.9 MB | 0 | 87 | 0 | Patient report layouts (unused) |
| 59 | `billsummary.pbd` | 3.7 MB | 2 | 38 | 1 | Consolidated bill summary (unused — `BillSummary` = 0) |
| 60 | `singleentry.pbd` | 3.5 MB | 43 | 110 | 1 | **Single-row lookup masters**: accounts, sub-accounts, supplier, doctor, disease, department, section, shift, timeslot, message, alert, locker, purchase type, sale type, tax category, resource, service |
| 61 | `barcodefunctions.pbd` | 3.5 MB | 0 | 0 | 0 | **265 global functions** — barcode/QR encoding maths only |
| 62 | `servicesalescomp.pbd` | 3.2 MB | 3 | 28 | 1 | Sale of services (unused) |
| 63 | `advancedsale.pbd` | 3.1 MB | 4 | 19 | 1 | Advance/deposit sale (`dbo.Module` 21) |
| 64 | `servicesalesreturn.pbd` | 3.0 MB | 3 | 30 | 1 | Service sale return (unused) |
| 65 | `poscomponents.pbd` | 2.8 MB | 1 | 4 | 1 | **POS screen** (§6.2) |
| 66 | `graphcomponents.pbd` | 2.7 MB | 11 | 23 | 3 | Graph viewer + graph config dialogs (type, series, colour, rotation, spacing, title); `w_activitymonitor`, `w_connectionmonitor` |
| 67 | `ipsale.pbd` | 2.6 MB | 1 | 10 | 1 | In-patient sale (unused) |
| 68 | `smscomponents.pbd` | 2.6 MB | 13 | 36 | 2 | SMS centre, templates, auto-SMS on posted sales / finalized SO |
| 69 | `salereportsdet.pbd` | 2.6 MB | 0 | 43 | 0 | Detailed sales report layouts |
| 70 | `servicereports.pbd` | 2.4 MB | 0 | 58 | 0 | Service report layouts (unused) |
| 71 | `expiryintimation.pbd` | 2.4 MB | 1 | 12 | 1 | **Expiry intimation** (near-expiry return-to-supplier worklist) |
| 72 | `proformapurchase.pbd` | 2.4 MB | 1 | 9 | 1 | Proforma purchase |
| 73 | `datatransferapp.pbd` | 2.3 MB | 4 | 24 | 1 | Data-transfer helper application |
| 74 | `salemodreports.pbd` | 2.3 MB | 0 | 45 | 0 | Modified-sale audit report layouts |
| 75 | `salemodified.pbd` | 2.2 MB | 1 | 4 | 1 | `w_sale_modified` — posted-sale modification audit |
| 76 | `patientvaccinecomp.pbd` | 2.1 MB | 3 | 9 | 2 | Vaccine/treatment schedule + follow-up (unused) |
| 77 | `packingmodule.pbd` | 2.1 MB | 3 | 20 | 2 | Packing job, case capacity |
| 78 | `servicesalesitop.pbd` | 2.1 MB | 0 | 46 | 0 | Service sales report layouts (clients I→P) |
| 79 | `contactmanagement.pbd` | 2.0 MB | 4 | 12 | 1 | Contact cards & groups (**unused** — `ContactCard` = 0) |
| 80 | `reportdwarg.pbd` | 1.9 MB | 0 | 309 | 0 | The DataWindows *inside* the 838 `w_arg_*` windows |
| 81 | `preferences.pbd` | 1.9 MB | 10 | 111 | 0 | **Preferences screen + typed editors** (§6.14) |
| 82 | `incentivesheet.pbd` | 1.8 MB | 1 | 5 | 1 | Sales incentive computation sheet |
| 83 | `servicesalesatoh.pbd` | 1.8 MB | 0 | 44 | 0 | Service sales report layouts (clients A→H) |
| 84 | `datatransfercomponents.pbd` | 1.7 MB | 40 | 68 | 0 | **Multi-site replication**: parent/child server control panels, DataCarryDB import/export, Drop Box pull, data migration/acquisition, OTP verification |
| 85 | `godownreports.pbd` | 1.6 MB | 0 | 26 | 0 | Godown-wise stock report layouts |
| 86 | `dropdowns.pbd` | 1.6 MB | 0 | **222** | 0 | **222 drop-down DataWindows (`ddd_*`)** — every lookup list in the app |
| 87 | `crsreports.pbd` | 1.6 MB | 0 | 33 | 0 | Consolidated Reporting System report layouts |
| 88 | `psrviewer.pbd` | 1.5 MB | 1 | 0 | 1 | `w_psrviewer` — "PowerSoft Report" (`.psr`) file viewer |
| 89 | `lists.pbd` | 1.5 MB | 0 | 68 | 0 | Generic list DataWindows |
| 90 | `servicesalesqtoz.pbd` | 1.4 MB | 0 | 31 | 0 | Service sales report layouts (clients Q→Z) |
| 91 | `dw2xls.pbd` | 1.4 MB (2019) | 5 | 2 | 0 | **Third-party** DataWindow→Excel export component (52 user objects, 11 functions) |
| 92 | `multientryitemrespwin.pbd` | 1.1 MB | 22 | 21 | 0 | Item-screen modal windows: image gallery, price checker, garments wizard, alternate alias |
| 93 | `dashboard.pbd` | 851 KB | 4 | 57 | 0 | **Dashboard** (§6.18) |
| 94 | `purchaseresponsewin.pbd` | 808 KB | 18 | 12 | 0 | Purchase-screen modal windows: GST calculator, unit-tax calculator, flat-discount calculator, document gallery |
| 95 | `crscomponents.pbd` | 806 KB | 7 | 32 | 0 | Consolidated Reporting System client/branch control |
| 96 | `multientrygroups.pbd` | 788 KB | 17 | 24 | 0 | **Users, Groups, group-scoped permissions** (`w_users`, `w_groups`, `w_userspermission`, `w_groupwiseallowedprices`, …) |
| 97 | `accountsext.pbd` | 744 KB | 3 | 35 | 0 | Journal voucher + legacy voucher windows (**Deprecated** variants) |
| 98 | `functions.pbd` | 706 KB | 0 | 0 | 0 | **151 global functions** — shared helpers |
| 99 | `accountsrespwin.pbd` | 703 KB | 13 | 14 | 0 | Accounts modal windows: account/patient/student ledger, GL document gallery, in-patient bill |
| 100 | `issuereports.pbd` | 701 KB | 0 | 21 | 0 | Issue report layouts |
| 101 | `eprescriptionbasics.pbd` | 567 KB | 12 | 42 | 0 | E-prescription lookups: symptom, organ, dosage unit, severity, diagnostic item (unused) |
| 102 | `saleprintouts.pbd` | 426 KB | 0 | 0 | 0 | **8 global functions** only — print dispatch helpers |
| 103 | `multientrypolicy.pbd` | 411 KB | 6 | 18 | 0 | **Policy forms**: bonus, discount, item price, loyalty, sales-discount, contact |
| 104 | `agingreports.pbd` | 404 KB | 0 | 13 | 0 | Receivables aging report layouts |
| 105 | `popupmenus.pbd` | 292 KB | 0 | 0 | 11 | **11 popup menus** for report families (CRS, employee, guest, installment, loyalty, passport, product, production, student, data-import) |
| 106 | `financialreports.pbd` | 273 KB | 0 | 7 | 0 | Balance sheet / P&L layouts |
| 107 | `receiptreports.pbd` | 265 KB | 0 | 7 | 0 | Receipt report layouts |
| 108 | `labels.pbd` | 252 KB | 0 | 18 | 0 | Label print layouts |
| 109 | `useratten.pbd` | 205 KB | 2 | 7 | 0 | `w_userattendance_form`, `w_userauthentication_form` — user time-in/time-out |
| 110 | `salereportscomp.pbd` | 201 KB | 0 | 30 | 0 | Comparative sales report layouts |
| 111 | `pbdwr125.pbd` | 196 KB (2011) | 0 | 0 | 0 | **Sybase runtime** — remote DataWindow (`remote_datawindow_appl.apl`) |
| 112 | `smswebservices.pbd` | 69 KB | 0 | 0 | 0 | **13 user objects** — SMS gateway web-service proxies |
| 113 | `printer.pbd` | 40 KB | 1 | 0 | 0 | `w_printer` — printer selection |
| 114 | `managementreports.pbd` | 35 KB | 0 | 0 | 0 | **7 global functions** only |
| 115 | `pbwsclient125.pbd` | 23 KB (2011) | 0 | 0 | 0 | **Sybase runtime** — web-service client |
| 116 | `servicesaleprintouts.pbd` | 22 KB | 0 | 0 | 0 | 1 global function |
| 117 | `pbsoapclient125.pbd` | 14 KB (2011) | 0 | 0 | 0 | **Sybase runtime** — SOAP client |
| 118 | `accountstemplate.pbd` | 6.7 KB | 0 | 0 | 0 | 1 global function |
| 119 | `serviceheads.pbd` | 2.7 KB | 0 | 0 | 0 | **Empty stub** — PBD header only. **Broken/Incomplete** |
| 120 | `mgmtcomp.pbd` | 2.6 KB | 0 | 0 | 0 | **Empty stub** — PBD header only. **Broken/Incomplete** |

*Sizes from `Get-ChildItem`; object counts from `pbd_summary.tsv`. `serviceheads.pbd` and `mgmtcomp.pbd` contain only the PowerBuilder header block (`HDR*PowerBuilder 0600`) and the shared type-name table — **Verified** by inspecting the extracted strings.*

### 7.1 `changeitemprice.pbd` — bulk repricing (called out because it is high-risk)

**Verified windows:** `w_changeitem_price`, `w_change_item_basicdata_v2`, `w_changeitem_reorderqty`, `w_changeitem_min_reorder_optimum_qty`, `w_set_columnvalue`, `w_set_columnvalue_areavolume`, `w_set_price_from_another_price`, `w_set_price_marginbased_formula`, `w_set_price_staxschedule_formula`, `w_set_saleprice_purchase_formula`, `w_set_purprice_from_saleprice_saledisc`, `w_set_saleprice_formula`, `w_set_packsalestax_formula`, `w_sale_margin_markup_auditing`.

**Verified:** the screen writes to `Item` (1,107 recovered refs) and reads `PurLedger` (83). Menu path `Maintenance → Change Items Price` (`7,4,`); **Sales Officer group 12 has this right**.

**Risk (Recommended for the new system):** eight different formula dialogs can bulk-rewrite sale prices across 30,050 items, executed by a non-admin role, with no visible preview/confirm step recovered. Treat as a controlled operation with dry-run + audit in the rebuild.

---

# 8. Client-Branded Print Layouts — the maintainability bomb

**Verified.** Of 8,747 DataWindow objects, **2,361 (27%)** are print layouts whose names embed a *specific customer's trade name*.

Sample (all **Verified** object names):

| Library | Examples |
|---|---|
| `transfer` | `d_alkausar_transferinvreport`, `d_mardanks_…`, `d_waqasauto_…`, `d_greenplus17_…`, `d_pwmpharmacy_…`, `d_bismillahstore_…`, `d_mushtaqpharmacy_…`, `d_medlabservices_…`, `d_alharmainlights_…`, `d_pakpunjabtrader_…` (~40 in this one library) |
| `issuecomponents` | `d_freesiaentp_…`, `d_forlandmotors_issueprint_dc/gp/pc`, `d_dwatsonsuper_…`, `d_hospitalservice_…`, `d_oncolinkpharma_…`, `d_princetraders_…thrml`, `d_slickerpharma_…` (~60) |
| `pocomponents` | `d_hassandiesel_poreport_full`, `d_ginumcancerhsp_…`, `d_skylinepharma_…`, `d_welcomeph_poreport_3inches`, `d_atiqmedicose_poreport_3inches`, … |
| `barcodecomponents` | `d_barcodelabels_dwatsonsuper`, `…_bambinostore`, `…_masoodhomoeo`, `…_perfumevalley`, `…_maktabaerizwia`, `…_metroazadkashmir` (~45) |
| `accounts` | `d_santepharmacy_voucherprint`, `d_pakangelsschool_feereceipt`, `d_nusrathospital_trans_printout_full`, `d_naveedelect_installmentreceipt_print` |
| `saleorder` | `d_barcodealbel_saleorder_masoodhomoeo` **1 through 8** — eight numbered variants for one client |
| `sprnt*.pbd` (4 libraries, 128 MB) | 1,832 sale-invoice print layouts, indexed alphabetically by client name |

### 8.1 ★ This deployment's own print layouts — and its sibling branches

**Verified.** Fazal Din's own invoice formats are identifiable inside `sprntetok.pbd` (the "clients E→K" printout library):

| DataWindow object | Library | Reading |
|---|---|---|
| `d_fazaldinpp2_retailsaleinvrepwh_thrml` | `sprntetok` | Fazal Din **PP2** — retail sale, wholesale-style, **thermal** |
| `d_fazaldinpp3_retailsaleinvrepwh_thrml` | `sprntetok` | Fazal Din **PP3** — thermal |
| `d_fazaldinpp8_retailsaleinvrepwh_t` | `sprntetok` | Fazal Din **PP8** — thermal |
| `d_fazaldinpp12wholesaleinvreport_full` | `sprntetok` | Fazal Din **PP12** — wholesale, full page |
| `d_fazaldinppwh2_wholesaleinvreport_f` | `sprntetok` | Fazal Din warehouse 2 |
| `d_fd_retailsaleinvreport` / `_full` / `_old` | `sprntetok` | Generic Fazal Din retail (`_old` = **Deprecated**) |
| `d_fd_wholesaleinvreport` / `_full` | `sprntetok` | Generic Fazal Din wholesale |
| `d_fdd_retailsaleinvreport`, `d_fdd_wholesaleinvreport` | `sprntetok` | Fazal Din variant "FDD" |
| `d_fds_retailsaleinvreport`, `d_fds_wholesaleinvreport`, `d_fdssohail_wholesaleinvreport_full` | `sprntetok` | Fazal Din variant "FDS" / a named person's format |
| `d_fazaldin2000_poreport` | `pocomponents` | Fazal Din purchase-order print |

**Strongly Inferred:** the deployment name "**PP19**" is a *branch number* — the binary carries hand-built layouts for at least PP2, PP3, PP8, PP12 and PP19's siblings. This is corroborated by the live preference `Thermal Print Format = Thermal (Sales Tax Schedule Format5) (12)`, i.e. the running site selects **format #12** from a numbered list of thermal layouts. **Verified** (`dbo.SoftwarePreferences`).

**Consequence for the rebuild:** the chain **branch → chosen print format → compiled DataWindow** must be replaced by **branch → template row → renderer**. Otherwise every new Fazal Din branch requires a vendor code change.

**Implications**

| Finding | Label |
|---|---|
| Every customer's invoice/label/voucher layout is a **hand-built object compiled into the shared product binary** | **Verified** |
| ~128 MB of the ~350 MB Application folder is *other pharmacies'* print layouts shipped to Fazal Din | **Verified** (`sprnt*.pbd` sizes) |
| Adding a customer or changing a layout requires a **full product rebuild and redeploy** | **Strongly Inferred** |
| Deprecated variants ship alongside current ones (`…_old`, `…_old2`, `d_customer_detail_old`, `d_woolmers_barcodelabels_old`, `d_barcodelabels_rahatdept_old`) | **Verified** — **Deprecated** |
| **Recommended (new system):** replace with a data-driven template engine (per-tenant template rows + a rendering service). This alone removes >25% of the object count. | **Recommended** |

---

# 9. Accessibility Assessment (Consolidated)

> Scope note: this is an assessment of a **1990s-idiom Windows desktop application**. WCAG is a web standard; the equivalent desktop baselines are **Section 508 / EN 301 549** and the Windows MSAA/UI Automation contract. Findings below are mapped to the closest recognisable criterion for the rebuild team's benefit and are labelled by evidence strength.

## 9.1 The single decisive finding

| Finding | Evidence | Label |
|---|---|---|
| **No control in the entire application exposes an accessible name or description.** The property strings `accessiblename` and `accessibledescription` appear **0 times** across all 120 extracted PBD string corpora (5,283,020 UTF‑16 strings). The only related string, `accessiblerole`, appears exclusively in PowerScript **type-name reference tables** alongside `windowtype`, `windowstate`, `borderstyle`, `fontcharset` — i.e. it is the enumerated *datatype* name, not a set property. | `grep -c accessiblename` over `pbdstr/*.txt` = 0; context dump of `salewin.txt` lines 12905–12930 shows `accessiblerole` in the type table | **Verified** |

**Consequence:** with a screen reader (NVDA/JAWS/Narrator), every field on every one of the 2,066 screens is announced with no name. The application is, in practice, **unusable by a blind or severely low-vision operator.** This is not a "gap to improve" — it is a total absence.

## 9.2 Structural accessibility problems

| ID | Problem | Evidence | Label |
|---|---|---|---|
| **A2** | Labels are free-floating `text` objects (`<column>_t`) with no programmatic association to their input. | `remarks_t`, `usercode_t`, `date_t`, `batch_t`, `expiry_t`, `pofooter_t`, `itemdiscperc_t`, `updatesaleprice_t`, `reorderlevel_t`, `optimumlevel_t`, `priority_t` recovered from `abuzarapp.txt` | **Verified** |
| **A3** | Primary input surface is a dense spreadsheet grid (~70 bound columns on the sale line, more on purchase). | §6.1.3, §6.3 | **Verified** |
| **A6** | ~70 distinct keyboard shortcuts product-wide; 69 of 2,122 `Rightsclone` entries embed a shortcut in their *name* because there is nowhere else to document it. | `ALT+F8/F9/F12`, `CTRL+B/H/I/J/Q/S/G/K/P/R/F1/F10/F12`, `CTRL+SHIFT+D/G/H/L/M`, `CTRL+Shift+1..5`, `F1/F5/F6/F7/F8/F9/F10`, `[F6 on Qty]` … | **Verified** |
| **A7** | Modal chains. 130 dedicated "response window" objects across `salerespwin` (77), `multientryitemrespwin` (22), `purchaseresponsewin` (18), `accountsrespwin` (13). | library inventory | **Verified** |
| **A8** | Credential modal on every transaction: `Ask User/Password in Cash Sale = Yes`, `… Credit Sale = Yes`, `Ask User/Password In POS = Yes`, plus `AskUserPwdInAdjustment`, `AskUserPwdInSaleReturn`, `AskUserPwdInPatientReg`, `Askuserpasswordinitem`, `Ask User Password in Service:` | `dbo.SoftwarePreferences` (live) + `abuzarapp.txt` literals | **Verified** |
| **A9** | All error reporting is modal `MessageBox`; 2,880 distinct message strings; none are inline, none manage focus back to the offending field. Messages like `Please Enter Valid Sale Qty in Row ` require manual row-hunting. | `all_validation_messages.txt` | **Verified** |
| **A10** | Almost no hover help: `tooltip` present in only **4 of 120** libraries. MDI micro-help (`setmicrohelp`) in 47 libraries — a bottom status line, not announced. | grep counts | **Verified** |
| **A11** | No responsive/reflow behaviour. Fixed-coordinate PowerBuilder classic windows. | PB 12.5 classic target; no layout-manager user objects among the 100 `.udo` | **Strongly Inferred** |
| **A12** | No RTL screen support despite an Urdu-speaking user base. `RightToLeft` in 2 libraries; `Jameel Noori Nastaleeq` (57) and `Urdu Name` columns appear only in print layouts. | grep counts | **Verified** |
| **A21/A22** | Critical affordances live in **window title bars**: `Search Window [{F12/Double Click} to Finalize Your Selection or {Escape} To Exit]`. | literal in `components.txt` | **Verified** |
| **A25** | Arbitrary hard caps surfaced only as errors: `You can not select more than 16 Zones.` | literal | **Verified** |
| **A27** | Shipped spelling/grammar errors in user-facing text degrade comprehension and machine translation: `Dsicount`, `betweeen`, `beteen`, `Recivable`, `Refrigrated`, `godwon`, `Enforece`, `Transation`, `Datbase`, `Exipry`, `Visibilty`, `Functionaliy`, `Lables`, `Sitel`, `d_prchasefooter`. | `all_validation_messages.txt`, `Rightsclone`, `SoftwarePreferences`, DW names | **Verified** |

## 9.3 Colour-only status encoding (WCAG 1.4.1 analogue)

**Verified** — recovered DataWindow background-colour expressions with **no textual equivalent**:

```
if(approved = 'N', RGB(255,255,255), RGB(255,150,150))
if(rejected = 'Y', RGB(255,50,50), if(approved = 'N', RGB(255,255,255), RGB(255,150,150)))
IF(UPPER(RetViaBillSummary)='Y', RGB(200,200,100), RGB(255,255,255))
if(netamount < totalofsalereturns, RGB(200,120,120), RGB(100,150,150))
RGB(100,170,100)   RGB(255,150,150)   RGB(255,50,50)
```

- White `#FFFFFF` vs pale pink `#FF9696` — approved/not approved
- Khaki `#C8C864` vs white — returned via bill summary
- Green `#64AA64` / red `#FF3232` — approved / rejected

Some places *do* provide text (`if(posted='Y', 'Posted', 'Un-Posted')`, `if(glheader_posted='Y', '(Posted)', '(Not Posted)')`), which proves the pattern was known and simply not applied consistently. **Verified.**

## 9.4 Typography

**Verified** typeface usage across all 120 libraries: Arial 16,762 · Times New Roman 9,735 · **Arial Narrow 7,302** · Tahoma 3,470 · Verdana 125 · Jameel Noori Nastaleeq 57 · MS Sans Serif 33 · Calibri 12 · Courier New 7 · Lucida Console 2.

- **Arial Narrow at 7,302 occurrences** is diagnostic: a condensed face is chosen when there are more columns than pixels. Condensed faces materially reduce legibility for low-vision and dyslexic users.
- Point sizes are **Missing** (compiled), but PowerBuilder classic windows do **not** honour Windows DPI/text scaling, so whatever the size is, the user cannot change it.

## 9.5 What is *reasonable* about the current UI (fairness)

- **Keyboard-first is correct for a high-volume pharmacy counter.** 291,334 invoices were entered here; the F-key model is fast for a trained operator. A rebuild must preserve keyboard throughput.
- **Consistent header/detail/footer/list metaphor** across every transaction reduces re-learning cost.
- **Right-gated column visibility** (`Show Purchase Price`, `Show Avg. Price`) is a genuinely good idea — commercially sensitive columns are hidden per role.
- **Textual posted/un-posted indicators** exist in several DataWindows.

---

# 10. Mobile / Responsive Feasibility

**Verdict: the existing UI cannot be made responsive or mobile. A rebuild is required, not a port.** Evidence:

| Blocker | Evidence | Label |
|---|---|---|
| Fixed-coordinate windows; no layout containers | PB 12.5 classic; no layout-manager user objects in the 100 `.udo` | **Strongly Inferred** |
| Field counts far exceed a phone viewport (≈90 header + ≈70 grid + footer on one screen) | §6.1.2 / §6.1.3 | **Verified** |
| Interaction is caret-position-sensitive: `F6/F7/F8/F9` mean different things *when the caret is in the Qty cell* | `dbo.Rights`: `Show Godown Wise Stock [F6 on Qty]`, `Show Unit Qty Calculator [F7 on Qty]`, `Show Batch Sale Price Selection [F8 on Qty]`, `Show Qty/Rate/Value Calculator [F9 on Qty]` | **Verified** |
| Commit gesture is `F12` or double-click | `Search Window [{F12/Double Click} to Finalize Your Selection…]` | **Verified** |
| 130 modal response windows stack | library inventory | **Verified** |
| Hardware coupling to the terminal: cash drawer COM port, LCD pole display COM port, thermal receipt printer, barcode printer, weighing-scale barcode parser | `dbo.SoftwarePreferences` POS settings; device model lists `POSIFLEX PD-2600 Series`, `BAYLAN VFD-860-A`, `TYSSO VFD-860-A`, `DSP-2022`; label printers `TSC TA200/TA210/TE200/TDP-247/ME240/B-2404/TTP-2410 M`, `Zebra TLP 2844z`, `Argox OS-214TT PPLA`, `Gprinter GP-1125T/1624T/3120T`, `Monarch 9855`, `BIXOLON SLP-T400`, `Bixolon SAMSUNG SRP 770II`, `Gainscha`; scanner `EZTwainX` (via `EZTW32.dll`); `dbo.WeighingScale` with `BarCodeLen`, `ItemStartPos`, `ItemEndPos`, `ScaleIDPos`, `WeightEndPos` | **Verified** |
| FBR fiscalization assumes the workstation *is* the POS: `http://localhost:8524/api/IMSFiscal/Get`, fiscalization application on port **9111**, `FBR REG. POS ID = 141973` | `dbo.SoftwarePreferences` (live) | **Verified** |
| Report output is a fixed-width page image, not a fluid table | `reportviewer.pbd` (`w_reviewreport`, `w_papersize`, `w_crystal_report_viewer`) | **Verified** |

**Recommended (new system):** three distinct front-ends rather than one — (1) a keyboard-optimised desktop-web dispensing screen, (2) a touch POS/tablet flow (scan → confirm → tender), (3) a responsive read-only reporting/dashboard surface. Do not attempt a 1:1 screen port.

---

# 11. Used vs Shipped-But-Unused at Fazal Din PP19

**Verified from live row counts** (`table_rowcounts.tsv` + live queries). Recall the rule: an empty table proves non-use *here*, not absence *in the product*.

## 11.1 Screens in active use

| Screen | Library | Live volume |
|---|---|---:|
| Sale invoice (`w_sale`) | `salewin` | `SaleLedger` 291,334 / `SaleDetail` 620,525 |
| Sale return (`w_salereturn`) | `salereturncomponents` | `SRLedger` 30,695 / `SRDetail` 44,563 |
| Purchase (`w_purchase`) | `purchasecomponents` | `PurLedger` 6,417 / `PurDetail` 113,082 |
| Purchase order (`w_purchaseorder`) | `pocomponents` | `PurOrderHeader` 2,810 |
| Stock adjustment (`w_adjwindow`, `w_adjbuffer`) | `adjustment` | `AdjHeader` 1,539 / `AdjBufferHeader` 1,061 |
| Purchase return (`w_purchasereturn`) | `prcomponents` | `PRLedger` 634 / `PRDetail` 2,481 |
| Item master (`w_item_form`) | `multientryitem` | `Item` 30,050 |
| Supplier / Manufacturer masters | `singleentry` | `Supplier` 235 / `Manufacturer` 838 |
| Users & Groups (`w_users`, `w_groups`) | `multientrygroups` | `Users` 9 / `Groups` 4 / `GroupRights` 726 |
| Preferences (`w_preferences`) | `preferences` | `SoftwarePreferences` 1,363 |
| Reports (838 `w_arg_*`) | `reports`, `reports_cust` | inferred from `Rights`/`GroupRights` |

## 11.2 Screens shipped, configured, but with **zero** transactions here

| Screen family | Windows | Proof of non-use |
|---|---:|---|
| Inter-godown transfer | 7 | `THeader` = 0, `TDetail` = 0; `Godown` = 1 |
| Goods receipt | 4 | `ReceiptHeader` = 0 |
| Stock issue / issue request / production | 13 | `IssueHeader` = 0, `ProdHeader` = 0 |
| Quotation / pre-sales | 12 | `QuotationHeader` = 0 |
| Sale order / work order | 26 | `SaleOrderHeader` = 0, `WorkOrder` = 0 |
| **Manual accounting vouchers** | 19+13+3 | `GLHeader` = 0, `GLDetail` = 0, `TransactionHeader` = 0 (vs `VirtualGl` = 1,015,581) |
| Cashier shift/job management | 10 | `CashierShift` = 0, `CashierActivity` = 0 |
| Patient / in-patient / visit / prescription / vaccine | 52+18+3+3 | `Patient` = 0 |
| Student (school) | 32 | `Student` = 0 |
| Guest (hotel) | 12 | `Guest` = 0 |
| Services (lab/clinic) — sale, purchase, result, templates | 22+6+4+3+3+13 | `ServiceHeader` = 0 |
| Loyalty cards & redemption | 4 | `LoyaltyCard` = 0 |
| Contact management | 4 | `ContactCard` = 0 |
| Installment processing | 5 | `InstallmentHeader` = 0 |
| Item inquiry | 1 | `ItemInquiry` = 0 |
| Bill summary | 2 | `BillSummary` = 0 |
| Sale-return buffer | 4 | `SRBufferLedger` = 0 |
| Due satisfaction | 4 | `DueSatisfyHeader` = 0 |
| Employee / payroll / biometric | 27 | `Employee` table does not exist in this DB |
| E-prescription lookups | 12 | module absent from `Rights` |
| CRS (consolidated multi-branch reporting) | 7 + 33 DW | single-site deployment |
| Data replication (parent/child servers, DataCarryDB, Drop Box) | 40 | single-site deployment |
| SMS centre | 13 | `SMSTemplate` table does not exist |
| Garments wizard, passport, locker, motor vehicle | ~10 | verticals not applicable |

**Roughly 1,150 of 2,066 windows (≈56%) belong to features with zero transactional data at this deployment.** **Verified** by the above row counts.

## 11.3 A notable live-and-used feature: pharma data-export utilities

`specialreports.pbd` (240 DataWindows) exposes, via `Reports → Special Reports`, named **Data Export Utility** screens for specific pharmaceutical companies — **Verified** from `Rightsclone` (`5,16,58,` … `5,16,68,`):

`Global Pharma` · `Pharma Link` · `Next Pharma` · `Bosch/Linz` · `Sci Life Pharma` · `Clinix` · `Otsuka` · `Libra` · `Racket` · `Masood Homoeo` · `Neutro Pharma`

These are almost certainly sell-out/secondary-sales data feeds to manufacturers. **Unclear** whether they are used at Fazal Din PP19 (no transaction table backs them; they read `SaleDetail` directly). **Flag for owner confirmation** — if any of these feeds are contractual, they must be reproduced.

---

# 12. Role → Screen Access Map (live, verified)

`dbo.Groups` has **4** groups; `dbo.UserGroups` maps 9 user rows.

| Group | Code | Rights enabled | Scope observed |
|---|---:|---:|---|
| **ADMINISTRATOR** | 2 | **486 of 486** | Everything |
| **SHIFT INCHARGE** | 11 | 123 | Counter operations + supervisory reads |
| **SALES OFFICER** | 12 | 111 | Sales + full Purchase/PO/PR + Item master + **Change Items Price** + Backup/Check DB + Stock/Purchase reports |
| **REMOTE** | 5 | **6** | `Reports`, `Show Sale Price`, `Show Sale Discount %`, `Modify Price/Values in Purchase`, `Show Invoices In List Window` |

**Group-level commercial limits (Verified, `dbo.Groups` columns):** `saleinvflatdisc`, `saleItemdiscperc` (ADMINISTRATOR 50.00 / 50.00; all others 0.00), `AccumulatedDiscPerc`, `AccumDiscPercCaution`, `FinancialLimitPerTransaction` (100,000.00 for all), `MaxQtyLimit` (10,000 for all), plus per-module godown strategies (`SaleGodownStrategy`, `PurchaseGodownStrategy`, … all = 1).

> **Finding (Verified):** `SALES OFFICER` — a counter role — holds `Maintenance → Change Items Price`, `Update Item Basic Data`, `Update Item Suppliers`, `Change Item Reorder Qty`, `BackUp Database` and `Check Database Integrity`. **This is a significant privilege-separation gap.** *(Full analysis in `09-roles-permissions.md`; noted here because it determines which screens each role can open.)*

---

# 13. Modernization Implications (Recommended — none of this exists today)

1. **Do not port screens 1:1.** 56% of screens have no data here and ~27% of DataWindows are other clients' print layouts. The realistic target is **~40–60 screens**, not 2,066.
2. **Seed the new settings model from `dbo.SoftwarePreferences`.** It is a machine-readable spec of 1,363 settings with captions, types, defaults, editors, categories and right associations. **Recommended:** import it, then aggressively *prune* — 1,277 visible settings is a maintenance liability, not a feature.
3. **Replace 2,361 client-branded print DataWindows with a per-tenant template engine.**
4. **Replace the 838 `w_arg_*` dialogs with one composable report-parameter component** driven by a report-definition table (the window names already enumerate the parameter sets).
5. **Accessibility must be a build-time gate, not a retrofit.** The current baseline is zero: no accessible names, colour-only status, no inline errors, no focus management. Set an explicit target (EN 301 549 / WCAG 2.2 AA) and enforce it in CI.
6. **Preserve keyboard throughput.** Map the existing shortcut vocabulary (`Ctrl+S` save, `Ctrl+Q` save+post, `Ctrl+G` open, `Ctrl+H` purchase history, `F6/F7/F8/F9` on quantity) onto the new dispensing screen; the operators have ~291k invoices of muscle memory.
7. **Kill the per-transaction password modal.** Replace `Ask User/Password in Cash Sale = Yes` with session-based identity plus a re-auth step only for genuinely privileged actions.
8. **Surface batch and expiry on the dispensing line.** Currently hidden by configuration (§6.1.9) in a pharmacy. **Requires owner/pharmacist decision.**
9. **Split the front-end into three surfaces** (desktop dispensing, touch POS, responsive reporting) rather than one responsive app (§10).
10. **Externalise device integration** (cash drawer, pole display, receipt/label printers, weighing scale, FBR fiscalization) into a small local agent with an HTTP/WebSocket contract, so the UI can be a browser.
11. **Rebuild search as one component.** There are currently 17 near-duplicate search popups (`w_popup_forselection`, `…_walias`, `…_walias2`, `…partialsearch`, `…responsivesearch`, `…comprehensicesearch`, `…comprehensicesearch2`, …). One typeahead component replaces all of them.
12. **Fix the shipped text.** ~15 user-visible spelling errors are baked into the product (§9.2 A27); the rebuild should start from a copy-reviewed string catalogue. The recovered corpus at `…/scratchpad/all_labels.txt` (4,385 captions) and `…/scratchpad/all_validation_messages.txt` (2,880 messages) is a ready-made starting point.

---

# 14. Requires Human Validation (explicit list)

| # | Question | Who must answer |
|---|---|---|
| V1 | **Batch and Expiry are hidden on the sale line** (`Item Detail Window Visibilty → Batch No = No, Expiry = No`). Is this intentional? What is the actual dispensing control for expiry? | Owner / Pharmacist-in-charge |
| V2 | `Validate Expiry = No`, `Expiry Day(s) = 100` — what expiry policy should the new system enforce? | Owner / Pharmacist |
| V3 | Manual journal vouchers (`GLHeader`/`GLDetail`) are empty. Is manual JV capability required at all? | Accountant |
| V4 | Are any of the 11 **Data Export Utility** pharma feeds (§11.3) contractually required? | Owner |
| V5 | `Ask User/Password in Cash/Credit Sale = Yes` — is this a real control, or do staff share one password? (`dbo.Users` shows passwords `1`, `55`, `z0`, `25`.) | Owner |
| V6 | `SALES OFFICER` can bulk-change item prices and back up the database. Intended? | Owner |
| V7 | FBR: fiscalization is ON (`Auto Fiscalize On Posting = Yes`, POS ID 141973, Rs 1.00 POS fee auto-applied) but Digital Invoicing is OFF with empty tokens. Which regime applies going forward? | Owner / Tax advisor |
| V8 | Which of the 1,277 visible preferences are actually *used*? Pruning requires business input. | Owner + rebuild team |
| V9 | Are the multi-site features (CRS, parent/child replication, Drop Box) planned for the future, or dead? | Owner |
| V10 | Third-party customer names embedded in `components.pbd` (§3.1) — confirm with the vendor whether any Fazal Din data has similarly leaked into other clients' binaries. | Owner → vendor |

---

# 15. Coverage Statement & Open Unknowns

## 15.1 What fraction of the UI was recovered

| Dimension | Recovered | Basis |
|---|---|---|
| **Screen (window) inventory** | **100%** — 2,066 of 2,066 | PBD object-catalogue entries are plaintext UTF‑16 with `.win` suffixes |
| DataWindow inventory | 100% — 8,747 | same, `.dwo` suffix |
| Menu object inventory | 100% — 156; item-name inventory 1,761 maximal names | same, `.men` suffix; item names from prefix-reduced `m_*` set |
| Which library hosts which screen | 100% | same |
| Data binding (tables/columns per screen) | **~85–90% for the 14 deep-dived screens; partial elsewhere** | 12,470 recovered `SELECT` fragments; some are truncated mid-token by non-printable bytes |
| Field captions | **~4,385 distinct captions**; for the Sale screen, captions and *visibility* are 100% verified via `dbo.SoftwarePreferences` | string corpus + live DB |
| Validation rules | 2,880 distinct messages; the *expressions* behind them recovered only sporadically (e.g. `Real(GetText()) >= 0`) | string corpus |
| Keyboard shortcuts | High confidence for `w_sale`/POS; partial elsewhere | literals + `Rights.RightName` |
| **Visual layout (x/y/w/h, tab order, per-control colour & size)** | **0%** | compiled bytecode |
| Event-script behaviour | **0%** | compiled bytecode. Authoritative behaviour lives in the 762 DB programmable objects |

**Honest summary: this document is a complete *inventory* and a strong *data-binding + validation* recovery; it is not a visual specification.**

## 15.2 Open unknowns

| # | Unknown | Why it matters | Suggested resolution |
|---|---|---|---|
| U1 | **Actual on-screen layout of every screen.** No geometry survived compilation. | The rebuild team cannot reproduce the operator's spatial muscle memory from this document. | Take **screenshots of the running application** for the ~20 screens in §11.1. Cheap, high value. |
| U2 | **Tab order** on every screen. | Directly determines keyboard throughput, which is the #1 operational requirement. | Screen-record a cashier entering 5 invoices. |
| U3 | **Font point sizes.** Typefaces recovered; sizes not. | Determines whether the current UI is already too small. | Screenshot + measure. |
| U4 | **Menu item *display text*.** Reconstructed from `Rightsclone` + `m_*` object names, not read directly. | Menu wording for the new IA. | Screenshot the menu bar; or compare `Rightsclone.MenuName` to the live menu. |
| U5 | Whether menus for `Transactions`, `E-Prescription`, `Patient Management`, `Activities` are **hidden or merely unrestricted** at this site. | Determines scope of the "shipped-unused" claim. | Launch the app as `ADMIN` and observe the menu bar. |
| U6 | **`Script.mdb` (29.4 MB Microsoft Access database)** sits in the Application folder. Contents not analysed in this pass. | Could contain report definitions, script templates, or migration data that materially affects the rebuild. | Open read-only and catalogue. **Recommended next step.** |
| U7 | **`mdsys.exe` (49 KB)** — a second executable shipped alongside `abuzar.exe`. Purpose unknown. | Possible licensing/watchdog/fiscalization bridge. | Inspect strings / process behaviour. |
| U8 | Exact semantics of `CTRL+D` in POS (a right-gated, enabled action). | Could be destructive. | Ask the vendor or test in a copy environment. |
| U9 | The nine purchase-order reorder algorithms (`d_dspodetail*`) — only the DataWindow *names* and table bindings were recovered, not the full SQL. | Reorder logic is commercially critical. | Targeted deep extraction of `pocomponents.pbd` SELECT text, or observe the screen with known data. |
| U10 | Whether the vendor's embedded client roster in `abuzarapp.pbd` includes any Fazal Din data that has been shipped to other sites. | Data-protection exposure. | Raise with vendor (V10). |
| U11 | `dbo.Rightsclone` vs `dbo.Rights` divergence (2,122 vs 486 rows) — is `Rightsclone` the product default, an upgrade staging table, or a backup? `temp_GroupRights` (6,265 rows) similarly unexplained. | Affects how the rebuild derives its permission catalogue. | Compare against a fresh vendor installation. |
| U12 | Whether `w_login1`, `w_customersite_form_old`, `w_transfer_old`, `w_voucher_old`, `w_purpayment_old`, `w_sendmail_old`, `w_emp_attendance_old`, `ww_qualifiedperson_form`, `ww_custwiseitemcategory` are dead code or still reachable. | Dead-code volume estimate. | Grep menu wiring in a decompiled build, or vendor confirmation. |

---

# 16. Appendix — Derived Evidence Artifacts

All produced read-only during this analysis; retained for audit.

| File | Contents |
|---|---|
| `…/scratchpad/extract_strings.ps1` | The extraction script (byte read → Latin‑1 → ASCII + UTF‑16LE regex) |
| `…/scratchpad/pbdstr/*.txt` (120) | Per-library string corpus, lines prefixed `A|` (ASCII) or `U|` (UTF‑16LE) |
| `…/scratchpad/pbd_defined_objects.tsv` | 11,587 rows — `library ⟶ object.suffix` |
| `…/scratchpad/pbd_summary.tsv` | 120 rows — per-library size + object counts by type |
| `…/scratchpad/win_clean.tsv` | 2,066 rows — `library ⟶ window name` (cleaned) |
| `…/scratchpad/menu_items_max.txt` | 1,761 maximal menu-item object names |
| `…/scratchpad/all_labels.txt` | 4,385 distinct colon-terminated field captions |
| `…/scratchpad/all_validation_messages.txt` | 2,880 distinct validation / error strings |
| `…/scratchpad/rights.tsv` | Live `dbo.Rights` (486 rows) |
| `…/scratchpad/rightsclone.tsv` | Live `dbo.Rightsclone` (2,122 rows) — the full product menu tree |
| `…/scratchpad/grouprights_named.tsv` | Live named rights for groups 5/11/12 (240 rows) |
| `…/scratchpad/sale_pref_visibility.tsv` | **Live sale-screen field visibility (93 rows)** — §6.1.9 |

**Reproduction command pattern (read-only):**
```powershell
$cs="Server=localhost\SQLEXPRESS;Database=FazalDinPP19DataBaseV2;User ID=sa;Password=…;TrustServerCertificate=True"
# then: SELECT ... FROM dbo.SoftwarePreferences / dbo.Rightsclone / dbo.Rights / dbo.Module
```

---

*End of document 04 — Screen / Form Inventory.*
*Companion documents: `02-repository-map.md`, `05a-workflows-sales.md`, `05b-workflows-purchase.md`, `06-database-analysis.md`, `07-accounting-logic.md`, `08-inventory-logic.md`, `09-roles-permissions.md`, `10-reports-catalog.md`, `11-integrations-dependencies.md`.*
