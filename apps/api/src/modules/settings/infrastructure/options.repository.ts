// Blueprint: docs/system-analysis/17-technical-blueprint.md §10.2 (schema), §10.5 (the P1
// areas from 00b, mapped to option-set keys).
//
// TODO: wire to @pharmacy/db once its `option_set`/`option_value` schema lands (a parallel
// agent owns packages/db/schema -- see the migration note in this repo's task brief). This
// repository's shape (`listValues(setKey)`) is what that swap must preserve; reconcile the
// field names below (camelCase) against whatever column names `@pharmacy/db`'s `options.ts`
// exports and adjust the mapping in the real implementation, not the call sites in
// `application/settings.service.ts`.
//
// Until then, this seeds a representative slice of §10.5's table in memory so
// `GET /settings/options/:key` is exercisable end-to-end.
import { Injectable } from "@nestjs/common";

import type { OptionValue } from "../domain/option-value.js";

let nextId = 1;
function v(
  setKey: string,
  code: string,
  displayName: string,
  opts: Partial<Pick<OptionValue, "isDefault" | "isEnabled" | "groupLabel" | "sortOrder" | "meta" | "minPermission" | "helpText" | "searchTerms">> = {},
): OptionValue {
  return {
    optionValueId: String(nextId++),
    setKey,
    code,
    displayName,
    helpText: opts.helpText ?? null,
    groupLabel: opts.groupLabel ?? null,
    sortOrder: opts.sortOrder ?? 100,
    isEnabled: opts.isEnabled ?? true,
    isDefault: opts.isDefault ?? false,
    isSystem: true,
    minPermission: opts.minPermission ?? null,
    searchTerms: opts.searchTerms ?? null,
    meta: opts.meta ?? null,
  };
}

const SEED: Record<string, readonly OptionValue[]> = {
  "supplier_payment.method": [
    v("supplier_payment.method", "CASH", "Cash", { isDefault: true, groupLabel: "Cash", sortOrder: 10 }),
    v("supplier_payment.method", "BANK_TRANSFER", "Bank transfer", { groupLabel: "Bank", sortOrder: 20, meta: { requiresReference: true } }),
    v("supplier_payment.method", "CHEQUE", "Cheque", { groupLabel: "Bank", sortOrder: 30, meta: { requiresReference: true } }),
    v("supplier_payment.method", "BANK_DRAFT", "Bank draft / pay order", { groupLabel: "Bank", sortOrder: 40, meta: { requiresReference: true } }),
    v("supplier_payment.method", "IBFT", "Online / IBFT", { groupLabel: "Digital wallet", sortOrder: 50 }),
    v("supplier_payment.method", "EASYPAISA", "Easypaisa", { groupLabel: "Digital wallet", sortOrder: 60 }),
    v("supplier_payment.method", "JAZZCASH", "JazzCash", { groupLabel: "Digital wallet", sortOrder: 70 }),
    v("supplier_payment.method", "CREDIT_NOTE", "Credit-note adjustment", { groupLabel: "Adjustment", sortOrder: 80 }),
  ],
  "sale.tender_method": [
    v("sale.tender_method", "CASH", "Cash", { isDefault: true, sortOrder: 10 }),
    v("sale.tender_method", "CARD", "Card", { sortOrder: 20 }),
    v("sale.tender_method", "MOBILE_WALLET", "Mobile wallet", { sortOrder: 30 }),
    v("sale.tender_method", "MIXED", "Mixed / split", { sortOrder: 40 }),
    // Credit ships disabled -- walk-in cash only today (D5); the switch exists, the option
    // is simply off, not removed (P1.3).
    v("sale.tender_method", "CREDIT", "Credit", { sortOrder: 50, isEnabled: false }),
  ],
  "stock_adjustment.reason": [
    v("stock_adjustment.reason", "DAMAGE", "Damage", { sortOrder: 10 }),
    v("stock_adjustment.reason", "EXPIRY", "Expiry", { sortOrder: 20 }),
    v("stock_adjustment.reason", "THEFT_SHRINKAGE", "Theft / shrinkage", { sortOrder: 30 }),
    v("stock_adjustment.reason", "COUNT_CORRECTION", "Count correction", { sortOrder: 40 }),
    v("stock_adjustment.reason", "SAMPLE_DONATION", "Sample / donation", { sortOrder: 50 }),
    v("stock_adjustment.reason", "BREAKAGE", "Breakage", { sortOrder: 60 }),
    v("stock_adjustment.reason", "OTHER", "Other", { sortOrder: 70 }),
    // Deliberately no default (§10.5): a defaulted reason would perpetuate the legacy's
    // unexplained-shrinkage problem (03 T1-31).
  ],
};

@Injectable()
export class OptionsRepository {
  listValues(setKey: string): Promise<readonly OptionValue[]> {
    return Promise.resolve(SEED[setKey] ?? []);
  }

  isKnownSet(setKey: string): Promise<boolean> {
    return Promise.resolve(setKey in SEED);
  }
}
