// The public surface of `accounting` (§3.1, B4). Grows as the follow-up agent adds
// controllers/services beneath this directory -- keep exports here in sync with what other
// modules are meant to consume (mirror settings/index.ts's convention).
export { AccountingModule } from "./accounting.module.js";
export { GlAccountService } from "./application/gl-account.service.js";
export { JournalEntryService } from "./application/journal-entry.service.js";
export { CashBankService } from "./application/cash-bank.service.js";
export { LedgerQueryService } from "./application/ledger-query.service.js";
