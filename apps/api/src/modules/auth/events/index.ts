// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.4 (domain events emitted by a
// module). `auth` emits none in Phase 1 -- placeholder kept so every module has the identical
// shape (§3.2 "Identical internal shape for all 17 modules"). login.success/login.fail/
// logout/password.change are recorded as `security_audit` rows once that table's writer exists
// (09 §I.2) -- not yet wired; see auth.service.ts.
export {};
