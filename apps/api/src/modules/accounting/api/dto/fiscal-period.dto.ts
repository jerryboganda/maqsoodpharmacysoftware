// Blueprint: docs/system-analysis/12-risks-gaps.md R-013 (CRITICAL) -- "Implement soft period
// lock (warn) and hard period lock (block, supervisor override, audited)". Wave 9: the enforcement
// half already existed (common/docflow/fiscal-period.service.ts's own `resolveOpenPeriod`); these
// DTOs back the missing admin half -- close/reopen. Mirrors branch.dto.ts's own zIntString +
// optional-`reason` conventions (CancelSaleInvoiceSchema's own precedent: `reason` accepted for
// the audit trail, not persisted to a dedicated column here -- fiscal_period has no reason column
// of its own, and AuditInterceptor already captures the full request body on every mutating route).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

// Mirrors branch.dto.ts's own zIntString -- fiscal_period_id is a BIGINT UNSIGNED idPk
// (docflow.ts), never negative/fractional.
const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);

export const FiscalPeriodIdParamSchema = z.object({ id: zIntString });
export class FiscalPeriodIdParamDto extends createZodDto(FiscalPeriodIdParamSchema) {}

export const CloseFiscalPeriodSchema = z.object({ reason: z.string().min(1).max(500).optional() });
export class CloseFiscalPeriodDto extends createZodDto(CloseFiscalPeriodSchema) {}

export const ReopenFiscalPeriodSchema = z.object({ reason: z.string().min(1).max(500).optional() });
export class ReopenFiscalPeriodDto extends createZodDto(ReopenFiscalPeriodSchema) {}
