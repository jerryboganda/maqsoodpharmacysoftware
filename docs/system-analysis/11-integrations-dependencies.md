# 11 — Integrations & External Dependencies

**System under analysis:** WASEELA ABUZAR V3 (vendor "Abuzar Consultancy, Lahore"), deployment **Fazal Din PP19** — retail pharmacy.
**Analysis stage:** Stage 11 — External integrations, fiscalisation/tax, messaging, hardware, third-party runtime and database-level external surface.
**Document status:** Evidence-based reverse engineering. **There is no application source code** (zero `.pbl/.srw/.sru/.srd/.pbt`). Authoritative logic = SQL Server programmable objects + schema + live data + string analysis of compiled binaries.

---

## Evidence sources used

| # | Source | What it gave us |
|---|--------|-----------------|
| E1 | `db_modules_full.sql` (2.48 MB, 762 objects: 643 procs / 74 funcs / 34 views / 10 triggers) | Full T-SQL source of `SP_FiscalizeSaleInvoice`, `SP_GetSaleInvoice_JSON`, `SP_RequestHttpWebService`, `SP_CreateDataSMS`, `SP_CRS_*`, `SP_WayToMoon`, `SP_MyExecuteLocal`, tax functions |
| E2 | **Live database** `FazalDinPP19DataBaseV2` on `localhost\SQLEXPRESS` (read-only SELECT/metadata queries only) | Actual FBR lookup contents, fiscalisation counts, `SoftwarePreferences` values, `sys.configurations`, `sys.servers`, `sys.objects` create dates |
| E3 | `table_columns.tsv` / `INFORMATION_SCHEMA.COLUMNS` | Column-level proof of fiscal/digital-invoicing/sync columns |
| E4 | `E:\Pharma Software\V2_AbuzarSoftware\Application\*` (122 `.pbd`, 60+ DLLs) | Binary string extraction: hardcoded SMS gateway URLs, Google QR URL, Jet OLEDB connection strings, device lists |
| E5 | `E:\Pharma Software\V2_AbuzarSoftware\FiscalizationApp\*` | `fiscalizationapp.pbd` string extraction → TCP socket listener, FBR JSON builder, registry key |
| E6 | `E:\Pharma Software\V2_AbuzarSoftware\IMSSetup\141973.ims` (68 MB, encrypted) | Named after the live FBR POS ID |
| E7 | Windows file/version metadata (`VersionInfo`) on every third-party DLL | Exact third-party library versions (OpenSSL 0.9.8l, Xerces 2.6.0, TX Text Control 15, DW2XLS 5.1.8 …) |
| E8 | Host inspection (services, listening ports, `D:\V3_AbuzarSoftware`) | Proof that this machine is a **recovery copy**, not the production host |

### Evidence-label legend (applies to every labelled claim below)

| Label | Meaning |
|-------|---------|
| **Verified** | Read directly in proc/function/view/schema/live data/binary string. Quoted or citable. |
| **Strongly Inferred** | Multiple converging pieces of evidence, no direct statement. |
| **Unclear** | Evidence insufficient or contradictory. |
| **Missing** | Expected artefact does not exist. |
| **Deprecated** | Exists but superseded / end-of-life. |
| **Broken/Incomplete** | Present in code but demonstrably cannot work or is half-finished. |
| **Recommended** | A **proposal for the NEW Node/React/MySQL system**. NOT an existing feature. |

> **Rule observed throughout:** nothing labelled *Recommended* exists today. Everything else is what the system actually is.

---

## 0. Executive summary — the integration map

| # | Integration | Regime / Vendor | Status at Fazal Din PP19 | Evidence label | Business criticality |
|---|-------------|-----------------|--------------------------|----------------|----------------------|
| 1 | **FBR POS fiscalisation** (real-time invoice numbering) | Pakistan FBR / PRAL "POS Integration" (Tier-1 retailer regime) | **ACTIVE — 290,922 of 291,361 sale invoices fiscalised (99.85 %)** | Verified | **Legally mandatory. Highest.** |
| 2 | **FBR Digital Invoicing (DI)** (`gw.fbr.gov.pk/di_data/v1/di/...`) | Pakistan FBR digital-invoicing gateway | **CONFIGURED BUT IDLE** — schema installed 2026‑05‑11, `ImplementDigitalInvoicing='N'`, tokens empty, `Digitalized='N'` on **all 291,361** invoices | Verified | **Compliance exposure. High.** |
| 3 | **FiscalizationApp** (separate PB EXE, TCP socket server) | Abuzar in-house | **ACTIVE transport** — `FiscalizationMethod=2` = "Use Fiscalization Application", port 9111 | Verified (pref) / Strongly Inferred (runtime) | High |
| 4 | **Local FBR middleware** `http://localhost:8524/api/IMSFiscal/...` | Third-party / PRAL "IMS" | **ACTIVE** (referenced by both DB proc and FiscalizationApp) | Verified (config) | High |
| 5 | **QR code generation** | `QRCodeGenLibrary.dll` (offline) — *not* Google Charts | **ACTIVE, offline path selected** (`qrcodeprintingmethodinsale='Q'` → "Use QRCodeGenLibrary - Offline") | Verified | Medium |
| 6 | Google Chart QR web service | `chart.apis.google.com/chart?cht=qr` | **DEPRECATED / DEAD** (Google retired the Infographics QR API); alternate code path only | Verified (string) + Deprecated | Low (not selected) |
| 7 | **SMS / bulk messaging** | Zong CorporateCBS (+6 other Pakistani gateways hardcoded) | **DORMANT** — `SMS_Center` = 0 rows, `SMS_Template` = 0 rows, all credentials empty | Verified | Low today, medium for rebuild |
| 8 | **GSM modem SMS (PDU)** | `MyPDUConverter.dll` (Abuzar in-house) | **DORMANT** | Verified (binary) | Low |
| 9 | **CRS multi-branch consolidation** (`SP_CRS_*`, 60+ procs) | Abuzar "Central Reporting System" | **DORMANT** — all 60+ `CRS_*` tables have **0 rows**; only linked server is the loopback self | Verified | None today |
| 10 | **DropBox / DB_* site-to-site invoice exchange** | Abuzar | **DORMANT** — `SaleLedger.SiteCode`/`TargetSiteCode` unused; `DataTransferLog` = 0 rows | Verified | None today |
| 11 | **DataCarry / migration packets** (`SP_PrepareDataMigrationPacket`) | Abuzar (BACKUP/RESTORE-based transport) | **DORMANT** | Verified | None today |
| 12 | **WaseelaMini export** (`SP_WaseelaMini_*`, 5 views) | Abuzar lightweight satellite app | **DORMANT** (linked-server dependent; no remote server) | Verified | None today |
| 13 | **Excel import** `SP_Get_ResultSet_From_Excel` (OPENROWSET + Jet) | Microsoft Jet OLEDB 4.0 | **BROKEN** — `Ad Hoc Distributed Queries = 0` (disabled) and Jet 4.0 is 32-bit-only | Verified | Low |
| 14 | **Excel export** DW2XLS / `pb2xls.dll` 5.1.8 | Desta Ltd (desta.com.ua, Ukraine) | Present, **Strongly Inferred ACTIVE** (report export) | Strongly Inferred | Medium |
| 15 | **PDF / RTF / DOC / HTML rendering** | TX Text Control 15 (`tp15_*.dll`, The Imaging Source) | Present, usage unproven | Unclear | Low |
| 16 | **TWAIN document scanning** | `EZTW32.dll` + "Dynamic Twain" (`ImageScanTool='Dynamic Twain'`) | Configured; no scanned images in DB | Unclear | Low |
| 17 | **Weighing scale** (barcode-embedded weight) | MOTEX ML 30P, `WeighingScale` table = 1 row | Configured (seed); usage unproven | Unclear | Low |
| 18 | **Barcode / label printers** | 45 device profiles (Zebra, TSC, Argox, Gprinter…) | `UseBarCodePrinter='N'`, `BarCodePrinterName` empty → **not used** | Verified | Low |
| 19 | **Biometric attendance** | `BioMetricMachine` (IPAddress/PORT) = **0 rows**; `EMP_FingerPrint` = 0 rows | **DORMANT** | Verified | None |
| 20 | **Customer payment API** | `CustomerPaymentAPIHost/Key/UserName/Password` | **DORMANT** — `UseCustomerPaymentAPI='N'`, all values empty | Verified | None today |
| 21 | **Licensing / anti-piracy** | `SP_WayToMoon` + `xp_cmdshell` + `Script.mdb` (Jet, 28 MB, obfuscated) | **ACTIVE and load-bearing** — blocks startup if broken | Verified | **Blocker for any migration** |
| 22 | **OS/DB external surface** | `xp_cmdshell=1`, `Ole Automation Procedures=1`, `SP_MyExecuteLocal` (arbitrary SQL) | **ENABLED** | Verified | **Security-critical** |

---

## 1. Pakistan FBR fiscalisation — the single most important integration

### 1.0 Two distinct FBR regimes are present. Do not confuse them.

| | **Regime A — FBR POS Integration** | **Regime B — FBR Digital Invoicing (DI)** |
|---|---|---|
| Pakistani framework | Online integration of Tier‑1 retailers (POS invoicing / "fiscal invoice number" + QR) | FBR Digital Invoicing gateway (`di_data/v1/di`), sandbox + production, bearer-token based |
| Endpoint(s) in this system | `http://localhost:8524/api/IMSFiscal/GetInvoiceNumberByModel` (POST) and `.../Get` (GET, test) — a **local middleware** | `https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata` (+ `_sb` sandbox, + `validateinvoicedata`) — **direct to FBR** |
| Identity | `FBRPOSID = 141973` | `DigitalInvoicing_NTN` (empty), `DigitalInvoicingProductionToken` (empty) |
| DB columns | `SaleLedger/SRLedger.Fiscalized, FiscalizedOn, FiscalInvoiceNo` | `SaleLedger/SRLedger.Digitalized, DigitalizedOn, DigitalizedBy, DigitalInvoiceNo, ScenarioID, BuyerRegStatus`; `SaleDetail/SRDetail.UOM, TransType` |
| Lookup tables | none (uses `PCT`, `SalesTaxSchedule`) | `FBR_DI_DocType`, `FBR_DI_TransactionType`, `FBR_DI_Scenario`, `FBR_DI_UOM` |
| **Status here** | **ACTIVE, daily, 290,922 invoices** | **NOT ACTIVATED — zero invoices** |

**Evidence:** `SoftwarePreferences` rows `FBRPOSID`, `FBRInvoiceServiceURL`, `DigitalInvoicingProductionURL`, `ImplementDigitalInvoicing`; `SELECT Fiscalized, COUNT(*) FROM SaleLedger`; `SELECT Digitalized, COUNT(*) FROM SaleLedger`.

---

### 1.1 Regime A — FBR POS fiscalisation is LIVE (Verified)

```
SELECT Fiscalized, COUNT(*), MIN(FiscalizedOn), MAX(FiscalizedOn) FROM SaleLedger GROUP BY Fiscalized
 Y | 290,922 | 2025-01-01 17:12:57 | 2026-07-31 18:41:06
 N |     439 |        (null)       |        (null)
```

| Metric | Sale invoices | Sale-return invoices |
|---|---|---|
| Total rows | 291,361 | 30,704 |
| Fiscalised (`Fiscalized='Y'`) | **290,922 (99.85 %)** | **11,049 (36.0 %)** |
| Not fiscalised | 439 | 19,655 |
| 2025 | 197,625 total / 197,276 fiscalised | 20,867 total / **1,225** fiscalised |
| 2026 | 93,736 total / 93,646 fiscalised | 9,837 total / **9,824** fiscalised |

**Reading (Verified):** sale-invoice fiscalisation has been continuous since 1 Jan 2025. **Sale-return fiscalisation was effectively switched on during/after 2025** — in 2025 only 5.9 % of returns were fiscalised, in 2026 99.87 % are. This is a discontinuity a tax adviser must review.

**Sample fiscal invoice numbers (Verified):**

| SaleInvCode | Invoice Date | `FiscalInvoiceNo` |
|---|---|---|
| 880233 | 2026‑07‑31 18:41:03 | `14197326073118416337` |
| 880232 | 2026‑07‑31 18:40:52 | `141973260731184054933` |
| 880231 | 2026‑07‑31 18:40:36 | `141973260731184038725` |

**Format (Verified for the first 12 digits, Strongly Inferred for the tail):** `<POSID=141973><YYMMDD=260731><HHMM…><sequence/millis>`, total length **20–21 characters**, `varchar(100)`. The POS ID prefix and the embedded `YYMMDD` reconcile exactly with `SaleLedger.Date`. The exact composition of the trailing 6–9 digits is **Unclear** (seconds + milliseconds + counter is the best fit but two samples do not decode cleanly as `HHMMSS`).

---

### 1.2 The fiscalisation transport chain — three code paths, only one is live

There are **three** distinct implementations of "send this invoice to FBR". Getting this right matters enormously for the rebuild.

#### Path 1 — SQL-side, via OLE Automation (`SP_FiscalizeSaleInvoice`) — **present but NOT invoked on posting**

`Evidence: dbo.SP_FiscalizeSaleInvoice → dbo.SP_GetSaleInvoice_JSON → dbo.SP_RequestHttpWebService → sp_OACreate 'MSXML2.ServerXMLHttp'`

```sql
SET @UseTestSvc = ISNULL(DBO.Fn_GetPreference('UseFBRTestService'),'Y')
IF @UseTestSvc = 'Y'
    SET @Url = ISNULL(DBO.Fn_GetPreference('FBRTestServiceURL'),
                      'http://localhost:8524/api/IMSFiscal/Get'), @HttpMethod = 'GET'
ELSE
    SET @Url = ISNULL(DBO.Fn_GetPreference('FBRInvoiceServiceURL'),
                      'http://localhost:8524/api/IMSFiscal/GetInvoiceNumberByModel'), @HttpMethod = 'POST'
...
IF CHARINDEX('"Code":"100"', @Response, 1) > 0
  AND CHARINDEX('{"InvoiceNumber":"', @Response, 1) > 0
    SET @FiscalInvCode = SUBSTRING(@Response, 19, CHARINDEX('","Code":"100"', @Response, 1) - 19)
    UPDATE SaleLedger SET Fiscalized='Y', FiscalizedOn=GETDATE(), FiscalInvoiceNo=ISNULL(@FiscalInvCode,'')
```

**CRITICAL FINDING (Verified):** the auto-fiscalise call inside the posting procedures is **commented out in both cases**.

`Evidence: dbo.sp_PostSaleLedger, lines 43153–43162 of db_modules_full.sql`
```sql
/*	IF @AutoFiscalize = 'Y'
	BEGIN
		EXECUTE @rt_code = DBO.SP_FiscalizeSaleInvoice @SaleInvCode, @ai_SalesmanCode
		...
	END
*/
```
`Evidence: dbo.sp_PostSRLedger, lines 44596–44604` — the identical block for `SP_FiscalizeSRInvoice` is also inside `/* … */`.

So `AutoFiscalizeOnPosting = 'Y'` is read into `@AutoFiscalize` and then **never used**. **Label: Broken/Incomplete (dead code retained).**

#### Path 2 — the standalone **FiscalizationApp** (the live path) — **Strongly Inferred ACTIVE**

`SoftwarePreferences.FiscalizationMethod = '2'`, and the preference's own display value is literally **"Use Fiscalization Application"** (`PrefValue2`). `FiscalizationAppPort = 9111`. `FiscalizationMachine` and `FiscalizationMachineIP` are **empty** → same machine / localhost.

String analysis of `E:\Pharma Software\V2_AbuzarSoftware\FiscalizationApp\fiscalizationapp.pbd` (Verified strings):

| String found | Meaning |
|---|---|
| `n_winsock.udo`, `of_listen`, `of_accept`, `WSAStartup`, `WSAAsyncSelect`, `closesocket`, `ListenPort`, `u_tabpg_tcpip_listen` | It is a **TCP/IP socket server**, not a Windows service |
| `Request Received for Sale Invoice #:` / `Request Received for S/R Invoice #:` / `Request Received for QRCode for Sale Invoice #:` | Three request verbs over the socket |
| `d_saleinvoice_json`, `d_srinvoice_json`, `d_saleinvoice_json_old` | The JSON is built by **DataWindows** that duplicate `SP_GetSaleInvoice_JSON`'s SQL |
| `f_fiscalizesaleinvoice.fun`, `f_fiscalizesrinvoice.fun` | Client-side fiscalise functions |
| `FBRInvoiceServiceURL`, `FiscalizationAppPort`, `UseFBRTestService` | It reads the **same** `SoftwarePreferences` keys |
| `HKEY_CURRENT_USER\Software\Waseela\FiscalizationApp` | Additional per-user config lives in the **Windows registry** (contents unknown here) |
| `Fiscalization Done, Fiscal Invoice No.:` / `Fiscalization Error-1/-2/-3:` / `Fiscalization failed, Database Connection Error.` | Result protocol back over the socket |
| `application/json`, `","Code":"100"` | Same JSON contract and same `Code:100` success marker |

**Architecture (Strongly Inferred):** `abuzar.exe` (POS) → TCP `localhost:9111` → `fiscalizationapp.exe` → HTTP POST → `localhost:8524/api/IMSFiscal/GetInvoiceNumberByModel` → FBR/PRAL. `fiscalizationapp.exe` then writes `Fiscalized/FiscalizedOn/FiscalInvoiceNo` back to `SaleLedger`.

#### Path 3 — the local **IMS middleware** on port 8524 — **Unclear (opaque third party)**

- `E:\Pharma Software\V2_AbuzarSoftware\IMSSetup\141973.ims` — **68,411,392 bytes**, filename == `FBRPOSID`. First bytes `01 9B 48 9F D6 66 41 A1 BE 16 BE E3 B0 E4 76 AE AF 00 …` then a long run of zeros; a full-file printable-string scan returns **nothing readable** ⇒ **encrypted/sealed**.
- **Strongly Inferred:** this is the FBR/PRAL *Invoice Management System* sealed store or installer that backs the `api/IMSFiscal` endpoint (the FBR POS regime requires an approved local fiscal recording component).
- **Verified:** on this analysis machine there is **no service and no listener on 8524 or 9111**, no `IMS`/`FBR`/`PRAL` program folder, and `D:\V3_AbuzarSoftware` (the path recorded in `SoftwarePreferences.LogoOnInvoices`) **does not exist**. ⇒ This machine is a *recovery copy*; the middleware runs only on the customer's production PC.

> **Migration blocker (Recommended action):** the rebuild team must obtain, from the customer's production machine, (a) the vendor/product behind `api/IMSFiscal`, (b) its licence/registration, and (c) the contents of `HKCU\Software\Waseela\FiscalizationApp`. Without these, real fiscal invoice numbers cannot be issued by any replacement system.

---

### 1.3 The FBR POS invoice JSON contract (Verified — reusable verbatim in the rebuild)

`Evidence: dbo.SP_GetSaleInvoice_JSON` (and the identical DataWindow `d_saleinvoice_json` inside `fiscalizationapp.pbd`).

**Envelope (header object), sale invoice:**

```json
{"InvoiceNumber":"","POSID":"141973","USIN":"880233","DateTime":"2026-07-31 18:41:03.000",
 "BuyerNTN":"","BuyerCNIC":"","BuyerName":"CASH CUSTOMER","BuyerPhoneNumber":"",
 "TotalBillAmount":"1234.00","TotalQuantity":"7","TotalSaleValue":"1150.00",
 "TotalTaxCharged":"84.00","Discount":"0.00","FurtherTax":"0.0",
 "PaymentMode":"1","RefUSIN":"null","InvoiceType":"1","Items":[ … ]}
```

| JSON field | Source expression (exact) | Notes |
|---|---|---|
| `InvoiceNumber` | literal `""` | filled by FBR in the response |
| `POSID` | `Fn_GetPreference('FBRPOSID')` → `141973` | |
| `USIN` | `STR(S.SaleInvCode)` | the internal invoice PK is the "unique sale invoice number" |
| `DateTime` | `CONVERT(VARCHAR(100), S.DATE, 121)` | `yyyy-mm-dd hh:mi:ss.mmm` |
| `BuyerNTN` | `ISNULL(C.NTNNo,'')` | **always empty** — `Customer.NTNNo` is NULL for both customers |
| `BuyerCNIC` | `ISNULL(C.NIC,'')` | **always empty** |
| `BuyerName` | `ISNULL(A.Name,'')` from `Accounts A` where `A.AccCode = S.CustCode` | |
| `BuyerPhoneNumber` | `ISNULL(C.Phone,'')` | **always empty** |
| `TotalBillAmount` | `STR(S.InvTotal,12,2)` | |
| `TotalQuantity` | `SUM(D.LooseQty + D.BonusQty)` over `SaleDetail` | bonus qty **included** |
| `TotalSaleValue` | `S.InvTotal − dbo.fn_getTaxOnSaleInv(SaleInvCode)` | net of tax |
| `TotalTaxCharged` | `dbo.fn_getTaxOnSaleInv(SaleInvCode)` | see §2.3 |
| `Discount` | `SUM(ROUND((D.LooseQty*D.ItemFlatDisc) + (D.LooseQty*(D.SalePrice−D.ItemFlatDisc)*(D.DiscPerc*0.01)),2))` | **line-level discounts only — invoice-level `SaleLedger.FlatDisc`/`DiscPerc` are NOT included** |
| `FurtherTax` | hardcoded `"0.0"` | |
| `PaymentMode` | hardcoded `"1"` | i.e. always reported as cash |
| `RefUSIN` | hardcoded `"null"` (string) | |
| `InvoiceType` | hardcoded `"1"` | 1 = sale |

**Line item object:**

| JSON field | Source expression |
|---|---|
| `ItemCode` | `I.customICode` |
| `ItemName` | `I.Name` |
| `Quantity` | `STR(D.LooseQty + D.BonusQty, 10, 4)` |
| `PCTCode` | `P.Description` from `PCT P` joined on `I.PCTCode` |
| `TaxRate` | `STS.TaxPerc` from `SalesTaxSchedule STS` joined on `I.SalesTaxScheduleCode` |
| `SaleValue` | `D.LooseQty * D.SalePrice` |
| `TotalAmount` | `D.LooseQty * D.SalePrice` (identical to `SaleValue`) |
| `TaxCharged` | `(D.LooseQty + D.BonusQty) * D.UnitSalesTax` |
| `Discount` | `ROUND((D.LooseQty*D.ItemFlatDisc) + (D.LooseQty*(D.SalePrice−D.ItemFlatDisc)*(D.DiscPerc*0.01)),2)` |
| `FurtherTax` | `"0.0"` |
| `InvoiceType` | `"1"` |
| `RefUSIN` | `"null"` |

**Sale-return variant** (`dbo.SP_GetSRInvoice_JSON`, Verified): identical shape with
`InvoiceType = "3"`, `RefUSIN = STR(SRLedger.SaleInvCode)` (the original sale invoice), `USIN = SRInvCode`,
and **`BuyerNTN`/`BuyerCNIC`/`BuyerName`/`BuyerPhoneNumber` hardcoded to `""`** (no customer join at all).
Line prices come from `D.SRPrice`; the SR discount formula omits `ItemFlatDisc`.

**Response contract (Verified):** success is detected purely by substring:
`CHARINDEX('"Code":"100"', @Response) > 0` **and** `CHARINDEX('{"InvoiceNumber":"', @Response) > 0`,
then `SUBSTRING(@Response, 19, CHARINDEX('","Code":"100"', @Response) - 19)`.
⇒ The response is assumed to literally begin `{"InvoiceNumber":"<number>","Code":"100"…`.

#### Defects in the JSON builder (all **Verified**, all reproduce risk)

| # | Defect | Consequence |
|---|---|---|
| J1 | `@JSON`/`@Qry` are `VARCHAR(8000)`. A cursor concatenates every line. | Invoices with many lines **silently truncate** → malformed JSON sent to FBR. **High severity.** |
| J2 | No JSON escaping anywhere. `I.Name`, `A.Name` are injected raw. | An item name containing `"` or `\` produces invalid JSON. |
| J3 | The line query is an **INNER JOIN** to `PCT` and `SalesTaxSchedule`. | Any item with an unmapped `PCTCode`/`SalesTaxScheduleCode` **vanishes from the FBR filing** while still appearing on the customer's bill. *Currently safe here:* all 30,052 items have both set (`Item.PCTCode` ∈ {1,2,3}, `Item.SalesTaxScheduleCode` ∈ {1..6}) — **but nothing enforces it**. |
| J4 | Header joins `Customer C` **and** `Accounts A` as inner joins. | An invoice whose `CustCode` is missing from either table produces **zero header rows** → JSON becomes `]}`. |
| J5 | Invoice-level discount (`SaleLedger.FlatDisc`, `SaleLedger.DiscPerc`) is excluded from the reported `Discount`, but `fn_getTaxOnSaleInv` **does** apply them. | `TotalBillAmount`, `TotalSaleValue` and `Discount` may not reconcile arithmetically for FBR. **Requires tax-adviser validation.** |
| J6 | `PaymentMode` hardcoded `"1"`; `FurtherTax` hardcoded `"0.0"`. | Card/mixed tender and further-tax cases are misreported. |
| J7 | `TotalQuantity` and `TaxCharged` include `BonusQty`, but `SaleValue`/`TotalAmount` use `LooseQty` only. | Free-goods handling is inconsistent between quantity and value. **Requires accountant validation.** |

---

### 1.4 `SP_RequestHttpWebService` — the generic HTTP/SOAP client inside SQL Server

`Evidence: dbo.SP_RequestHttpWebService`

```sql
exec sp_OACreate 'MSXML2.ServerXMLHttp', @obj out
exec sp_OAMethod @obj, 'Open', null, @method, @Url, false
-- GET:  @Url = @Url + '?' + @ParamsValues ; sp_OAMethod @obj,'send'
-- POST: setRequestHeader 'Content-Type','application/json' ; send @ParamsValues
-- SOAP: builds a hand-rolled soap:Envelope, namespace hardcoded to http://tempuri.org/
exec sp_OAGetProperty @obj, 'responseText', @response out
exec sp_OADestroy @obj
select @status as [status], @statusText as [statusText], @response as [response]
```

| Finding | Label |
|---|---|
| Requires `Ole Automation Procedures` — **confirmed enabled**: `sys.configurations` → `Ole Automation Procedures value_in_use = 1` | Verified |
| `@status` and `@statusText` are **declared and returned but never assigned** → always `NULL`. **The HTTP status code is never checked.** A 500 or a captive-portal HTML page is treated as a normal response. | Verified / Broken/Incomplete |
| No timeout is set on `ServerXMLHttp` → a hung endpoint blocks a SQL Server worker and the POS thread indefinitely. | Verified |
| `sp_OADestroy` is only on the success path; on `sp_OAMethod` failure the COM object **leaks** inside SQL Server's process. | Verified |
| SOAP mode hardcodes `xmlns="http://tempuri.org/"` and `SOAPAction: http://tempuri.org/<action>` (a .NET default namespace) and does **no XML escaping** of parameter values. | Verified |
| Sends over plain **HTTP** to `localhost:8524` — acceptable only because it is loopback. | Verified |

**Recommended (new system):** replace entirely with a Node service using `undici`/`axios` — explicit timeouts, retries with exponential backoff + jitter, idempotency key per invoice, structured request/response logging to a `fiscal_submission` audit table, and a durable outbox/queue so a POS sale never blocks on FBR availability.

---

### 1.5 QR code generation

| Method | Preference value | Implementation | Status |
|---|---|---|---|
| **Offline (selected)** | `qrcodeprintingmethodinsale = 'Q'` → display value **"Use QRCodeGenLibrary - Offline"** | `QRCodeGenLibrary.dll` v1.0.0.1, in `Application\` (Sep 2021) | **ACTIVE** — Verified |
| Online (alternative) | other value of the same preference | `f_get_google_qrcode` in `functions.pbd` / `fiscalizationapp.pbd`: `http://chart.apis.google.com/chart?cht=qr&chs=230x230&chof=gif&&chl=` ; error string `Cannot invoke Google QR Code Web service` | **DEPRECATED / DEAD** — Google retired the Chart Infographics QR API; would fail if selected |

**Supply-chain note (Verified from file metadata):** `QRCodeGenLibrary.dll` is published by **ОАО "Северсталь‑Инфоком"** (Severstal‑Infocom), description in Russian: *"Библиотека для создания BITMAP файла с QR кодом"*. It is an unsigned third-party binary of unknown provenance running inside the POS. `qrcode.bmp` (14 KB, Dec 2024) in `Application\` is its scratch output file.

**Recommended:** use `qrcode` (npm) or `bwip-js` server-side; render the FBR QR payload as SVG/PNG in the invoice print pipeline. No native DLL, no network call.

---

### 1.6 The FBR POS service fee (Verified — a real money line)

| Preference | Value | Meaning |
|---|---|---|
| `Auto_Apply_FBR_POS_Fee_InSale` | `Y` | fee applied automatically on every sale |
| `Amount_For_FBR_POS_Fee_InSale` | `1.00` | **Re. 1 per invoice** |
| `Apply_FBR_POS_Fee_InService` | `N` | not applied to service invoices |
| `Amount_FBR_POS_Fee_InService` | `0.00` | |
| `FetchFBRPosFeeForRefSR` | `Y` | the fee is carried onto referenced sale returns |

Live data: `SELECT FBRPOSFee, COUNT(*) FROM SaleLedger GROUP BY FBRPOSFee` → **`1.00` on all 291,361 rows**. Column `SaleLedger.FBRPOSFee numeric NOT NULL`; also present on `SRLedger`, `CRS_SaleLedger`, `DB_SaleLedger`, `IMP_SaleLedger`.

**Recommended:** model this as a first-class configurable statutory charge line (`invoice.statutory_fees[]`) rather than a bare numeric column, so future FBR fee changes are data, not schema.

---

### 1.7 Regime B — FBR Digital Invoicing: installed 2026‑05‑11, never switched on

**Configuration (Verified, `SoftwarePreferences`):**

| Preference | Value |
|---|---|
| `ImplementDigitalInvoicing` | **`N`** ("No") |
| `DigitalInvoicingEnvironment` | `S` ("SandBox") |
| `DigitalInvoicingProductionURL` | `https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata` |
| `DigitalInvoicingSandBoxURL` | `https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata_sb` |
| `DigitalInvoicingValidationURL` | `https://gw.fbr.gov.pk/di_data/v1/di/validateinvoicedata` |
| `DigitalInvoicingSandBoxValidationURL` | `https://gw.fbr.gov.pk/di_data/v1/di/validateinvoicedata_sb` |
| `DigitalInvoicingProductionToken` | **empty** (secret slot exists; no value stored) |
| `DigitalInvoicingSandBoxToken` | **empty** (secret slot exists; no value stored) |
| `DigitalInvoicing_NTN` | empty |
| `DigitalInvoicing_Company` | empty |
| `DigitalInvoicing_CompanyAddress` | empty |
| `DigitalInvoicing_CompanyProvince` | empty |
| `DigitalInvoicingFee` | `0.00` |
| `DigitalInvoicingAllowZeroRetailPrice` | `N` |

> Two bearer-token preference slots exist and are **empty**. No secret value was found anywhere in the corpus; nothing is redacted here because there is nothing to redact.

**Schema (Verified, `sys.objects.create_date`):**

| Object | Created |
|---|---|
| `FBR_DI_DocType`, `FBR_DI_Scenario`, `FBR_DI_TransactionType`, `FBR_DI_UOM` | **2026‑05‑11 16:29:36** |
| `DF_SaleLedger_Digitalized`, `DF_SaleLedgerLog_Digitalized`, `DF_SRLedger_Digitalized` | 2026‑05‑11 16:29:22 – 16:29:37 |

New columns: `SaleLedger`/`SaleLedgerLog`/`SRLedger` → `Digitalized char`, `DigitalizedBy smallint`, `DigitalizedOn datetime`, `DigitalInvoiceNo varchar`, `ScenarioID varchar`, `BuyerRegStatus varchar(100)`; `SaleDetail`/`SaleDetailLog`/`SRDetail` → `UOM varchar`, `TransType varchar`.

**Live data (Verified):**

```
SELECT Digitalized, ScenarioID, COUNT(*) FROM SaleLedger GROUP BY Digitalized, ScenarioID
 N | (null) | 291,361          -- every single invoice, no exceptions

SELECT BuyerRegStatus, MIN(Date), MAX(Date), COUNT(*) FROM SaleLedger GROUP BY BuyerRegStatus
 (null)       | 2025-01-01 | 2026-05-11 16:16 | 260,219
 Unregistered | 2026-05-11 16:39 | 2026-07-31 | 31,142

SELECT UOM, TransType, COUNT(*) FROM SaleDetail GROUP BY UOM, TransType
 (null) | (null) | 620,619      -- never populated
```

**Conclusions:**

1. **Verified — Digital Invoicing has never submitted a single invoice.** `Digitalized='N'` on 100 % of rows; `DigitalInvoiceNo` and `ScenarioID` are never set.
2. **Verified — the schema went in on 11 May 2026 and immediately began defaulting `BuyerRegStatus='Unregistered'`** on new invoices (31,142 rows). So a newer client build *is* writing one DI field, but nothing else.
3. **Verified — there is ZERO Digital-Invoicing logic in the database.** A case-insensitive grep of all 762 programmable objects for `Digitaliz|ScenarioID|BuyerRegStatus|FBR_DI` returns **no matches**. All DI logic lives in the compiled client.
4. **Verified — and it is not in the binaries we hold either.** A byte-scan of all 122 `.pbd` files in `Application\` and `Application\PBD_Backup\` for `digitalinvoic|postinvoicedata|Digitaliz|ScenarioID|di_data` returns **zero hits**. The `.pbd` set is dated **8 Nov 2024**; the DI schema is dated **11 May 2026**.
   ⇒ **The binaries in `E:\Pharma Software\V2_AbuzarSoftware\Application` are NOT the binaries that produced the live data.** Production ran from `D:\V3_AbuzarSoftware\Application\` (per `SoftwarePreferences.LogoOnInvoices = D:\V3_AbuzarSoftware\Application\logo1.bmp`), which does not exist on this machine. **Label: Missing (production V3 client binaries).**

#### FBR DI lookup tables — full dumps (Verified, live DB)

**`FBR_DI_DocType`** (2 rows)

| DocTypeCode | Name |
|---|---|
| 4 | Sale Invoice |
| 9 | Debit Note |

**`FBR_DI_TransactionType`** (26 rows)

| Code | Name | | Code | Name |
|---|---|---|---|---|
| 18 | Services | | 84 | Telecommunication services |
| 21 | Goods (FED in ST Mode) | | 85 | Petroleum Products |
| 22 | Services (FED in ST Mode) | | 115 | Potassium Chlorate |
| 23 | 3rd Schedule Goods | | 122 | Mobile Phones |
| 24 | Goods at Reduced Rate | | 123 | Steel melting and re-rolling |
| 25 | Processing/Conversion of Goods | | 125 | Ship breaking |
| 62 | Electricity Supply to Retailers | | 129 | SIM |
| **75** | **Goods at standard rate (default)** | | 130 | Cotton ginners |
| 77 | Gas to CNG stations | | 132 | Electric Vehicle |
| 80 | Goods at zero-rate | | 134 | Cement /Concrete Block |
| 81 | Exempt goods | | 138 | Non-Adjustable Supplies |
| 82 | DTRE goods | | 139 | Goods as per SRO.297(I)/2023 |
| | | | 178 | CNG Sales |
| | | | 181 | Toll Manufacturing |

**`FBR_DI_Scenario`** (28 rows — **`Applicable = 'N'` on every single row**)

| ScenarioID | Name | TransTypeCode | Applicable |
|---|---|---|---|
| SN001 | Goods at standard rate to registered buyers | 75 | N |
| SN002 | Goods at standard rate to unregistered buyers | 75 | N |
| SN003 | Sale of Steel (Melted and Re-Rolled) | 123 | N |
| SN004 | Sale by Ship Breakers | 125 | N |
| SN005 | Reduced rate sale | 24 | N |
| SN006 | Exempt goods sale | 81 | N |
| SN007 | Zero rated sale | 80 | N |
| SN008 | Sale of 3rd schedule goods | 23 | N |
| SN009 | Cotton Spinners purchase from Cotton Ginners (Textile Sector) | 130 | N |
| SN010 | Telecom services rendered or provided | 84 | N |
| SN011 | Toll Manufacturing sale by Steel sector | 181 | N |
| SN012 | Sale of Petroleum products | 85 | N |
| SN013 | Electricity Supply to Retailers | 62 | N |
| SN014 | Sale of Gas to CNG stations | 77 | N |
| SN015 | Sale of mobile phones | 122 | N |
| SN016 | Processing / Conversion of Goods | 25 | N |
| SN017 | Sale of Goods where FED is charged in ST mode | 21 | N |
| SN018 | Services rendered or provided where FED is charged in ST mode | 22 | N |
| SN019 | Services rendered or provided | 18 | N |
| SN020 | Sale of Electric Vehicles | 132 | N |
| SN021 | Sale of Cement /Concrete Block | 134 | N |
| SN022 | Sale of Potassium Chlorate | 115 | N |
| SN023 | Sale of CNG | 178 | N |
| SN024 | Goods sold that are listed in SRO 297(1)/2023 | 139 | N |
| **SN025** | **Drugs sold at fixed ST rate under serial 81 of Eighth Schedule Table 1** | 138 | N |
| **SN026** | **Sale to End Consumer by retailers** | 75 | N |
| **SN027** | **Sale to End Consumer by retailers** | 23 | N |
| **SN028** | **Sale to End Consumer by retailers** | 24 | N |

> **Pharmacy relevance (Strongly Inferred):** for a retail pharmacy the operative scenarios are **SN025** (drugs at fixed sales-tax rate, 8th Schedule Table‑1 serial 81 → transaction type 138 *Non-Adjustable Supplies*) and **SN026–SN028** (sale to end consumer by retailers). `Applicable='N'` on all of them means **no scenario has been enabled for this taxpayer**. Which scenario(s) FBR has actually licensed for NTN/STRN of this pharmacy is **Unclear** and must be confirmed with the tax adviser.

**`FBR_DI_UOM`** (43 rows — note the duplicated names with different codes, i.e. two FBR code generations merged)

| Code | Name | Code | Name | Code | Name |
|---|---|---|---|---|---|
| 3 | MT | 61 | Gallon | 96 | 1000 kWh |
| 4 | Bill of lading | 63 | Kilogram | 98 | MMBTU |
| 5 | SET | 65 | Pound | 99 | Numbers, pieces, units |
| 6 | KWH | 67 | Timber Logs | 100 | Square Foot |
| 8 | 40KG | **69** | **Numbers, pieces, units** | 101 | Thousand Unit |
| 9 | Liter | **71** | **Packs** | 102 | Barrels |
| 11 | SqY | 73 | Pair | 110 | KWH |
| 12 | Bag | 75 | Square Foot | 112 | Packs |
| 13 | KG | 77 | Square Metre | 114 | Meter |
| 46 | MMBTU | 79 | Thousand Unit | 116 | Liter |
| 48 | Meter | 81 | Mega Watt | 117 | Bag |
| **50** | **Pcs** | 83 | Foot | 118 | Meter |
| 53 | Carat | 85 | Barrels | | |
| 55 | Cubic Metre | 87 | NO | | |
| 57 | Dozen | 88 | Others | | |
| 59 | Gram | | | | |

> For a pharmacy the likely UOMs are **50 (Pcs)**, **69 (Numbers, pieces, units)**, **71/112 (Packs)**, **9/116 (Liter)**. `SaleDetail.UOM` is **never populated** today, so no mapping from the internal pack/loose model to FBR UOM codes exists yet. **Label: Missing.**

**Risk (High):** Pakistan's Digital Invoicing regime is being phased in for sales-tax registered persons through 2025–2026. This deployment has the schema but **no activation, no tokens, no NTN, no scenario, no UOM mapping**. The rebuild must treat DI as a **first-class, must-build** feature, not an optional extra.

---

### 1.8 FBR-related preference reference (Verified — full list)

| Preference | Value | Display value (`PrefValue2`) |
|---|---|---|
| `FBRPOSID` | `141973` | |
| `UseFBRTestService` | `N` | No |
| `FBRInvoiceServiceURL` | `http://localhost:8524/api/IMSFiscal/GetInvoiceNumberByModel` | |
| `FBRTestServiceURL` | `http://localhost:8524/api/IMSFiscal/Get` | |
| `FiscalizationMethod` | `2` | **Use Fiscalization Application** |
| `FiscalizationAppPort` | `9111` | 9111 |
| `FiscalizationMachine` / `FiscalizationMachineIP` | *(empty)* | |
| `AutoFiscalizeOnPosting` | `Y` | Yes *(but the DB call sites are commented out)* |
| `PrintUnFiscalizedInvoice` | `N` | No — **an un-fiscalised invoice cannot be printed** |
| `FiscalizeServiceInvoice` | `N` | No |
| `qrcodeprintingmethodinsale` | `Q` | Use QRCodeGenLibrary - Offline |
| `Auto_Apply_FBR_POS_Fee_InSale` | `Y` | |
| `Amount_For_FBR_POS_Fee_InSale` | `1.00` | |
| `ownertaxregno` | `055-3252501` | caption: *"Phone, Tax Reg. No. etc"* |

> `ownertaxregno = 055-3252501` is stored in a free-text field whose caption is "Phone, Tax Reg. No. etc". Whether this is the pharmacy's STRN/NTN or a landline is **Unclear** — the format resembles a Pakistani landline (Faisalabad area code 041 / Gujranwala 055). **Must be confirmed with the owner before it is reused as a tax identifier.**

---

## 2. Tax rules engine

### 2.1 Rule master tables — full dumps (Verified, live DB)

**`GSTRules`** / **`UnitSalesTaxRules`** / **`AdditionalTaxRule`** / **`ExtraTaxRule`** / **`IncomeTaxRule`** / **`CustomDutyRule`** — all six are the *same* 4-row "which quantity does the tax apply to" enumeration:

| Code | Name | ShortName |
|---|---|---|
| 1 | TAX ON ACTUAL AND BONUS QTY | A |
| 2 | TAX ON ACTUAL QTY ONLY | B |
| 3 | TAX ON BONUS QTY ONLY | C |
| 4 | NO TAX | D |

(`GSTRules` uses "GST ON …", `CustomDutyRule` uses "DUTY ON …"; the semantics are identical.)

**`GSTType`** (3 rows) — the *base* on which GST is computed:

| GSTTypeCode | Name |
|---|---|
| 1 | GST on Normal Price |
| 2 | GST on Retail Price |
| 3 | GST on Purchase Price |

**`TaxCategory`** (3 rows) — advance/withholding income-tax bands:

| Code | Name | TaxPerc |
|---|---|---|
| 1 | DEFAULT | 0.00 |
| 2 | FILER | 0.50 |
| 3 | NON-FILER | 1.00 |

`DefaultTaxCategory = 1` (DEFAULT, 0 %). `ApplyAdvanceIncomeTaxInSale = N`, `ApplyAdvanceIncomeTaxInPur = Y`.
Live data: `SaleLedger.AdvanceTax = 'Y'` on **0** rows → advance income tax is never applied on sales. **Verified.**

**`SalesTaxSchedule`** (7 rows) — the rate table actually fed to FBR as `TaxRate`:

| Code | Name | TaxPerc | TaxType | Applicable | Items using it |
|---|---|---|---|---|---|
| **1** | NO SALES TAX | **0.00** | S | Y | **28,967** |
| 2 | 20 % SALES TAX SCHEDULE | 20.00 | E | Y | 76 |
| 3 | 15 % SALE TAX SCEDULE *(sic)* | 15.00 | E | Y | 8 |
| **4** | 18 % SALES TAX SCHEDULE | **18.00** | E | Y | **951** |
| 5 | 25 % SALE TAX SCHEDULE | 25.00 | E | Y | 18 |
| 6 | 22 % SALES TAX SCHEDULE | 22.00 | E | Y | 32 |
| 7 | 28 % SALE TAX SCEDULE *(sic)* | 28.00 | E | Y | 0 |

`TaxType` values `S` / `E` are **Unclear** (plausibly *Standard* vs *Exempt/Extra*; no proc reads this column). Only `TaxPerc` is consumed — by `SP_GetSaleInvoice_JSON` / `SP_GetSRInvoice_JSON` as the FBR `TaxRate`.

**`PCT`** (3 rows) — the HS/PCT heading sent to FBR as `PCTCode`:

| PCTCode | Description | Items |
|---|---|---|
| 1 | `.` | 29,883 |
| 2 | `3305` | 2 |
| 3 | `3307` (OTHER) | 167 |

> **Finding (Verified, High risk):** 99.4 % of items map to PCT description **`.`** — a placeholder. The FBR line field `"PCTCode":"."` is therefore sent for almost every line. Whether FBR accepts this is **Unclear**; under Digital Invoicing a valid 8-digit HS code is expected. **Requires tax-adviser validation and a full item→HS-code remapping exercise before DI go-live.**

### 2.2 Where tax actually lives on a transaction (Verified)

| Level | Column | Reality in live data |
|---|---|---|
| Invoice header | `SaleLedger.SalesTax numeric NOT NULL` | **`0` on all 291,361 rows** — unused |
| Invoice header | `SaleLedger.InvGSTPerc1 numeric` | **`0` on all 291,361 rows** — unused |
| Invoice header | `SaleLedger.GSTNO tinyint NOT NULL` | **`1` on all rows.** It is a `tinyint` **code**, *not* a GST registration number, despite the name |
| Invoice header | `SaleLedger.AdvanceTax char(1)` / `AdvanceTaxAmt` | never `'Y'` |
| **Line** | `SaleDetail.UnitSalesTax` | **the live mechanism** — non-zero on 2,861 of 41,201 recent lines (~7 %) |
| Line | `SaleDetail.GSTPerc` | **`0` on all recent lines** — percentage-based GST unused |
| Item master | `Item.SalesTaxScheduleCode` → `SalesTaxSchedule.TaxPerc` | drives the FBR `TaxRate` only |
| Item master | `Item.PCTCode` → `PCT.Description` | drives the FBR `PCTCode` only |

**Model in one sentence (Strongly Inferred):** this pharmacy charges sales tax as a **per-unit amount** (`SaleDetail.UnitSalesTax`, captured at purchase and carried onto sale), not as a percentage — consistent with Pakistan's fixed/retail-price drug taxation. The percentage schedule exists only to *report* a rate to FBR.

Relevant preferences (Verified): `itemunittax = Y`, `ShowSalesTax = Y`, `ApplySTaxScheduleOnUnitSalesTax = Y`, `fetchlatestunitsalestaxinpur = Y`, `updateunitsalestaxinpur = N`, `CopyPurTaxToSalesTax = N`, `showsalestaxscheduleinpur = Y`, `showsalestaxinbarcode = N`, `POS_ItemUnitTax = N`, `extrataxpercinsale = N`, `ExtraTaxPercInPurchase = N`, `ApplySalesTaxOnSavingBeforeUserPwd = Y`.

### 2.3 `fn_getTaxOnSaleInv` — the authoritative invoice tax total (Verified, quoted)

`Evidence: dbo.fn_getTaxOnSaleInv`

```sql
SELECT @netamount = Round(
    Sum( Round( (SD.looseqty + SD.bonusqty) * SD.unitsalestax
              + Round( Round( SD.looseqty * (SD.saleprice - SD.itemflatdisc)
                              * (1 - SD.discperc * 0.01), 2 )
                       * SD.gstperc * 0.01 , 2 ) , 2 ) )
  + (CASE WHEN ( ... ) IS NULL THEN 0
     ELSE ( Round( Sum( (SD.looseqty * (SD.saleprice - SD.itemflatdisc))
                        * (1 - SD.discperc/100) * (1 - SL.discperc/100) ) - flatdisc , 2) )
           * SL.invgstperc1 * 0.01 END)
  , @RoundUpYo)
FROM Saleledger SL, Saledetail SD
WHERE SL.SaleInvCode = @saleinvcode AND SL.saleinvcode = SD.saleinvcode
GROUP BY SL.saleinvcode, SL.flatdisc, SL.misccharges, SL.discperc, SL.invgstperc1
```

**Structure (Verified):** total tax = **Σ per-line unit tax on (loose + bonus) qty** + **Σ per-line percentage GST on the discounted loose value** + **invoice-level GST% on the twice-discounted net**. Final rounding to `Fn_Get_Int_Preference('roundsaleinvon')` decimals.

`fn_getTaxOnSRInv` is the mirror image using `SD.srprice` and `roundsalereturninvon`, and **omits `itemflatdisc`** from the return-side line base — an asymmetry that will change refunded tax if an item-level flat discount was given on the original sale. **Requires accountant validation.**

Because `GSTPerc` and `InvGSTPerc1` are `0` throughout this deployment, in practice **`fn_getTaxOnSaleInv` reduces to `Σ (LooseQty + BonusQty) × UnitSalesTax`** — and that is exactly the number reported to FBR as `TotalTaxCharged`. **Verified by construction; recommend numeric reconciliation against a sample of printed invoices before rebuild sign-off.**

Sibling functions: `fn_getTaxOnServiceInvoice`, `fn_getTaxOnServiceReturn` (service/lab module — not used in this pharmacy deployment).

### 2.4 Tax — risks and recommendations

| Risk | Severity | Detail |
|---|---|---|
| `PCTCode` = `.` for 99.4 % of items | **High** | invalid HS classification for FBR DI |
| Rounding is preference-driven at three levels (`roundsaleinvon`, `roundsalereturninvon`, per-line `Round(...,2)`) | Medium | tax totals can differ from a naive recomputation by a paisa per line; must be replicated **exactly** |
| No tax-rate effective-dating anywhere — `SalesTaxSchedule.TaxPerc` is mutable in place | **High** | a rate change silently rewrites the reported rate on **historical** invoices, since the FBR JSON reads live master data (`STS.TaxPerc`), not a snapshot |
| Bonus quantity taxed but not valued (§1.3 J7) | Medium | free-goods VAT treatment |
| Two typos shipped in production data (`SCEDULE`) | Low | cosmetic, but appears on reports |

**Recommended (new system):**
- Store **`tax_rate_snapshot`, `pct_code_snapshot`, `unit_tax_snapshot` on the invoice line at posting time**. Never recompute a historical filing from mutable master data.
- Model `sales_tax_schedule` with `valid_from` / `valid_to` and a surrogate `schedule_version_id` on each line.
- Implement `computeInvoiceTax()` as one pure, unit-tested function with golden-master tests replaying ≥10,000 historical invoices from the legacy DB and asserting byte-equal totals.
- Replace `PCT.Description` free text with a validated HS-code table and make it **mandatory** for any item that is not zero-rated.

---

## 3. SMS / messaging subsystem

### 3.1 Status: complete engine, zero usage (Verified)

| Table | Rows | Meaning |
|---|---|---|
| `SMS_Center` (outbox) | **0** | **no SMS has ever been queued** |
| `SMS_Template` | **0** | **no template configured** |
| `SMS_AssociatedRecipient` | 0 | |
| `SMS_Type` | 13 | seed lookup |
| `SMS_Status` | 3 | seed lookup |
| `SMS_DataDefinition` | 26 | seed lookup (payload catalogue) |

Credentials: `WebSMSUserID`, `WEBSMSPassword`, `WebSMSAPIKey`, `WEBSMSMask` — **all empty**. `WebSMSProvider = 'Z'` → display value **"Zong"**. `AskContactCardForSMS = N`, `defaultsmsexpiry = 24` (hours).

**Verdict: DORMANT here, but fully built in the product.**

### 3.2 Data model

`SMS_Center` — `SMSCode, Date, SMSTO, SMSText, SMSTypeCode, SMSStatusCode, SMSTemplateCode, SentDate, Expiry`
`SMS_Template` — `SMSTemplateCode, Name, SMSTypeCode, SMSDataCode, SMSTemplate, Enabled, ModuleID, Event, Scheduled, ScheduleType, RunOnce, RunEvery, RunEveryFreq, Executed, ExecutedOn, NextRunOn, RunParameters, Active`
`SMS_DataDefinition` — `SMSDataCode, Name, ModuleID, ViewName, FilterOn, Enabled`

### 3.3 The template engine (Verified)

`Evidence: dbo.SP_CreateDataSMS`

1. Look up the template → `@ViewName`, `@FilterOn` from `SMS_DataDefinition`.
2. Build recipients by **dynamic SQL against the view**:
   ```sql
   SET @Qry = 'INSERT INTO #InputRows (CardCode, Code, TokenValue, SMSText, SMSTO)
               SELECT DISTINCT T.ContactCardCode, P.Code, NULL, NULL, T.Mobile
               FROM ' + @ViewName + ' AS T,
                    (SELECT CODE FROM udf_StringToTabl_String(''' + @as_list + ''', '','')) P
               WHERE P.Code = T.' + @FilterOn
   EXECUTE (@Qry)
   ```
3. Union in extra recipients from the view `GetAssociatedRecipientForSMS` (contact groups).
4. Parse `«TokenName»` placeholders out of `SMS_Template.SMSTemplate` (French guillemets U+00AB / U+00BB), resolve each token against the corresponding **column of the data view**, substitute, and insert the rendered message into `SMS_Center` with `SMSStatusCode = 1` (UN-SENT) and an expiry of `defaultsmsexpiry` hours.

**Delivery is NOT done in SQL.** `SMS_Center` is a pure outbox; the PowerBuilder client (`smscomponents.pbd` / `smswebservices.pbd`) polls and sends. **Verified** by the absence of any send logic in the 762 DB objects and by the presence of the gateway URLs in the client binaries.

### 3.4 Trigger points (Verified)

| Proc | Called from | Signature |
|---|---|---|
| `SP_CreateAutoTriggerSMS` | **`sp_PostSaleLedger`** — `EXECUTE DBO.SP_CreateAutoTriggerSMS @ai_list, 1, 'Posting'` (this call is **live**, not commented out) | `(@ai_list, @ai_moduleid, @ai_event)` — selects `SMS_Template WHERE ModuleID=@ai_moduleid AND Scheduled='N' AND Event=@ai_event AND Enabled='Y' AND Active='Y'` |
| `SP_CreateDataSMS` | from the above | renders + queues |
| `SP_CreateSMS` | ad-hoc / SMS Centre UI | manual compose |
| `SP_CreateScheduledSMS` | scheduler | `Scheduled='Y'` templates with `RunEvery`/`NextRunOn` |

> Because `SMS_Template` is empty, `SP_CreateAutoTriggerSMS` finds 0 templates and returns immediately on every sale posting — a small but real per-invoice overhead. **Verified.**

### 3.5 The 22 SMS payload views (Verified — full catalogue)

Each view is the *data contract* for one message type; its columns become the `«tokens»`.

| # | `SMS_DataDefinition` name | View | Filter key | Module | Enabled |
|---|---|---|---|---|---|
| 1 | Sale Order Basic Information | `VIEW_SMS_SaleOrderInfo` | `SaleOrderCode` | 12 | N |
| 2 | Sale Invoice Basic Information | `VIEW_SMS_SaleInvInfo` | `SaleInvCode` | 1 | N |
| 3 | Daily Gross Profit Report | `VIEW_SMS_DailySalesAndReturnSummary` | `Code` | — | N |
| 4 | Daily Header Wise Sale Summary | `VIEW_SMS_DailyHeaderWiseNetSalesSummary` | `Code` | — | N |
| 5 | Customer Receipt Acknowledgement | `VIEW_SMS_CustomerReceiptAcknowledgement` | `GLVochCode` | 45 | **Y** |
| 6 | Supplier Payment Information | `VIEW_SMS_SupplierPaymentInfo` | `GLVochCode` | 45 | **Y** |
| 7 | Customer License Key | `VIEW_SMS_CustomerLicenseInfo` | `Code` | 46 | N |
| 8 | Manufacturer Wise Monthly Net Sales To Date | `VIEW_SMS_ManufacturerMonthlyNetSaleToDate` | `Code` | — | N |
| 9 | Zonal Category Wise Stock and Sales To Date | `VIEW_SMS_ZonalSaleAndStock_CatWise_ToDate` | `Code` | — | N |
| 10 | Category Wise Stock and Sales To Date for a Zone | `VIEW_SMS_Zone_SaleAndStock_CatWise_ToDate` | `ZoneCode` | — | N |
| 11 | Cash Service Invoice Information | `VIEW_SMS_ServiceInvInfo` | `ServiceInvCode` | 22 | N |
| 12 | Credit Service Invoice Information | `VIEW_SMS_ServiceInvInfo` | `ServiceInvCode` | 23 | N |
| 13 | Cash Service Invoice Patient Information | `VIEW_SMS_ServiceInvPatientInfo` | `ServiceInvCode` | 22 | N |
| 14 | Credit Service Invoice Patient Information | `VIEW_SMS_ServiceInvPatientInfo` | `ServiceInvCode` | 23 | N |
| 15 | Supplier Credit Intimation | `VIEW_SMS_SupplierCreditIntimation` | `GLVochCode` | 45 | N |
| 16 | Customer Debit Intimation | `VIEW_SMS_CustomerDebitIntimation` | `GLVochCode` | 45 | N |
| 17 | Customer Sale Invoice Info. | `VIEW_SMS_CustomerSaleInvInfo` | `SaleInvCode` | 1 | **Y** |
| 18 | Patient Sale Invoice Info. | `VIEW_SMS_PatientSaleInvInfo` | `SaleInvCode` | 1 | **Y** |
| 19 | Patient Admission Information | `VIEW_SMS_PatientAdmissionInfo` | `AdmissionCode` | 36 | N |
| 20 | Patient Discharge Information | `VIEW_SMS_PatientDischargeInfo` | `AdmissionCode` | 36 | N |
| 21 | Total Daily Service Revenue | `VIEW_SMS_TotalServicesInfo` | `Code` | — | N |
| 22 | Installment Receipt Information | `VIEW_SMS_CustomerInstallmentReceiptAcknowledgement` | `ReceiptCode` | 50 | N |
| 23 | Visit Appointment Information | `VIEW_SMS_VisitAppointmentInfo` | `AppointmentCode` | 19 | N |
| 24 | Sale Invoice Information-Via Contact Card | `VIEW_SMS_SaleInvInfo2` | `SaleInvCode` | 1 | **Y** |
| 25 | Patient Registration Information | `VIEW_SMS_PatientRegistrationInfo` | `PatientCode` | 14 | **Y** |
| 26 | Registered Patients for Campaign | `VIEW_SMS_PatientRegistrationInfo` | `PatientCode` | — | **Y** |

Plus the recipient-resolution view `GetAssociatedRecipientForSMS` (joins `SMS_AssociatedRecipient` → contact groups → contact cards → mobile numbers).

### 3.6 The SMS gateways (Verified — hardcoded in `smscomponents.pbd`)

| Provider | Hardcoded URL prefix |
|---|---|
| **Zong Corporate CBS** (selected: `WebSMSProvider='Z'`) | `http://cbs.zong.com.pk/ReachCWSv2/CorporateSMS.svc?Service1` |
| Jazz CMT | `https://connect.jazzcmt.com/sendsms_url.html?Username=` |
| BizSMS | `http://api.bizsms.pk/api-send-branded-sms.aspx?username=` |
| BrandedSMS.pk | `http://brandedsms.pk/api/sendsms.php?id=` |
| Outreach.pk | `http://outreach.pk/api/sendsms.php/sendsms/url?id=` |
| SMSPoint.pk | `http://www.smspoint.pk/api/smsapi/` |
| BrandYourText | `https://brandyourtext.com/sms/api/send?username=` |

**Zong contract (Verified from `Service1.dll` + `smswebservices.pbd`):** a WCF `BasicHttpBinding_ICorporateCBS` proxy exposing

`BulkSMS` · `QuickSMS` · `DynamicSMS` · `GetInbox` · `GetReports` · `GetCampaigns` · `GetAccountSummary`
(SOAP actions `http://tempuri.org/ICorporateCBS/<Op>`)

with request DTO
`BulkSMSResquest(String loginId, String loginPassword, String CampaignName, String Mask, String Message, String Uni…, [] lstNL, String CampaignDate, String ShortCodePrefered)`
and response DTO carrying `…age, SentDate, STATUS, ErrorMessage`.

`Service1.dll` (24 KB, 1 Jun 2020, **unsigned, no version, no company**) is the generated .NET proxy; `smswebservices.pbd` is the PowerBuilder .NET-assembly bridge (loaded by `pbNetWSRuntime125.dll` + `Sybase.PowerBuilder.WebService.*.dll`).

**Note (Verified):** four of the seven gateways are plain **HTTP** and every one of them puts `username`/`password` in the **query string**. Credentials would traverse the wire and appear in proxy logs in clear text. Not currently exploitable (no credentials configured) but it is the shipped design.

### 3.7 GSM modem path (Verified)

`MyPDUConverter.dll` v1.00, **CompanyName = "Abuzar Consultancy, Lahore - Pakistan"**, description *"Text to PDU converter to be used in any sms based application."* → the product can also drive a **serial GSM modem** with AT commands, encoding messages as GSM 03.40 PDUs. `smscomponents.pbd` contains `d_smscenter_devicelist` / `d_smscenter_devicedetail` DataWindows (a device/modem registry). No device table exists in this DB. **DORMANT.**

### 3.8 Recommended replacement

| Legacy element | Recommended in Node/React/MySQL |
|---|---|
| `SMS_Center` outbox + client poller | `notification_outbox` table + BullMQ/pg-boss worker; at-least-once with idempotency key; exponential backoff |
| 7 hardcoded gateways | one `SmsProvider` interface, adapters per gateway, credentials in a secrets manager (**never** in a preferences table, **never** in a query string) |
| `«token»` substitution over a SQL view | typed template objects rendered with a real templating engine; templates versioned in the DB with a JSON-schema-validated variable contract |
| `SP_CreateAutoTriggerSMS` inside the posting transaction | **domain events** (`SaleInvoicePosted`) published after commit — messaging must never be able to fail or slow a sale |
| 22 payload views | 22 typed DTO builders with unit tests |

---

## 4. Web services

| Object | What it is | Status |
|---|---|---|
| `SP_RequestHttpWebService` | generic GET/POST/SOAP client via `sp_OACreate 'MSXML2.ServerXMLHttp'` (§1.4) | **ACTIVE mechanism, dormant call sites** |
| `SP_Get_WaseelaVersions` | `CREATE PROCEDURE SP_Get_WaseelaVersions AS SELECT VersionNo=1` | **Stub.** A version-handshake hook that returns a hardcoded `1`. **Verified / Broken/Incomplete** |
| `SP_Get_Patient_From_Outside` | `AS --GENERAL Implementation is empty` `RETURN 0` | **Empty by design** — a customer-specific extension point for pulling patients from an external HIS. **Verified / Missing implementation** |
| `SP_Validate_Patient_From_Outside` | companion validation hook | Same pattern (**Strongly Inferred**) |
| `pbsoapclient125.pbx` / `pbwsclient125.pbx` / `EasySoap125.dll` / `ExPat125.dll` | PowerBuilder 12.5 SOAP/WS client stacks (EasySoap + Expat XML parser, 2011) | present; used only by the SMS path |
| `Sybase.PowerBuilder.WebService.Runtime / .WSDL / .WSDLRemoteLoader / .RuntimeRemoteLoader .dll` + `pbNetWSRuntime125.dll` | .NET web-service proxy loader (the Zong path) | present |
| `Application\TmpWebService\` | `BuildError.txt`, `BuildLog.txt`, `CS.txt` — **all 0 bytes**, dated 1 Jun 2020 | scratch output from PowerBuilder's on-the-fly WSDL→C# proxy compiler. **Verified — empty, no leftover artefacts** |
| `SP_WaseelaMini_Export` + `VIEW_WaseelaMini_{Customer,Item,Stock,StockSummary,Supplier}` | pushes master data + stock to a lightweight satellite ("Waseela Mini") over a **linked server**: `EXECUTE <srv>.<db>.<owner>.SP_WaseelaMini_Truncate '<Table>'` then `INSERT INTO <srv>.<db>.<owner>.<Table> SELECT * FROM DBO.View_WaseelaMini_<Table>` | **DORMANT** — no remote linked server exists |
| `SP_WaseelaMini_Fetch_SalesOrders`, `sp_WaseelaMini_RaiseSaleFromPendingOrders`, `SP_WaseelaMini_Update_SaleOrder` | pull orders back from the satellite and raise sales | **DORMANT** |
| `SP_WaseelaMini_Export_CRS_*` | the sale/return/transaction export variants | **DORMANT — and the entire body is commented out** (`/* DECLARE @Value CHAR(1) … */`). **Verified / Broken/Incomplete** |

**`sys.servers` (Verified):** exactly **one** row — `DESKTOP-JCB2VPA\SQLEXPRESS`, the loopback self-reference. **No remote linked server is defined**, which conclusively grounds the "dormant" verdict for every 4-part-name integration (CRS, WaseelaMini, DropBox, DataCarry, `SP_ImportData`).

**Recommended:** REST/JSON over HTTPS with OpenAPI contracts; no database-resident HTTP clients; all outbound calls from the Node application layer with mTLS or bearer auth, circuit breakers and per-endpoint budgets.

---

## 5. Multi-branch / CRS / DataCarry / DropBox

Four *separate* data-movement mechanisms ship in the product. **All four are dormant at Fazal Din PP19** (single shop, single warehouse). They matter only because the schema is riddled with their columns and the rebuild must decide whether to keep multi-site capability.

### 5.1 CRS — Central Reporting System (Verified DORMANT)

- **60+ procedures**: `SP_CRS_ClientDataTransfer`, `SP_CRS_Push_{Sales,SR,Purchase,PR,Stock,Receipt,Issue,Adjustment,AccVouchers,Transfers,CRSData}`, `SP_CRS_Pull_Client{Sale,SaleReturn,Pur,PR,Stock,Receipt,Issue,Adj,AccTrans,DueSatisfy,IGT}`, `SP_CRS_VirtualGL*` (9 variants), `SP_CRS_Transmit*`, `SP_CRS_Fetch_ItemStockPosition`, `sp_CRS_IncomeStatement`, `SP_CRS_MONTHLYSALES`, `SP_CRS_{SUBAREA,ZONAL}SALES_CROSSTAB`.
- **~60 `CRS_*` mirror tables** — `CRS_SaleLedger`, `CRS_SRLedger`, `CRS_VirtualGl`, `CRS_Customer`, … **every one has 0 rows** except `CRS_TransferableData` (63, config seed) and `CRS_Transactions` (11, config seed).
- **Protocol (Verified):** SQL Server **linked-server 4-part names**, e.g.
  `INSERT INTO CRSServer.CRSDatabase.DBO.CRS_SaleLedger (…) SELECT @ClientInstanceID, SaleInvCode, …`
  and dynamic-SQL variants building `@TablePrefix = @SRV + '.' + @DB + '.' + @OWNER + '.'`.
- **Handshake (Verified):** `SP_CRS_ClientDataTransfer` → `SP_Compare_Remote_VersionInfo` (abort on schema-version mismatch) → `SP_CRS_GetClientInstanceInfo` (register/validate this client with the hub) → per-table push via `SP_CRS_TransferClientTable`.
- **Client identity:** `ClientInstance` = 1 row, `Name = '4159RA2'`, **`ClientID = NULL`, `ClientInstanceID = NULL`** ⇒ *never registered with any CRS hub*. **Verified.**
- **Transaction watermarks on `SaleLedger`:** `CRS_Transfered char(1) NOT NULL`, `CRS_TransferedOn`, `Transmit`, `Transmited`, `Synced`, `SyncedOn`, `SyncedBy`.
- **Schema-drift landmine (Verified):** in `SP_CRS_Push_CRSData` the column list is partly **commented out** —
  `…,SaleTypeInvNo/*,CurrencyCode,ConversionRate,MiscCharges1,…,Fiscalized,FiscalizedOn,FiscalInvoiceNo,AdvanceTax,AdvanceTaxAmt,FBRPOSFee,CashierShiftCode*/`
  while the *other* push proc (`SP_CRS_TransmitClientSale`) includes them. Two code paths, two different column sets. **Broken/Incomplete.**

### 5.2 DropBox / `DB_*` — site-to-site invoice exchange (Verified DORMANT)

- Procs: `SP_DB_Push{Sales,SR,Purchase,PR,PO,Issue,ExpiryIntimation}ToDropBox`, `SP_DB_Fetch_*View` (10), `SP_DB_Mark*AsPulled` (5), `SP_DB_Fetch_DropBoxInfo`, view `View_DB_DropBox`.
- Staging tables `DB_SaleLedger`, `DB_SaleDetail`, `DB_PurLedger`, … keyed by `SiteCode` / `TargetSiteCode`.
- Watermarks on `SaleLedger`: `SiteCode smallint NULL`, `TargetSiteCode smallint NULL`, `Pushed char(1) NOT NULL`, `PushedBy`, `PushedOn`.
- **Guard condition (Verified):** every push is `WHERE SiteCode IS NOT NULL AND TargetSiteCode IS NOT NULL AND Posted='Y' AND Pushed='N'`. In this DB `SiteCode`/`TargetSiteCode` are never set ⇒ nothing is ever eligible.
- Preferences present: `DropBox_AllowNewInvBeforeOld=Y`, `DropBox_MonitorActivityPeriod=50000`, `DropBox_MonitorRefreshTime=60`, `DropBox_AutoPullPurOrderAsQutation=N`.
- `DropData` (36 rows) is a *config* table (`TableName, ColumnName, Priority`) listing quantity/stock columns to be zeroed when data crosses a site boundary — e.g. `PurOrderDetail.Stock`, `SaleInvDetail.LooseQty`, `AdvPurDetail.CurrStock`.
- `DataTransferLog` (`TRANSFERLOGID, LOGDATE, TRANSFEREDBY, INVOICECODE, INVOICETYPE, DATE, ACCCODE, SGCODE, DGCODE, STATUS`) = **0 rows**. `DataTransferLogDetail`, `DataTransferDate` = 0 rows.

### 5.3 DataCarry — offline "sneakernet" (Verified DORMANT)

- **84 references** to `DataCarry` across the corpus: `sp_Export_Stock_To_DataCarryDB`, `SP_InsertBasicData_To_DataCarryDB`, `sp_Insert{Sale,Issue,PO,PR,Pur,Quot,SO,ServiceSales}_To_DataCarryDB`, `sp_Import_*_From_DataCarryDB`, `sp_*List_From_DataCarryDB`, `sp_Empty_DataCarryDB`, `SP_CheckForNewItemInDataCarry`, `SP_SetUserResponsibility_For_DataCarry`, `sp_GenerateItemLog_DataCarryDB`.
- Preference `AgeOfItemChangesForDataCarryInDays = 999`.
- **Transport = a full SQL Server backup file** (Verified):
  `Evidence: dbo.SP_PrepareDataMigrationPacket`
  ```sql
  IF @DBVersion = '2012'
      SET @Qry = 'BACKUP DATABASE ' + @DB + ' TO DISK = ''' + @Path + ''' WITH INIT'
  ELSE
      SET @Qry = 'BACKUP DATABASE ' + @DB + ' TO DISK = ''' + @Path +
                 ''' WITH INIT, MEDIAPASSWORD = ''alcia' + @SVR + ''', PASSWORD = ''alfia' + @SVR + ''''
  ```
  and `SP_ReadDataMigrationPacket` / `SP_VerifyDataMigrationPacket` restore it into a temp DB.
- **SECURITY (Verified, High):** the backup media password is the literal string **`alcia` + server name** and the backup password is **`alfia` + server name**. Trivially derivable by anyone who knows the machine name.

### 5.4 `SP_ImportData` / `TransferableData` — master-data pull (Verified DORMANT)

`Evidence: dbo.SP_ImportData(@SRV, @DB, @OWNER)`
```sql
SELECT TABLENAME, IMP_TABLENAME = 'DBO.Import_' + TABLENAME
FROM TransferableData
WHERE Enable='Y' AND (AUTOINSERT='Y' OR AUTOUPDATE='Y' OR AUTODELETE='Y' OR UPDATETABMAXKEY='Y')
ORDER BY Priority
...
SET @Query = 'SELECT * INTO ' + @Imp_TableName + ' FROM ' + @srv+'.'+@db+'.'+@owner+'.' + @TableName
EXECUTE (@Query)
```
`TransferableData` (176 rows) is the **table-by-table replication policy**: `TABLENAME, PRIORITY, AUTOINSERT, AUTOUPDATE, AUTODELETE, UPDATETABMAXKEY, Enable`. Ordered by `Priority` — e.g. `RightsClone`(10) → `Rights`(20) → `Site`(25) → `Groups`(30) → `Users`(40) → `UserGroups`(50) → `GroupRights`(60) → `LockReason`(70) → `TaxCategory`(80) → … → `Alert`(500) → `SaleType`(510). Special case: `Item` is pulled incrementally on `LastUpdate`. Companion: `TransferableData_RestrictedColumns` (28 rows), `TransferableData_ExportRestrictedColumns` (0), `DataImportLog` (**0 rows**), `SP_SyncImportedData`, `SP_DropImportTables`, `sp_ImportData_From_ParentServer`, `sp_ImportStock_From_ParentServer`, `SP_Import_Quot_SO_PO_FromParentServer`.

### 5.5 Verdict and recommendation

**Verdict (Verified):** Fazal Din PP19 is a **single-site deployment**. All four sync mechanisms are shipped-but-unused. They contribute ~130 procedures, ~70 tables and ~15 columns per transaction table of pure dead weight.

**Recommended (new system):**
- **Do not port CRS / DropBox / DataCarry / WaseelaMini.** Drop ~70 `CRS_*` and `DB_*` tables and the `SiteCode/TargetSiteCode/Pushed/CRS_Transfered/Transmit/Synced` column family, subject to a written owner decision.
- If multi-branch is ever wanted, build it properly: a cloud API + per-branch outbox with monotonic change IDs, not linked servers or backup-file sneakernet.
- **Explicitly confirm with the owner** that no second branch, delivery van, or head-office consolidation is planned before deleting these.

---

## 6. File, Excel, PDF and printing

| Component | Version / Vendor | Purpose | Status |
|---|---|---|---|
| `dw2xls.pbd` (1.4 MB, 2 Feb 2019) + `pb2xls.dll` **5.1.8, Desta Ltd** (`http://desta.com.ua/pb2xls`) | third-party PB library | export any DataWindow to real `.xls`/`.xlsx` | present; **Strongly Inferred ACTIVE** (the only Excel export path) |
| `pbDWExcel12Interop125.dll` | Sybase 12.5 | DataWindow ↔ Excel 2007+ interop | present |
| `tp15.dll` **15.0.1504.500, The Imaging Source Europe GmbH** — "TX Text Control Core Component" + filters `tp15_pdf.dll`, `tp15_rtf.dll`, `tp15_doc.dll`, `tp15_dox.dll`, `tp15_htm.dll`, `tp15_css.dll`, `tp15_tls.dll`, `tp15_obj.dll`, `tp15_ic.dll`, `tp15_wnd.dll` + image filters `tp15_{bmp,gif,jpg,png,tif,wmf}.flt` + `tp4ole15.ocx` | TX Text Control 15 (2011) | rich-text editing and **PDF/RTF/DOC/HTML export** | present; **Unclear** whether any pharmacy workflow uses it (likely the prescription/notes editor) |
| `SP_Get_ResultSet_From_Excel(@File)` | — | `SELECT * FROM OPENROWSET('Microsoft.Jet.OLEDB.4.0','Excel 5.0;HDR=Yes;Database=<file>','select * from [sheet1$]')` | **BROKEN** — `Ad Hoc Distributed Queries` is **0 (disabled)** in `sys.configurations`, and Jet OLEDB 4.0 has no 64-bit provider. It cannot execute. **Verified** |
| `SP_ImportData`, `SP_SyncImportedData`, `SP_DropImportTables`, `DataImportLog` | — | bulk table import framework (§5.4) | DORMANT (`DataImportLog` = 0 rows) |
| `GroupWiseImpExpTemplate` (`GroupCode, AccCode, ExpenseType, RowID`) | — | purchase-expense allocation template, *not* a file import/export template despite the name | **0 rows — unused**. Siblings `GroupPurExpTemplate`, `ItemPurExpTemplate`, `ItemReceiptExpTemplate` also 0 rows |
| `printer.pbd`, `reportviewer.pbd`, `reportformat.pbd`, `psrviewer.pbd`, `labels.pbd`, 5 × `sprnt*.pbd` (**157 MB of compiled print layouts**) | PowerBuilder DataWindows | all invoice/report printing | ACTIVE |
| `Application\Reports\rptPrintCheque.rpt` | Crystal-style cheque template | cheque printing (`ChequePrintingInterface = N` → **disabled**) | DORMANT |
| `Print.WAV`, `Welcome.Wav`, `GoodBYE.wav` | — | audio feedback on print/login/logout | present |

Print-related preferences (Verified): `salethermalprintformat = 12`, `salereturnthermalprintformat = 1`, `voucherprintingformat = 2`, `POPrintPageSize = T`, `printerforactivitymonitor = <Default Printer>`, `asknoofcoppiesinprintdialog = Y`, `promptbeforeprinting = N`, `allowprintsetupbutton = N`, `LogoOnInvoices = D:\V3_AbuzarSoftware\Application\logo1.bmp`, **`PrintUnFiscalizedInvoice = N`**.

**Recommended:** `exceljs` for XLSX; server-side PDF via a headless-Chromium HTML→PDF renderer (or `pdfmake`) with a versioned template registry; ESC/POS thermal printing via a small local print agent exposing a signed local API — never a native OCX. Drop TX Text Control and Jet entirely.

---

## 7. Barcode & hardware

### 7.1 Barcode

| Item | Evidence | Status |
|---|---|---|
| `barcodecomponents.pbd` (5.4 MB), `barcodefunctions.pbd` (3.5 MB) | compiled modules | present |
| `UseBarCodePrinter = N`, `BarCodePrinterName = ''` | preferences | **label printing OFF** — Verified |
| `defaultbarcodeformat = 1` ("Format 1"), `barcodeleninprint = 20`, `printpriceonbarcodelabel = Y`, `printsalepricefrombasicdata = Y`, `showsalepriceinbarcode = Y`, `showremarksinbarcode = Y`, `showbatchinbarcode = N`, `showexpirydateinbarcode = N`, `showmfgdateinbarcode = N`, `showretailpriceinbarcode = N`, `showcustomerpriceinbarcode = N`, `showsalestaxinbarcode = N`, `barcodepricestartswith`/`barcodepriceendswith` empty | preferences | label content configured but unused |
| 45 label-printer device profiles hardcoded in `preferences.pbd` | `DataValue='Zebra ZT230'`, `'TSC TTP-244 Pro'`, `'Argox OS-214TT PPLA'`, `'Gprinter GP-3120T'`, `'Monarch 9855'`, `'ZDesigner GK888t (EPL)'`, … | driver-name presets |
| Customer-display poles | `DataValue='DSP-2022'`, `'POSIFLEX PD-2600 Series'`, `'TYSSO VFD-860-A'`, `'Bixolon SAMSUNG SRP 770II'` | present |
| `CashDrawerWithPrinter = N`, `CashDrawerPrinter = ''` | preferences | cash drawer kick **not** configured |

### 7.2 Weighing scale (Verified — configured, usage unproven)

`WeighingScale` = **1 row**:

| Field | Value |
|---|---|
| `WeighingScaleCode` | 1 |
| `Name` | SCALE1 |
| `Manufacturer` | **MOTEX** |
| `MODEL` | **ML 30P** |
| `ScaleID` | 98 |
| `ScaleIDPos` | 1 |
| `BarCodeLen` | 13 |
| `ItemStartPos` / `ItemEndPos` | 3 / 7 |
| `WeightStartPos` / `WeightEndPos` | 8 / 12 |

**Interpretation (Verified from the column semantics):** a classic **EAN‑13 embedded-weight barcode** — prefix `98` at position 1 identifies a scale label, positions 3‑7 are the item code, positions 8‑12 are the weight. This is a *supermarket* pattern, unusual for a pharmacy; `preferences.pbd` also lists a `Baylan …` scale option. Whether it is in daily use is **Unclear** (no barcode-scan audit table exists). Related preferences: `showunitweightinsale/pur/issue/receipt = N`, `showtotalweightinpur = N`, `unitweightcaptioninsale = 'Weight(kg)'`.

### 7.3 Biometrics / attendance (Verified DORMANT)

| Table | Rows | Note |
|---|---|---|
| `BioMetricMachine` (`MachineCode, Name, Manufacturer, Model, **IPAddress**, **PORT**`) | **0** | network fingerprint reader — none registered |
| `EMP_Finger` | 10 | seed lookup (Right Thumb … Left Baby Finger) |
| `EMP_FingerPrint` (`EmpCode, FingerCode, **FingerPrint**, **Features**`) | **0** | biometric template store — empty |
| `EMP_Employee`, `EMP_Attendance`, `EMP_Payroll`, `EMP_Pay*` | **0** | whole HR/payroll vertical unused |
| `showfingerprintinonlineatten = Y` | pref | UI flag only |

> **Privacy note:** the product is capable of storing raw fingerprint templates in the SQL database (`EMP_FingerPrint.FingerPrint`, `.Features`). It stores none here. If the rebuild ever enables attendance, biometric templates must be treated as special-category data.

### 7.4 Other devices

| Item | Status |
|---|---|
| `TestMachine` = 1 row (`MANUAL`) | lab-machine interface placeholder — **effectively unused** |
| `EZTW32.dll` (65 KB, 2008) + `ImageScanTool = 'Dynamic Twain'` (options: `EZTwainX`, `Dynamic Twain`) | **TWAIN document scanning configured**; no image blobs found in the DB → **Unclear/DORMANT** |
| `Service1.dll` | Zong SMS proxy (§3.6), not a device driver |

**Recommended:** WebUSB/WebHID or a small signed local hardware agent (Node + `serialport`) exposing scale/scanner/printer over a localhost WebSocket; the React POS talks to the agent, never to a DLL. Keep the embedded-weight barcode parser as pure, unit-tested config (prefix, positions, check digit).

---

## 8. Third-party runtime dependency inventory

All versions below are **Verified** from Windows `VersionInfo` on the actual shipped files.

### 8.1 Security-critical

| Library | Version | Date | Verdict |
|---|---|---|---|
| **`libeay32.dll`** | **OpenSSL 0.9.8l** | 4 Jul 2011 | **CRITICAL.** 0.9.8 reached end-of-life **31 Dec 2015**. No TLS 1.1/1.2, RC4/MD5/SSLv3 era, and a long CVE tail (renegotiation, BEAST/POODLE/FREAK class issues). Any HTTPS made through it — e.g. `https://connect.jazzcmt.com`, `https://gw.fbr.gov.pk` — would either fail (modern servers require TLS 1.2+) or be insecure. |
| **`ssleay32.dll`** | **OpenSSL 0.9.8l** | 4 Jul 2011 | same |
| `xerces-c_2_6.dll` / `xerces-depdom_2_6.dll` / `pbXerces125.dll` | **Xerces-C++ 2.6.0** (2004) | 4 Jul 2011 | **Deprecated.** 20+ years old XML parser; XXE/entity-expansion exposure by default. |
| `msvcr71.dll` / `msvcp71.dll` | **7.10.3052.4 / 7.10.3077.0 — Visual Studio .NET 2003** | Feb/Mar 2003 | **Deprecated.** Unsupported CRT, side-by-side-less, known heap/`printf` issues. |
| `QRCodeGenLibrary.dll` | 1.0.0.1, **ОАО "Северсталь-Инфоком"** | Sep 2021 | Unsigned third-party native DLL of unclear provenance running in the POS process. **Supply-chain risk.** |
| `Service1.dll` | **0.0.0.0, no company, no description** | 1 Jun 2020 | Unsigned, unversioned .NET assembly (Zong SMS proxy). **Supply-chain risk.** |
| `EZTW32.dll` | **no version resource at all** | 10 Jul 2008 | Unsigned TWAIN bridge. |

### 8.2 PowerBuilder 12.5 runtime (Sybase Inc., build 12.5.0.2511 — released 2011, vendor now SAP; PB 12.5 is out of mainstream support)

`pbvm125.dll` (4.9 MB, the VM) · `pbshr125.dll` · `pbdwe125.dll` (DataWindow engine, 4.0 MB) · `pbdwr125.pbd` · `pbdwr100.dll` · `pbase125.dll` · `pbrtc125.dll` (rich text) · `pbdpl125.dll` · `pbdir125.dll` · `pbtra125.dll` · `pbtrs125.dll` · `pbcomrt125.dll` · `pbole125.dll` · `pbacc125.dll` · `nlwnsck.dll` (winsock)
**Database drivers:** `pbodb125.dll` + `pbodb125.ini` (ODBC) · `pbado125.dll` (ADO/OLEDB — **the live path, SQLOLEDB**) · `pbsnc125.dll` (SQL Native Client) · `pbin9125.dll` · `pbi10125.dll` · `pbo10125.dll` / `pbo90125.dll` / `pbora125.dll` (Oracle) · `pbsyc125.dll` / `pbsyj125.dll` / `pbjag125.dll` (Sybase/Jaguar) · `pbjdb125.dll` (JDBC)
**Java:** `pbjvm125.dll` + `pbjdbc12125.jar` (46 KB) + `libjcc.dll`, `libjlog.dll`, `libjtml.dll`, `libjutils.dll` — a full JVM bridge is shipped. **No evidence any Java code is used** by this deployment. **Unclear / almost certainly dead weight.**
**Web services:** `pbsoapclient125.pbx` · `pbwsclient125.pbx` · `pbNetWSRuntime125.dll` · `EasySoap125.dll` · `ExPat125.dll` · `Sybase.PowerBuilder.{Db,DbExt}.dll` · `Sybase.PowerBuilder.WebService.{Runtime,WSDL,WSDLRemoteLoader,RuntimeRemoteLoader}.dll`
`msvcr100.dll` (VS2010 CRT, for `pb2xls.dll`).

> **Note (Verified):** `PBVM125.dll` in `Application\` is dated **4 Jan 2026** and `libjcc.dll` **7 Dec 2025** — i.e. the runtime has been touched far more recently than the 2011 originals elsewhere. Whether these are patched builds or merely re-copied files is **Unclear**.

### 8.3 `Script.mdb` — the vendor's schema-migration engine (28 MB)

**Verified:** `abuzarapp.pbd` contains the literal connection strings
`PROVIDER='Microsoft.Jet.OLEDB.4.0',DATASOURCE='Script.mdb'` and `PROVIDER='Microsoft.Jet.OLEDB.4.0',DATASOURCE='Data.mdb'`,
plus the error string `Can not connect to a Script database` and functions `f_firsttime_script`, `f_firsttime_waytomoon`, `f_islicenseexpire`, `ls_waytomoon`, `ls_waytomoon2`, `as_licensekey`, `Kindly enter valid license key.`, `&Renew License`.

**Content probe (Verified):** a full 28 MB printable-string scan yields almost nothing readable — the MDB is **password-protected/obfuscated** (only `stdole`, `ADODB`, an `ID="{5698BEA8-…}"` VBA project GUID and `DPB="3C3EE90D…"` — an *encrypted VBA project password* — survive). But a handful of long runs leak the payload's nature:

```
 /* EXECUTE SP_VirtualGl
TRUNCATE TABLE VirtualGL
DELETE GroupAllowedGodown
DELETE GROUPALLOWEDHEADER
EXECUTE SP_SetVoucherCode_Notes;
Drop Table DepartmentSection
DROP FUNCTION udf_opeingstock
```

**Conclusion (Strongly Inferred, high confidence):** `Script.mdb` is the vendor's **versioned database-upgrade script repository** — the app opens it via Jet OLEDB at startup, compares the DB's schema version, and replays DDL/DML patches against SQL Server. It is *also* entangled with licensing (`f_firsttime_script` sits next to `f_firsttime_waytomoon`).

**Implications:**
- Jet OLEDB 4.0 is **32-bit only and deprecated** → hard-pins the app to 32-bit forever.
- The migration history is **opaque** — we cannot read which patches were applied, which is exactly why the live DB is the only trustworthy schema authority.
- **Risk (High):** nobody but the vendor can produce a schema upgrade. The 11 May 2026 Digital-Invoicing schema change almost certainly came from here.
- **Recommended:** replace with a plain-text, version-controlled migration tool (Prisma Migrate / Knex / Flyway), every migration reviewable in git.

`E:\Pharma Software\V2_AbuzarSoftware\Data\MSSQL.rat` (117 MB, 11 Nov 2024) — unidentified vendor payload, probably a packaged SQL Server installer/resource. **Unclear.**

---

## 9. Database-level external surface

### 9.1 `sys.configurations` — actual state (Verified)

| Setting | `value_in_use` | Why |
|---|---|---|
| **`xp_cmdshell`** | **1 — ENABLED** | required by `SP_WayToMoon` (licensing). Disabling it **breaks application startup**. |
| **`Ole Automation Procedures`** | **1 — ENABLED** | required by `SP_RequestHttpWebService` (`sp_OACreate`) |
| `Ad Hoc Distributed Queries` | **0 — DISABLED** | ⇒ `SP_Get_ResultSet_From_Excel` (OPENROWSET) **cannot run** |
| `clr enabled` | 0 | no SQLCLR |
| `remote access` | 1 | legacy default |
| `SMO and DMO XPs` | 1 | default |
| `Database Mail XPs` | 0 | **no email from the DB** |
| `show advanced options` | 1 | |

`sys.servers` → **1 row (self)**. No remote linked server.

### 9.2 `SP_WayToMoon` — the licensing dongle (Verified, quoted in full)

`Evidence: dbo.SP_WayToMoon`
```sql
CREATE PROCEDURE SP_WayToMoon @fl VARCHAR(100), @fl2 VARCHAR(100)
AS
DECLARE @cmdline VARCHAR(255), @rt_code INT, @Ver VARCHAR(4000)
SET @Ver = @@Version
IF CHARINDEX('X64', @Ver, 1) > 0
    SET @cmdline = 'dir %systemroot%\syswow64\' + LTRIM(RTRIM(@fl))
ELSE
    SET @cmdline = 'dir %systemroot%\system32\' + LTRIM(RTRIM(@fl))
EXEC @rt_code = master..xp_cmdshell @cmdline, NO_OUTPUT
IF @rt_code >= 1 RETURN 1
ELSE BEGIN
    ... same for @fl2 ...
END
RETURN 0
```

**What it does (Verified):** asks the OS, *through SQL Server*, whether two marker files exist in `%systemroot%\system32` (or `syswow64` on x64). Returns 1 if **missing**, 0 if present. The client (`f_firsttime_waytomoon`, `ls_waytomoon`, `ls_waytomoon2` in `abuzarapp.pbd`) uses this as its anti-piracy check.

**Risk assessment:**

| Aspect | Severity | Detail |
|---|---|---|
| Requires `xp_cmdshell` permanently on | **Critical** | any SQL login that can `EXEC master..xp_cmdshell` gets OS command execution as the SQL Server service account. Combined with the plaintext `sa` password hardcoded in `abuzar.exe`, this is **full machine compromise from any workstation on the LAN**. |
| Command string is built from parameters with **no sanitisation** | **Critical** | `@fl = 'x & net user hacker P@ss /add'` → arbitrary command injection. Any caller of `SP_WayToMoon` owns the box. |
| Licensing depends on undocumented files in a Windows system directory | **High** | Windows updates, AV quarantine or a rebuild silently kill the application. |
| The marker filenames are supplied by the client, not stored in the DB | — | so we cannot enumerate them from this corpus. **Unclear.** |

**Recommended:** delete the entire concept. The new system is a bespoke rebuild for one owner — no dongle, no `xp_cmdshell`, no OS-level licensing. If licensing is ever needed, use a signed JWT licence file validated in application code.

### 9.3 `SP_MyExecuteLocal` — arbitrary SQL execution (Verified, quoted in full)

`Evidence: dbo.SP_MyExecuteLocal`
```sql
CREATE PROCEDURE SP_MyExecuteLocal @Qry VARCHAR(8000) AS
EXECUTE (@Qry)
```

That is the whole procedure. **Any principal with EXECUTE on it can run any T-SQL statement** the proc's context allows — a complete, deliberate SQL-injection primitive shipped as a feature. Combined with the app connecting as **`sa`**, every workstation effectively has `sysadmin`.

**Severity: Critical.** **Recommended:** does not exist in the new system. All data access through parameterised queries / an ORM with least-privilege DB users.

### 9.4 Dynamic SQL more broadly

Dynamic `EXECUTE(@string)` is pervasive: `SP_ImportData`, `SP_CRS_*` (dozens), `SP_DB_Push*`, `SP_WaseelaMini_Export`, `SP_Get_PreviousSaleHistory`, `SP_PrepareDataMigrationPacket`, `SP_ReadDataMigrationPacket`, `SP_CheckDBIntegrity`, `SP_AlterDB`, `SP_CreateDataSMS`. Almost none of it uses `sp_executesql` with typed parameters or `QUOTENAME()`. Most inputs are server/DB/table names supplied by the client. **Systemic injection surface — Verified.**

### 9.5 Database maintenance procedures (Verified)

| Proc | Behaviour | Notes |
|---|---|---|
| `SP_AlterDB(@DB, @Option)` | `EXEC('ALTER DATABASE ' + @DB + ' SET Single_User' \| ' SET Multi_User')` | **injectable via `@DB`**; used to gate exclusive maintenance |
| `SP_CheckDBIntegrity(@DB)` | `TRUNCATE TABLE DBCC_History` then, per database in `master.dbo.sysdatabases` (excluding the four system DBs), `INSERT INTO DBCC_History … EXEC('dbcc checkdb(''' + @DB + ''') with tableresults, ALL_ERRORMSGS')` | version-branches on `SP_DBMS_Version` — recognises only **"Microsoft SQL Server 2012"**, else assumes **"2000"**. On SQL Server **2019** it takes the *2000* branch and uses the **short column list**, which will mis-map DBCC's tableresults. **Broken on the current engine — Verified.** |
| `SP_DBReindex` | index rebuild | |
| `SP_RepairDB` | repair path | |
| `sp_BackupDB` | `BACKUP DATABASE @db TO DISK = @file WITH INIT, SKIP, STATS = 5;` | the app's own backup |
| `DBCC_History` | **767 rows** — integrity checks *have* been run | `ErrorID, LevelID, StateID, MessageText, RepairLevel, StatusID, DbId, ObjectId, …, DB, Object, Date, ROWID` |
| `SP_PrepareDataMigrationPacket` / `SP_ReadDataMigrationPacket` / `SP_VerifyDataMigrationPacket` | BACKUP/RESTORE with hardcoded passwords `'alcia'+@SVR` / `'alfia'+@SVR` | §5.3 |

**Observed backup artefacts (Verified on disk):** `AutoBackup\AutoClientFazalDinPP19DBDump2.BAK` (3.02 GB) and `AutoBackup\AutoStartupFazalDinPP19DBDump2.BAK` (3.02 GB) — i.e. the client takes a **full database backup at startup and at client shutdown**. Preference `CheckManualBackupHealthAtStartUp = Y`. On a 3 GB database this is a multi-minute startup penalty and a large I/O cost. **Recommended:** replace with proper scheduled backups (full + differential + log) plus off-site copies; never at application startup.

### 9.6 Credentials & secrets (Verified — carried over from earlier stages, restated because it is an integration risk)

| Secret | Where | Severity |
|---|---|---|
| SQL `sa` password | **hardcoded in `abuzar.exe`**; the application connects as `sa` | **Critical** |
| Application user passwords | **plaintext** in `dbo.Users` | **Critical** |
| Backup media/DB passwords | derived string `'alcia'+servername` / `'alfia'+servername` in `SP_PrepareDataMigrationPacket` | High |
| SMS gateway credentials | designed to travel in **URL query strings** over plain HTTP | High (dormant) |
| FBR DI bearer tokens | `SoftwarePreferences.DigitalInvoicingProductionToken` / `…SandBoxToken` — plaintext preference rows (currently empty) | High **when populated** |
| `CustomerPaymentAPIKey` / `…Password` | plaintext preference rows (currently empty) | High **when populated** |

**Recommended:** every secret in a secrets manager or `.env` outside the DB; DB credentials per-service with least privilege; app passwords `argon2id`; all outbound integrations over TLS 1.2+ with certificate validation.

---

## 10. Consolidated risk register

| ID | Risk | Severity | Evidence |
|---|---|---|---|
| R1 | `xp_cmdshell` must stay enabled for licensing; `SP_WayToMoon` builds its command line from unsanitised parameters; app connects as `sa` with a password embedded in the EXE | **Critical** | `dbo.SP_WayToMoon`; `sys.configurations` |
| R2 | `SP_MyExecuteLocal` = `EXECUTE(@Qry)` — arbitrary SQL as `sa` | **Critical** | `dbo.SP_MyExecuteLocal` |
| R3 | FBR invoice JSON is built by string concatenation into `VARCHAR(8000)` with **no escaping and no length guard** — long invoices truncate, quotes in item names corrupt the payload | **Critical** (tax filing correctness) | `dbo.SP_GetSaleInvoice_JSON` |
| R4 | **FBR Digital Invoicing is not activated** (schema present since 2026‑05‑11, `Digitalized='N'` on 291,361 invoices, no token, no NTN, no scenario, no UOM mapping) | **Critical** (regulatory) | `SoftwarePreferences.ImplementDigitalInvoicing='N'`; `SELECT Digitalized,COUNT(*) FROM SaleLedger` |
| R5 | OpenSSL **0.9.8l** (EOL 2015) and Xerces-C **2.6.0** (2004) ship in the runtime | **Critical** | `libeay32.dll`/`ssleay32.dll` VersionInfo |
| R6 | 99.4 % of items carry PCT description `.` — an invalid HS classification transmitted to FBR on almost every line | **High** | `PCT` table; `Item.PCTCode` distribution |
| R7 | No effective-dating on `SalesTaxSchedule`/`PCT`; the FBR JSON reads **live** master data, so changing a rate retroactively alters what a re-sent historical invoice would report | **High** | `SP_GetSaleInvoice_JSON` joins live `SalesTaxSchedule` |
| R8 | Fiscalisation logic lives in a **separate 30 KB EXE + an opaque 68 MB `.ims` blob + an unknown localhost:8524 service**, none of which is present on this machine and none of which we can rebuild without the vendor/FBR | **High** | `IMSSetup\141973.ims`; port scan; `D:\V3_AbuzarSoftware` absent |
| R9 | **The `.pbd` binaries we hold (8 Nov 2024) predate the live database schema (11 May 2026)** — they are not the production build | **High** | `sys.objects.create_date` vs file dates; zero DI strings in any `.pbd` |
| R10 | `Script.mdb` (28 MB, Jet 4.0, password-protected, encrypted VBA) is the only schema-migration mechanism and is vendor-locked | **High** | `abuzarapp.pbd` connection strings; string probe |
| R11 | Sale-return fiscalisation coverage jumps from 5.9 % (2025) to 99.9 % (2026) — 19,642 unfiscalised 2025 credit notes | **High** (tax) | `SELECT YEAR(Date),Fiscalized,COUNT(*) FROM SRLedger` |
| R12 | `SP_RequestHttpWebService` never checks the HTTP status, never sets a timeout, and leaks the COM object on failure | **High** | `dbo.SP_RequestHttpWebService` |
| R13 | Backup packet passwords are the fixed strings `'alcia'+servername` / `'alfia'+servername` | High | `dbo.SP_PrepareDataMigrationPacket` |
| R14 | `AutoFiscalizeOnPosting='Y'` while both DB call sites are commented out — configuration lies about behaviour | Medium | `sp_PostSaleLedger` / `sp_PostSRLedger` |
| R15 | `SP_CheckDBIntegrity` only recognises SQL Server 2000 and 2012; on 2019 it uses the wrong DBCC column list | Medium | `dbo.SP_CheckDBIntegrity` |
| R16 | Full 3 GB database backup taken at every client **startup and shutdown** | Medium | `AutoBackup\AutoStartup…BAK`, `AutoClient…BAK` |
| R17 | SMS gateway design puts credentials in URL query strings over plain HTTP; 4 of 7 endpoints are `http://` | Medium (dormant) | `smscomponents.pbd` strings |
| R18 | Unsigned third-party native DLLs in the POS process (`QRCodeGenLibrary.dll` — Russian vendor; `Service1.dll` — no publisher; `EZTW32.dll` — no version resource) | Medium | VersionInfo |
| R19 | Google Chart QR endpoint (`chart.apis.google.com`) is dead; selecting that method silently breaks QR printing | Medium | `functions.pbd` / `fiscalizationapp.pbd` strings |
| R20 | `SP_Get_ResultSet_From_Excel` cannot run (`Ad Hoc Distributed Queries` disabled + Jet 32-bit only) yet is still exposed | Low | `sys.configurations`; proc body |
| R21 | ~130 dormant sync procedures and ~70 empty `CRS_*`/`DB_*` tables inflate the schema and confuse any reader | Low | row counts |
| R22 | Invoice-level discount excluded from the FBR `Discount` field but included in the tax base | Medium (tax) | `SP_GetSaleInvoice_JSON` vs `fn_getTaxOnSaleInv` |
| R23 | `PrintUnFiscalizedInvoice='N'` means **any FBR/middleware outage halts billing** — there is no offline/queue fallback | **High** (business continuity) | preference + `SP_FiscalizeSaleInvoice` returns `-1` |

---

## 11. Modernization mapping — legacy → Node/React/MySQL (all **Recommended**)

| Legacy | Recommended replacement | Priority |
|---|---|---|
| `SP_FiscalizeSaleInvoice` + `SP_RequestHttpWebService` + `fiscalizationapp.exe` + `localhost:8524` | **`FiscalizationService`** in Node: pure `buildFbrInvoice(saleId)` → validated DTO (zod) → HTTP client with timeout/retry/circuit-breaker → durable `fiscal_submission` table (request JSON, response JSON, HTTP status, attempt no., latency) → outbox worker | **P0** |
| No offline fallback (`PrintUnFiscalizedInvoice='N'`) | **Store-and-forward**: sale completes locally, prints a provisional receipt, fiscal number attaches asynchronously and reprints/annexes. Never block a customer at the till on a government API. | **P0** |
| FBR **Digital Invoicing** (schema only) | Implement `postinvoicedata` / `validateinvoicedata` against `gw.fbr.gov.pk`, sandbox-first; bearer token in a secrets manager; scenario + UOM + HS-code mapping tables with effective dates; per-invoice validation before submission | **P0** |
| `SP_GetSaleInvoice_JSON` string concatenation | `JSON.stringify` on a typed object; schema-validated; no length limit; unit tests incl. 200-line invoices and names containing `"` and `\` | **P0** |
| `PCT.Description = '.'` | proper `hs_code` master with validation; mandatory for taxable items; bulk remap exercise for all 30,052 items | **P0** |
| `fn_getTaxOnSaleInv` / `fn_getTaxOnSRInv` | one pure `computeInvoiceTax()` with golden-master regression over ≥10,000 historical invoices | **P0** |
| Live `SalesTaxSchedule`/`PCT` reads in the filing payload | **snapshot** rate, PCT and unit tax onto the invoice line at posting | **P0** |
| `xp_cmdshell` + `SP_WayToMoon` + `Script.mdb` licensing | **delete**; no dongle, no OS calls from the DB | **P0** |
| `SP_MyExecuteLocal`, all `EXECUTE(@string)` | parameterised queries / ORM only; least-privilege DB users; `sa` never used by the app | **P0** |
| OpenSSL 0.9.8l / Xerces 2.6 / msvcr71 / Jet 4.0 / TX Text Control 15 / PB 12.5 runtime / JVM bridge | Node LTS + OS TLS; `exceljs`; headless-Chromium PDF; **all removed** | **P0** |
| `QRCodeGenLibrary.dll` / Google Chart QR | `qrcode` or `bwip-js` (npm), server-side SVG/PNG | P1 |
| `SMS_Center` + `smscomponents.pbd` + 7 hardcoded gateways | `notification_outbox` + queue worker + provider adapters + secrets manager; templates versioned with a typed variable contract | P1 |
| 22 `VIEW_SMS_*` payload views | 22 typed DTO builders, unit-tested | P1 |
| DW2XLS / `pb2xls.dll` | `exceljs` server-side export; streaming for large reports | P1 |
| 45 hardcoded printer models, cash drawer, scale, TWAIN | local **hardware agent** (Node + `serialport`/`node-hid`) exposing a signed localhost API; browser talks to the agent | P1 |
| `sp_BackupDB` + startup/shutdown full backups | scheduled full+diff+log backups, verified restores, off-site copy; **never** at app startup | P1 |
| `SP_CheckDBIntegrity` / `SP_DBReindex` / `DBCC_History` | managed MySQL maintenance + monitoring (`mysqlcheck`, slow-query log, Prometheus) | P2 |
| CRS / DropBox / DataCarry / WaseelaMini / `SP_ImportData` (~130 procs, ~70 tables) | **do not port** (owner decision required). If multi-branch is needed later: cloud API + per-branch outbox with monotonic change IDs | P2 |
| `SP_Get_ResultSet_From_Excel` (OPENROWSET/Jet) | file upload → `exceljs`/`papaparse` parse in Node → staged import with a preview/diff UI and a real `import_batch` audit | P2 |
| Biometric attendance (`BioMetricMachine`, `EMP_FingerPrint`) | out of scope unless the owner asks; if built, templates encrypted at rest and treated as special-category data | P3 |

---

## 12. Requires accountant / tax-adviser validation (explicit list)

1. **Which FBR regime is the pharmacy legally on right now** — POS integration only, or is Digital Invoicing already mandatory for this NTN? (`ImplementDigitalInvoicing='N'`, zero DI submissions.)
2. **Which `FBR_DI_Scenario` applies** — SN025 (drugs at fixed ST rate, 8th Sch. Table‑1 s.81) vs SN026/27/28 (sale to end consumer by retailers)? All 28 are `Applicable='N'` today.
3. **The 19,642 unfiscalised 2025 sale returns** — is a retrospective filing/correction required?
4. **The 439 unfiscalised sale invoices** — voided, offline, or genuine gaps?
5. **`Discount` reported to FBR excludes invoice-level discount** but the tax base includes it (§1.3 J5). Is the reported figure compliant?
6. **Bonus quantity is taxed and counted but not valued** (§1.3 J7). Correct treatment for free goods?
7. **`PCTCode` sent as `"."`** for 99.4 % of lines — accepted by FBR under POS; acceptable under DI?
8. **The `FBRPOSFee` of Re. 1 per invoice** — correct amount, correct accounting treatment, correct disclosure on the customer's bill?
9. **`ownertaxregno = '055-3252501'`** — is this the STRN/NTN or a telephone number? (Field caption is ambiguous.)
10. **Sale-return tax asymmetry**: `fn_getTaxOnSRInv` omits `ItemFlatDisc` from the line base while `fn_getTaxOnSaleInv` includes it — does the refunded tax match the tax originally charged?
11. **`TaxType` codes `S` / `E`** in `SalesTaxSchedule` — no code reads them; what were they meant to mean?
12. **Rounding preferences** `roundsaleinvon` / `roundsalereturninvon` — confirm the legally required rounding for tax amounts.

---

## 13. Open questions / what could not be determined

| # | Question | Why it matters | Blocked by |
|---|---|---|---|
| Q1 | Who/what serves `http://localhost:8524/api/IMSFiscal/*`? | It **is** the fiscalisation integration | Not installed on this machine; `141973.ims` is encrypted |
| Q2 | What is in `HKCU\Software\Waseela\FiscalizationApp`? | May hold endpoint, retry and credential settings | Registry hive of the production PC not available |
| Q3 | Exact wire protocol on TCP 9111 between `abuzar.exe` and `fiscalizationapp.exe` | Needed to replace either half independently | Compiled `.pbd`; no traffic capture |
| Q4 | Exact composition of the trailing digits of `FiscalInvoiceNo` | Needed if the new system must generate or validate them | Only two decodable samples; POSID + `YYMMDD` confirmed, tail ambiguous |
| Q5 | **The production V3 client binaries** — where are they? | The DI logic exists only there | `D:\V3_AbuzarSoftware` absent; `.pbd`s here are 8 Nov 2024 |
| Q6 | Full contents of `Script.mdb` (schema migration history) | Would reveal every schema change the vendor ever applied | Jet password + encrypted VBA (`DPB=`) |
| Q7 | Are the two `SP_WayToMoon` marker filenames known? | Needed to keep the legacy app runnable during parallel-run | Filenames are passed in by the client, not stored in the DB |
| Q8 | Is the **weighing scale** actually used at the counter? | Determines whether the barcode weight parser must be rebuilt | Config row exists; no usage telemetry |
| Q9 | Is **TWAIN scanning** used (prescriptions, ID cards)? | Determines document-capture scope | `ImageScanTool` set; no image blobs found |
| Q10 | Is **DW2XLS** used by staff daily, and for which reports? | Determines export scope | Binary present; no usage log |
| Q11 | Why is `SaleLedger.GSTNO` a `tinyint` fixed at `1`? | Name suggests a tax number; type says lookup code | No FK, no proc reads it |
| Q12 | Did the vendor ever run DI in sandbox from another machine? | Would show whether the integration is proven at all | `Digitalized='N'` everywhere; no submission log table exists |
| Q13 | Are `PBVM125.dll` (4 Jan 2026) / `libjcc.dll` (7 Dec 2025) patched builds or re-copied files? | Supply-chain integrity | No hashes/signatures to compare against |

---

*End of document 11 — Integrations & Dependencies.*
