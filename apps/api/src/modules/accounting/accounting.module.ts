// Blueprint: docs/system-analysis/18-api-plan.md Part 5 §5.4 "Module `ledger` -- chart of
// accounts, journals, periods". Chart-of-accounts read endpoints (gl.account/gl.ledger), manual
// JV/CP/CR/BP/BR vouchers (gl.voucher), and cash & bank (cash_bank) -- built against the Wave 5
// shared foundation (packages/db/schema/{ledger,payments,options}.ts, the seeded permission grid,
// the "JV"/"CBT" doc series and the `voucher_category` option list). Does NOT build
// /gl/trial-balance, /gl/income-statement, or /gl/balance-sheet -- blocked pending U-017
// (financial-statement sign-off), tracked separately, out of scope for this module.
//
// JournalService/DocNumberService/FiscalPeriodService come from the globally-provided
// DocflowModule (apps/api/src/common/docflow) -- no import needed here. TenantContextService has
// no constructor dependencies of its own (a dev-mode tenancy stub, see its header comment) and
// InventoryModule does not export it, so -- mirroring purchasing.module.ts's own identical
// reasoning -- it is provided directly here rather than importing the whole InventoryModule for
// a service this module does not otherwise need anything else from.
import { Module } from "@nestjs/common";

import { TenantContextService } from "../inventory/infrastructure/tenant-context.service.js";
import { CashBankAccountsController } from "./api/cash-bank-accounts.controller.js";
import { CashBankController } from "./api/cash-bank.controller.js";
import { FiscalPeriodsController } from "./api/fiscal-periods.controller.js";
import { GlAccountsController } from "./api/gl-accounts.controller.js";
import { JournalEntriesController } from "./api/journal-entries.controller.js";
import { CashBankService } from "./application/cash-bank.service.js";
import { GlAccountService } from "./application/gl-account.service.js";
import { JournalEntryService } from "./application/journal-entry.service.js";
import { LedgerQueryService } from "./application/ledger-query.service.js";

// FiscalPeriodService (used by FiscalPeriodsController above) comes from the globally-provided
// DocflowModule -- same "no import needed here" reasoning this file's own header comment already
// documents for JournalService/DocNumberService.
@Module({
  controllers: [GlAccountsController, JournalEntriesController, CashBankAccountsController, CashBankController, FiscalPeriodsController],
  providers: [GlAccountService, JournalEntryService, CashBankService, LedgerQueryService, TenantContextService],
  exports: [GlAccountService, JournalEntryService, CashBankService, LedgerQueryService],
})
export class AccountingModule {}
