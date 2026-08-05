// Blueprint: docs/system-analysis/18-api-plan.md Part 5 §5.1 "Module `payments` -- supplier and
// other payments" (R2.1) and §5.3 "cash book, bank book, transfers, cashier shifts" (R2.3/R2.4).
// Wave 5 "lay the shared foundation" package -- this is a deliberately empty skeleton, registered
// in app.module.ts, so the follow-up `payments` agent (payment / payment_method / cash_bank:
// record payments and receipts, allocate against invoices, cash/bank book, transfers,
// reconciliations, cashier shifts) owns this one file plus everything under
// api/application/infrastructure it creates beneath this directory, with zero collision risk
// against the other two follow-up agents (accounting, expenses).
//
// GL posting is "Dr Supplier-or-Customer / Cr Cash-or-Bank" resolving off the already-existing
// supplier.glAccountId / customer.glAccountId / cashBankAccounts.glAccountId columns (parties.ts,
// payments.ts) -- no invented GL account codes needed. JournalService/DocNumberService come from
// the globally-provided DocflowModule (apps/api/src/common/docflow) -- no import needed here,
// constructor-inject directly into whatever service this module adds.
import { Module } from "@nestjs/common";

import { ScopeService } from "../../common/authz/scope.service.js";
import { InventoryModule } from "../inventory/index.js";
import { TenantContextService } from "../inventory/infrastructure/tenant-context.service.js";
import { PaymentMethodsController } from "./api/payment-methods.controller.js";
import { PaymentsController } from "./api/payments.controller.js";
import { PaymentMethodService } from "./application/payment-method.service.js";
import { PaymentService } from "./application/payment.service.js";

@Module({
  // InventoryModule is imported (not exported by it) purely for TenantContextService's shape --
  // mirrors purchasing.module.ts/sales.module.ts's identical import, and TenantContextService is
  // re-provided per-module below for the same reason those two modules do (InventoryModule does
  // not export it).
  imports: [InventoryModule],
  controllers: [PaymentMethodsController, PaymentsController],
  providers: [PaymentMethodService, PaymentService, TenantContextService, ScopeService],
  exports: [PaymentMethodService, PaymentService],
})
export class PaymentsModule {}
