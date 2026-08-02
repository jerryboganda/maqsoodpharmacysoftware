# 02 — Repository Map

**Analysis phase:** Stage 1 (Read‑Only Discovery)
**Status of this document:** Verified structure; module *purposes* are Strongly Inferred from names + DB objects until PBD/DB deep‑analysis (Stage 2–3) confirms them.
**Working directory analysed:** `E:\Pharma Software`
**Discovery commands used:** recursive `Get-ChildItem` inventories + extension histogram + `ctx_execute_file` over `extracted_scripts.sql` (all read‑only).

> ⚠️ **Reality correction vs. the assignment brief.** The brief is written for a web‑app repo (routes / controllers / services / models / migrations). **This project is not that.** It is a **compiled Sybase/SAP PowerBuilder 12.5, 32‑bit Windows desktop application** backed by **Microsoft SQL Server**. Consequently the authoritative business logic lives in **SQL Server stored procedures, functions, triggers and schema**, and the UI lives in **compiled DataWindows inside `.pbd` binaries** — *not* in readable source. The analysis method is adapted accordingly (see §6). All deliverables the brief requests are still produced; only the evidence sources change.

---

## 1. What this is (Verified)

| Fact | Value | Evidence |
|------|-------|----------|
| Product | **WASEELA ABUZAR V3** (title `WASEELA ABUZAR V3 01.01.2025`) | `ABUZAR_V2_RECOVERY_JOURNAL.md` §1; app title bar |
| Application type | PowerBuilder 12.5, 32‑bit desktop `.exe` | `abuzar.exe` (1.11 MB, 2024‑11‑08) + `PBVM125.dll`, `pb*125.dll` runtime in `Application\` |
| Compiled build | **3567** | Recovery Journal §4 (Problem 7 binary search) |
| Data tier | Microsoft SQL Server (orig. SQL 2000‑era → migrated to **SQL Server 2019 Express**) | Journal §1; `SQLData\*.mdf` |
| Live database | `FazalDinPP19DataBaseV2` (**761–762 tables**, ~643 procs, 73 functions, 34 views, 10 triggers) | Journal §1, §9b |
| Source code | **NONE present — compiled binaries only** | `*.pbl/*.srw/*.sru/*.srd/*.sra/*.pbt/*.pbw/*.pbg` counts = **0** (verified) |
| Vendor / customer | Product by **Abuzar** (a.k.a. Waseela); this deployment is client **"Fazal Din PP19"** (a pharmacy). `MehmoodDataBase`, `KausarDataBase` names indicate other client sites. | DB/backup filenames; Journal |
| Scope of product | **Multi‑vertical ERP** — pharmacy/retail + hospital/clinic + school + HR/payroll + hotel/guest + manufacturing + loyalty + multi‑branch sync + tax fiscalization | 762‑table schema; `.pbd` module names (§4) |

**Total files in tree:** 2,432. Dominant types: `.dll` 918 (mostly PB runtime + SQL Server installer), `.pbd` 244 (122 live + 122 backup copies), `.xml` 144, `.rll`/`.exe`/`.if`/`.ve6` (PB deploy + installer artifacts), `.sql` 26.

---

## 2. Top‑level directory tree (Verified)

```
E:\Pharma Software\
├─ V2_AbuzarSoftware\              ← the application deployment
│  ├─ Application\                 ← RUNTIME: abuzar.exe + 122 .pbd + PB runtime DLLs
│  │  ├─ PBD_Backup\               ← hash-matched backup copies of the 122 .pbd (Journal §1)
│  │  ├─ Reports\                  ← report output/templates
│  │  └─ TmpWebService\            ← PB web-service scratch (SOAP/WSDL runtime)
│  ├─ Data\                        ← MSSQL.rat (112 MB password-protected RAR of raw MDF/LDF — NOT needed, Journal §9)
│  ├─ Backup\ , AutoBackup\        ← SQL .BAK dumps (live + auto startup/shutdown)
│  ├─ FiscalizationApp\            ← SEPARATE tax-authority (FBR) e-invoice/QR app (63 dll, .exe, .jar, .ocx, QRCodeGenLibrary.dll)
│  ├─ IMSSetup\                    ← InstallShield/IMS installer (.ims 65 MB) + Backup\
│  └─ Junk\                        ← 2024-11-11 dated copies of old MDF/LDF/BAK (legacy duplicates)
├─ SQLData\                        ← attached SQL Server files: MehmoodDataBase*.mdf/.ldf + _SQL2008R2.bak
├─ extracted_db\  (BACKUP\, Data\) ← extracted DB artifacts
├─ tools\                          ← SQLEXPR2008R2 installer, 7z, provisioning + backup PowerShell scripts, SQL2008R2Extracted\
├─ .serena\  (cache\, memories\)   ← Serena project workspace
├─ docs\system-analysis\           ← THIS ANALYSIS (new, additive)
├─ extracted_scripts.sql           ← 10.7 MB — extracted DDL + procs/functions/views/triggers (offline evidence, ~85–90% complete; see §5)
├─ FazalDinPP19V3DBDump.BAK (2.29 GB) + FazalDinPP19V3Log.ldf ← DB backup + log
├─ ABUZAR_V2_RECOVERY_JOURNAL.md   ← prior-session operational recovery (authoritative env reference)
├─ ABUZAR_V2_CONNECTION_RESOLVED.md
└─ diagnostic .txt (dbparm_all, sqloledb_occurrences, strings_kw, pbole125_occurrences, server_context, license.txt)
```

---

## 3. Application entry points & startup gates (Verified — from Recovery Journal)

| Entry point | Detail |
|-------------|--------|
| Executable | `V2_AbuzarSoftware\Application\abuzar.exe` |
| DB connection | OLE DB, `PROVIDER='SQLOLEDB'` → dials server alias `FAZALDINPP19` → `FazalDinPP19DataBaseV2` |
| Startup gate 1 | `SP_WayToMoon` — licensing check: requires marker files `systemab.dll` + `tapi161.dll` in `SysWOW64` (uses `xp_cmdshell`) |
| Startup gate 2 | `Sequence` table `AppVersion` vs. compiled build (must be ≤ 3567) |
| App auth | `dbo.Users` (plaintext passwords). Admin = `ADMIN` / `pakistan9080` (UserCode 1) + 8 staff |
| SQL auth | `sa` / `2yhg35xe` (hardcoded in binary) |
| In‑app backup | Broken on SQL 2019 (hardcoded `MEDIAPASSWORD`, removed in SQL 2012). Replaced by external scheduled task. |

---

## 4. Module backbone — 122 compiled `.pbd` libraries (Verified existence; purpose Strongly Inferred)

Grouped by inferred domain. Each `.pbd` is a compiled PowerBuilder library (windows + DataWindows + user objects). Names are strong evidence of module existence; internal screens/fields require Stage‑2 binary extraction to enumerate.

- **Core / framework:** `abuzarapp` (main app object), `functions`, `lists`, `dropdowns`, `labels`, `templates`, `preferences`, `printer`, `popupmenus`, `notescomponents`, `dw2xls`/`pb2xls` (Excel export)
- **Master data & inventory:** `components`, `custcomponents`, `singleentry`, `singleentryitem`, `multientry`, `multientryitem`, `multientrygroups`, `multientryitemrespwin`, `multientrypolicy`, `changeitemprice`, `adjustment`, `transfer`, `issuecomponents`, `issuereq`, `expiryintimation`, `packingmodule`, `barcodecomponents`, `barcodefunctions`
- **Purchasing:** `purchasecomponents`, `purchaseprintouts`, `purchaseresponsewin`, `advancedpurchase`, `proformapurchase`, `pocomponents` (purchase orders), `prcomponents` (purchase returns), `purchase&returnreports`
- **Sales / POS:** `salewin`, `saleorder`, `advancedsale`, `proformasales`, `salemodified`, `poscomponents`, `cashierjob`, `useratten`, `saleprintouts`, `salerespwin`, `salereturncomponents`, `salereturnprintouts`
- **Quotation:** `quotation`
- **Customers / receipts / dues / accounting:** `receiptcomponents`, `contactmanagement`, `duecomponents`, `billsummary`, `incentivesheet`, `accounts`, `accountsext`, `accountsrespwin`, `accountstemplate`
- **Services (lab/diagnostic/clinic services & service‑sales):** `servicecomponents`, `serviceheads`, `servicemodules`, `servicepurcomponents`, `serviceresult`, `servicesalescomp`, `servicesalesatoh`, `servicesalesitop`, `servicesalesqtoz`, `servicesalesreturn`, `servicesaleprintouts`, `ipsale`, `ipservices` (in‑patient)
- **Healthcare / patient:** `patientcomponents`, `patientvisitcomp`, `patientvaccinecomp`, `eprescriptionbasics`
- **Education:** `studentcomponents`
- **HR:** `employee`
- **Hospitality:** `guestcomponents`
- **Multi‑branch sync (CRS / DataCarry):** `crscomponents`, `crsreports`, `datatransferapp`, `datatransfercomponents`
- **Messaging:** `smscomponents`, `smswebservices`
- **Reporting infrastructure & dashboards:** `reports` (20 MB), `reports_cust`, `reportformat`, `reportdwarg`, `reportviewer`, `psrviewer`, `specialreports`, `managementreports`, `mgmtcomp`, `financialreports`, `graphcomponents`, `dashboard`, `agingreports`, and domain report libs: `accountreports`, `salereports*` (comp/cust/det/summ/modreports), `purchase&returnreports`, `itemreports`, `stockreports`, `godownreports`, `issuereports`, `patientreports`, `servicereports`, `receiptreports`
- **Large print/data libraries (alphabetical partitions):** `sprntatod`, `sprntetok`, `sprntlton`, `sprntotos`, `sprntttoz` (150 MB combined — likely partitioned sale/print DataWindows; to confirm in Stage 2)

**Companion:** `Script.mdb` (28 MB MS Access) in `Application\` — role unconfirmed (possibly report/DataWindow or dynamic‑script store). Flagged for Stage 2. `FiscalizationApp\` is a separate tax‑fiscalization helper (QR/e‑invoice) with its own DLLs, `.jar`, `.ocx`.

---

## 5. Database evidence assets (Verified)

| Asset | Use in analysis |
|-------|-----------------|
| **Live DB** `FazalDinPP19DataBaseV2` on `localhost\SQLEXPRESS` | Authoritative & complete. Needs read‑only permission to introspect (row counts, seed/config/permission data, `OBJECT_DEFINITION`). |
| `extracted_scripts.sql` (10.7 MB, 10.7 M chars) | Offline mirror of DDL + programmable objects. **Partial (~85–90%)** — regex counts: 683 `CREATE TABLE` (incl. ~50 `#temp`), 532 procedures, 30 views, 10 triggers, 72 functions vs. live 761/643/34/10/73. Usable now with the "may be incomplete" caveat. |
| `FazalDinPP19V3DBDump.BAK` (2.29 GB), `SQLData\*.mdf`, `extracted_db\` | Full data for reconciliation & migration dry‑runs later. |

Programmable‑object naming already reveals the accounting & inventory engines, e.g. `sp_PostSaleLedger`, `sp_PostGeneralLedger`, `SP_VirtualGL_*` (double‑entry GL), `SP_OpeningBalance`/`SP_AbsoluteOpeningBalance`, `SP_UpdateStockLedger`/`SP_UpdateItemStockLedger`, `sp_Aging*`, `sp_IncomeStatement`, `sp_PostStockAdjustment`, `sp_PostPurOrder`, `SP_FiscalizeSaleInvoice`. These are the primary targets for Pass 6 (calculations) and Pass 4 (workflows).

---

## 6. Adapted evidence hierarchy for THIS system

Because there is no application source, evidence is ranked:

1. **SQL Server programmable objects & schema** (procs/functions/triggers/views/DDL) — *directly readable → "Verified"* business rules, calculations, posting logic.
2. **Live DB data** (seed/lookup/config/permission tables, row counts) — *"Verified"* for what modules are actually used and how the product is configured.
3. **Compiled `.pbd` binary extraction** (embedded DataWindow SQL, window titles, menu text, column labels via string/asset extraction) — recovers the **screen/form/field** layer; typically *"Strongly Inferred"/"Unclear"* pending runtime confirmation.
4. **Runtime observation** (driving the running app, read‑only) — confirms UI/workflow; used to upgrade findings to *"Verified."*
5. **Auxiliary:** help/`.chm`, `Script.mdb`, config `.ini`, FiscalizationApp, prior recovery docs.

Anything not supported by the above is labelled **Recommended** (for the new system) and never presented as existing.
