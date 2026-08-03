// Shared document-flow + ledger-posting services every transactional module (inventory,
// purchasing, sales) depends on. Global so posting services can inject without re-importing.
import { Global, Module } from "@nestjs/common";

import { JournalService } from "../ledger/journal.service.js";
import { DocNumberService } from "./doc-number.service.js";
import { FiscalPeriodService } from "./fiscal-period.service.js";

@Global()
@Module({
  providers: [DocNumberService, FiscalPeriodService, JournalService],
  exports: [DocNumberService, FiscalPeriodService, JournalService],
})
export class DocflowModule {}
