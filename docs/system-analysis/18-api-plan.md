# 18 — REST API Plan (New System)

| Field | Value |
|---|---|
| **Purpose** | Define the complete REST API surface of the rebuilt pharmacy system: every endpoint, the role that may call it, the fields it accepts, the validation it performs, what it returns, how it fails, what it audits, whether it needs an idempotency key, and whether it must run inside a database transaction. This document is the contract between the React frontend, the Node/TypeScript backend and the MySQL 8 schema. |
| **Analysis stage** | Stage 18 — **forward design**. Follows `17-technical-blueprint.md` (architecture) and `19-mysql-schema-blueprint.md` (data model). Consumed by implementation, by `21-feature-traceability-matrix.md`, and by the OpenAPI generator described in Part 6. |
| **Scope** | Pharmacy business in full, including tax and FBR fiscalization (**D1**). Non-pharmacy verticals are catalogued in `feature_capability` and exposed read-only through `GET /api/v1/admin/feature-capabilities` — **catalogued, never silently dropped**. |
| **Inputs read** | `00b-owner-decisions-and-requirements.md`, `03-module-catalog.md`, `09-roles-permissions.md`, `17-technical-blueprint.md`, `19-mysql-schema-blueprint.md`, plus `06`, `07`, `08`, `10`, `11` for cited legacy behaviour. |
| **Status** | Draft for owner + accountant review. Items in Part 8 must be answered before the corresponding endpoints are built. |
| **Author stance** | This is a **plan**, not code. No implementation is included by design. |

---

## ⚠️ The existing system was NOT modified

Every statement about WASEELA ABUZAR V3 in this document was derived from **read-only** inspection of the SQL Server database catalogue, stored-procedure text and compiled-library file listings performed in earlier analysis stages. **No legacy table, procedure, binary, configuration file or data row was created, altered or deleted at any point.** No endpoint described here exists yet; nothing here has been deployed against the live shop.

---

## Evidence-label legend

Every significant statement in this document carries exactly one label.

| Label | Meaning |
|---|---|
| `Verified` | Directly observed in the legacy database, stored-procedure text, file listing or a prior analysis document, and cited. |
| `Strongly Inferred` | Not directly observed, but the only conclusion consistent with several `Verified` facts. |
| `Unclear` | Evidence is contradictory or insufficient. Flagged, never guessed. |
| `Missing` | The capability does not exist in the legacy system at all. |
| `Deprecated` | Exists in the legacy system but is dead, dormant or superseded. |
| `Broken/Incomplete` | Exists but does not work as intended — defect evidence cited. |
| `Recommended` | A proposal for the **new** system. **Everything in Parts 0–9 that describes an endpoint is `Recommended`** unless it cites legacy behaviour, which carries its own label. |

> **Rule 1 restated:** no endpoint in this document exists today. When a row says "replaces `sp_PostSaleLedger`", the legacy procedure is `Verified` and the replacement is `Recommended`.

---

## How to read this document

| Part | Contents |
|---|---|
| **Part 0** | Conventions defined once — versioning, naming, pagination, filtering, sorting, envelopes, errors, idempotency, concurrency, transactions, audit, roles. **Read this first; the module tables assume it.** |
| **Part 1** | Platform, identity, access — auth/session, users, roles/permissions/scopes/limits, jobs, series, feature register. |
| **Part 2** | Catalogue, pricing, visibility (R1), stock, batches and expiry (R4), adjustments and stock takes. |
| **Part 3** | Sales, POS, sale returns, customers. |
| **Part 4** | Suppliers, purchase orders, purchase invoices / goods receipt, purchase returns. |
| **Part 5** | Money out and accounting — supplier payments (R2.1), expenses (R2.2), cash/bank book (R2.3), cashier shifts (R2.4), GL and periods, statements (R2.5), tax, FBR fiscalization. |
| **Part 6** | Reporting, settings and options-as-data (P1), admin and migration, audit log, documents/printing, notifications. |
| **Part 7** | OpenAPI strategy — how the spec is generated and kept honest. |
| **Part 8** | Additive-new vs. replacement classification, and the deferred surface. |
| **Part 9** | Open questions requiring owner or accountant sign-off before the endpoint is built. |
| **Part 10** | Residual risks carried into implementation. |

---
---

# PART 0 — CONVENTIONS (DEFINED ONCE, ASSUMED EVERYWHERE)

## 0.1 Versioning

`Recommended`.

| Rule | Statement |
|---|---|
| **V-1** | Every endpoint lives under `/api/v1`. The version is in the path, not a header — it is visible in logs, in the browser address bar, and in a support call transcript. |
| **V-2** | `v1` is **additive-only** after go-live: new optional fields and new endpoints may be added; existing fields are never removed, renamed or re-typed. A breaking change mints `/api/v2` and both run side by side for one full fiscal year (`Recommended`; a pharmacy on a single box cannot coordinate a flag-day client upgrade). |
| **V-3** | Deprecation is signalled with `Deprecation: true` and `Sunset: <HTTP-date>` response headers plus a `deprecation` entry in the OpenAPI operation. The frontend logs a console warning; the CI contract test fails if a sunset date passes while the operation is still referenced. |
| **V-4** | There is exactly **one** API. The POS surface, the tablet surface and the desktop surface (`17` §8.9) are three clients of the same endpoints. No "mobile API". |

## 0.2 Resource naming

`Recommended`.

| Rule | Statement |
|---|---|
| **N-1** | Resources are **plural nouns in `kebab-case`**: `/sale-invoices`, `/purchase-orders`, `/stock-lots`, `/cash-bank-accounts`. |
| **N-2** | Sub-resources nest one level only: `/sale-invoices/{saleInvoiceId}/lines`. Deeper relationships are expressed as filters on a top-level collection (`/stock-movements?saleInvoiceId=…`), not as three-level paths. |
| **N-3** | State transitions that are not CRUD are **verb sub-resources** on the document: `POST /sale-invoices/{id}/post`, `/cancel`, `/reverse`, `/approve`. This is deliberate: `PATCH {status:"posted"}` hides an eight-leg ledger posting behind a field assignment, which is how the legacy system ended up with a status column nobody could explain. |
| **N-4** | JSON fields are `camelCase`. Database columns are `snake_case` (`19` §2.1). The mapping happens once, in the repository layer. |
| **N-5** | Path parameters are typed IDs (`{saleInvoiceId}`), never bare `{id}`, so that generated client code is self-documenting. |
| **N-6** | Identifiers in the URL are the **surrogate** `BIGINT` keys, never the human document number. `doc_number` is searchable (`?docNumber=SV-000123`) but is not a path segment — it is unique only per series (`19` §4.4). |
| **N-7** | No verbs in collection paths. `/sales/checkout` is the one deliberate exception, justified in §3.3. |

## 0.3 Pagination

`Recommended`. Two mechanisms, chosen by data shape, never mixed on one endpoint.

| Mode | Used for | Request | Response |
|---|---|---|---|
| **Offset** (default) | Master data and any list a human browses with page numbers: items, suppliers, users, options. | `?page=1&pageSize=50` — `pageSize` max 200, default 50 | `meta.page`, `meta.pageSize`, `meta.totalItems`, `meta.totalPages` |
| **Keyset (cursor)** | High-volume append-only streams where offset paging degrades and rows shift under the reader: `stock-movements`, `audit/events`, `sale-invoices` unfiltered, `journal-lines`. | `?cursor=<opaque>&limit=100` — `limit` max 500 | `meta.nextCursor` (null at end), `meta.hasMore`. **No `totalItems`** — counting 1.02 M ledger rows on every page is the mistake the legacy report layer makes. |

Rules:
- **P-1** Every collection endpoint is paginated. There is no unbounded list response anywhere in the API.
- **P-2** A cursor is an opaque, signed, base64url token encoding `(sortKey, tieBreakerId, filterHash)`. Changing filters invalidates the cursor with `400 PAGINATION.CURSOR_FILTER_MISMATCH` rather than silently returning wrong rows.
- **P-3** Counting is opt-out: `?includeTotal=false` on offset endpoints skips the `COUNT(*)`. The item catalogue (30,052 rows, `Verified`, `06a` §2) counts cheaply; the sale ledger (291,361 rows) does not.
- **P-4** Exports never paginate. They stream (§0.14).

## 0.4 Filtering

`Recommended`. One grammar for the whole API — the legacy alternative is 1,080 bespoke parameter windows (`Verified`, `10` §10.1).

| Form | Syntax | Example |
|---|---|---|
| Equality | `?field=value` | `?warehouseId=1` |
| Multi-value (IN) | repeat the key | `?status=posted&status=cancelled` |
| Range | `?field.gte=` / `.lte=` / `.gt=` / `.lt=` | `?postingDate.gte=2026-01-01&postingDate.lte=2026-01-31` |
| Null tests | `?field.isNull=true` | `?expiryDate.isNull=true` |
| Text search | `?q=` — server decides the fields per resource, documented in OpenAPI | `?q=panadol` |
| Prefix search | `?field.startsWith=` | `?docNumber.startsWith=SV-2026` |
| Soft-deleted / inactive | `?includeInactive=true`, `?includeDeleted=true` (needs `*:view_archived`) | |
| **Visibility override (R1.7)** | `?includeHidden=true` | Guarantees *hidden never means unreachable* |

Rules:
- **F-1** Unknown query parameters are **rejected** with `400 VALIDATION.UNKNOWN_PARAMETER`, not ignored. Silent ignoring is how a typo becomes a wrong report.
- **F-2** Every filterable field is declared in the endpoint's Zod schema and therefore in OpenAPI. There is no free-form filter DSL and **no client-supplied SQL fragment** — the legacy cross-tab builder concatenates client input into dynamic SQL (`Verified`, `10` §10.1), an injection surface that is removed by construction.
- **F-3** Date filters are inclusive `DATE` values in `YYYY-MM-DD`, interpreted in the shop's configured timezone (`Asia/Karachi`), never in UTC. Datetime filters use ISO-8601 with an offset.
- **F-4** Row-level scope (`role_scope`, `19` T18) is applied **after** the client's filters as a mandatory `AND`. A client cannot widen its own scope by omitting a filter.

## 0.5 Sorting

`Recommended`.

- `?sort=field` ascending, `?sort=-field` descending, comma-separated for multi-key: `?sort=-postingDate,docNumber`.
- **S-1** Only fields declared `sortable` in the endpoint schema are accepted; anything else is `400 VALIDATION.UNSORTABLE_FIELD`.
- **S-2** Every sort is made total by appending the primary key as a final tie-breaker, so paging is stable.
- **S-3** Every endpoint declares a default sort. Unsorted result sets are not permitted (MySQL order without `ORDER BY` is arbitrary, and the legacy reports depend on it).

## 0.6 Standard response envelopes

`Recommended`.

**Single resource** — the resource object at the top level, no wrapper:

```jsonc
{
  "saleInvoiceId": "918273",
  "docNumber": "SV-000918273",
  "status": "posted",
  "invoiceTotal": "1250.7500",          // money is a STRING (§0.7)
  "rowVersion": 4,
  "links": { "self": "/api/v1/sale-invoices/918273", "print": "/api/v1/sale-invoices/918273/print" }
}
```

**Collection** — `data` + `meta`:

```jsonc
{
  "data": [ /* … */ ],
  "meta": {
    "page": 1, "pageSize": 50, "totalItems": 30052, "totalPages": 602,
    "sort": "-postingDate,docNumber",
    "appliedScope": { "warehouseIds": [1] },     // what row-level scope the server enforced
    "hiddenByVisibility": 1159                    // R1 transparency: how many rows the filter removed
  }
}
```

- **R-1** `hiddenByVisibility` is present on every catalogue-bearing collection. R1.7 requires that a user can always tell that something was hidden and can reach it — a count in the envelope is the machine-readable half of that promise.
- **R-2** `appliedScope` is always echoed. A user who cannot see another warehouse's stock is told so, rather than silently seeing zero.
- **R-3** Successful mutations return the **full resource**, not `204`, so the client never needs a follow-up `GET` to refresh a grid. The one exception is `DELETE`-style disable operations, which return the updated resource too.

## 0.7 Money, quantity and decimal transport [BINDING]

`Recommended`, and non-negotiable — this is Rule M from `17` §6.

| Rule | Statement |
|---|---|
| **M-1** | **Every money and quantity value crosses the wire as a JSON string**, never a JSON number: `"1250.7500"`, not `1250.75`. IEEE-754 doubles cannot represent PKR paisa exactly, and JavaScript's `JSON.parse` produces doubles. |
| **M-2** | Money is `DECIMAL(18,4)` and is serialised with **exactly 4 decimal places**. Quantities are `DECIMAL(18,3)`, serialised with exactly 3. Unit rates are `DECIMAL(18,6)` with exactly 6 (`19` §3.4). The scale is fixed so string comparison and hashing are stable — this matters for the idempotency `request_hash`. |
| **M-3** | Percentages are `DECIMAL(9,4)` strings; a 2 % discount is `"2.0000"`, not `"0.0200"`. |
| **M-4** | The edge validator **rejects** a JSON number in a money field with `400 VALIDATION.NUMERIC_TYPE` — it does not coerce. Coercion is how precision is lost silently. |
| **M-5** | Currency is PKR everywhere (**D4**); `currencyCode` is still present on financial resources because omitting it makes a future second currency a breaking change. |
| **M-6** | Dates are `YYYY-MM-DD`. Timestamps are ISO-8601 with offset, millisecond precision (`DATETIME(3)`). **The sentinel dates `1900-01-01`, `2012-12-12` and `2030-12-12` are rejected as input** — `2030-12-12` is the legacy "no expiry" marker on 5,867 of 6,165 stock rows (`Verified`, `06` §5.6 D3). Unknown expiry is `expiryDate: null` + `expiryStatus: "unknown"`. |

## 0.8 Standard error envelope [BINDING]

`Recommended`. RFC 9457 `application/problem+json`, exactly as specified in `17` §9.4.

```jsonc
{
  "type":     "https://errors.pharmacy.local/insufficient-stock",
  "title":    "Not enough stock",
  "status":   422,
  "code":     "INVENTORY.INSUFFICIENT_STOCK",
  "detail":   "Panadol 500mg: 12 packs available, 20 requested.",
  "instance": "/api/v1/sales/checkout",
  "traceId":  "01J9XKQ4M2P7RB0S3T5V8W",
  "errors": [
    {
      "path":    "lines[3].qty",
      "code":    "INVENTORY.INSUFFICIENT_STOCK",
      "message": "Only 12 packs are in stock.",
      "severity":"error",
      "meta":    { "available": "12.000", "requested": "20.000", "itemId": "4471" }
    }
  ]
}
```

### 0.8.1 The `errors[]` array is the accessibility contract

`Recommended`. This shape exists to satisfy WCAG 2.2 AA — the client's stated #1 product feature — and directly remedies the legacy behaviour in which *all* error reporting is a modal `MessageBox` with no inline placement and no focus management (`Verified`, `04` §9.2 A9, e.g. `Please Enter Valid Sale Qty in Row `, with the row number left blank).

| Field | Purpose | WCAG mapping |
|---|---|---|
| `path` | RFC 6901-style dotted/indexed path matching the **exact** React Hook Form field name, so the client can call `setFocus(path)` with no translation table. | 3.3.1 Error Identification, 2.4.3 Focus Order |
| `message` | Plain language, ≤ 120 chars, states what is wrong **and what to do**. No codes, no SQL, no table names. Localisable (en / ur). | 3.3.3 Error Suggestion |
| `code` | Stable machine identifier. Never changes once published; the message may be rewritten freely. | — |
| `severity` | `error` blocks submit; `warning` permits submit after acknowledgement (near-expiry sale, price below cost); `info` is advisory. | 3.3.4 Error Prevention |
| `meta` | Structured values the UI needs to render a helpful control (available qty, allowed maximum, the conflicting document number). Never free prose. | 3.3.3 |

Client contract (`Recommended`, tested by Playwright per `17` §9.4): on a `422` with `errors[]`, the client (a) renders a summary in an `aria-live="assertive"` region naming the count and the first problem, (b) links each summary entry to its field with an in-page anchor, (c) moves focus to the first `severity: "error"` field, (d) sets `aria-invalid="true"` and `aria-describedby` on each named control. **Field-level errors are never rendered as a modal.**

### 0.8.2 Status code mapping [BINDING]

| Status | Meaning | Typical `code` prefix |
|---|---|---|
| `400` | Malformed request: bad JSON, unknown parameter, wrong type, missing `Idempotency-Key` on a financial POST | `VALIDATION.*`, `PAGINATION.*`, `IDEMPOTENCY.KEY_REQUIRED` |
| `401` | Not authenticated, session expired or revoked | `AUTH.*` |
| `403` | Authenticated but not permitted; also **row-scope denial** and **limit exceeded** | `AUTHZ.PERMISSION_DENIED`, `AUTHZ.SCOPE_DENIED`, `AUTHZ.LIMIT_EXCEEDED`, `AUTHZ.STEP_UP_REQUIRED` |
| `404` | Not found **or out of the caller's scope** — the two are deliberately indistinguishable so the API is not an existence oracle | `NOT_FOUND` |
| `409` | Optimistic-concurrency conflict (`rowVersion` mismatch), or an idempotent request still in flight | `CONCURRENCY.VERSION_CONFLICT`, `IDEMPOTENCY.IN_PROGRESS` |
| `413` | Upload too large | `UPLOAD.TOO_LARGE` |
| `422` | Well-formed but violates a business rule: unbalanced journal, insufficient stock, closed period, return exceeds original, expired lot | `INVENTORY.*`, `LEDGER.*`, `PERIOD.*`, `SALES.*`, `PURCHASE.*` |
| `429` | Rate limited. `Retry-After` always present | `RATE_LIMIT.EXCEEDED` |
| `500` | Unexpected. Body carries `traceId` only | `INTERNAL` |
| `503` | External dependency unavailable — **FBR only**. Never returned for a database problem | `FBR.UNAVAILABLE` |

- **E-1** Nothing internal leaks: no SQL text, no stack frame, no MySQL error number, no table name (`17` §9.4 E-5). A contract test asserts no response body ever contains `SELECT `, `mysql`, `information_schema` or a stack frame.
- **E-2** `traceId` is on **every** response, success or failure, as both a body field (on errors) and the `X-Trace-Id` header. The user sees it as a short reference to quote to support.
- **E-3** A financial operation never fails partially. Any error inside a transaction script rolls the whole thing back, and the `detail` says plainly that nothing was saved.

### 0.8.3 Shared error sets (referenced by shorthand in the module tables)

To keep the endpoint tables readable, three sets are defined here and referenced by name.

| Set | Contents |
|---|---|
| **`E-STD`** | `400` malformed/validation · `401` unauthenticated · `403` permission or scope denied · `429` rate limited · `500` internal |
| **`E-READ`** | `E-STD` + `404` not found or out of scope |
| **`E-WRITE`** | `E-READ` + `409` `CONCURRENCY.VERSION_CONFLICT` + `422` domain-rule violation |
| **`E-FIN`** | `E-WRITE` + `400 IDEMPOTENCY.KEY_REQUIRED` + `409 IDEMPOTENCY.IN_PROGRESS` + `422 IDEMPOTENCY.KEY_REUSE` + `422 PERIOD.CLOSED` + `403 AUTHZ.LIMIT_EXCEEDED` |

Rows list only the errors **beyond** the named set.

## 0.9 Idempotency [BINDING]

`Recommended`. Mechanism specified in `17` §7.5; this section states the API-surface rules.

| Rule | Statement | Why |
|---|---|---|
| **I-1** | **Every request that moves money, stock or the ledger MUST carry `Idempotency-Key: <UUIDv7>`.** Missing → `400 IDEMPOTENCY.KEY_REQUIRED`. This covers: all sale, sale-return, purchase, purchase-return, adjustment, stock-take-generate, payment, expense, journal, transfer and shift-close creates; **and every `…/post`, `…/cancel`, `…/reverse`, `…/approve` action**. | A cashier double-clicking *Save*, or a dropped response after a successful commit, must not create two invoices. The legacy system has no such protection **and no way to detect that it happened** (`Missing`; `17` §7.5). |
| **I-2** | The key is minted **once when the form is opened**, not per click, and is reused across retries of that same intent. The client regenerates only when the user starts a new document. | A per-click key defeats the entire mechanism. |
| **I-3** | Replay of a completed key returns the **stored response verbatim** with `Idempotency-Replayed: true` and the original status code. | The client cannot distinguish "it worked the first time" from "it worked now", which is the point. |
| **I-4** | Same key + **different** canonicalised body → `422 IDEMPOTENCY.KEY_REUSE`. Same key + still running → `409 IDEMPOTENCY.IN_PROGRESS` with `Retry-After: 2`. | Detects a client bug rather than silently doing the wrong thing. |
| **I-5** | Keys are scoped to `(key, endpoint)` and expire after **7 days**. | Bounded storage; longer than any realistic retry window. |
| **I-6** | Read-only methods (`GET`, `HEAD`) and pure-configuration writes that are naturally idempotent (`PUT /settings/{key}`) do **not** require a key. `PATCH` on master data uses `If-Match` optimistic concurrency instead (§0.10), which serves the same purpose for that class. | Requiring a key everywhere trains clients to send a fresh UUID per request, which is equivalent to not having the feature. |
| **I-7** | `POST /reports/{id}/run` and other **read-only POSTs** (used because the filter payload is too large for a query string) are exempt — they mutate nothing. They are marked `x-read-only: true` in OpenAPI so the contract test does not demand a key. | |

**Every row in Parts 1–5 whose "DB transaction required" cell says `Yes` because it moves money or stock also says `Required` under Idempotency.** That pairing is an invariant of this document and is checked by the route-enumeration test in Part 6.

## 0.10 Optimistic concurrency

`Recommended`.

- Master-data resources (`item`, `supplier`, `customer`, `gl_account`, `role`, `app_setting`, options) carry `rowVersion` (`19` §4.1 pack `AP`).
- `PATCH` and `PUT` **must** send `If-Match: "<rowVersion>"`. Missing → `428 PRECONDITION_REQUIRED`; stale → `409 CONCURRENCY.VERSION_CONFLICT` with `meta.currentVersion` and a field-level diff of what changed, so the UI can show "someone else changed the sale price while you were editing".
- Transactional documents do **not** use `If-Match` for state transitions; they use their `status` as the guard (`POST /…/post` on an already-posted document is `422 DOC.ALREADY_POSTED`, not a version conflict) plus the idempotency key.
- **Rationale (`Recommended`):** the legacy system has no defence against lost updates at all — two windows editing the same item silently overwrite each other (`Strongly Inferred` from the absence of any version column on `Item`, `06` §6).

## 0.11 Transaction policy [BINDING]

`Recommended`, from `17` §7.1–7.3 and `19` §8.5.

| Rule | Statement |
|---|---|
| **T-1** | **One HTTP request = at most one database transaction.** No endpoint opens a second transaction, and no transaction spans two requests. |
| **T-2** | A transaction is **mandatory** wherever a single logical change touches more than one table and any of them is `stock_movement`, `stock_balance`, `journal_entry`, `journal_line`, `doc_series_counter`, `item_cost_snapshot`, or a document header + its lines. In practice: **every financial or stock mutation**. |
| **T-3** | Isolation is `READ COMMITTED`. Serialisation where required is explicit `SELECT … FOR UPDATE`. |
| **T-4** | **Fixed lock order, always:** `doc_series_counter` → `stock_balance` (ordered by PK) → `item` cost row → `journal_entry` → `journal_line`. A single global ordering is what prevents POS↔purchase deadlocks (`19` §8.5). |
| **T-5** | The document number is allocated **last** inside the transaction (`17` §7.6 N-1), never held across user interaction. The legacy pattern burned 880,233 keys to produce 291,361 invoices — roughly 3 per surviving invoice (`Verified`, `06` §8.5.1). |
| **T-6** | The audit row is written **inside** the same transaction as the change it records (`17` §9.5 A-4). An audit trail that can be lost is not an audit trail. |
| **T-7** | External calls (FBR, SMS, e-mail, object storage) are **never** inside a business transaction. They go through the transactional outbox (`17` §7.7): the outbox row commits with the invoice, a worker delivers it afterwards. |
| **T-8** | Long-running work (exports, balance rebuilds, bulk visibility over 30,052 items, migration steps) is a **job**, not a request. The endpoint returns `202 Accepted` with a `jobId` and a poll URL. |
| **T-9** | Reads run on the read-only connection pool and never open a write transaction. The `reporting` module has no write grant at all (`17` §9.6). |

## 0.12 Authentication and session transport

`Recommended`, from `17` §9.1 and `09` §I.5.

- Opaque session ID in an `HttpOnly; Secure; SameSite=Strict` cookie, backed by `user_session`. **Not** a stateless JWT — instant revocation is the requirement that decides this (`09` §I.5, `03` §2.5 `allow_multiple_session='N'`, `Verified`).
- CSRF: double-submit token in `X-CSRF-Token`, required on every unsafe method. Rejected → `403 AUTH.CSRF_INVALID`.
- Sliding idle timeout 20 min for counter roles, 8 h absolute cap.
- **Step-up re-authentication** is a P1 option per action (*never · once per session · once per N minutes · every time*), default **never**. The legacy asks for user+password on **every** cash sale, credit sale, POS sale, adjustment, sale return and item edit (`Verified`, `04` §9.2 A8) — at 511 invoices/day (`Verified`, `06a` §2) that is an accessibility and throughput failure. Break-glass actions always require step-up regardless of the option.
- When step-up is needed the server returns `403 AUTHZ.STEP_UP_REQUIRED` with `meta.stepUpToken`; the client calls `POST /auth/step-up` and retries **with the same `Idempotency-Key`**, which is precisely why I-2 mandates a stable key.

## 0.13 RBAC — the role set and permission grammar [BINDING]

`Recommended`. Roles are taken verbatim from `09` §I.3; the permission grid from `09` §I.4.

### 0.13.1 The eight seeded roles

| Shorthand (used in tables) | Role key | Display name | Origin | Notes |
|---|---|---|---|---|
| **OWN** | `owner` | Owner / Proprietor | new | Sees all financials and reports; **cannot post transactions** |
| **SYS** | `sys_admin` | System Administrator | `ADMINISTRATOR` (GroupCode 2) | Users, roles, settings, backups. **No** posting, **no** repricing |
| **MGR** | `pharmacy_manager` | Pharmacy Manager | `ADMINISTRATOR` operational half | Pricing, item master, purchase approval, discount override |
| **SHF** | `shift_incharge` | Shift In-charge | `SHIFT INCHARGE` (11) | Counter supervision, item creation, daily reports |
| **SLS** | `sales_officer` | Sales Officer / Counter | `SALES OFFICER` (12) | Cash sale + return end-to-end; **no cost visibility by default** |
| **PUR** | `purchase_officer` | Purchase Officer | split out of 11/12 | Create/edit purchase & PO — **cannot post** (separation of duties) |
| **ACC** | `accountant` | Accountant | `ADMINISTRATOR` accounting half | Vouchers, ledgers, GL, reconciliation |
| **AUD** | `auditor` | Auditor (read-only) | `REMOTE` (5) | Read everything, write nothing, export with logging |

`Verified` context that makes this split necessary: today one group (`ADMINISTRATOR`) holds all 486 rights, and the counter groups can **create, edit and post a purchase invoice unaided** — no separation of duties (`09` §I.3 finding S21).

### 0.13.2 Permission grammar

- Permissions are `resource:action`, lower-snake, e.g. `sale.cash:create`, `item:view_cost`, `accounting.period:reopen`.
- Actions: `view, list, create, edit, delete, post, unpost, approve, export, print, reprice, discount, override, configure`.
- Every permission row keeps `legacy_right_code` so all 486 legacy rights stay traceable and the owner can sign off the mapping (`09` §I.6 step 2).
- **Deny by default.** No permission row ⇒ denied. The route-enumeration test (Part 6) fails the build if any mutating route lacks a `@RequirePermission` declaration.
- **The client uses the permission set only to hide UI. It is never the control** (`09` §I.1 principle 1). This is the single most important correction to a system where only **eleven** of 643 stored procedures perform a server-side right check (`Verified`, `09` §C.2.2).

### 0.13.3 Scopes and limits

- **Scope** (`role_scope`) is a mandatory `WHERE` clause injected by the repository layer — warehouse, cash account, price tier, supplier category, voucher category. Replaces the whole `GroupAllowed*` family (`09` §C.3). A denial is `403 AUTHZ.SCOPE_DENIED` on write and an invisible row on read.
- **Limits** (`role_limit`) — `max_txn_value`, `max_qty`, `max_line_disc_pct`, `max_inv_flat_disc`, `max_price_delta_pct` — are **evaluated inside the transaction that writes the document**, returning `403 AUTHZ.LIMIT_EXCEEDED` with `meta.limitKey`, `meta.limitValue`, `meta.attemptedValue`, **and no database side effect**. `Verified` and critical: legacy group-level discount and transaction-value ceilings are **never enforced by SQL at all** (`09` §C.2.3, `Broken/Incomplete`).
- **Break-glass** grants a time-boxed (≤ 60 min) elevation after a per-user MFA challenge with a mandatory typed reason; used only for editing a posted document, posting into a closed period, and overriding an expired-stock block (`09` §I.5).

### 0.13.4 Role notation used in the endpoint tables

`OWN SYS MGR SHF SLS PUR ACC AUD` as above. A cell lists the roles that hold the permission in the **seeded starting configuration**. `◐` after a role means conditional — limit- or scope-bound — and the condition is named. **Every assignment is administrator-editable at runtime** (P1/D9): the seed is a default, not a hard-coded rule.

## 0.14 Exports, printing and large payloads

`Recommended`.

- Export is `POST /…/export` → `202 Accepted` + `{ jobId, statusUrl }`. The job streams CSV/XLSX/PDF to object storage and the client downloads via a short-lived signed URL from `GET /platform/jobs/{jobId}`.
- **Every export writes `audit_event(action='export')` with row count and the exact filter parameters** (`17` §9.5 A-3). This is what makes export a *logged right* rather than a *withheld* one — today only `ADMINISTRATOR` holds `Save As Excel`, which blocks every analyst (`Verified`, `10` §1.2 finding 5).
- Print returns a rendered document: `GET /sale-invoices/{id}/print?format=thermal|a5|a4|pdf`. `format` values come from the `doc_print_format` option list (P1, `19` T02) — not from an enum in code.
- Upload limit 10 MB per attachment, `multipart/form-data`, MIME sniffed server-side, SHA-256 computed and stored; images re-encoded to strip EXIF.

## 0.15 Rate limiting and abuse controls

`Recommended`. Sized for a 9-user, single-shop deployment (`Verified`, `09` §D.2) — the goal is containing runaway clients and credential attacks, not public-internet scale.

| Bucket | Limit | Applies to |
|---|---|---|
| `auth.login` | 10 / 15 min per username **and** per IP | `POST /auth/login`; independent of the 5-attempt account lockout |
| `write.financial` | 120 / min per session | all `E-FIN` endpoints — well above the observed 511 invoices/day peak |
| `read.default` | 600 / min per session | all `GET` |
| `report.run` | 10 concurrent per user, 30 / min | `POST /reports/*/run` |
| `export` | 5 concurrent server-wide | export jobs |

`429` always carries `Retry-After` and `RateLimit-*` headers.

## 0.16 Caching and conditional requests

`Recommended`.

- Option lists, settings, permissions and the item catalogue bootstrap support `ETag` + `If-None-Match` → `304`. The POS bootstrap payload (§3.3) is the main beneficiary.
- Everything financial or stock-bearing is `Cache-Control: no-store`. A cached stock figure is a wrong stock figure.
- `GET /settings/version` returns a monotonic settings generation number; the client polls it cheaply and invalidates its option cache when it changes (P1 runtime cache invalidation, `17` §10.3).

## 0.17 Audit event convention

`Recommended`. The **Audit event** column in every table below names the `audit_event.action` written, per `19` T20 and `17` §9.5. Conventions:

- `—` means no audit row (safe reads that are not exports).
- Reads are **not** audited except: exports (`export`), audit-log reads by non-auditors (`audit.read`), and any read of a break-glass-protected resource.
- Every audited write records `before_json` / `after_json` / `changed_fields`, the `request_id` correlating all rows from one user action, `amount_impact` where financial, and `reason` where the action demands one (cancel, reverse, bulk visibility change, permission change, period reopen, break-glass use).
- Security-class events (`login`, `logout`, `grant`, `revoke`, `breakglass.*`, `authz.denied`, `setting.change`, `period.*`, `backup.*`) are additionally flagged `is_sensitive`.

## 0.18 Standard request headers

| Header | Required on | Notes |
|---|---|---|
| `Idempotency-Key` | all `E-FIN` endpoints | UUIDv7, minted at form open |
| `If-Match` | `PATCH`/`PUT` on versioned master data | `rowVersion` |
| `X-CSRF-Token` | every unsafe method | double-submit |
| `X-Workstation` | every request from a till | replaces legacy `SaleLedger.MachineName` attribution (`Verified`, `09` §F.3); stored on `user_session` and copied onto documents |
| `Accept-Language` | optional | `en` / `ur`; drives `detail` and `message` localisation and RTL hints |
| `X-Request-Id` | optional | client-supplied correlation id; echoed, and used as `audit_event.request_id` if well-formed |

---
---

# PART 1 — PLATFORM, IDENTITY AND ACCESS

## 1.1 Module `identity` — authentication and session

**Replaces:** nothing — there is **no server-side authentication in the legacy system at all**. The application connects to SQL Server as `sa` with credentials embedded in the compiled binary, and `Users.Password varchar(60)` holds **plaintext** for all 9 users (`Verified`, `09` Part F, §H.1, Critical). Everything in this section is therefore `Recommended` and additive.

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| POST | `/api/v1/auth/login` | Authenticate and open a session | *(public)* | `username`, `password`, `workstation?` | username 1–64; password present; argon2id verify; account not locked; not `deleted_at` | `200` `{ user, roles, permissions[], mustChangePassword, mfaRequired, sessionExpiresAt }` + `Set-Cookie` | `E-STD`; `401 AUTH.INVALID_CREDENTIALS` (generic — never reveals which half failed); `423 AUTH.ACCOUNT_LOCKED` with `retryAfter`; `403 AUTH.MFA_REQUIRED` with `mfaToken` | `login.success` / `login.fail` (both, always) | Not required (naturally re-runnable) | **Yes** — session insert + failed-count reset + audit row must commit together |
| POST | `/api/v1/auth/mfa/verify` | Complete TOTP challenge | *(mfaToken)* | `mfaToken`, `code` (6 digits) or `recoveryCode` | TOTP window ±1 step; recovery code single-use | `200` same as login | `E-STD`; `401 AUTH.MFA_INVALID`; `410 AUTH.MFA_TOKEN_EXPIRED` | `login.success` / `login.fail` | Not required | **Yes** |
| POST | `/api/v1/auth/logout` | End the current session | any | — | session exists | `200 { ok: true }` | `E-STD` | `logout` | Not required | No — single row update |
| GET | `/api/v1/auth/session` | Who am I, what may I do (drives UI hiding only) | any | — | — | `200 { user, roles[], permissions[], scopes, limits, stepUpUntil, breakGlassUntil, settingsVersion }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/auth/password/change` | Change own password | any | `currentPassword`, `newPassword` | ≥12 chars; not in last 5; HIBP k-anonymity check with **offline fallback** (the shop may have no internet); differs from current | `200 { changedAt }` | `E-STD`; `422 AUTH.PASSWORD_POLICY` with per-rule `errors[]`; `401 AUTH.CURRENT_PASSWORD_INVALID` | `password.change` | Not required | **Yes** — hash + history + revoke-other-sessions |
| POST | `/api/v1/auth/mfa/enroll` | Begin TOTP enrolment | any | — | not already enrolled | `200 { secretUri, qrPngDataUrl, recoveryCodes[] }` (codes shown **once**) | `E-STD`; `409 AUTH.MFA_ALREADY_ENROLLED` | `mfa.enrolled` (on confirm) | Not required | **Yes** on confirm |
| POST | `/api/v1/auth/mfa/confirm` | Activate TOTP | any | `code` | valid TOTP for the pending secret | `200 { enrolledAt }` | `E-STD`; `401 AUTH.MFA_INVALID` | `mfa.enrolled` | Not required | **Yes** |
| DELETE | `/api/v1/auth/mfa` | Remove own TOTP | any (blocked for roles where MFA is mandatory) | `password`, `code` | role permits removal — **denied for SYS/OWN/ACC/MGR** (`09` §I.5) | `200` | `E-STD`; `403 AUTH.MFA_MANDATORY` | `mfa.removed` | Not required | **Yes** |
| POST | `/api/v1/auth/step-up` | Re-authenticate for a sensitive action | any | `password` or `code`, `intent` | intent is a declared step-up action | `200 { stepUpUntil }` | `E-STD`; `401` | `stepup.granted` / `stepup.failed` | Not required | No |
| POST | `/api/v1/auth/break-glass` | Time-boxed elevation | MGR ACC (per `09` §I.5) | `code` (MFA), `reason` (≥20 chars), `durationMinutes` ≤60 | MFA valid; reason non-boilerplate; duration ≤ configured max | `200 { breakGlassUntil, grantId }` | `E-STD`; `403 AUTHZ.BREAKGLASS_NOT_PERMITTED`; `422 VALIDATION.REASON_TOO_SHORT` | `breakglass.enable` (**sensitive**, alerts owner) | Not required | **Yes** |
| DELETE | `/api/v1/auth/break-glass` | End elevation early | self | — | active grant | `200` | `E-STD` | `breakglass.end` | Not required | No |
| GET | `/api/v1/auth/sessions` | List my active sessions | any | pagination | — | `200 { data: [{ sessionId, workstation, ip, startedAt, lastSeenAt, isCurrent }] }` | `E-STD` | — | n/a | No |
| DELETE | `/api/v1/auth/sessions/{sessionId}` | Revoke one of my sessions | any (own) | — | session belongs to caller | `200` | `E-READ` | `session.revoked` | Not required | No |

> **`Recommended` migration note.** No password value is ever imported. All 9 legacy users are created with `must_change_password = 1` and a one-time enrolment credential (`09` §I.6 step 5; migration risk MR-3). A migration test asserts the string `Password` from the legacy export appears nowhere in the target database.

## 1.2 Module `access` — users, roles, permissions, scopes, limits

**Replaces:** `Users`, `UserGroups`, `Groups`, `Rights` (483 rows), `GroupRights` (720 rows) and the `GroupAllowed*` scoping family (`Verified`, `09` Parts B–D). Discards `Rightsclone` (2,122), `temp_GroupRights` (6,265) and `UserRights` (0 rows) as `Deprecated` staging (`09` §C.1).

### 1.2.1 Users

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/users` | List users | SYS OWN AUD | `q`, `isActive`, `roleKey`, pagination, sort | declared filters only | `200 { data: [User], meta }` — **never** includes any credential field | `E-STD` | — | n/a | No |
| POST | `/api/v1/users` | Create a user | SYS | `username`, `displayName`, `displayNameUr?`, `email?`, `phone?`, `roleKeys[]`, `warehouseIds[]` | username unique, `[a-z0-9._-]{3,64}`; ≥1 role; email unique where present; role assignment within SYS's own grant set | `201 { user, enrolmentToken }` | `E-WRITE`; `409 USER.USERNAME_TAKEN` | `user.create` (**sensitive**) | Not required (`If-Match` n/a on create; duplicate username is caught by the unique key) | **Yes** — user + role rows + audit |
| GET | `/api/v1/users/{userId}` | Read a user | SYS OWN AUD; self | — | — | `200 { user, roles[], effectivePermissions[], scopes, limits }` | `E-READ` | — | n/a | No |
| PATCH | `/api/v1/users/{userId}` | Edit profile fields | SYS; self (name/phone only) | any of `displayName`, `displayNameUr`, `email`, `phone`, `fatherName`, `address` | `If-Match` required; email unique | `200 { user }` | `E-WRITE` | `user.update` | Not required (`If-Match` guards) | **Yes** |
| POST | `/api/v1/users/{userId}/deactivate` | Disable a login | SYS | `reason` | not the last active SYS; reason ≥10 chars | `200 { user }` | `E-WRITE`; `422 USER.LAST_ADMIN` | `user.deactivate` (**sensitive**) | Required | **Yes** — deactivate + revoke all sessions + audit |
| POST | `/api/v1/users/{userId}/reactivate` | Re-enable | SYS | `reason` | — | `200 { user }` | `E-WRITE` | `user.reactivate` (**sensitive**) | Required | **Yes** |
| POST | `/api/v1/users/{userId}/reset-password` | Issue a one-time credential | SYS | `reason` | target not SYS-self | `200 { enrolmentToken, expiresAt }` — **the admin never sees a password** | `E-WRITE` | `password.reset_by_admin` (**sensitive**) | Required | **Yes** |
| POST | `/api/v1/users/{userId}/force-logout` | Revoke all sessions now | SYS | `reason` | — | `200 { revokedCount }` | `E-WRITE` | `session.revoked` (**sensitive**) | Required | **Yes** |
| PUT | `/api/v1/users/{userId}/roles` | Replace role set | SYS | `assignments[{ roleKey, validFrom?, validTo? }]` | ≥1 role; **union semantics, never `MIN()`** (`09` §I.1 principle 5); `validTo > validFrom`; SYS cannot grant a role it does not hold | `200 { roles[], effectivePermissionsDiff }` | `E-WRITE`; `403 AUTHZ.CANNOT_GRANT_UNHELD_ROLE` | `role.assign` / `role.revoke` (**sensitive**, one row per change) | Required | **Yes** |
| GET | `/api/v1/users/{userId}/activity` | Login and action history | SYS OWN AUD | date range, pagination (keyset) | — | `200 { data: [AuditEvent], meta }` | `E-READ` | — | n/a | No |

### 1.2.2 Roles, permissions, scopes, limits

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/roles` | List roles | SYS OWN AUD | `includeDisabled` | — | `200 { data: [Role] }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/roles` | Create a custom role | SYS | `key`, `name`, `nameUr?`, `description`, `clonedFromRoleKey?` | key unique `[a-z_]{3,32}`; description mandatory (R1.10 plain-language rule applied to admin objects) | `201 { role }` | `E-WRITE`; `409 ROLE.KEY_TAKEN` | `role.create` (**sensitive**) | Required | **Yes** |
| PATCH | `/api/v1/roles/{roleKey}` | Rename / describe / disable | SYS | `name`, `description`, `isEnabled` | `If-Match`; `is_system` roles may be **disabled or renamed, never deleted** (P1.3) | `200 { role }` | `E-WRITE`; `422 ROLE.SYSTEM_ROLE_PROTECTED` | `role.update` (**sensitive**) | Not required | **Yes** |
| GET | `/api/v1/permissions` | The full `resource:action` catalogue | SYS OWN AUD | `resource`, `module` | — | `200 { data: [{ permissionKey, resource, action, description, legacyRightCode, module }] }` — `legacyRightCode` keeps all 486 legacy rights traceable (`09` §I.6 step 2) | `E-STD` | — | n/a | No |
| GET | `/api/v1/roles/{roleKey}/permissions` | Grants for a role | SYS OWN AUD | — | — | `200 { granted: [permissionKey] }` | `E-READ` | — | n/a | No |
| PUT | `/api/v1/roles/{roleKey}/permissions` | Replace grants | SYS | `granted: [permissionKey]`, `reason` | every key exists; **SYS cannot grant a permission it does not itself hold**; reason ≥10 chars | `200 { granted[], diff: { added[], removed[] } }` | `E-WRITE`; `403 AUTHZ.CANNOT_GRANT_UNHELD_PERMISSION` | `permission.grant` / `permission.revoke` (**sensitive**, one row per key) | Required | **Yes** — full replace must be atomic |
| GET / PUT | `/api/v1/roles/{roleKey}/scopes` | Row-level scope set | SYS (PUT), + OWN AUD (GET) | `scopes: [{ scopeType, scopeValues[] }]` — types: `warehouse`, `cash_bank_account`, `price_type`, `supplier_category`, `voucher_category` | every referenced id exists and is enabled | `200 { scopes[] }` | `E-WRITE` | `scope.change` (**sensitive**) | Required (PUT) | **Yes** |
| GET / PUT | `/api/v1/roles/{roleKey}/limits` | Numeric commercial ceilings | SYS (PUT), + OWN AUD (GET) | `limits: [{ limitKey, limitValue }]` — `max_txn_value`, `max_qty`, `max_line_disc_pct`, `max_inv_flat_disc`, `max_price_delta_pct` | decimal string; `>= 0`; percentage ≤ 100 | `200 { limits[] }` | `E-WRITE` | `limit.change` (**sensitive**) | Required (PUT) | **Yes** |
| GET | `/api/v1/access/matrix` | The whole role × resource grid, for owner sign-off | SYS OWN AUD | `format=json\|csv` | — | `200` matrix mirroring `09` §I.4 | `E-STD` | `export` when `format=csv` | n/a | No |
| POST | `/api/v1/access/simulate` | "What could user X do?" dry run | SYS OWN AUD | `userId`, `operations: [{ method, path, sampleBody? }]` | operations exist in the route registry | `200 { results: [{ operation, allowed, denyReason }] }` — **read-only, mutates nothing** | `E-STD` | — | n/a (read-only POST, `x-read-only`) | No |
| POST | `/api/v1/access/migration-diff` | "Under the new roles, user X gains/loses…" | SYS OWN | — | migration snapshot present | `200 { perUser: [{ userId, gained[], lost[] }] }` — the report `09` §I.6 step 4 requires the owner to sign | `E-STD` | `export` | n/a | No |

> **Why `PUT` and not `PATCH` for permission sets (`Recommended`).** A full replace makes the resulting state unambiguous and makes the audit diff trivially correct. Incremental grant/revoke endpoints invite lost updates, which in an access-control system is a security bug rather than a UX annoyance.

## 1.3 Module `platform` — health, jobs, series, backups, feature register

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/health` | Liveness | *(public, unauthenticated)* | — | — | `200 { status: "ok", version, uptimeSeconds }` | `503` when the DB pool is down | — | n/a | No |
| GET | `/api/v1/ready` | Readiness incl. required GL bindings | *(internal)* | — | — | `200 { db, migrations, requiredBindingsSatisfied, fbrReachable }` | `503 PLATFORM.NOT_READY` | — | n/a | No |
| GET | `/api/v1/platform/jobs` | Background job list | SYS OWN AUD | `jobType`, `status`, date range, keyset | — | `200 { data: [SystemJob], meta }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/platform/jobs/{jobId}` | Job detail + download URL when finished | caller who started it, or SYS OWN AUD | — | — | `200 { job, resultUrl?, expiresAt? }` | `E-READ` | — | n/a | No |
| POST | `/api/v1/platform/jobs/{jobType}/run` | Trigger a job manually | SYS | `params?`, `reason` | job type is in the registry and is manually triggerable | `202 { jobId }` | `E-WRITE`; `409 JOB.ALREADY_RUNNING` | `job.trigger` (**sensitive**) | Required | No — enqueue only; the job manages its own transactions |
| POST | `/api/v1/platform/jobs/{jobId}/cancel` | Cancel a queued/running job | SYS | `reason` | job cancellable | `200 { job }` | `E-WRITE` | `job.cancel` | Required | No |
| GET | `/api/v1/platform/doc-series` | Numbering series and current counters | SYS ACC OWN AUD | — | — | `200 { data: [{ seriesCode, documentType, prefix, padWidth, periodReset, nextValue, isGapless }] }` | `E-STD` | — | n/a | No |
| PATCH | `/api/v1/platform/doc-series/{seriesCode}` | Change prefix / padding / reset policy | SYS | `prefix`, `suffix`, `numberLength`, `periodReset`, `reason` | `If-Match`; **`nextValue` is NOT editable through the API** — see note | `200 { series }` | `E-WRITE`; `422 SERIES.COUNTER_NOT_EDITABLE` | `setting.change` (**sensitive**) | Required | **Yes** |
| GET | `/api/v1/platform/backups` | Backup history | SYS OWN AUD | pagination | — | `200 { data: [Backup] }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/platform/backups` | Run a backup now | SYS | `note?` | no backup in progress | `202 { jobId }` | `E-WRITE`; `409 BACKUP.IN_PROGRESS` | `backup.run` (**sensitive**) | Required | No |
| GET | `/api/v1/admin/feature-capabilities` | **D1 register** — every legacy capability and its rebuild status | OWN SYS AUD ACC MGR | `status`, `module` | — | `200 { data: [{ code, name, status: in_scope\|deferred\|excluded\|replaced, legacyTableCount, legacyEvidence, decisionRef, rationale }] }` | `E-STD` | `export` on CSV | n/a | No |
| PATCH | `/api/v1/admin/feature-capabilities/{code}` | Record an owner decision on a deferred vertical | OWN | `status`, `rationale`, `decisionRef` | rationale ≥20 chars | `200 { capability }` | `E-WRITE` | `capability.decision` (**sensitive**) | Required | **Yes** |

> **Why `nextValue` is not editable (`Recommended`).** Editing a live counter is how invoice numbers get re-issued. Seeding happens **once**, at migration, using `GREATEST(_TABMAXKEY, _HeaderTabMaxKey, MAX(actual))+1` — and `_HeaderTabMaxKey` Module 1 = **880,542** is *higher* than `_TABMAXKEY.SaleLedger` = **880,233**, so seeding from the wrong one re-issues **309 already-printed header numbers** (`Verified`, `06` §9 MR-2, Critical). Any post-migration correction is a controlled `platform` job with a written reason, not an API field.

---
---

# PART 2 — CATALOGUE, PRICING, VISIBILITY AND INVENTORY

## 2.1 Module `catalog` — items, categories, manufacturers, generics

**Replaces:** the 148-column `Item` table (30,052 rows, 28,893 active), `ItemCategory` (7), `ItemClass` (12), `Manufacturer` (838), `GenericItem`, `DosageUnit`, `ItemNotes` (30,046), `ItemAlert` (5), `ItemSuppliers` (22,246), `ItemLog` (110,329) (`Verified`, `03` T1-01/T1-18/T1-37/T1-39, `06` §3.1). **D7 binds: all 30,052 items are kept and all are visible by default.**

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/items` | Search / browse the catalogue | all roles (fields vary — see cost note) | `q`, `categoryId`, `classId`, `manufacturerId`, `genericItemId`, `isActive`, `hasStock`, `expiringWithinDays`, `visibilityScope`, **`includeHidden`**, `includeInactive`, pagination, sort | declared filters only (F-1); `visibilityScope ∈ {pos, purchase, reports, stock_list}` | `200 { data: [ItemSummary], meta: { …, hiddenByVisibility } }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/items/lookup` | Typeahead for POS/purchase entry — deliberately narrow and fast | SLS SHF MGR PUR ACC OWN | `q` (≥2 chars), `scope`, `limit` ≤25, `barcode?` | `q` trimmed; barcode exact match short-circuits | `200 { data: [{ itemId, name, packSize, uom, salePrice, availableQty, nearestExpiry, alerts[] }] }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/items` | Create an item | MGR SHF; PUR ◐ *only from a purchase line* | `name`, `nameUr?`, `customCode?`, `categoryId`, `classId?`, `manufacturerId`, `genericItemId?`, `dosageFormId?`, `packUnits`, `uomId`, `barcodes[]?`, `taxCategoryId`, `hsCode?`, `prices[]?`, `reorderLevel?`, `notes?` | name required; `packUnits ≥ 1`; `customCode` unique **absolutely** (a soft-deleted code stays reserved — `19` §4.2); category/manufacturer exist and are enabled; tax category required (blocks the legacy "untaxed by accident" path) | `201 { item }` | `E-WRITE`; `409 ITEM.CODE_TAKEN`; `422 ITEM.PACK_UNITS_INVALID` | `create` on `item` | Required (creates a master record referenced by stock) | **Yes** — item + barcode + price + audit rows |
| GET | `/api/v1/items/{itemId}` | Full item record | all; **cost/margin fields omitted server-side for SLS** | `include=stock,prices,suppliers,alerts,notes` | — | `200 { item, … }` — for SLS the response **has no `avgCost` / `lastPurchaseCost` / `margin` keys at all** | `E-READ` | — | n/a | No |
| PATCH | `/api/v1/items/{itemId}` | Edit item master | MGR SHF; PUR ◐ limited fields | any editable field | `If-Match`; **price fields are rejected here** — repricing has its own endpoint and its own limit (§2.2) | `200 { item }` | `E-WRITE`; `422 ITEM.USE_REPRICE_ENDPOINT` | `update` on `item`, with `changed_fields` | Not required | **Yes** |
| POST | `/api/v1/items/{itemId}/deactivate` | Hide from all workflows without deleting | MGR SYS | `reason` | **no hard delete path exists anywhere in the API (R1.1)** | `200 { item }` | `E-WRITE` | `update` (`isActive` false) | Required | **Yes** |
| GET | `/api/v1/items/{itemId}/history` | Field-level change history | MGR SHF ACC OWN AUD | `field`, date range, keyset | — | `200 { data: [{ changedAt, changedBy, field, oldValue, newValue, sourceModule, sourceDocument }] }` — built on `item_change_log` | `E-READ` | — | n/a | No |
| GET | `/api/v1/items/{itemId}/stock` | On-hand by lot and warehouse | all except SLS-cost | `warehouseId`, `includeZero` | — | `200 { totals, lots: [{ stockLotId, batchNo, expiryDate, expiryStatus, qtyOnHand, qtyAvailable, lotStatus }] }` | `E-READ` | — | n/a | No |
| POST | `/api/v1/items/bulk` | Multi-entry wizard (create/update many) | MGR | `operation`, `rows[]` (≤500), `dryRun` | every row validated independently; `dryRun` returns the full error map without writing | `200` when `dryRun`; `202 { jobId }` otherwise | `E-WRITE`; `422 BULK.ROW_ERRORS` with one `errors[]` entry per failing row+field | `create`/`update` per row, one `bulk_operation_id` | Required | **Yes** per chunk; the job commits in bounded batches and reports partial success explicitly |
| GET/POST/DELETE | `/api/v1/items/{itemId}/barcodes` | Manage barcodes | MGR SHF | `barcode`, `isPrimary` | barcode unique across all items; EAN/UPC checksum validated when the format matches | `200/201` | `E-WRITE`; `409 BARCODE.TAKEN` | `update` on `item_barcode` | Required on write | **Yes** |
| GET/PUT | `/api/v1/items/{itemId}/suppliers` | Preferred suppliers for reordering | MGR PUR | `suppliers[{ supplierId, supplierItemCode?, isPreferred, leadTimeDays? }]` | ≤1 preferred | `200` | `E-WRITE` | `update` | Required | **Yes** |
| GET/PUT | `/api/v1/items/{itemId}/notes` · `/alerts` | Counter-facing notes and warnings | MGR SHF | `text`, `alertTypeId`, `severity`, `showOn` (`sale`, `purchase`, `both`) | text ≤1000 | `200` | `E-WRITE` | `update` | Required | **Yes** |
| GET/POST/PATCH | `/api/v1/item-categories` · `/item-classes` · `/manufacturers` · `/generic-items` · `/dosage-forms` · `/uoms` | Reference data (all pack `LK`) | MGR SYS (write); all (read) | `code`, `name`, `nameUr`, `description`, `isEnabled`, `isDefault`, `sortOrder` | `code` immutable after create; exactly one enabled default per list, enforced by a functional unique index (`19` §4.3) | `200/201 { resource }` | `E-WRITE`; `409 LOOKUP.CODE_TAKEN`; `422 LOOKUP.SYSTEM_ROW_PROTECTED` | `option.enable` / `option.disable` / `update` | Required on write | **Yes** |

> **Cost visibility is enforced by omission, not by hiding (`Recommended`).** `sales_officer` does not hold `item:view_cost`, and the serializer **removes the keys** rather than sending nulls or zeros (`09` §I.4, `17` §8.7). A field a client never receives cannot be revealed by a DevTools inspection — which is the exact failure mode of the legacy client-side rights model (`Verified`, `09` §C.2.1).

## 2.2 Module `pricing` — prices, repricing, resolution

**Replaces:** `PricePolicy` / `PricePolicyDetail` (30,052 rows each) and the five sale-price columns on `Item` (`Verified`, `03` T1-02). `PriceChanges` holds only **8 rows against 110,329 `ItemLog` rows** — price change history is effectively `Broken/Incomplete` today (`Verified`, `09` §G.2).

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/price-types` | The price tiers (retail, trade, …) | all | — | — | `200 { data: [PriceType] }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/items/{itemId}/prices` | Current prices for all tiers | MGR SHF PUR ACC OWN AUD | `effectiveOn?` | — | `200 { data: [{ priceTypeId, price, effectiveFrom, effectiveTo }] }` | `E-READ` | — | n/a | No |
| POST | `/api/v1/items/{itemId}/reprice` | Change one or more sale prices | MGR; SHF ◐ within `max_price_delta_pct` | `prices: [{ priceTypeId, newPrice, effectiveFrom }]`, `reason` | new price `> 0`; **delta vs current ≤ role limit, evaluated inside the transaction**; warn (not block) when `newPrice < avgCost` unless `pricing.allow_below_cost` is on | `200 { item, appliedPrices[], warnings[] }` | `E-WRITE`; `403 AUTHZ.LIMIT_EXCEEDED` with `meta.limitValue`; `422 PRICING.BELOW_COST` (severity `warning` when the setting permits) | `price.change` (**sensitive**, with `amount_impact`) | Required | **Yes** — price row + `item_change_log` + audit |
| POST | `/api/v1/pricing/bulk-reprice` | Percentage or absolute change across a filter | MGR | `filter` (same grammar as `/items`), `changeKind` (`percent`/`absolute`/`set`), `value`, `priceTypeIds[]`, `reason`, `dryRun` | filter must resolve to ≤5,000 items or `422`; limit check applied to the **largest** resulting delta | `200 preview` when `dryRun`, else `202 { jobId, bulkOperationId }` | `E-WRITE`; `422 PRICING.SELECTION_TOO_LARGE` | `price.change` per item, one `bulk_operation_id` | Required | **Yes** per batch |
| POST | `/api/v1/pricing/resolve` | Explain the price a line would get | SLS SHF MGR PUR | `items: [{ itemId, qty, customerId?, priceTypeId?, saleCategoryId? }]` | ≤200 items | `200 { results: [{ itemId, resolvedPrice, priceTypeUsed, trace: [{ rule, effect }] }] }` — the **price resolution trace** `03` T1-02 recommends, so any invoice line can explain itself | `E-STD` | — | n/a (read-only POST) | No |
| GET | `/api/v1/items/{itemId}/price-history` | Step chart data | MGR ACC OWN AUD | date range | — | `200 { data: [{ changedAt, priceTypeId, oldPrice, newPrice, changedBy, reason }] }` | `E-READ` | — | n/a | No |

## 2.3 Module `catalog` — visibility administration (**R1, additive-new**)

`Recommended`, and entirely new — the legacy system has `Item.Active` (28,893 on / 1,159 off, `Verified`) and nothing else. Every endpoint here implements **R1** and honours **R1.1: never delete an item**.

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/visibility/items` | Curation workbench — what is hidden, where, and why | MGR SYS OWN AUD | `scope`, `source`, `q`, pagination | `scope` valid | `200 { data: [{ itemId, name, scope, isVisible, source, changedAt, changedBy, bulkOperationId }], meta: { hiddenCount, visibleCount } }` | `E-STD` | — | n/a | No |
| PUT | `/api/v1/items/{itemId}/visibility` | Set per-scope visibility for one item | MGR SYS | `scopes: [{ scope, isVisible }]`, `reason?` | scope enum; absence of a row means visible (R1.2), so setting `true` deletes the override rather than storing redundancy | `200 { itemId, scopes[] }` | `E-WRITE` | `visibility_change` | Required | **Yes** |
| POST | `/api/v1/admin/visibility/bulk` | Hide/show many items in one audited action | MGR SYS | `filter` or `itemIds[]`, `scopes[]`, `isVisible`, `reason`, `dryRun` | **`dryRun` returns the live affected count before anything happens (R1.5)**; reason ≥10 chars | `200 { affectedCount }` when `dryRun`; else `202 { jobId, bulkOperationId }` | `E-WRITE`; `422 VISIBILITY.SELECTION_TOO_LARGE` (>30,052 is impossible but the guard is explicit) | `visibility_change` with one shared `bulk_operation_id` (R1.8) | Required | **Yes** per batch |
| POST | `/api/v1/admin/visibility/bulk/{bulkOperationId}/undo` | **Single-click undo of a whole bulk action (R1.4)** | MGR SYS | `reason?` | operation exists and is not already undone | `202 { jobId, reversedCount }` | `E-WRITE`; `422 VISIBILITY.ALREADY_UNDONE` | `visibility_change` (`source='bulk_undo'`) | Required | **Yes** |
| GET/POST/PATCH | `/api/v1/admin/visibility/presets` | Saved non-destructive rules (R1.5) | MGR SYS | `code`, `name`, `description`, `scope`, `ruleKind` (`never_stocked`, `no_sales_since`, `zero_stock_no_po`, `manufacturer_discontinued`, `category`, `custom`), `ruleParams`, `isEnabled` | `ruleParams` validated per `ruleKind`; description mandatory (R1.10) | `200/201 { preset }` | `E-WRITE` | `setting.change` | Required on write | **Yes** |
| POST | `/api/v1/admin/visibility/presets/{presetId}/preview` | Live count before enabling | MGR SYS OWN | — | — | `200 { matchedCount, sampleItems[], evaluatedAt }` — **the preset engine has no write path to `item`; this is a query, always** | `E-READ` | — | n/a (read-only POST) | No |
| GET | `/api/v1/admin/visibility/effective/{itemId}` | "Why is this item hidden?" explainer | MGR SYS OWN AUD | `scope` | — | `200 { isVisible, decidedBy: 'is_active'\|'override'\|'preset:<code>'\|'default', explanation }` | `E-READ` | — | n/a | No |

> **R1.7 is an endpoint guarantee, not a UI convention.** Every catalogue-reading endpoint accepts `includeHidden=true`, and every collection reports `meta.hiddenByVisibility`. *Hidden must never mean unreachable* — that is an error-prevention and accessibility requirement (`00b` R1.7), so it is enforced at the API boundary where it cannot be forgotten by a screen.

## 2.4 Module `inventory` — stock, movements, valuation

**Replaces:** `GodownDetail` (6,164 batch rows, destructively updated in place), `StockReport` (3,215,967 rows, no primary key), `PreviousSaleHistory` (94,317) and `LastPurchaseHistory` (9,746) caches, and the five stock-repair procedures whose existence is itself the evidence of the design fault (`Verified`, `03` T1-03, `06` §6.1, `08` §25.1).

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/stock` | On-hand balances | all except SLS-cost | `warehouseId`, `itemId`, `categoryId`, `manufacturerId`, `belowReorder`, `includeZero`, `q`, pagination, sort | scope-filtered by `role_scope.warehouse` | `200 { data: [{ itemId, warehouseId, qtyOnHand, qtyReserved, qtyAvailable, lotCount, nearestExpiry, avgCost?, stockValue? }], meta }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/stock/movements` | The append-only inventory ledger | MGR SHF PUR ACC OWN AUD | `itemId`, `stockLotId`, `warehouseId`, `documentType`, date range, **keyset pagination** | date range ≤ 366 days unless `report.*:export` held | `200 { data: [{ movementId, occurredAt, direction, qtyDelta, unitCost, documentType, docNumber, stockLotId, runningBalance? }], meta: { nextCursor } }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/stock/valuation` | Stock value at a date | MGR ACC OWN AUD | `asOfDate`, `warehouseId`, `groupBy` (`category`, `manufacturer`, `item`) | `asOfDate` not in the future | `200 { asOfDate, totalValue, rows[] }` — uses the single canonical `stock_value` metric (`10` §10.2) | `E-STD` | `export` on CSV | n/a | No |
| POST | `/api/v1/stock/allocations/preview` | FEFO allocation dry run for a basket | SLS SHF MGR PUR | `warehouseId`, `lines: [{ itemId, qty }]` | ≤200 lines | `200 { lines: [{ itemId, allocations: [{ stockLotId, batchNo, expiryDate, qty }], shortfallQty, warnings[] }] }` — **mutates nothing, reserves nothing** | `E-STD`; `422 INVENTORY.INSUFFICIENT_STOCK` only when `strict=true` | — | n/a (read-only POST) | No |
| GET | `/api/v1/stock/snapshots` | Daily snapshot index + heartbeat | SYS ACC OWN AUD | date range | — | `200 { data: [{ snapshotDate, rowCount, generatedAt, status }] }` — **a missed day is visible**, closing the legacy silent-failure risk (`10` §10.1 risk 20) | `E-STD` | — | n/a | No |
| POST | `/api/v1/stock/rebuild-balances` | Rebuild `stock_balance` from `stock_movement` | SYS | `warehouseId?`, `itemId?`, `reason` | reason ≥20 chars; refuses while any financial job is running | `202 { jobId }` | `E-WRITE`; `409 JOB.CONFLICT` | `stock.rebuild` (**sensitive**) | Required | **Yes** per chunk — the projection is rebuilt inside transactions so a crash leaves it consistent |
| GET | `/api/v1/warehouses` | Godowns | all | `includeInactive` | — | `200 { data: [Warehouse] }` — **one row today** (`Verified`, `03` T1-33: multi-godown is structurally impossible at this deployment) | `E-STD` | — | n/a | No |

> **Why there is no `PATCH /stock` (`Recommended`).** Stock is never set; it is moved. Every quantity change enters through a document (sale, purchase, return, adjustment, stock take) so that the reason, the actor, the cost and the ledger consequence exist. The legacy system's in-place `GodownDetail.CurrQty` update is exactly the design that made five repair procedures necessary and that deletes a batch row when it reaches zero, destroying the fact that the lot was ever held (`Verified`, `08` §7.1, §25.1).

## 2.5 Module `inventory` — batches, expiry and recall (**R4, additive-new**)

`Recommended`. **D12/R4 approves real batch and expiry tracking as a Tier-1 feature.** Today "batch" is a `varchar(100)` holding `'.'` on 95.2 % of rows, with only **62 distinct batch values warehouse-wide**, and `2030-12-12` used as a no-expiry sentinel on 5,867 of 6,165 rows (`Verified`, `06` §6.7, `08` §10, business finding F2).

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/stock-lots` | Browse lots | MGR SHF PUR ACC OWN AUD | `itemId`, `batchNo`, `expiryDate.lte/gte`, `expiryStatus`, `lotStatus`, `supplierId`, `warehouseId`, pagination, sort | — | `200 { data: [StockLot], meta }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/stock-lots/{stockLotId}` | Lot detail with full movement history | MGR SHF PUR ACC OWN AUD | — | — | `200 { lot, movements[], sourceDocument, currentQty }` | `E-READ` | — | n/a | No |
| PATCH | `/api/v1/stock-lots/{stockLotId}` | Correct batch number / expiry (the R4.6 resolution workflow) | MGR SHF | `batchNo?`, `expiryDate?`, `expiryStatus`, `reason` | `If-Match`; **`2030-12-12` and the other legacy sentinels are rejected** (`400 VALIDATION.SENTINEL_DATE`); setting `expiryStatus='known'` requires a non-null date; expiry ≥ manufactured date | `200 { lot }` | `E-WRITE`; `422 LOT.EXPIRY_REQUIRED` | `update` on `stock_lot` (**sensitive** — changes what may be sold) | Required | **Yes** |
| POST | `/api/v1/stock-lots/{stockLotId}/hold` | Quarantine a lot | MGR SHF | `holdReasonId`, `reason` | reason option enabled | `200 { lot }` | `E-WRITE` | `lot.hold` | Required | **Yes** |
| POST | `/api/v1/stock-lots/{stockLotId}/release` | Return a lot to `available` | MGR | `reason` | lot is held/quarantined | `200 { lot }` | `E-WRITE` | `lot.release` | Required | **Yes** |
| GET | `/api/v1/expiry/dashboard` | **R4.2** — what expires in 30/60/90/180 days, with value | MGR SHF PUR ACC OWN AUD | `warehouseId`, `buckets[]`, `categoryId` | buckets from `expiry_alert_rule` | `200 { buckets: [{ days, lotCount, qty, costValue, retailValue }], topItems[] }` | `E-STD` | `export` on CSV | n/a | No |
| GET | `/api/v1/expiry/alerts` | Current alert list | MGR SHF PUR OWN | `severity`, `ruleCode`, pagination | — | `200 { data: [{ ruleCode, severity, stockLotId, itemName, expiryDate, qty, daysRemaining }] }` | `E-STD` | — | n/a | No |
| GET/POST/PATCH | `/api/v1/expiry/alert-rules` | Configure thresholds (P1 — options, not code) | MGR SYS | `code`, `name`, `daysBeforeExpiry`, `appliesToCategoryId?`, `severity`, `notifyRoles[]`, `notifyBySms`, `isEnabled` | `daysBeforeExpiry` 1–1095; role keys exist | `200/201 { rule }` | `E-WRITE` | `setting.change` | Required on write | **Yes** |
| GET | `/api/v1/expiry/unknown-queue` | **R4.6** — lots whose expiry is unknown, as a work queue | MGR SHF | `warehouseId`, `hasStock`, pagination | — | `200 { data: [Lot], meta: { totalUnknown } }` — migration is expected to land **6,106 of 6,164 rows** here (`Verified` estimate, `08` §28.3) | `E-STD` | — | n/a | No |
| POST | `/api/v1/expiry/write-off` | Turn expired lots into a posted stock decrease | MGR (approval per threshold) | `stockLotIds[]`, `adjustmentReasonId` (must be an expiry reason), `reason`, `documentDate` | every lot has stock; reason's `gl_account_id` is `NOT NULL` by schema, so the posting always has a home | `201 { stockAdjustment }` | `E-FIN`; `422 INVENTORY.LOT_EMPTY` | `create` + `document.post` on `stock_adjustment` | **Required** | **Yes** — stock movements + GL journal + audit in one transaction |
| GET | `/api/v1/recall/trace` | **R4.5** — full trace for a batch: who supplied it, which invoices sold it | MGR OWN ACC AUD | `batchNo` or `stockLotId`, `itemId?` | at least one identifier | `200 { lots[], inbound: [{ purchaseInvoice, supplier, qty, receivedOn }], outbound: [{ saleInvoice, docNumber, soldAt, qty, customer }] , remainingQty }` | `E-READ` | `export` on CSV | n/a | No |

> **The expired-stock guardrail is a setting, not a hard rule (`Recommended`, P1).** `inventory.expiry.expired_sale_action ∈ {warn, block, allow}`, default **block** for already-expired and **warn** for near-expiry, with permission `sale.expired_stock:override` and an `audit_event` on every use (`19` §T66). A blocked line returns `422 INVENTORY.LOT_EXPIRED` with `severity: "error"`; a warned line returns `200` with `warnings[]` carrying `severity: "warning"` so the cashier acknowledges rather than being stopped.

## 2.6 Module `inventory` — adjustments and stock takes

**Replaces:** `AdjHeader` (1,542) / `AdjDetail` (11,181) and `AdjBufferHeader` (1,061) / `AdjBufferDetail` (12,270) (`Verified`, `08` §13). Three `Verified` defects are fixed at the API boundary: **100 % of legacy adjustments are silently excluded from the GL** because `AdjHeader.AccCode IS NULL` on all 1,542 rows (`07` §13.3, `Broken/Incomplete`); there is **no reason dimension** beyond INCREASE/DECREASE plus free text (`08` §4.2); and there is **no approval step at all** — `sp_PostStockAdjustment` writes `Posted='Y'` immediately (`08` §28.5).

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/stock-adjustments` | List adjustments | MGR SHF ACC OWN AUD | `direction`, `status`, `adjustmentReasonId`, date range, `createdBy`, pagination | — | `200 { data: [Adjustment], meta }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/stock-adjustments` | Create a draft adjustment | MGR SHF | `direction`, `adjustmentReasonId`, `documentDate`, `warehouseId`, `updateAvgCost`, `notes`, `lines: [{ itemId, stockLotId, qty, unitCost?, notes? }]` | ≥1 line; `qty > 0`; **`stockLotId` mandatory on every line** (legacy adjustments all land in the `'.'` batch); reason enabled and direction-compatible; decrease lines cannot exceed lot quantity; reason requiring a note has one | `201 { adjustment }` | `E-FIN`; `422 INVENTORY.INSUFFICIENT_LOT_QTY`; `422 ADJUSTMENT.REASON_DIRECTION_MISMATCH` | `create` | **Required** | **Yes** — header + lines |
| PATCH | `/api/v1/stock-adjustments/{id}` | Edit a draft | MGR SHF (creator or MGR) | as create | `If-Match`; `status='draft'` only | `200 { adjustment }` | `E-WRITE`; `422 DOC.NOT_DRAFT` | `update` | Required | **Yes** |
| POST | `/api/v1/stock-adjustments/{id}/approve` | Approve above the value threshold | MGR (never the creator) | `reason` | **approver ≠ creator**; `totalCostAmount` above `document_type.approval_threshold_amount` requires this step | `200 { adjustment }` | `E-FIN`; `422 APPROVAL.SELF_APPROVAL_FORBIDDEN` | `approve` (**sensitive**, `amount_impact`) | **Required** | **Yes** |
| POST | `/api/v1/stock-adjustments/{id}/post` | Move stock and post the GL | MGR SHF ◐ below threshold | `postingDate?` | approval present when required; period open; every lot still has the quantity; **reason's GL account resolved and non-null** | `200 { adjustment, journalEntry, movements[] }` | `E-FIN`; `422 PERIOD.CLOSED`; `422 INVENTORY.INSUFFICIENT_LOT_QTY`; `422 LEDGER.BINDING_MISSING` | `document.post` (`amount_impact`) | **Required** | **Yes** — counter → stock_balance → cost → journal, in the fixed lock order (T-4) |
| POST | `/api/v1/stock-adjustments/{id}/cancel` | Void an unposted adjustment | MGR | `cancelReasonId`, `reason` | not posted | `200 { adjustment }` | `E-FIN` | `document.cancel` | **Required** | **Yes** |
| POST | `/api/v1/stock-adjustments/{id}/reverse` | Reverse a posted adjustment | MGR ◐ break-glass; ACC | `reason`, `postingDate` | posted; target period open; **creates a reversing document, never edits the original** | `201 { reversal }` | `E-FIN`; `422 PERIOD.CLOSED` | `document.reverse` (**sensitive**) | **Required** | **Yes** |
| GET/POST/PATCH | `/api/v1/adjustment-reasons` | The reason taxonomy (P1) | MGR SYS | `code`, `name`, `description`, `direction`, **`glAccountId` (required)**, `requiresApproval`, `approvalThresholdAmount`, `requiresNote`, `affectsShrinkageKpi`, `isEnabled`, `isDefault` | **`glAccountId` is `NOT NULL`** — an adjustment that cannot post cannot be saved; account must be postable | `200/201 { reason }` | `E-WRITE`; `422 LOOKUP.GL_ACCOUNT_REQUIRED` | `option.*` / `setting.change` | Required on write | **Yes** |
| GET | `/api/v1/stock-takes` · POST | Physical count sessions | MGR SHF | `countScope`, `scopeFilter`, `captureExpiry`, `warehouseId`, `documentDate` | scope filter valid | `201 { stockTake, expectedLineCount }` | `E-WRITE` | `create` | Required | **Yes** |
| PUT | `/api/v1/stock-takes/{id}/lines` | Submit counted quantities (batched) | MGR SHF | `lines: [{ itemId, stockLotId?, qtyCounted, capturedBatchNo?, capturedExpiryDate? }]`, `isFinalBatch` | qty ≥ 0; ≤1,000 lines per call; **`capturedExpiryDate` rejects sentinels** | `200 { acceptedCount, varianceSummary }` | `E-WRITE` | `update` | Required | **Yes** per batch |
| GET | `/api/v1/stock-takes/{id}/variance` | Variance before committing | MGR SHF ACC OWN | `minVarianceQty` | — | `200 { lines: [{ itemId, qtySystem, qtyCounted, qtyVariance, costImpact }], totals }` | `E-READ` | — | n/a | No |
| POST | `/api/v1/stock-takes/{id}/generate-adjustments` | Turn variance into an increase + a decrease document | MGR | `adjustmentReasonId`, `reason` | reason is a count-correction reason; take not already generated | `201 { increaseAdjustment?, decreaseAdjustment? }` | `E-FIN`; `422 STOCKTAKE.ALREADY_GENERATED` | `create` ×2 | **Required** | **Yes** — both documents in one transaction, or neither |
| POST | `/api/v1/stock-takes/{id}/close` | Close the count | MGR | `reason?` | adjustments generated or explicitly waived | `200 { stockTake }` | `E-WRITE` | `document.post` | Required | **Yes** |
| GET | `/api/v1/stock-takes/{id}/count-sheet` | Printable blind count sheet | MGR SHF | `format`, `hideSystemQty` (default **true**) | — | `200` PDF/A4 | `E-READ` | `print` | n/a | No |

---
---

# PART 3 — SALES, POS AND CUSTOMERS

## 3.1 Module `sales` — sale invoices

**Replaces:** `SaleLedger` (291,361 rows, **148 columns**, ~55 of which belong to hospital/hotel/school/vehicle verticals referencing empty tables) and `Saledetail` (620,525 rows, **no primary key at all**), plus `sp_PostSaleLedger` and `SP_STOCKLEDGER` (`Verified`, `03` T1-08, `05a`, `06` §6.1, §6.8 L2). Volume baseline: ~540 invoices/trading day, ~2.1 lines/invoice, average value ≈ 803 PKR (`Verified`, `06a` §2).

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| POST | `/api/v1/sales/preview` | Price, tax, stock and expiry dry run for a basket — **no writes** | SLS SHF MGR | `warehouseId`, `customerId?`, `saleCategoryId`, `lines: [{ itemId, qty, unitPriceOverride?, discountPercent? }]`, `invoiceDiscountPercent?`, `invoiceDiscountAmount?` | ≤200 lines; qty `> 0`; discount ≤ role limit **(checked here so the cashier learns before saving)** | `200 { lines: [{ …resolvedPrice, allocations[], lineTax, lineTotal, warnings[] }], gross, lineDiscount, invoiceDiscount, net, salesTax, fbrPosFee, rounding, invoiceTotal }` | `E-STD`; `422 INVENTORY.INSUFFICIENT_STOCK` (only when `strict=true`) | — | n/a (read-only POST, `x-read-only`) | No |
| POST | `/api/v1/sale-invoices` | Create a sale invoice (draft or posted in one step) | SLS SHF MGR | `documentDate`, `warehouseId`, `customerId`, `saleCategoryId`, `salesmanId?`, `cashierShiftId?`, `lines[]`, `invoiceDiscountPercent?`, `invoiceDiscountAmount?`, `payments: [{ paymentMethodId, cashBankAccountId, amount, referenceNo?, cardLast4? }]`, `postImmediately` (default **true**), `notes?`, `removedLines[]?` | ≥1 line; every line resolves to sufficient stock **inside the transaction**; discounts within `max_line_disc_pct` / `max_inv_flat_disc`; total within `max_txn_value`; `Σ payments ≥ invoiceTotal` when posting a cash sale (**D5**); period open; expired lots handled per the guardrail setting | `201 { saleInvoice, journalEntry?, fbrStatus, allocations[], changeAmount }` | `E-FIN`; `422 INVENTORY.INSUFFICIENT_STOCK`; `422 INVENTORY.LOT_EXPIRED`; `422 SALES.PAYMENT_SHORT`; `403 AUTHZ.LIMIT_EXCEEDED` | `create` + `document.post` (`amount_impact = invoiceTotal`) | **Required** | **Yes** — the canonical sale commit: validate → allocate lots FEFO → decrement `stock_balance` (`FOR UPDATE`, PK order) → write `stock_movement` → compute COGS → write `journal_entry`+lines → allocate `doc_number` **last** → enqueue FBR outbox row |
| GET | `/api/v1/sale-invoices` | List / search invoices | SLS ◐ own shift; SHF MGR ACC OWN AUD | `docNumber`, `q`, `status`, `customerId`, `cashierShiftId`, `createdBy`, `saleCategoryId`, date range, `minTotal`, `maxTotal`, keyset pagination | date range required beyond 90 days unless `report:export` held | `200 { data: [SaleInvoiceSummary], meta }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/sale-invoices/{id}` | Full invoice with lines, payments, FBR state | SLS ◐ own shift; SHF MGR ACC OWN AUD | `include=lines,payments,fbr,journal,allocations` | — | `200 { invoice, lines[], payments[], fbr, journalEntry?, removedLines? }` | `E-READ` | — | n/a | No |
| PATCH | `/api/v1/sale-invoices/{id}` | Edit a **draft** invoice | SLS ◐ own shift; SHF MGR | as create | `If-Match`; `status='draft'` only | `200 { saleInvoice }` | `E-WRITE`; `422 DOC.NOT_DRAFT` | `update` | Required | **Yes** |
| POST | `/api/v1/sale-invoices/{id}/post` | Post a draft | SLS SHF MGR | `postingDate?` | period open; stock still available; limits re-checked | `200 { saleInvoice, journalEntry }` | `E-FIN`; `422 PERIOD.CLOSED`; `422 DOC.ALREADY_POSTED` | `document.post` | **Required** | **Yes** |
| POST | `/api/v1/sale-invoices/{id}/cancel` | Void an invoice, **keeping its number** | SHF MGR; SLS ◐ same shift, unposted | `cancelReasonId`, `reason` | reason option enabled; if posted, requires the reverse path instead | `200 { saleInvoice }` | `E-FIN`; `422 DOC.POSTED_USE_REVERSE` | `document.cancel` (**sensitive**) | **Required** | **Yes** |
| POST | `/api/v1/sale-invoices/{id}/reverse` | Reverse a posted invoice with a compensating document | MGR ◐ break-glass; ACC | `reason`, `postingDate` | posted; target period open | `201 { reversal }` | `E-FIN`; `422 PERIOD.CLOSED` | `document.reverse` (**sensitive**, `amount_impact`) | **Required** | **Yes** — stock returns, GL reverses, FBR credit note enqueued |
| GET | `/api/v1/sale-invoices/{id}/print` | Render the receipt | SLS SHF MGR ACC OWN | `format` (from the `doc_print_format` option list), `copies?` | format enabled | `200` PDF or ESC/POS payload, with the FBR QR when fiscalised | `E-READ` | `print` | n/a | No |
| POST | `/api/v1/sale-invoices/{id}/reprint` | Audited duplicate | SHF MGR | `reason` | — | `200` document | `E-READ` | `print` (**flagged duplicate**) | Required | No |
| POST | `/api/v1/sales/removed-lines` | Record lines the cashier removed **before** saving | SLS SHF MGR | `sessionRef`, `lines: [{ itemId, qty, unitPrice, removalStage, removalReasonId? }]` | ≤50 lines per call | `202 { recordedCount }` | `E-STD` | `update` on `sale_line_removed` | Not required (append-only telemetry; duplicates are harmless and dated) | No — single insert batch |
| GET | `/api/v1/sales/removed-lines` | The deleted-line exception grid | SHF MGR OWN AUD | `itemId`, `removedBy`, date range, `removalStage`, keyset | — | `200 { data, meta }` | `E-STD` | — | n/a | No |

> **`Verified` context for `removed-lines`.** `DeletedSaleItem` holds **235,887 rows against 291,361 invoices** in a heap with **no index of any kind**, so the question "is this normal POS correction or a workflow problem?" has never been answerable (`06` §3.1, §6.2, §10 V8). Here the data is indexed by invoice, user and item, which makes it a control report rather than dead weight.

> **Why COGS is stored, not recomputed (`Recommended`).** The legacy system computes cost of sale and then **discards it**, because the GL fan-out is gated on periodic-inventory mode (`Verified`, `07` §10.4). `cogs_amount` is therefore written on the invoice and posted, which is what makes a trustworthy gross-profit statement possible (R2.5).

## 3.2 Module `sales` — sale returns

**Replaces:** `SRLedger` (30,704 rows, **all `SRCatCode = 8`**) / `SRdetail` (44,563) and `sp_PostSRLedger` (`Verified`, `03` T1-10, `07` §13.1).

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/sale-returns` | List returns | SLS ◐ own; SHF MGR ACC OWN AUD | `docNumber`, `saleInvoiceId`, `status`, date range, keyset | — | `200 { data, meta }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/sale-returns/lookup-invoice` | Find the original invoice to return against | SLS SHF MGR | `docNumber` or `fiscalInvoiceNo` or `barcode` | one identifier | `200 { invoice, lines: [{ …, qtyAlreadyReturned, qtyReturnable }] }` | `E-READ` | — | n/a (read-only POST) | No |
| POST | `/api/v1/sale-returns` | Create a return | SLS SHF MGR | `documentDate`, `warehouseId`, `saleInvoiceId?`, `customerId`, `saleCategoryId`, `refundMethodId`, `cashBankAccountId`, `lines: [{ saleInvoiceLineId?, itemId, stockLotId, qty, unitPrice, costBasis }]`, `reason` | **`qty ≤ original qty − already returned`** when linked; `stockLotId` mandatory; `costBasis` explicit on every line; refund method enabled; period open | `201 { saleReturn, journalEntry, fbrStatus }` | `E-FIN`; `422 SALES.RETURN_EXCEEDS_ORIGINAL`; `422 SALES.RETURN_WINDOW_EXPIRED` (when the setting is configured) | `create` + `document.post` | **Required** | **Yes** — stock in, GL, refund leg, FBR credit-note outbox |
| POST | `/api/v1/sale-returns/{id}/cancel` · `/reverse` | Void / reverse | SHF MGR ACC | `reason` | as for invoices | `200/201` | `E-FIN` | `document.cancel` / `document.reverse` | **Required** | **Yes** |

> **A `Verified` accounting defect surfaced rather than inherited.** A sale return **not linked** to an original invoice is valued at its discounted **selling** price rather than at cost — booking zero margin on the return (`07` §13.1, `08` §5.3, "economically wrong"). The API therefore makes `costBasis ∈ {original_cost, current_avg, sale_price_estimate}` an **explicit, required field on every return line**, reportable and auditable. **The correct default requires accountant sign-off** (Part 9, V-5).

## 3.3 Module `sales` — POS surface

`Recommended`. The POS is not a different API; it is a **thin, latency-optimised composition** over the same resources, plus one deliberate verb endpoint.

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/pos/bootstrap` | One payload the till caches: visible catalogue slice, prices, options, permissions, printer profile, settings version | SLS SHF MGR | `warehouseId`, `since?` (delta sync), `scope=pos` | — | `200 { items[], priceTypes[], paymentMethods[], saleCategories[], settings, permissions[], settingsVersion, etag }` + strong `ETag` | `E-STD` | — | n/a | No |
| POST | `/api/v1/sales/checkout` | **The single atomic POS transaction**: create + post + tender + fiscalize-enqueue + print payload | SLS SHF MGR | as `POST /sale-invoices` with `postImmediately: true`, plus `tendered`, `printFormat` | all sale-invoice validations; `Σ payments ≥ invoiceTotal`; open cashier shift required when `cashier.require_shift` is on | `201 { saleInvoice, changeAmount, printPayload, fbrStatus: "queued"\|"fiscalized"\|"deferred" }` | `E-FIN`; `422 SALES.SHIFT_REQUIRED`; `422 INVENTORY.INSUFFICIENT_STOCK` | `create` + `document.post` | **Required** | **Yes** — this is the transaction script of `17` §7.2 |
| GET | `/api/v1/pos/held-sales` · POST · DELETE | Park and resume a basket (server-side, so a till crash does not lose it) | SLS SHF MGR | `basketJson`, `label` | ≤50 held baskets per till | `200/201` | `E-WRITE` | — | Not required | No — draft storage only, no stock effect |
| GET | `/api/v1/sale-templates` · POST · PATCH | Repeat-prescription templates | SLS SHF MGR | `code`, `name`, `customerId?`, `lines[]` | ≤100 lines | `200/201 { template }` | `E-WRITE` | `create`/`update` | Required on write | **Yes** |
| POST | `/api/v1/sale-templates/{id}/instantiate` | Load a template into a basket (prices re-resolved **now**) | SLS SHF MGR | `warehouseId`, `qtyMultiplier?` | template active | `200 { lines[], warnings[] }` — a template never carries stale prices | `E-READ` | — | n/a (read-only POST) | No |

> **Why one composite `checkout` endpoint is justified (`Recommended`).** N-7 bans verbs in collection paths; this is the exception because splitting checkout into create → post → tender would put a user interaction between the stock lock and the commit, violating T-5 and reproducing the legacy key-wastage pattern. One request, one transaction, one idempotency key.

> **Offline behaviour (`Recommended`).** `/pos/bootstrap` makes the till able to *display and price* without the server, but **no sale is ever committed offline**. Committing offline would require client-side document numbering and client-side stock decrement — the two things that produce duplicate invoice numbers and negative stock. If the server is unreachable, the till shows a clear, non-modal banner and queues nothing (`17` §8.11).

## 3.4 Module `sales` — customers and sale categories

**Context (`Verified`):** `Customer` holds **2 rows**; the shop is a walk-in cash business (**D5**), so there is **no accounts receivable**. The resource exists because D9/P1 forbids hard-coding "there will only ever be walk-in cash".

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/customers` | List customers | SLS SHF MGR ACC OWN AUD | `q`, `isActive`, `categoryId`, pagination | — | `200 { data, meta }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/customers` | Create | SHF MGR | `name`, `nameUr?`, `phone?`, `address?`, `customerCategoryId`, `ntn?`, `cnic?`, `creditLimit?` | name required; CNIC 13 digits when present; **credit fields hidden unless `customer.credit` option is enabled** (currently off per D5) | `201 { customer }` | `E-WRITE` | `create` | Required | **Yes** |
| PATCH | `/api/v1/customers/{id}` | Edit | SHF MGR | editable fields | `If-Match` | `200 { customer }` | `E-WRITE` | `update` | Not required | **Yes** |
| GET | `/api/v1/customers/{id}/ledger` | Statement | ACC MGR OWN AUD | date range, keyset | — | `200 { openingBalance, lines[], closingBalance }` — **opening balance is 0.0000 at cutover per D10/R3.1** | `E-READ` | `export` on CSV | n/a | No |
| GET/POST/PATCH | `/api/v1/sale-categories` | The sale-type taxonomy (P1) | MGR SYS | `code`, `name`, `description`, `counterparty` (`cash` \| `customer_account`), `defaultCashAccountId`, `isReturn`, `affectsStock`, `isEnabled`, `isDefault` | exactly one enabled default; `counterparty='customer_account'` requires the credit option enabled | `200/201 { category }` | `E-WRITE` | `option.*` | Required on write | **Yes** |

> **`counterparty` as data, not code (`Recommended`, P1.1).** The legacy rule is the literal "`SaleCatCode` 1 or 3 → debit `CashAccCode`; else debit `CustCode`" inside a stored procedure (`Verified`, `07` §4.1). Here it is a column on `sale_category`, so adding a sale type is an `INSERT`, not a deployment.

---
---

# PART 4 — PURCHASING AND SUPPLIERS

## 4.1 Module `purchasing` — suppliers

**Replaces:** `Supplier` (235 rows) and `ItemSuppliers` (22,246) (`Verified`, `03` T1-17). **F1.1 is the governing finding:** suppliers have been credited **186,197,682 PKR** and debited only **3,526,552**, and *every one of those debits is a purchase return, not a payment* — so the 182.6 M "owed" is fiction and all supplier balances start at **zero** at cutover (**D10/R3**, `Verified`, `00b` F1.1).

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/suppliers` | List | PUR MGR ACC OWN AUD | `q`, `isActive`, `categoryId`, `hasOpenBalance`, pagination, sort | scope-filtered by `supplier_category` scope | `200 { data, meta }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/suppliers` | Create | PUR MGR | `name`, `nameUr?`, `supplierCategoryId`, `phone?`, `email?`, `address?`, `ntn?`, `strn?`, `paymentTermsDays?`, `glAccountId?` | name required; NTN format when present; category enabled | `201 { supplier }` | `E-WRITE`; `409 SUPPLIER.NAME_TAKEN` | `create` | Required | **Yes** — supplier + its control-account link |
| PATCH | `/api/v1/suppliers/{id}` | Edit | PUR MGR | editable fields | `If-Match` | `200 { supplier }` | `E-WRITE` | `update` | Not required | **Yes** |
| POST | `/api/v1/suppliers/{id}/deactivate` | Retire without deleting | MGR | `reason` | no open documents, or `force` + reason | `200 { supplier }` | `E-WRITE`; `422 SUPPLIER.HAS_OPEN_DOCUMENTS` | `update` | Required | **Yes** |
| GET | `/api/v1/suppliers/{id}/ledger` | Account statement | PUR MGR ACC OWN AUD | date range, keyset | — | `200 { openingBalance: "0.0000", lines[], closingBalance }` | `E-READ` | `export` | n/a | No |
| GET | `/api/v1/suppliers/{id}/aging` | Aged payables | ACC MGR OWN AUD | `asOfDate`, `buckets[]` | — | `200 { buckets[], total }` — **meaningful only after R2.1 payments exist**; before that every invoice ages forever, which the response states explicitly in `meta.caveat` | `E-READ` | `export` | n/a | No |
| GET/POST/DELETE | `/api/v1/suppliers/{id}/bank-accounts` | Payment destinations | ACC MGR | `bankName`, `accountNo`, `iban`, `title` | IBAN checksum when present | `200/201` | `E-WRITE` | `update` (**sensitive** — changes where money goes) | Required on write | **Yes** |
| GET | `/api/v1/suppliers/{id}/items` | What we buy from them | PUR MGR | pagination | — | `200 { data, meta }` | `E-READ` | — | n/a | No |
| GET/POST/PATCH | `/api/v1/supplier-categories` | Options-as-data (P1) | MGR SYS | pack `LK` fields | one enabled default | `200/201` | `E-WRITE` | `option.*` | Required on write | **Yes** |

## 4.2 Module `purchasing` — purchase orders

**Replaces:** `PurOrderHeader` (2,810) / `PurOrderDetail` (108,423) (`Verified`, `03` T1-06, `06a` §2).

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/purchase-orders` | List POs | PUR SHF MGR ACC OWN AUD | `supplierId`, `orderStatus`, date range, `hasOutstanding`, pagination | — | `200 { data, meta }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/purchase-orders` | Create a PO | PUR SHF MGR SLS | `supplierId`, `documentDate`, `expectedDate?`, `warehouseId`, `lines: [{ itemId, qtyOrdered, unitPrice?, expectedDate? }]`, `notes?` | ≥1 line; `qtyOrdered > 0`; supplier active | `201 { purchaseOrder }` | `E-WRITE` | `create` | Required (a PO is not financial, but duplicate POs cause duplicate deliveries) | **Yes** — header + lines |
| PATCH | `/api/v1/purchase-orders/{id}` | Edit an open PO | PUR SHF MGR | as create | `If-Match`; `orderStatus='open'`; cannot reduce a line below `qtyReceived` | `200 { purchaseOrder }` | `E-WRITE`; `422 PO.BELOW_RECEIVED_QTY` | `update` | Required | **Yes** |
| POST | `/api/v1/purchase-orders/{id}/close` · `/cancel` | Close short / cancel | PUR MGR | `reason` | not already closed | `200 { purchaseOrder }` | `E-WRITE` | `document.cancel` | Required | **Yes** |
| POST | `/api/v1/purchase-orders/suggest` | Reorder proposal from stock, sales velocity and lead time | PUR MGR | `warehouseId`, `supplierId?`, `coverDays`, `categoryId?`, `includeZeroSales` | `coverDays` 1–365 | `200 { lines: [{ itemId, onHand, avgDailySales, daysOfCover, suggestedQty, preferredSupplier, lastPurchasePrice }] }` — uses the canonical `days_of_cover` metric (`10` §10.2) | `E-STD` | `export` | n/a (read-only POST) | No |
| GET | `/api/v1/purchase-orders/{id}/receipts` | What has been received against it | PUR MGR ACC AUD | — | — | `200 { data: [{ purchaseInvoiceId, docNumber, receivedOn, lines[] }] }` | `E-READ` | — | n/a | No |

## 4.3 Module `purchasing` — goods receipt / purchase invoice

**Replaces:** `Purledger` (6,417 rows, **100 columns** including 20 unlabelled `QE*`/`WE*` account slots whose purpose is `Unclear`) / `Purdetail` (113,082) and `SP_STOCKLEDGER`'s purchase branch (`Verified`, `03` T1-05, `06` §6.8 L3, `07` §4.2). 99.6 % of legacy purchases are `Normal Purchase Credit` (6,396 invoices, `Verified`).

`Recommended` design decision: **goods receipt and supplier invoice are one document with two timestamps**, not two documents. The shop receives and invoices in the same act (`Strongly Inferred` from the absence of any GRN table and the 1:1 `Purledger`↔delivery pattern). A separate GRN is a P1 option (`purchase.separate_grn`, default **off**) that, when enabled, splits the flow — but it is not built into the base path where it would add a step nobody performs.

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| POST | `/api/v1/purchase-invoices/preview` | Cost, tax and margin dry run before saving | PUR SHF MGR | `supplierId`, `purchaseCategoryId`, `lines[]`, `charges[]` | ≤500 lines | `200 { lines: [{ landedUnitCost, newAvgCost, currentSalePrice, resultingMarginPct, warnings[] }], totals }` | `E-STD` | — | n/a (read-only POST) | No |
| POST | `/api/v1/purchase-invoices` | Create a purchase / goods receipt | PUR SHF MGR | `supplierId`, `supplierInvoiceNo`, `documentDate`, `warehouseId`, `purchaseCategoryId`, `purchaseOrderId?`, `lines: [{ itemId, batchNo?, expiryDate?, expiryStatus, qtyPack, qtyLoose, packUnits, unitCost, bonusQty?, discountPercent?, taxCategoryId, salePrice? }]`, `charges: [{ chargeTypeId, amount, debitAccountId, creditAccountId, allocationBasis, includeInCost }]`, `notes?` | ≥1 line; `supplierInvoiceNo` unique per supplier (`409` otherwise — the legacy has no such guard); **`expiryDate` sentinel-rejected**; `qty > 0`; `unitCost ≥ 0`; category's `qtyBasis` decides pack vs loose interpretation; period open | `201 { purchaseInvoice, lotsCreated[], costChanges[] }` | `E-FIN`; `409 PURCHASE.DUPLICATE_SUPPLIER_INVOICE`; `422 PURCHASE.PO_QTY_EXCEEDED` | `create` | **Required** | **Yes** — header + lines + **lot creation** + stock movements (on post) |
| PATCH | `/api/v1/purchase-invoices/{id}` | Edit a draft | PUR SHF MGR | as create | `If-Match`; draft only | `200 { purchaseInvoice }` | `E-WRITE`; `422 DOC.NOT_DRAFT` | `update` | Required | **Yes** |
| POST | `/api/v1/purchase-invoices/{id}/post` | Receive stock and post the GL | **MGR SHF only — `purchase_officer` cannot post (separation of duties)** | `postingDate?` | period open; **poster ≠ creator when `purchase.require_segregation` is on (default on)**; charges balance; every line's landed cost resolvable | `200 { purchaseInvoice, journalEntry, movements[], newAvgCosts[] }` | `E-FIN`; `403 AUTHZ.SEGREGATION_OF_DUTIES`; `422 PERIOD.CLOSED`; `422 LEDGER.BINDING_MISSING` | `document.post` (`amount_impact`) | **Required** | **Yes** — lots → stock movements → moving-average cost snapshot → journal → number allocation |
| POST | `/api/v1/purchase-invoices/{id}/cancel` · `/reverse` | Void / reverse | MGR ACC ◐ break-glass | `cancelReasonId`, `reason` | reverse only when posted; period open | `200/201` | `E-FIN` | `document.cancel` / `document.reverse` (**sensitive**) | **Required** | **Yes** |
| GET | `/api/v1/purchase-invoices` · `/{id}` | List / read | PUR SHF MGR ACC OWN AUD | filters as elsewhere; `include=lines,charges,journal,lots` | — | `200` | `E-READ` | — | n/a | No |
| GET/POST/DELETE | `/api/v1/purchase-invoices/{id}/charges` | Freight, handling and other landed costs | PUR MGR ACC | `chargeTypeId`, `amount`, `debitAccountId`, `creditAccountId`, `allocationBasis`, `includeInCost` | draft only; both accounts postable | `200/201` | `E-WRITE` | `update` | Required | **Yes** |
| GET/POST/PATCH | `/api/v1/purchase-categories` | Options-as-data (P1) | MGR SYS ACC | `code`, `name`, `qtyBasis` (`pack`\|`loose`), `counterparty` (`supplier`\|`equity`\|`customer`), `isReturn`, `isOpening`, `isEnabled`, `isDefault` | one enabled default | `200/201` | `E-WRITE` | `option.*` | Required on write | **Yes** |

> **`includeInCost` is a required decision, not a default (`Recommended`).** Whether a freight or handling charge lands in inventory cost or straight to expense **materially changes gross profit**, and the legacy schema never records the choice — it hides in 20 unlabelled account columns (`Verified`, `06` §6.8 L3). The field is mandatory on every charge row and **requires accountant sign-off on its default** (Part 9, V-6).

## 4.4 Module `purchasing` — purchase returns

**Replaces:** `PRLedger` (634) / `PRdetail` (2,481) (`Verified`, `03` T1-07). `Verified` open question: the purchase-return counter stands at 2,122 against 634 surviving documents — **1,488 numbers consumed by documents that no longer exist** (`06` §10 V6), which is itself the argument for N-3 (cancelled documents keep their number and are never deleted).

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| POST | `/api/v1/purchase-returns` | Return goods to a supplier | PUR SHF MGR | `supplierId`, `purchaseInvoiceId?`, `documentDate`, `warehouseId`, `purchaseCategoryId`, `reasonId`, `creditNoteNo?`, `lines: [{ purchaseInvoiceLineId?, itemId, stockLotId, qty, unitCost }]` | **`stockLotId` mandatory** — returning to a supplier must name the lot, which is what makes the near-expiry supplier-return workflow of R4.2 possible; `qty ≤ lot on-hand`; `qty ≤ received − already returned` when linked | `201 { purchaseReturn }` | `E-FIN`; `422 INVENTORY.INSUFFICIENT_LOT_QTY`; `422 PURCHASE.RETURN_EXCEEDS_RECEIPT` | `create` | **Required** | **Yes** |
| POST | `/api/v1/purchase-returns/{id}/post` | Post it | MGR SHF | `postingDate?` | period open | `200 { purchaseReturn, journalEntry, movements[] }` | `E-FIN` | `document.post` | **Required** | **Yes** |
| POST | `/api/v1/purchase-returns/{id}/cancel` · `/reverse` | Void / reverse | MGR ACC | `reason` | — | `200/201` | `E-FIN` | `document.cancel` / `document.reverse` | **Required** | **Yes** |
| GET | `/api/v1/purchase-returns` · `/{id}` | List / read | PUR MGR ACC OWN AUD | filters | — | `200` | `E-READ` | — | n/a | No |
| GET | `/api/v1/purchase-returns/expiry-candidates` | **R4.2 additive** — near-expiry lots eligible for supplier return | PUR MGR | `supplierId?`, `daysBeforeExpiry`, `warehouseId` | — | `200 { data: [{ stockLotId, itemName, batchNo, expiryDate, qty, costValue, supplier, lastPurchaseDoc }] }` | `E-STD` | `export` | n/a | No |

---
---

# PART 5 — MONEY OUT, CASH, BANK AND ACCOUNTING

> **Everything in §5.1, §5.2 and §5.3 is `Recommended` and ADDITIVE-NEW.** It implements **D8/R2** — "port the trading ledger as-is, then add expenses, cash/bank book, supplier payments and a plain-language profit statement". `Verified` finding F1 is the reason: the legacy GL records money coming **in** but never going **out**. Cash was debited 234,003,081 and credited only 19,691,239 (all returns); MARKETING/ADMIN EXPENSES, PAYROLL, CASH AT BANK and COST OF SALES have **zero entries in 19 months**; **no supplier payment or expense has ever been recorded** (`00b` F1, `07` §2.4). **R2.7 binds: none of these endpoints may alter existing posting behaviour. R2.8 binds: the debit/credit rules require accountant sign-off before implementation** (Part 9).

## 5.1 Module `payments` — supplier and other payments (**R2.1**)

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/payments` | List payments | ACC MGR OWN AUD; PUR ◐ read own supplier scope | `direction`, `partyKind`, `supplierId`, `paymentMethodId`, `cashBankAccountId`, `status`, `chequeStatus`, date range, `hasUnallocated`, pagination | scope-filtered by `cash_bank_account` | `200 { data, meta }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/payments` | **Record money leaving (or entering) the business** | ACC MGR; OWN ◐ record-only | `direction` (`out`\|`in`), `partyKind`, `supplierId?`/`customerId?`/`otherPartyName?`, `paymentMethodId`, `cashBankAccountId`, `supplierBankAccountId?`, `amount`, `documentDate`, `allocationMode` (`specific`\|`oldest_first`\|`on_account`, default **oldest_first** per R2.1), `allocations: [{ targetDocumentType, targetDocumentId, allocatedAmount }]?`, `referenceNo?`, `chequeNo?`, `chequeDate?`, `attachmentId?` (**receipt photo, R2.1**), `notes?` | `amount > 0`; exactly one party reference consistent with `partyKind`; method enabled and `direction_allowed` compatible; **`requiresReference` / `requiresChequeDetails` / `requiresBankAccount` enforced from `payment_method` — as data, not code**; `Σ allocations ≤ amount`; each target document exists, belongs to the same party, and has that much outstanding; cash account has funds unless `allowNegative`; period open | `201 { payment, allocations[], journalEntry, unallocatedAmount }` | `E-FIN`; `422 PAYMENT.ALLOCATION_EXCEEDS_AMOUNT`; `422 PAYMENT.TARGET_ALREADY_SETTLED`; `422 PAYMENT.REFERENCE_REQUIRED`; `422 CASH.INSUFFICIENT_FUNDS` | `create` + `document.post` (`amount_impact`) | **Required** — a double-submitted supplier payment is money paid twice | **Yes** — payment + allocations + `Dr Supplier / Cr Cash-or-Bank` journal, atomically |
| GET | `/api/v1/payments/{id}` | Read with allocations and journal | ACC MGR OWN AUD | `include=allocations,journal,attachment` | — | `200` | `E-READ` | — | n/a | No |
| POST | `/api/v1/payments/{id}/allocations` | Allocate (or re-allocate) an on-account payment | ACC MGR | `allocations[]`, `reason?` | `Σ new + existing ≤ amount`; targets unsettled | `200 { payment, allocations[] }` | `E-FIN`; `422 PAYMENT.ALLOCATION_EXCEEDS_AMOUNT` | `update` on `payment_allocation` | **Required** | **Yes** |
| POST | `/api/v1/payments/{id}/allocations/{allocationId}/reverse` | Undo one allocation | ACC MGR | `reason` | not already reversed | `200 { allocation }` — **reversal row, never an in-place edit** | `E-FIN` | `document.reverse` | **Required** | **Yes** |
| GET | `/api/v1/payments/allocation-candidates` | What this supplier owes, oldest first | ACC MGR PUR | `supplierId`, `asOfDate?` | supplier exists | `200 { data: [{ documentType, documentId, docNumber, documentDate, total, settled, outstanding, ageDays }], totalOutstanding }` | `E-READ` | — | n/a | No |
| POST | `/api/v1/payments/{id}/cheque-status` | Track a cheque through clearing | ACC MGR | `chequeStatus` (`issued`\|`presented`\|`cleared`\|`bounced`\|`cancelled`), `statusDate`, `reason?` | forward-only transitions except `bounced`; `bounced` and `cancelled` generate a reversing journal | `200 { payment, journalEntry? }` | `E-FIN`; `422 CHEQUE.INVALID_TRANSITION` | `update` (**sensitive**) | **Required** | **Yes** when the transition posts |
| POST | `/api/v1/payments/{id}/cancel` · `/reverse` | Void / reverse | ACC MGR ◐ break-glass | `reason` | reverse when posted; period open | `200/201` | `E-FIN` | `document.cancel` / `document.reverse` (**sensitive**) | **Required** | **Yes** |
| GET/POST/PATCH | `/api/v1/payment-methods` | **The direct implementation of D9** | ACC MGR SYS | `code`, `name`, `nameUr`, `description`, `directionAllowed`, `defaultCashBankAccountId`, `requiresReference`, `requiresBankAccount`, `requiresChequeDetails`, `settlementLagDays`, `isCounterMethod`, `minPermissionId`, `isEnabled`, `isDefault`, `sortOrder` | exactly one enabled default (**Cash**); `is_system` rows disable but never delete; **disabling hides the option but historical payments that used it still render (P1.3)** | `200/201 { method }` | `E-WRITE`; `422 LOOKUP.SYSTEM_ROW_PROTECTED` | `option.enable` / `option.disable` (**sensitive**) | Required on write | **Yes** |

> **Seeded methods (`Recommended`, verbatim from the P1 options table in `00b`):** Cash *(default)* · Bank transfer · Cheque · Bank draft / pay order · Online transfer (IBFT) · Mobile wallet — Easypaisa · Mobile wallet — JazzCash · Credit-note adjustment · Other (free text). `isCounterMethod` is what lets a cashier see only Cash/Card/Wallet while the owner sees the full list (**P1.5**).

## 5.2 Module `payments` — expenses (**R2.2**)

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/expenses` | List expenses | ACC MGR OWN AUD | `expenseCategoryId`, `paymentMethodId`, `cashBankAccountId`, `status`, date range, `payeeName`, pagination | scope-filtered | `200 { data, meta }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/expenses` | Record a business expense | ACC MGR; SHF ◐ below a configurable ceiling | `documentDate`, `payeeName?`, `supplierId?`, `paymentMethodId`, `cashBankAccountId`, `warehouseId`, `lines: [{ expenseCategoryId, amount, description?, warehouseId? }]`, `taxAmount?`, `withholdingAmount?`, `attachmentId?` (**receipt photo, R2.2**), `recurringTemplateId?`, `notes?` | ≥1 line; `amount > 0` per line; **`totalAmount = Σ line amounts`, enforced by the posting service (a header `CHECK` cannot span rows)**; category enabled and its `glAccountId` resolvable; `requiresAttachment` honoured; SHF ceiling from `role_limit.max_txn_value`; period open | `201 { expense, journalEntry }` | `E-FIN`; `422 EXPENSE.TOTAL_MISMATCH`; `422 EXPENSE.ATTACHMENT_REQUIRED`; `403 AUTHZ.LIMIT_EXCEEDED` | `create` + `document.post` (`amount_impact`) | **Required** | **Yes** — expense + lines + `Dr Expense / Cr Cash-or-Bank` journal |
| PATCH | `/api/v1/expenses/{id}` | Edit a draft | ACC MGR | as create | `If-Match`; draft only | `200` | `E-WRITE` | `update` | Required | **Yes** |
| POST | `/api/v1/expenses/{id}/post` · `/cancel` · `/reverse` | Lifecycle | ACC MGR | `postingDate?` / `reason` | period open | `200/201` | `E-FIN` | `document.post` / `.cancel` / `.reverse` | **Required** | **Yes** |
| POST | `/api/v1/expenses/from-template/{templateId}` | **"One click each month"** recurring expense | ACC MGR | `documentDate`, `amountOverride?` | template enabled | `201 { expense }` | `E-FIN` | `create` | **Required** | **Yes** |
| GET/POST/PATCH | `/api/v1/expense-categories` | The expense taxonomy (P1) | ACC MGR SYS | `code`, `name`, `nameUr`, `description`, **`glAccountId` (required)**, `isRecurringTemplate`, `defaultRecurrence`, `requiresAttachment`, `isEnabled`, `isDefault`, `sortOrder` | **`glAccountId` `NOT NULL` and postable** — this is the same fix as `adjustment_reason`, and it is why the legacy adjustments could never post | `200/201` | `E-WRITE`; `422 LOOKUP.GL_ACCOUNT_REQUIRED` | `option.*` | Required on write | **Yes** |
| POST | `/api/v1/attachments` | Upload a receipt photo | ACC MGR SHF | `multipart/form-data`: `file`, `entityType`, `entityId?`, `caption?` | ≤10 MB; MIME sniffed server-side; SHA-256 stored; EXIF stripped | `201 { attachmentId, sha256, byteSize, mimeType }` | `E-WRITE`; `413 UPLOAD.TOO_LARGE`; `415 UPLOAD.UNSUPPORTED_TYPE` | `create` | Required | No — object storage write, then one metadata insert |

> **Seeding note (`Recommended`, and a build blocker).** `Verified`: 9 of 29 legacy sub-accounts have **zero leaf accounts** — CASH AT BANK, MARKETING EXPENSES, all three PAYROLL sub-accounts, both STOCK ADJUSTMENT sub-accounts (`07` §2.4). **R2 requires these to be populated with real leaf accounts at seeding**, otherwise the new expense, bank and adjustment postings have nowhere to go. `GET /api/v1/ready` reports `requiredBindingsSatisfied: false` until they are, and the application refuses to accept postings for the affected document types — loudly, at startup, rather than silently at 3 a.m.

## 5.3 Module `payments` — cash book, bank book, transfers, cashier shifts (**R2.3, R2.4**)

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/cash-bank-accounts` | The money accounts | ACC MGR OWN AUD; SLS ◐ own till | `accountKind`, `isActive`, `warehouseId` | scope-filtered by `cash_bank_account` scope | `200 { data: [{ glAccountId, name, accountKind, bankName, accountNo, currentBalance, allowNegative, isDefaultForSales }] }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/cash-bank-accounts` | Open a cash drawer or bank account | ACC SYS | `glAccountId`, `accountKind`, `bankName?`, `branchName?`, `accountNo?`, `iban?`, `warehouseId?`, `allowNegative`, `isDefaultForSales` | GL account exists, is postable, and is not already linked; **`openingBalanceAmount` is forced to `0.0000` per D10/R3.1** and is not accepted from the client | `201 { account }` | `E-WRITE`; `409 CASHBANK.ACCOUNT_ALREADY_LINKED` | `create` (**sensitive**) | Required | **Yes** |
| GET | `/api/v1/cash-bank/book` | **The cash book / bank book (R2.3)** — running balance | ACC MGR OWN AUD | `cashBankAccountId`, date range, `sourceType`, keyset | date range required; scope-enforced | `200 { openingBalance, data: [{ postedAt, docNumber, sourceType, description, moneyIn, moneyOut, runningBalance, counterparty }], closingBalance }` | `E-STD` | `export` | n/a | No |
| POST | `/api/v1/cash-bank/transfers` | Move money between own accounts (cash → bank, bank → cash) | ACC MGR | `fromAccountId`, `toAccountId`, `amount`, `documentDate`, `referenceNo?`, `notes?` | accounts differ; both active; source has funds unless `allowNegative`; period open | `201 { transfer, journalEntry }` | `E-FIN`; `422 CASH.INSUFFICIENT_FUNDS`; `422 TRANSFER.SAME_ACCOUNT` | `create` + `document.post` | **Required** | **Yes** — two legs, one journal |
| POST | `/api/v1/cash-bank/reconciliations` | Start a bank reconciliation | ACC | `cashBankAccountId`, `statementDate`, `statementClosingBalance` | account is a bank kind | `201 { reconciliation, unreconciledLines[] }` | `E-WRITE` | `create` | Required | **Yes** |
| POST | `/api/v1/cash-bank/reconciliations/{id}/complete` | Close it | ACC | `matchedLineIds[]`, `adjustments[]?`, `reason?` | difference is zero or an adjustment covers it | `200 { reconciliation, journalEntry? }` | `E-FIN`; `422 RECON.UNEXPLAINED_DIFFERENCE` | `document.post` | **Required** | **Yes** |
| POST | `/api/v1/cashier-shifts` | **Open a till session (R2.4)** | SLS SHF MGR | `warehouseId`, `cashBankAccountId`, `openingFloatAmount` | no other open shift for this user+till; float ≥ 0 | `201 { cashierShift }` | `E-FIN`; `409 SHIFT.ALREADY_OPEN` | `create` | **Required** | **Yes** |
| POST | `/api/v1/cashier-shifts/{id}/count` | Enter the denomination count | SLS SHF MGR | `counts: [{ denominationAmount, denominationCount }]` | denominations from the configured currency set; counts ≥ 0 | `200 { countedTotal, expectedCash, variance }` — **the expected figure is hidden until the count is submitted** (blind count) | `E-WRITE` | `update` | Required | **Yes** |
| POST | `/api/v1/cashier-shifts/{id}/close` | Close and post the variance | SLS SHF MGR | `varianceReason?`, `varianceAccountId?` | count submitted; reason mandatory when `|variance| > tolerance`; variance account defaults from `gl_account_binding['cashier_variance']` and is **not free-form** | `200 { cashierShift, journalEntry? }` | `E-FIN`; `422 SHIFT.VARIANCE_REASON_REQUIRED` | `document.post` (`amount_impact = variance`) | **Required** | **Yes** |
| POST | `/api/v1/cashier-shifts/{id}/approve` | Supervisor sign-off | SHF MGR (never the cashier) | `reason?` | approver ≠ cashier | `200 { cashierShift }` | `E-FIN`; `422 APPROVAL.SELF_APPROVAL_FORBIDDEN` | `approve` (**sensitive**) | **Required** | **Yes** |
| GET | `/api/v1/cashier-shifts/{id}/z-report` | End-of-shift summary | SLS ◐ own; SHF MGR OWN ACC AUD | `format` | — | `200 { shift, salesByMethod[], returns, expensesPaid, openingFloat, expectedCash, countedCash, variance, invoiceCount }` | `E-READ` | `print` | n/a | No |

> **`Verified` basis for R2.4.** The legacy `CashierShift` / `CashierShiftCashCount` / `CashierWindow` tables already model this and are **dormant with zero rows** (`06` §3.6). R2.4 says *activate rather than reinvent* — which is what these endpoints do. Legacy account **42 CASHIER CASH DIFFERENCE** exists for exactly this purpose, but `DiffTransferedTo` is not forced to it (`07` §4.6, `Unclear`); here the binding decides it.

## 5.4 Module `ledger` — chart of accounts, journals, periods

**Replaces:** `VirtualGl` (1,015,581 rows, **no primary key**), the `Accounts`/`SubAccounts`/`CategoryAccounts`/`MainAccounts` hierarchy (267/29/13/5 rows — **sound and preserved intact**), `Global` (81 `GT_*` bindings), `TransactionHeader`/`TransactionDetail` (0 rows, `Verified-but-DORMANT`) (`Verified`, `03` T1-20/T1-21/T1-22, `06` §6.1, `07` §2).

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/gl/accounts` | Chart of accounts, as a tree or flat | ACC MGR OWN AUD | `level`, `parentId`, `q`, `isPostable`, `isActive`, `format=tree\|flat` | — | `200 { data: [{ glAccountId, code, name, nameUr, level, parent, accountNature, normalBalance, isContra, isPostable, isSystem, currentBalance? }] }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/gl/accounts` | Add a leaf account | ACC | `code`, `name`, `nameUr?`, `glAccountSubId`, `isContra?`, `isRestricted?`, `balanceLimitAmount?`, `openedOn?`, `aliasName?` | code and name unique; parent sub-account exists; **`accountNature`/`normalBalance` derived from the parent, not client-supplied** | `201 { account }` | `E-WRITE`; `409 GL.CODE_TAKEN` | `create` (**sensitive**) | Required | **Yes** |
| PATCH | `/api/v1/gl/accounts/{id}` | Rename / deactivate | ACC | `name`, `nameUr`, `isActive`, `isRestricted`, `balanceLimitAmount`, `reason` | `If-Match`; **`is_system` accounts (the 42 reserved control accounts) cannot be deactivated**; an account with movement cannot be reparented | `200 { account }` | `E-WRITE`; `422 GL.SYSTEM_ACCOUNT_PROTECTED`; `422 GL.ACCOUNT_HAS_MOVEMENT` | `update` (**sensitive**) | Required | **Yes** |
| GET | `/api/v1/gl/accounts/{id}/ledger` | Account ledger with running balance | ACC MGR OWN AUD | date range, `supplierId`, `customerId`, keyset | date range required | `200 { openingBalance, data: [{ postedAt, journalEntryId, docNumber, memo, debit, credit, runningBalance, counterparty }], closingBalance }` | `E-READ` | `export` | n/a | No |
| GET/POST/PATCH | `/api/v1/gl/main-accounts` · `/category-accounts` · `/sub-accounts` | Levels 1–3 of the hierarchy | ACC SYS | pack `LK` fields + level-specific (`accountNature`, `statementSection`, `presentationOrder`, `isControlAccount`, `subledgerKind`) | hierarchy integrity; a level with children cannot change nature | `200/201` | `E-WRITE` | `update` (**sensitive**) | Required on write | **Yes** |
| GET | `/api/v1/gl/bindings` | The symbolic account map (`sales_account`, `cogs_account`, `cash_default`, `fbr_pos_fee_payable`, `supplier_control`, `cashier_variance`, …) | ACC SYS OWN AUD | — | — | `200 { data: [{ bindingKey, name, bindingLevel, target, isRequired, isSatisfied, legacyGlobalName }] }` | `E-STD` | — | n/a | No |
| PUT | `/api/v1/gl/bindings/{bindingKey}` | Re-point a binding | ACC (+ step-up) | `targetId`, `bindingLevel`, `reason` | target exists, is postable and matches the binding level; **reason ≥20 chars** | `200 { binding }` | `E-WRITE`; `422 GL.BINDING_TARGET_INVALID` | `setting.change` (**sensitive**) | Required | **Yes** |
| GET | `/api/v1/gl/journal-entries` | Browse the ledger | ACC MGR OWN AUD | `sourceDocumentType`, `sourceDocumentId`, `glAccountId`, `legRole`, date range, `minAmount`, keyset | — | `200 { data, meta }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/gl/journal-entries/{id}` | One balanced entry with all legs | ACC MGR OWN AUD | — | — | `200 { entry, lines: [{ lineNo, glAccountId, debit, credit, legRole, supplierId?, customerId?, itemId?, memo }], sourceDocument }` | `E-READ` | — | n/a | No |
| POST | `/api/v1/gl/journal-entries` | Manual voucher (JV, CP, CR, BP, BR) | ACC | `voucherCategoryId`, `documentDate`, `postingDate`, `narration`, `lines: [{ glAccountId, debit, credit, supplierId?, customerId?, memo }]` | **`Σ debit = Σ credit` to the paisa**; ≥2 lines; each line has exactly one non-zero side; every account postable and permitted by `voucher_category.allowed_sub_account_ids`; period open | `201 { entry }` | `E-FIN`; `422 LEDGER.UNBALANCED` with the exact difference in `meta`; `422 LEDGER.ACCOUNT_NOT_POSTABLE` | `create` + `document.post` | **Required** | **Yes** |
| POST | `/api/v1/gl/journal-entries/{id}/reverse` | Reverse an entry | ACC (+ break-glass when the period is soft-closed) | `reason`, `postingDate` | period open; **no in-place edit path exists** | `201 { reversal }` | `E-FIN`; `422 PERIOD.CLOSED` | `document.reverse` (**sensitive**) | **Required** | **Yes** |
| GET/POST/PATCH | `/api/v1/gl/voucher-categories` | The 22 legacy voucher types as data | ACC SYS | `code`, `name`, `headerSide`, `detailSide`, `isJournalVoucher`, `isInvoiceBased`, `invoiceKind`, `autoPost`, `allowedSubAccountIds`, `isEnabled` | side rules coherent | `200/201` | `E-WRITE` | `option.*` | Required on write | **Yes** |
| GET | `/api/v1/fiscal-years` · `/fiscal-periods` | Calendar and period status | ACC MGR OWN AUD | `fiscalYearId`, `status` | — | `200 { data: [{ periodId, name, startDate, endDate, status: open\|soft_closed\|locked, closedBy, closedAt }] }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/fiscal-periods/{id}/close` | Soft-close or lock a period | ACC (+ OWN approval when `locked`) | `targetStatus`, `reason` | all documents in the period posted or cancelled; reconciliation checks green | `200 { period, blockingDocuments[] }` | `E-WRITE`; `422 PERIOD.HAS_UNPOSTED_DOCUMENTS` | `period.close` (**sensitive**) | Required | **Yes** |
| POST | `/api/v1/fiscal-periods/{id}/reopen` | Reopen | ACC + OWN (dual, + step-up) | `reason` (≥30 chars) | period is `soft_closed` or `locked`; later periods still open | `200 { period }` | `E-WRITE`; `422 PERIOD.LATER_PERIOD_CLOSED` | `period.reopen` (**sensitive**, alerts owner) | Required | **Yes** |

> **There is no `POST /gl/journal-lines` and no `PATCH` or `DELETE` on any ledger resource (`Recommended`, [BINDING]).** `journal_line` is append-only, enforced by MySQL grants **and** by `BEFORE UPDATE`/`BEFORE DELETE` triggers that `SIGNAL SQLSTATE '45000'`. The legacy correction path **deletes GL rows and re-derives them silently**, so an auditor cannot tell that a posted invoice was amended (`Verified`, `07` §9.3, `Broken/Incomplete`). Corrections here are compensating entries, always.

> **Period locking is genuinely new.** `Missing` in the legacy system — any date can be posted or edited at any time, forever (`Verified`, `07` §9.1). Note also that legacy `ServerDateMonth` **looks** like a period lock and is not: all 12 of its references sit inside monthly invoice-number reset logic (`Verified`, `07` §9.2), so it is not migrated as a period control.

## 5.5 Module `reporting` — financial statements

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/gl/trial-balance` | Trial balance at a date | ACC MGR OWN AUD | `asOfDate`, `level` (1–4), `includeZero`, `warehouseId?` | `asOfDate` within a known period | `200 { asOfDate, rows: [{ accountCode, accountName, level, debit, credit }], totals: { debit, credit, difference } }` — `difference` is **always rendered**, even when zero | `E-STD` | `export` | n/a | No |
| GET | `/api/v1/gl/income-statement` | Accountant-facing P&L | ACC MGR OWN AUD | date range, `compareTo?` | range within known periods | `200 { sections[], lines[], grossProfit, netProfit }` | `E-STD` | `export` | n/a | No |
| GET | `/api/v1/gl/balance-sheet` | Balance sheet | ACC MGR OWN AUD | `asOfDate`, `compareTo?` | — | `200 { assets[], liabilities[], equity[], totals, isBalanced }` | `E-STD` | `export` | n/a | No |
| GET | `/api/v1/reports/profit-statement` | **R2.5 — the plain-language profit statement for the owner** | OWN MGR ACC AUD | date range, `granularity` (`day`\|`week`\|`month`) | — | `200 { moneyIn: { sales, otherIncome }, costOfGoodsSold, grossProfit, expenses: [{ categoryName, amount }], netProfit, plainLanguageSummary, caveats[] }` | `E-STD` | `export` | n/a | No |
| GET | `/api/v1/gl/reconciliation-checks` | The nightly integrity checks and their results | ACC SYS OWN AUD | `checkCode`, `status`, date range | — | `200 { data: [{ checkCode, name, lastRunAt, status, expected, actual, difference }] }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/gl/reconciliation-checks/run` | Run them now | ACC SYS | `checkCodes[]?` | — | `202 { jobId }` | `E-WRITE` | `job.trigger` | Required | No |

> **Why the profit statement returns `caveats[]` (`Recommended`).** Gross profit **is** trustworthy — sales, purchases, returns and stock valuation are all properly recorded (`Verified`, `00b` F1). Net profit is only as complete as the expenses actually entered, and for the first months after cutover that will be partial. The endpoint says so in the payload rather than letting a confident-looking number mislead the owner. The legacy GL-based Income Statement is `Broken/Incomplete` — it reads `StockLedger`, which has **0 rows**, reducing "gross profit" to *Sales − Purchases* (`Verified`, `10` §1.2 finding 3).

## 5.6 Module `tax` — schedules, categories, calculation

**Replaces:** `SalesTaxSchedule` (7 rows), `TaxCategory` (3), the quantity-based tax rules, and `fn_getTaxOnSaleInv` (`Verified`, `03` T1-23, `11` §2.3).

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/tax/schedules` | Tax schedules with **effective-dated** rates | ACC MGR OWN AUD | `effectiveOn`, `isEnabled` | — | `200 { data: [{ scheduleId, code, name, rates: [{ rate, effectiveFrom, effectiveTo }] }] }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/tax/schedules/{id}/rates` | Add a future rate | ACC SYS | `rate`, `effectiveFrom`, `reason` | **no overlapping effective ranges**; `effectiveFrom` not in a locked period; rate 0–100 | `201 { rate }` | `E-WRITE`; `422 TAX.RATE_PERIOD_OVERLAP` | `setting.change` (**sensitive**) | Required | **Yes** |
| GET/POST/PATCH | `/api/v1/tax/categories` · `/tax/qty-rules` · `/tax/gst-bases` | Tax configuration as data | ACC SYS | pack `LK` + rule fields | — | `200/201` | `E-WRITE` | `option.*` | Required on write | **Yes** |
| POST | `/api/v1/tax/calculate` | Explain the tax on a hypothetical document | ACC MGR SHF SLS | `documentKind`, `documentDate`, `lines[]` | ≤200 lines | `200 { lines: [{ taxableAmount, rateApplied, scheduleUsed, taxAmount, trace[] }], totalTax }` | `E-STD` | — | n/a (read-only POST) | No |
| GET | `/api/v1/tax/hs-codes` | HS code lookup | MGR PUR ACC | `q`, pagination | — | `200 { data, meta }` | `E-STD` | — | n/a | No |

> **Effective dating is the change (`Recommended`).** Statutory rates change independently of everything else and must be versioned by date — a capability the legacy lacks (`17` §2.3 module 8). Historic invoices must always re-render with the rate that applied on their own date, which is a tax-audit requirement, not a nicety.

## 5.7 Module `fiscal` — FBR fiscalization

**Mission critical and live (`Verified`, `03` T1-24, `11` §1.1):** 290,922 of 291,361 sale invoices are fiscalised (99.85 %), and account 37 accrues **exactly PKR 1 per invoice × 291,361 invoices** (`00b` F1). But **439 sale invoices and 19,655 sale returns are un-fiscalised with no record anywhere of why**, because the auto-fiscalise call inside `sp_PostSaleLedger` and `sp_PostSRLedger` is **commented out in both cases** and the real path is a separate socket application on port 9111 that writes results straight back onto `SaleLedger` with no attempt history (`Verified` / `Broken/Incomplete`, `11` §1.2). FBR Digital Invoicing (PRAL DI) is configured but dormant: `Digitalized='N'` on all 291,361 rows (`Verified`, `03` T1-25) — **build-ready, off**.

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/fbr/submissions` | Every fiscalization attempt, with request and response | ACC MGR OWN AUD SYS | `sourceDocumentType`, `sourceDocumentId`, `outcome`, date range, keyset | — | `200 { data: [{ submissionId, attemptNo, submittedAt, outcome, responseCode, fiscalInvoiceNo, errorText, latencyMs }], meta }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/fbr/queue` | What is waiting or stuck | ACC MGR SYS OWN | `ageMinutes.gte`, `outcome` | — | `200 { pendingCount, failedCount, oldestPendingAt, data[] }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/fbr/submissions/{documentType}/{documentId}/retry` | Re-submit one document | ACC MGR SYS | `reason?` | document posted; not already successfully fiscalised | `202 { submissionId, jobId }` | `E-WRITE`; `422 FBR.ALREADY_FISCALIZED`; `503 FBR.UNAVAILABLE` | `fiscalization.retry` | **Required** — a duplicate submission is a duplicate tax record | No — enqueues an outbox row; **the external call is never inside a business transaction** (T-7) |
| GET | `/api/v1/fbr/reconciliation` | Fiscalised vs posted, by day | ACC OWN AUD | date range | — | `200 { data: [{ date, postedInvoices, fiscalized, unfiscalized, unfiscalizedValue }] }` — the report that would have surfaced the 439 + 19,655 gap | `E-STD` | `export` | n/a | No |
| GET/PATCH | `/api/v1/fbr/settings` | POS ID, endpoint, test/live mode, per-invoice fee amount, retry policy | SYS ACC (+ step-up) | `posId`, `endpointUrl`, `isTestService`, `posFeeAmount`, `maxAttempts`, `autoFiscalizeOnPost` | endpoint is https; **`posFeeAmount` is an `app_setting`, never a constant** | `200 { settings }` | `E-WRITE` | `setting.change` (**sensitive**) | Required | **Yes** |
| POST | `/api/v1/fbr/test-connection` | Probe the FBR endpoint | SYS ACC | `useTestService` | — | `200 { reachable, latencyMs, responseCode }` | `E-STD`; `503 FBR.UNAVAILABLE` | `fiscalization.test` | Not required | No |
| GET | `/api/v1/fbr/codes` | The seeded FBR lookups (UOM 43, scenario 28, transaction type 26, doc type 2) | ACC MGR PUR SYS | `codeType`, `q` | — | `200 { data, meta }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/sale-invoices/{id}/fbr` | Fiscal state of one invoice, incl. QR payload for reprint | SLS SHF MGR ACC OWN AUD | — | — | `200 { isFiscalized, fiscalInvoiceNo, posId, usin, qrPayload, attempts[] }` | `E-READ` | — | n/a | No |

> **Failure is never allowed to block the till (`Recommended`).** `POST /sales/checkout` returns `201` with `fbrStatus: "queued"` when FBR is unreachable; the invoice is committed, the outbox row is committed with it, and a worker retries with backoff. A `503` from FBR is never surfaced as a checkout failure — the legally required record is the invoice, and the fiscal number is attached when it arrives. Every attempt, success or failure, is a row in `fbr_submission` with its verbatim request and response.

---
---

# PART 6 — REPORTING, SETTINGS, ADMIN, AUDIT, DOCUMENTS

## 6.1 Module `reporting` — the report registry and runner

**Replaces:** 3,015 unversioned DataWindow layouts, 1,080 hand-built parameter windows and 357 format-picker windows, driving ~197 deployed report leaves — reduced to ~95 registered reports (`Verified`, `10` §10.4). The architectural defect being removed: `ReportData` and `CrossTab_ReportData` have **no session key**, and every producer begins `DELETE ReportData` / `TRUNCATE TABLE ReportData`, so **two users running two reports at the same time corrupt each other's output** (`Verified`, `10` §1.1, §1.2 finding 1, Critical).

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/reports` | The registry — what reports exist and who may run them | all (filtered to the caller's grants) | `group`, `q` | — | `200 { data: [{ reportId, title, titleUr, group, description, permission, defaultView, supportsExport }] }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/reports/{reportId}/schema` | The declarative filter schema, so one generic component renders every report's filters | per-report permission | — | — | `200 { filters: [{ name, kind, label, help, required, default, options?, min?, max? }], columns[], sorts[], chartTypes[] }` — ~15 filter primitives cover all 1,080 legacy parameter windows (`10` §10.1) | `E-READ` | — | n/a | No |
| POST | `/api/v1/reports/{reportId}/run` | Execute and return rows | per-report permission | `filters{}`, `page`/`cursor`, `sort`, `groupBy?` | filters validated against the report's own Zod schema; **date range caps enforced per report**; row-level scope applied on top | `200 { columns[], data[], totals?, meta: { rowCount, executionMs, metricVersions } }` | `E-STD`; `422 REPORT.FILTER_INVALID`; `422 REPORT.RANGE_TOO_LARGE`; `504 REPORT.TIMEOUT` | — | n/a (`x-read-only`; runs on the read-only pool) | No — **and it may not open one; `reporting` has no write grant** |
| POST | `/api/v1/reports/{reportId}/export` | CSV / XLSX / PDF | per-report permission **+ `report:export`** | `filters{}`, `format`, `includeTotals` | as run | `202 { jobId, statusUrl }` | `E-WRITE`; `429` (5 concurrent server-wide) | **`export`** — with row count and the exact filter parameters (A-3) | Required | No |
| GET | `/api/v1/reports/saved-views` · POST · PATCH · DELETE | Per-user saved filter+column+sort+chart sets, shareable | any (own); MGR to share | `reportId`, `name`, `filters`, `columns`, `sort`, `chartType`, `isShared` | name unique per user per report | `200/201` | `E-WRITE` | `update` | Required on write | **Yes** |
| GET | `/api/v1/dashboards/{dashboardId}` | Dashboard tiles in one call | per-dashboard permission | `dateRange`, `warehouseId` | — | `200 { tiles: [{ tileId, kind, title, value?, series?, unit, comparison, metricVersion }] }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/metrics/definitions` | The 12 canonical metric definitions, in plain language | ACC MGR OWN AUD | — | — | `200 { data: [{ metricKey, title, plainDefinition, formula, referenceLegacyProcedure, version }] }` | `E-STD` | — | n/a | No |

> **Why `/metrics/definitions` is an endpoint and not a wiki page (`Recommended`).** `net sales` has **at least four incompatible implementations** in the legacy system (`Verified`, `10` §1.2 finding 2). Publishing the single canonical definition through the API means the dashboard tile, the daily P&L and the profit statement can all display *the same* definition text next to the same number, and a consistency test can assert they return identical figures for the same period.

> **Dead dimensions are not exposed (`Recommended`).** Area, SubArea, Region, Zone, SalesMan and CustomerCategory all have **1 row** (`Verified`, `10` §1.2 finding 4), so the entire cross-tab family they drive produces single-column output. They are not offered as `groupBy` values; ItemCategory (7), ItemClass (12), Manufacturer (838) and User (9) are. The dimensions remain in `feature_capability` as `deferred`, not deleted.

## 6.2 Module `settings` — settings and options-as-data (**P1/D9**)

**Replaces:** `SoftwarePreferences` (1,352 name/value rows read through `Fn_GetPreference`), `Preferences` (**a 443-column single-row table**, architecturally obsolete), `ConfigSetting` (9) and `Global` (79) (`Verified`, `06` §3.3).

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/settings` | All settings the caller may see, grouped for the admin panel | SYS MGR ACC OWN AUD (per setting's `minPermission`) | `group`, `q` | — | `200 { data: [{ key, group, label, helpText, valueType, value, defaultValue, allowedValues?, minPermission, requiresRestart, isSystem, legacySource }], settingsVersion }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/settings/{key}` | One setting | per-setting permission | — | — | `200 { setting }` | `E-READ` | — | n/a | No |
| PUT | `/api/v1/settings/{key}` | Change a setting | per-setting `minPermission` | `value`, `reason` | typed per `valueType`; enum values from `allowedValues`; `account_ref` must resolve to a postable account; **reason mandatory for any setting flagged sensitive** | `200 { setting, settingsVersion }` | `E-WRITE`; `422 SETTING.VALUE_INVALID`; `403 AUTHZ.PERMISSION_DENIED` | `setting.change` (**sensitive**, before/after) | Not required (`PUT` is naturally idempotent; `If-Match` guards concurrent edits) | **Yes** — value + audit |
| POST | `/api/v1/settings/{key}/reset` | Restore the shipped default | SYS | `reason` | default exists | `200 { setting }` | `E-WRITE` | `setting.change` | Required | **Yes** |
| GET | `/api/v1/settings/version` | Cheap cache-invalidation probe | any | — | — | `200 { settingsVersion, generatedAt }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/option-lists` | Every P1 option list and its metadata | SYS MGR ACC OWN AUD | `q`, `isAdminExtensible` | — | `200 { data: [{ listCode, name, description, isAdminExtensible, allowsDisable, itemCount }] }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/option-lists/{listCode}/items` | The options in a list | all (read) | `includeDisabled` | — | `200 { data: [{ optionItemId, code, name, nameUr, description, isEnabled, isDefault, isSystem, sortOrder }] }` | `E-READ` | — | n/a | No |
| POST | `/api/v1/option-lists/{listCode}/items` | **Add an option — an `INSERT`, not a deployment (P1.4)** | MGR SYS (per list) | `code`, `name`, `nameUr?`, `description`, `sortOrder?` | list is `isAdminExtensible`; code unique in the list; **description mandatory** (R1.10: every admin control carries a one-line plain-English explanation) | `201 { optionItem }` | `E-WRITE`; `422 LOOKUP.LIST_NOT_EXTENSIBLE`; `409 LOOKUP.CODE_TAKEN` | `option.create` | Required | **Yes** |
| PATCH | `/api/v1/option-lists/{listCode}/items/{optionItemId}` | Rename / re-describe / re-order | MGR SYS | `name`, `nameUr`, `description`, `sortOrder` | `If-Match`; **`code` is immutable once created** | `200 { optionItem }` | `E-WRITE`; `422 LOOKUP.CODE_IMMUTABLE` | `option.update` | Not required | **Yes** |
| POST | `/api/v1/option-lists/{listCode}/items/{optionItemId}/disable` · `/enable` | **Hide without deleting (P1.3)** | MGR SYS | `reason` | list `allowsDisable`; cannot disable the current default without naming a replacement | `200 { optionItem }` | `E-WRITE`; `422 LOOKUP.DEFAULT_REQUIRED` | `option.disable` / `option.enable` (**sensitive**) | Required | **Yes** |
| POST | `/api/v1/option-lists/{listCode}/items/{optionItemId}/set-default` | Change the pre-selected default (P1.2) | MGR SYS | `reason` | item enabled; **exactly one default per list is enforced by a functional unique index in MySQL, not by hope** | `200 { list }` | `E-WRITE` | `option.update` (**sensitive**) | Required | **Yes** — clear old default + set new, atomically |
| GET | `/api/v1/options/bootstrap` | Every enabled option the UI needs, in one cached call | any | `lists[]?` | — | `200 { lists: { <listCode>: [OptionItem] }, settingsVersion }` + `ETag` | `E-STD` | — | n/a | No |

> **There is deliberately no `DELETE` on any option (`Recommended`, P1.3).** Disabling hides an option from pickers; every historical document that used it still resolves and renders correctly, because the foreign key remains valid. **Disabling hides but never deletes history** — that is the owner's stated rule (D9/P1.3), and the API has no path that could break it.

> **Guard rail (`Recommended`, `17` §10.6).** Some things may **never** become options: double-entry balancing, append-only ledger semantics, audit immutability, permission deny-by-default, idempotency on financial writes, and the ban on hard-deleting documents. `PUT /settings/{key}` rejects any attempt to reach these with `422 SETTING.NOT_CONFIGURABLE`. `SoftwarePreferences.AutoPurgeVirtualGL = 'Y'` **truncates the entire general ledger on the next balance enquiry, with no confirmation and no backup** (`Verified`, `07` §3.5 — the highest-severity latent defect found in the accounting domain). In the target that capability is **removed, not re-permissioned**.

## 6.3 Module `platform` / `audit` — admin, migration and the audit trail

### 6.3.1 Migration, opening balances and reconciliation

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/opening-balances` | **R3.4** — the recorded zero/manual/imported choice per balance type | OWN ACC SYS AUD | `balanceKind` | — | `200 { data: [{ balanceKind, party, glAccount, method, openingAmount, legacyAmount, asOfDate, decidedBy, decidedAt, notes }] }` | `E-STD` | — | n/a | No |
| PUT | `/api/v1/admin/opening-balances/{balanceKind}` | Record the decision (pre-cutover only) | OWN + ACC (dual) | `method` (`start_at_zero` \| `entered_manually` \| `imported_from_statement`), `openingAmount`, `asOfDate`, `evidenceAttachmentId?`, `notes` | **default is `start_at_zero` with `0.0000` per D10/R3.1**; a non-zero manual amount requires an evidence attachment; refused once the first fiscal period is closed | `200 { decision }` | `E-WRITE`; `422 OPENING.CUTOVER_PASSED`; `422 OPENING.EVIDENCE_REQUIRED` | `setting.change` (**sensitive**) | Required | **Yes** |
| GET | `/api/v1/admin/migration/batches` | Migration run history | SYS ACC OWN AUD | `status`, `entity` | — | `200 { data: [{ batchId, entity, sourceRowCount, loadedRowCount, rejectedRowCount, startedAt, finishedAt, status }] }` | `E-STD` | — | n/a | No |
| GET | `/api/v1/admin/migration/row-map` | Legacy key → new key lookup, for reconciliation | SYS ACC AUD | `entity`, `legacyId`, `newId`, pagination | one identifier | `200 { data, meta }` | `E-STD` | `export` | n/a | No |
| GET | `/api/v1/admin/migration/reconciliation` | The `06a` invariants: counts and totals, legacy vs new | SYS ACC OWN AUD | `checkCode` | — | `200 { data: [{ checkCode, description, legacyValue, newValue, difference, status }] }` | `E-STD` | `export` | n/a | No |
| GET | `/api/v1/admin/legacy-archive/{entity}` | Read-only view of archived legacy figures (the "fiction" retained for explanation) | OWN ACC AUD | `q`, pagination | — | `200 { data, meta, caveat: "Archived legacy balances. Never posted. See D10/R3." }` | `E-STD` | `export` | n/a | No |

> **`Verified` figures retained as `legacyAmount`, never posted (D10/R3.4):** cash **214,311,842 Dr**, suppliers **182,671,130 Cr**, equity **11,873,579 Cr** (`00b` F1). They exist in the API so the owner can still be shown *what the old books claimed and why it was not carried over* — which is a change-management need, not an accounting one.

### 6.3.2 Audit log

**Replaces:** `ItemLog` (110,329 rows — the single genuinely useful audit trail in the legacy system), `DeletedSaleItem` (235,887) and `UserGroupsLog` (9). **Not audited today at all:** logins, permission changes, price changes (only 8 rows in `PriceChanges`), document posting, document deletion, exports, backups, and every stock-adjustment approval (`Verified`, `09` §G.1–G.2, "the critical gap list").

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/audit/events` | Search the trail | AUD SYS OWN; MGR ACC ◐ scoped | `action`, `entityType`, `entityId`, `actorUserId`, `requestId`, `isSensitive`, `minAmountImpact`, date range, **keyset** | date range required beyond 90 days | `200 { data: [{ auditEventId, occurredAt, actorUsername, action, entityType, entityId, entityLabel, changedFields, amountImpact, reason, requestId }], meta }` | `E-STD` | `audit.read` when the caller is **not** AUD | n/a | No |
| GET | `/api/v1/audit/events/{id}` | One event with full before/after | AUD SYS OWN | — | — | `200 { event, beforeJson, afterJson, diff[] }` | `E-READ` | `audit.read` | n/a | No |
| GET | `/api/v1/audit/entities/{entityType}/{entityId}/history` | The timeline of one record | AUD SYS OWN MGR ACC | keyset | — | `200 { data: [AuditEvent], meta }` — powers item history with field-level diffs, the price-history step chart and the deleted-line grid (A-6: **the audit is a product feature, not a compliance artefact**) | `E-READ` | — | n/a | No |
| GET | `/api/v1/audit/security-events` | Auth, permission, break-glass, export, backup, period events | AUD SYS OWN | `eventType`, `actorUserId`, date range, keyset | — | `200 { data, meta }` | `E-STD` | `audit.read` | n/a | No |
| POST | `/api/v1/audit/export` | Export the trail | AUD SYS OWN | `filters`, `format` | date range ≤ 24 months per job | `202 { jobId }` | `E-WRITE` | `export` (**sensitive**) | Required | No |
| GET | `/api/v1/audit/coverage` | Which audited actions have fired, and when last | SYS OWN AUD | — | — | `200 { data: [{ action, lastSeenAt, count30d, expected }] }` — a **missing** audit stream is visible rather than assumed working | `E-STD` | — | n/a | No |

> **There is no write endpoint on the audit trail, by construction (`Recommended`, [BINDING]).** The application database user holds `INSERT` and `SELECT` only; `UPDATE` and `DELETE` are not granted, and triggers `SIGNAL SQLSTATE '45000'` on either. **Intent is not a control; grants are** (`17` §9.5 A-1). Retention ≥ 7 years for FBR/tax defensibility; expiry happens by dropping whole partitions after export to cold storage, and the drop itself is recorded in `system_job`.

## 6.4 Module `documents` — printing, labels and barcodes

**Replaces:** 5 alphabetically-partitioned print libraries plus 4 `*printouts.pbd` and 357 format-picker windows — "the maintainability bomb" (`Verified`, `04` §8, `03` T1-30/T1-41).

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/print-templates` | Available templates per document type | MGR SYS ACC | `documentTypeCode` | — | `200 { data: [{ templateId, name, documentType, pageFormat, isDefault, isEnabled }] }` | `E-STD` | — | n/a | No |
| PATCH | `/api/v1/print-templates/{id}` | Edit header/footer text, logo, paper size, copies | MGR SYS | `name`, `pageFormat`, `headerText`, `footerText`, `logoAttachmentId`, `copies`, `isDefault` | `If-Match`; format from the `doc_print_format` option list | `200 { template }` | `E-WRITE` | `setting.change` | Required | **Yes** |
| POST | `/api/v1/print-templates/{id}/preview` | Render with sample data | MGR SYS | `sampleDocumentId?` | — | `200` PDF | `E-READ` | — | n/a (read-only POST) | No |
| POST | `/api/v1/labels/print` | Shelf labels and item barcodes | MGR SHF PUR | `items: [{ itemId, qty, priceTypeId? }]`, `labelTemplateId`, `startPosition?` | ≤2,000 labels per job | `202 { jobId }` | `E-WRITE` | `print` | Required | No |
| GET | `/api/v1/barcodes/generate` | Render a single barcode image | MGR SHF | `value`, `symbology`, `width`, `height` | symbology supported; value valid for it | `200` PNG/SVG | `E-STD` | — | n/a | No |

## 6.5 Module `notifications` — alerts and channels

**Context (`Verified`, `03` T2-16/T2-17, `11` §3.6):** SMS is switched **off** (`AllowSMSFunctions='N'`), `EmailTemplate` has 0 rows, and the legacy binary **hardcodes 7 Pakistani SMS gateways**. Channels here are P1 options, so adding a gateway is configuration.

| Method | Endpoint | Purpose | Required Role | Request fields | Validation | Response | Error responses | Audit event | Idempotency | DB transaction required |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/v1/notifications` | My in-app notifications | any | `isRead`, `severity`, keyset | — | `200 { data, meta, unreadCount }` | `E-STD` | — | n/a | No |
| POST | `/api/v1/notifications/{id}/read` · `/read-all` | Mark read | any (own) | — | — | `200 { unreadCount }` | `E-READ` | — | Not required | No |
| GET/POST/PATCH | `/api/v1/notification-rules` | Which events notify whom, on which channel | SYS MGR OWN | `eventType`, `channelIds[]`, `roleKeys[]`, `userIds[]`, `severityThreshold`, `digestSchedule`, `isEnabled` | at least one recipient; channel enabled | `200/201` | `E-WRITE` | `setting.change` | Required on write | **Yes** |
| GET/PATCH | `/api/v1/notification-channels` | In-app / e-mail / SMS adapters (P1 options) | SYS | `code`, `isEnabled`, `configJson` (secrets **write-only**, never returned) | credentials go to the secrets store, not the response | `200` — config secrets are returned as `"••••"` | `E-WRITE` | `setting.change` (**sensitive**) | Required | **Yes** |
| POST | `/api/v1/notification-channels/{code}/test` | Send a test message | SYS | `recipient` | channel enabled | `200 { delivered, latencyMs, providerResponse }` | `E-STD`; `503` | `setting.test` | Required | No |

---
---

# PART 7 — OPENAPI STRATEGY

`Recommended`. The problem this section solves is specific: the legacy system's *de-facto* API is 643 stored procedures with no contract, no version, no documentation and no way to tell which of them are dead (`Verified`, `03` §2.8). An API plan that produces a hand-maintained YAML file recreates that problem with better syntax.

## 7.1 The rule: the spec is generated, never written

| # | Rule | Mechanism |
|---|---|---|
| **O-1** | **Zod schemas in `packages/contracts` are the single source of truth.** The OpenAPI 3.1 document is *generated* from them at build time. Nobody edits YAML by hand. | The same schema validates the request at the edge (`17` §9.3 layer 1) and drives React Hook Form on the client (`17` §8.5). One definition, three consumers — a field cannot be validated differently in two places. |
| **O-2** | **The generated spec is committed** and a CI job regenerates it and fails on any diff. | A pull request that changes behaviour must also change the committed spec, so the spec cannot drift silently. |
| **O-3** | **Route enumeration test.** A test walks the framework's route table and asserts that **every** route has: an OpenAPI operation, a `@RequirePermission` declaration (or an explicit `@Public`), a declared response schema per documented status, and — for any route in the `E-FIN` class — an idempotency declaration. Build fails otherwise. | This is what makes "deny by default" and "every financial POST is idempotent" structural rather than aspirational. It is also the mechanism that keeps this document honest: **the invariant asserted in §0.9 (financial transaction ⇒ idempotency key) is machine-checked.** |
| **O-4** | **Contract tests run the spec against the implementation.** Every documented error `code` must be reachable by at least one test, and every example in the spec must validate against its own schema. | Prevents documented-but-impossible errors and impossible-but-real ones. |
| **O-5** | **The frontend client is generated from the spec**, typed end to end. A removed or renamed field breaks the TypeScript build, not a user's screen. | Removes the entire class of "the UI sends a field the server ignores". |
| **O-6** | **Every operation carries `x-audit-event`, `x-idempotent`, `x-transactional`, `x-permission`, `x-legacy-source` and `x-requirement` extensions.** | These are the machine-readable form of the last five columns of every table in this document. `21-feature-traceability-matrix.md` is then generated from the spec rather than maintained by hand, and `x-legacy-source` keeps each endpoint tied to the stored procedure or table it replaces. |

## 7.2 Structure of the published spec

- One document, split by tag into the 17 backend modules of `17` §2.3. Tags mirror module names exactly (`sales`, `purchasing`, `inventory`, `ledger`, `payments`, `access`, …).
- Shared components: `Problem` (RFC 9457), `FieldError`, `PageMeta`, `CursorMeta`, `Money` (string with pattern), `Quantity`, `Percent`, `AuditStamp`, `DocumentStatus`.
- `securitySchemes`: one cookie-based session scheme; every operation lists the permission it needs in `x-permission` (OpenAPI's `security` field cannot express `resource:action` grids, so the extension carries it and O-3 enforces it).
- Examples are **generated from integration-test fixtures**, so a published example is one that actually ran.

## 7.3 Documentation surfaces

| Surface | Audience | Content |
|---|---|---|
| Interactive API reference (served at `/api/v1/docs`, permission-gated) | Implementers, future maintainers | The generated spec with try-it disabled against production |
| **Plain-language endpoint index** | Owner, accountant, auditor | One page per business capability: *what it does, who may do it, what it records, what it cannot do*. Written from `x-audit-event` + `x-permission` + `x-requirement`, so it cannot drift from the code. |
| Migration mapping | Implementers, vendor | Generated from `x-legacy-source`: legacy procedure/table → replacing endpoint(s), with the analysis-document citation |

## 7.4 Versioning the spec

- The spec's `info.version` is the application version; the **API** version stays `v1` under V-2.
- Every additive change bumps the minor version and appends to a generated changelog.
- A stored snapshot of the previous spec is diffed in CI; any **removal or type change** fails the build unless the PR is labelled `api-breaking`, which requires a `/api/v2` path.

---
---

# PART 8 — ADDITIVE-NEW VS REPLACEMENT

`Recommended`. Every endpoint group is classified so the owner can see exactly what is being rebuilt versus what is genuinely new, and so no legacy behaviour disappears without a decision.

## 8.1 Replacements — legacy behaviour, rebuilt

| Endpoint group | Replaces (`Verified`) | Behaviour that changes, and why |
|---|---|---|
| `/sale-invoices`, `/sales/checkout` | `SaleLedger` (148 cols), `Saledetail` (no PK), `sp_PostSaleLedger`, `SP_STOCKLEDGER` | Lean header; split tender; stored COGS; idempotent; gapless numbering; FBR through an outbox |
| `/sale-returns` | `SRLedger`/`SRdetail`, `sp_PostSRLedger` | `costBasis` made explicit per line (fixes the zero-margin free-standing return) |
| `/purchase-invoices` | `Purledger` (100 cols incl. 20 unlabelled account slots), `Purdetail` | Charges become rows with explicit Dr/Cr accounts and an `includeInCost` decision |
| `/purchase-orders`, `/purchase-returns` | `PurOrderHeader/Detail`, `PRLedger/PRdetail` | Outstanding quantity is generated, not tracked by hand; returns must name a lot |
| `/items`, `/item-categories`, `/manufacturers` | `Item` (148 cols), `ItemCategory`, `ItemClass`, `Manufacturer`, `ItemNotes`, `ItemAlert` | Core + extensions; absolute unique codes; no hard delete |
| `/items/{id}/reprice`, `/pricing/*` | `PricePolicy`/`PricePolicyDetail`, five sale-price columns | Server-side delta limits; full price history (legacy `PriceChanges` has **8 rows**) |
| `/stock`, `/stock/movements` | `GodownDetail` (destructive in-place update), `StockReport` (3.2 M rows, no PK), two history caches | Append-only ledger + rebuildable projection; zero-quantity rows retained |
| `/stock-adjustments`, `/stock-takes` | `AdjHeader`/`AdjDetail`, `AdjBufferHeader`/`AdjBufferDetail` | Mandatory GL account on every reason; approval above a threshold; lot identity on every line |
| `/gl/*`, `/gl/journal-entries` | `VirtualGl` (1.02 M rows, no PK), `Accounts` hierarchy, `Global` bindings | Balanced-by-constraint; append-only; period locking; audited bindings |
| `/reports/*`, `/dashboards/*` | 3,015 DataWindows, `ReportData`/`CrossTab_ReportData` scratch tables | Stateless queries — the concurrent-report corruption defect disappears by construction |
| `/settings`, `/option-lists` | `SoftwarePreferences` (1,352), `Preferences` (443 columns), `ConfigSetting`, `Global` | Typed, permissioned, audited; destructive settings removed entirely |
| `/users`, `/roles`, `/permissions` | `Users` (plaintext passwords), `Groups`, `Rights` (483), `GroupRights`, `GroupAllowed*` | Server-enforced; limits evaluated in-transaction; separation of duties |
| `/audit/*` | `ItemLog`, `DeletedSaleItem`, `UserGroupsLog` | One immutable stream; eleven of twelve un-audited event classes closed |
| `/fbr/*` | Port-9111 socket app writing straight onto `SaleLedger`; the commented-out SQL path | Every attempt is a queryable row with its verbatim request and response |
| `/print-templates`, `/labels/print` | 5 print libraries, 4 `*printouts.pbd`, 357 format windows | One renderer, data-driven templates |

## 8.2 Additive-new — capabilities that do not exist today

| Endpoint group | Requirement | Why it is new (`Verified` basis) |
|---|---|---|
| `/payments`, `/payment-methods`, `/payments/*/allocations` | **R2.1** | **No supplier payment has ever been recorded.** Suppliers credited 186.2 M, debited 3.5 M — all purchase returns (`00b` F1.1) |
| `/expenses`, `/expense-categories` | **R2.2** | MARKETING/ADMIN EXPENSES and PAYROLL have **zero GL entries in 19 months** (`00b` F1.3) |
| `/cash-bank-accounts`, `/cash-bank/book`, `/cash-bank/transfers`, `/cash-bank/reconciliations` | **R2.3** | CASH AT BANK has **zero leaf accounts and zero entries** (`07` §2.4) |
| `/cashier-shifts/*` | **R2.4** | `CashierShift` tables exist and are **dormant with zero rows** (`06` §3.6) — activated, not reinvented |
| `/reports/profit-statement`, `/metrics/definitions` | **R2.5** | The legacy GL Income Statement is `Broken/Incomplete` — it reads `StockLedger`, which has 0 rows (`10` §1.2) |
| `/stock-lots/*`, `/expiry/*`, `/recall/trace` | **R4 (D12)** | "Batch" is `'.'` on 95.2 % of rows; only 62 distinct values exist; expiry uses a `2030-12-12` sentinel on 5,867 of 6,165 rows (`06` §6.7, `08` §10) |
| `/admin/visibility/*`, `?includeHidden` | **R1 (D7)** | Only `Item.Active` exists — no scoped visibility, no presets, no bulk undo, no audit of who hid what |
| `/fiscal-periods/*/close`, `/reopen` | new control | Period locking is `Missing`: any date can be posted or edited at any time, forever (`07` §9.1) |
| `/auth/*` in its entirety | new control | **There is no server-side authentication** in the legacy system (`09` Part F) |
| `/admin/opening-balances`, `/admin/migration/*` | **R3 (D10/D11)** | Records the zero/manual/imported decision per balance type, with who chose it and when |
| `/admin/feature-capabilities` | **D1** | Makes "catalogued but deferred" a queryable register rather than a promise |
| `/platform/jobs`, `/stock/snapshots` heartbeat | new control | The legacy daily snapshot can fail silently (`10` §10.1 risk 20) |

## 8.3 Deliberately not built in v1 (catalogued, `deferred`)

`Recommended`, per **D1**. No endpoint is exposed for: hospital/patient/EMR, e-prescription, lab and services invoicing, school, HR/payroll and biometric attendance, hotel/guest, manufacturing/production/recipe, packing/work orders, multi-branch CRS sync, Waseela Mini, DropBox, DataCarry, loyalty, contact/CRM, installments, post-dated cheques as a module, debit/credit notes, aging as a credit-control workflow, incentive sheets, multi-godown transfers, garments attributes, item conversion, vehicles, customer licences. Every one is a row in `feature_capability` with `status = 'deferred'`, its legacy table count and evidence, and is readable through `GET /api/v1/admin/feature-capabilities`. **Nothing is silently dropped.**

Three items are marked `Requires-clarification` rather than `deferred` and are listed in Part 9: expiry intimation (T1-04b), receipts/payments/dues (T1-19), and the 11 named pharma-distributor data exports (T1-38).

---
---

# PART 9 — OPEN QUESTIONS REQUIRING SIGN-OFF

`Recommended`. Each item **blocks** the endpoint(s) named. None may be resolved by inference.

| # | Question | Blocks | Owner of the answer | Why it cannot be guessed |
|---|---|---|---|---|
| **V-1** | Confirm the eight-role mapping and the starting permission matrix, including that `purchase_officer` **cannot post** and `sales_officer` **cannot see cost** | `/roles`, `/users/*/roles`, all `Required Role` cells | Owner | Today one group holds all 486 rights and the counter groups can post purchases unaided (`09` §I.3 S21). The change is a business decision about trust, not a technical one. |
| **V-2** | **Approve the debit/credit rules for every new R2 posting** — supplier payment, expense, cash/bank transfer, cashier variance, cheque bounce | `/payments`, `/expenses`, `/cash-bank/transfers`, `/cashier-shifts/*/close` | Accountant (**R2.8 binds**) | These postings have never existed. Guessing a contra account produces a plausible, wrong P&L. |
| **V-3** | Which GL leaf accounts should be created under the 9 empty sub-accounts (CASH AT BANK, MARKETING EXPENSES, the three PAYROLL sub-accounts, both STOCK ADJUSTMENT sub-accounts) | `/expenses`, `/cash-bank-accounts`, `/stock-adjustments/*/post`, `GET /ready` | Accountant | Without them the new postings have nowhere to go — precisely why legacy adjustments could never post (`07` §13.3) |
| **V-4** | The default `inventory.expiry.expired_sale_action` (`warn` / `block` / `allow`) and who holds the override | `/sales/checkout`, `/sale-invoices` | Owner + pharmacist | A `block` default stops a sale; an `allow` default risks dispensing expired medicine. Both are business calls. |
| **V-5** | The correct default `costBasis` for a sale return **not linked** to an original invoice | `POST /sale-returns` | Accountant | The legacy behaviour books cost equal to net revenue — zero margin — and is flagged "economically wrong" (`07` §13.1) |
| **V-6** | Default `includeInCost` for each purchase charge type (freight, handling, quantity- and weight-based) | `POST /purchase-invoices`, `/charges` | Accountant | It materially changes gross profit and the legacy schema never records the choice (`06` §6.8 L3) |
| **V-7** | Meaning of the two unresolved legacy counters — `SaleLedgerCashDummy` (222) and `_HeaderTabMaxKey` Module 3 (18,694) | Document-series seeding, therefore **every** document endpoint | Vendor | Seeding a series from a misunderstood counter re-issues printed numbers (MR-2, Critical) |
| **V-8** | Whether the 1,488 purchase-return numbers with no surviving document represent deleted financial documents | `/purchase-returns` reconciliation | Vendor + accountant | If they were deleted, the migration reconciliation baseline is wrong (`06` §10 V6) |
| **V-9** | Is `DeletedSaleItem` at 235,887 rows normal POS correction or a workflow problem? | `/sales/removed-lines` thresholds and alerting | Owner + shift in-charge | Determines whether this is a routine log or an exception report (`06` §10 V8) |
| **V-10** | Should T1-04b expiry intimation, T1-19 receipts/dues and T1-38 distributor exports be built, deferred or removed? | `/purchase-returns/expiry-candidates` extensions; no endpoints exist for the other two | Owner | All three are `Requires-clarification` in `03`; building the wrong one wastes a sprint, dropping the wrong one loses a workflow |
| **V-11** | Sale-return fiscalisation jumped from 5.9 % (2025) to 99.87 % (2026) | `/fbr/reconciliation` interpretation | Tax adviser | A discontinuity in a statutory record needs explaining before it is reported on |
| **V-12** | Retention horizon for `audit_event` beyond the statutory 7 years, and where cold-storage exports live | `/audit/export`, partition-drop job | Owner | Dropping a partition is irreversible |

---
---

# PART 10 — RESIDUAL RISKS CARRIED INTO IMPLEMENTATION

`Recommended`.

| # | Risk | Mitigation built into this API plan | Residual exposure |
|---|---|---|---|
| **A-R1** | A financial endpoint ships without an idempotency key | O-3 route-enumeration test fails the build; §0.9 pairs `E-FIN` with `Required` in every table | A new endpoint added outside the `E-FIN` classification could slip through; the classification is reviewed at PR time |
| **A-R2** | Document-number allocation races under concurrent POS use | T-5 (allocate last), `FOR UPDATE`, and the go-live gate of ≥20 concurrent sessions × 500 allocations asserting zero duplicates | Depends on the seeding step V-7 being answered correctly |
| **A-R3** | A role limit is bypassed because it is checked at the edge and not in the transaction | §0.13.3 mandates in-transaction evaluation, and the permission-matrix test submits a 40 % discount as `sales_officer` and asserts `403` with **no database side effect** | A limit added later without a matching test |
| **A-R4** | The plain-language profit statement is trusted before expenses are being entered consistently | `caveats[]` in the payload; `/audit/coverage` shows whether expense entry is actually happening | Behavioural — it depends on the shop adopting R2.2 |
| **A-R5** | Report figures diverge between dashboard, daily P&L and profit statement | Single metric layer, `/metrics/definitions` published, and a consistency test asserting identical gross profit for the same period | A report that bypasses the metric layer; forbidden by review, not by the compiler |
| **A-R6** | The 6,106 lots landing with unknown expiry make the R4.2 dashboard look empty rather than incomplete | `/expiry/unknown-queue` surfaces them as a work queue with a total; the dashboard reports `unknownLotCount` alongside every bucket | Resolution requires physical stock-take effort |
| **A-R7** | An external FBR outage is misread as a system failure at the counter | Checkout returns `201` with `fbrStatus: "queued"`; `503` is never surfaced as a checkout failure; `/fbr/queue` shows the backlog | Prolonged outages create a large backlog needing operational attention |
| **A-R8** | Break-glass becomes routine | Time-boxed ≤60 min, per-user MFA, mandatory reason, owner alert, and a `/audit/security-events` review report | Cultural; the control is visibility, not prevention |

---

## Document control

| Field | Value |
|---|---|
| Document | `18-api-plan.md` |
| Depends on | `00b` (decisions D1–D12, P1, R1–R4, finding F1), `03` (module catalogue), `09` (RBAC), `17` (architecture), `19` (schema) |
| Feeds | implementation, `21-feature-traceability-matrix.md`, the generated OpenAPI 3.1 document |
| Endpoint groups defined | 26 across 17 backend modules |
| Endpoints requiring an idempotency key | every `E-FIN` operation — all creates, posts, cancels, reverses and approvals on sales, returns, purchases, adjustments, stock takes, payments, expenses, transfers, shifts and journals |
| Endpoints with **no** write path by design | `/audit/*` (append-only, enforced by grant and trigger), `/gl/journal-lines` (does not exist), `/reports/*` (read-only pool, no write grant), `/stock` (stock is moved, never set), item hard-delete (does not exist) |
| Legacy system modified | **No.** Read-only analysis throughout. |
| Status | Draft — Parts 9 items V-1…V-12 must be answered before the endpoints they block are implemented |




