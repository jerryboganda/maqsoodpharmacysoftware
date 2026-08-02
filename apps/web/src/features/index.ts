// Blueprint: docs/system-analysis/17-technical-blueprint.md §3.1 -- "features/ one folder per
// feature slice, mirrors API modules." Empty in Phase 1 (only apps/api/modules/identity and
// modules/settings exist so far, and neither needs a dedicated feature slice yet -- their one
// screen each lives directly under src/app/ and src/surfaces/). The first real feature slice
// (e.g. features/catalog/, features/sales/) should mirror its API module's name.
export {};
