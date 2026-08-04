// Blueprint: 19-mysql-schema-blueprint.md §T94 `payment_method` -- "the direct implementation
// of decision D9, add all options for the respective user to select from". Simple LK-pack CRUD
// (mirrors purchase-categories.service.ts's read side / supplier.service.ts's create+update
// shape), plus the light-touch flag-sanity check the task asked for (see the DTO's header
// comment for exactly which two rules are enforced and why).
import { Injectable } from "@nestjs/common";
import { and, asc, eq, ne } from "drizzle-orm";
import { cashBankAccounts, getDb, paymentMethods } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import type { Tx } from "../../../common/db/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { CreatePaymentMethodInput, UpdatePaymentMethodInput } from "../api/dto/payment-method.dto.js";

type PaymentMethodRow = typeof paymentMethods.$inferSelect;

/** The merged view assertSaneFlags checks -- either the full CREATE input or the existing row
 *  with a PATCH overlaid on top. */
interface FlagView {
  readonly requiresBankAccount: boolean;
  readonly requiresChequeDetails: boolean;
  readonly isCounterMethod: boolean;
}

@Injectable()
export class PaymentMethodService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async list(params: { includeDisabled?: boolean | undefined }, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(paymentMethods.tenantId, tenantId)];
    if (!params.includeDisabled) conditions.push(eq(paymentMethods.isEnabled, true));
    const rows = await db
      .select()
      .from(paymentMethods)
      .where(and(...conditions))
      .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.name));
    return { paymentMethods: rows };
  }

  async getById(paymentMethodId: number, actor: Actor): Promise<PaymentMethodRow> {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const [row] = await db
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.paymentMethodId, paymentMethodId)));
    if (!row) {
      throw new AppException({
        status: 404,
        code: "PAYMENT_METHOD.NOT_FOUND",
        title: "Payment method not found",
        detail: `No payment method with id ${paymentMethodId} exists.`,
      });
    }
    return row;
  }

  async create(input: CreatePaymentMethodInput, actor: Actor): Promise<PaymentMethodRow> {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);
    const code = input.code.toUpperCase();

    this.assertSaneFlags(input);

    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ paymentMethodId: paymentMethods.paymentMethodId })
        .from(paymentMethods)
        .where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.code, code)));
      if (existing) {
        throw new AppException({
          status: 409,
          code: "PAYMENT_METHOD.DUPLICATE_CODE",
          title: "Payment method code already used",
          detail: `A payment method with code "${code}" already exists.`,
        });
      }

      if (input.defaultCashBankAccountId !== undefined) {
        await this.assertCashBankAccountExists(tx, tenantId, input.defaultCashBankAccountId);
      }

      // P1.2: at most one default per tenant list -- unset any other default first (functional
      // unique is not expressed at the DB layer for this table, see payments.ts's lack of one;
      // enforced here instead, same "at most one default" intent as sale/purchase categories).
      if (input.isDefault) {
        await tx.update(paymentMethods).set({ isDefault: false, updatedBy: actorId }).where(eq(paymentMethods.tenantId, tenantId));
      }

      await tx.insert(paymentMethods).values({
        tenantId,
        code,
        name: input.name,
        description: input.description ?? null,
        isEnabled: input.isEnabled,
        isDefault: input.isDefault,
        sortOrder: input.sortOrder,
        directionAllowed: input.directionAllowed,
        defaultCashBankAccountId: input.defaultCashBankAccountId ?? null,
        requiresReference: input.requiresReference,
        requiresBankAccount: input.requiresBankAccount,
        requiresChequeDetails: input.requiresChequeDetails,
        settlementLagDays: input.settlementLagDays,
        isCounterMethod: input.isCounterMethod,
        minPermissionId: input.minPermissionId ?? null,
        createdBy: actorId,
        createdSource: "api",
      });

      const [row] = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.code, code)));
      if (!row) throw new Error("payment_method insert did not land"); // unreachable; defensive
      return row;
    });
  }

  async update(paymentMethodId: number, input: UpdatePaymentMethodInput, actor: Actor): Promise<PaymentMethodRow> {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(paymentMethods)
        .where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.paymentMethodId, paymentMethodId)));
      if (!existing) {
        throw new AppException({
          status: 404,
          code: "PAYMENT_METHOD.NOT_FOUND",
          title: "Payment method not found",
          detail: `No payment method with id ${paymentMethodId} exists.`,
        });
      }

      const merged: FlagView = {
        requiresBankAccount: input.requiresBankAccount ?? existing.requiresBankAccount,
        requiresChequeDetails: input.requiresChequeDetails ?? existing.requiresChequeDetails,
        isCounterMethod: input.isCounterMethod ?? existing.isCounterMethod,
      };
      this.assertSaneFlags(merged);

      const nextDefaultCashBankAccountId =
        input.defaultCashBankAccountId === undefined ? undefined : input.defaultCashBankAccountId; // null clears it, a number sets it
      if (typeof nextDefaultCashBankAccountId === "number") {
        await this.assertCashBankAccountExists(tx, tenantId, nextDefaultCashBankAccountId);
      }

      if (input.isDefault === true) {
        await tx
          .update(paymentMethods)
          .set({ isDefault: false, updatedBy: actorId })
          .where(and(eq(paymentMethods.tenantId, tenantId), ne(paymentMethods.paymentMethodId, paymentMethodId)));
      }

      await tx
        .update(paymentMethods)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.directionAllowed !== undefined && { directionAllowed: input.directionAllowed }),
          ...(nextDefaultCashBankAccountId !== undefined && { defaultCashBankAccountId: nextDefaultCashBankAccountId }),
          ...(input.requiresReference !== undefined && { requiresReference: input.requiresReference }),
          ...(input.requiresBankAccount !== undefined && { requiresBankAccount: input.requiresBankAccount }),
          ...(input.requiresChequeDetails !== undefined && { requiresChequeDetails: input.requiresChequeDetails }),
          ...(input.settlementLagDays !== undefined && { settlementLagDays: input.settlementLagDays }),
          ...(input.isCounterMethod !== undefined && { isCounterMethod: input.isCounterMethod }),
          ...(input.minPermissionId !== undefined && { minPermissionId: input.minPermissionId }),
          ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
          ...(input.isEnabled !== undefined && { isEnabled: input.isEnabled }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
          updatedBy: actorId,
        })
        .where(eq(paymentMethods.paymentMethodId, paymentMethodId));

      const [row] = await tx.select().from(paymentMethods).where(eq(paymentMethods.paymentMethodId, paymentMethodId));
      if (!row) throw new Error("payment_method update did not land"); // unreachable; defensive
      return row;
    });
  }

  // ---- helpers ------------------------------------------------------------------------------

  /**
   * Two, deliberately narrow, well-justified rules ("use judgement, don't over-engineer" per the
   * task instruction) -- see CreatePaymentMethodSchema's header comment for the rationale:
   *   1. requiresChequeDetails -> requiresBankAccount (a cheque is a bank instrument).
   *   2. isCounterMethod (P1.5) cannot also require bank account or cheque details (a counter/
   *      till method must be a simple, immediate tender).
   */
  private assertSaneFlags(flags: FlagView): void {
    if (flags.requiresChequeDetails && !flags.requiresBankAccount) {
      throw new BusinessRuleException(
        "PAYMENT_METHOD.CHEQUE_REQUIRES_BANK_ACCOUNT",
        "Inconsistent payment method flags",
        "requiresChequeDetails implies requiresBankAccount -- a cheque is a bank instrument and cannot clear against a cash drawer.",
      );
    }
    if (flags.isCounterMethod && (flags.requiresBankAccount || flags.requiresChequeDetails)) {
      throw new BusinessRuleException(
        "PAYMENT_METHOD.COUNTER_METHOD_CANNOT_REQUIRE_BANK_OR_CHEQUE",
        "Inconsistent payment method flags",
        "isCounterMethod (a cashier counter/till method, P1.5) cannot also require bank account or cheque details -- a counter tender must be simple and immediate.",
      );
    }
  }

  private async assertCashBankAccountExists(tx: Tx, tenantId: number, cashBankAccountId: number): Promise<void> {
    const [row] = await tx
      .select({ cashBankAccountId: cashBankAccounts.cashBankAccountId })
      .from(cashBankAccounts)
      .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.cashBankAccountId, cashBankAccountId)));
    if (!row) {
      throw new BusinessRuleException(
        "PAYMENT_METHOD.CASH_BANK_ACCOUNT_MISSING",
        "Unknown cash/bank account",
        `defaultCashBankAccountId ${cashBankAccountId} does not exist for this tenant.`,
      );
    }
  }
}
