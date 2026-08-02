// Blueprint: docs/system-analysis/17-technical-blueprint.md Part 10 "Implementing P1: options
// are data, not code" -- §10.2 schema. Pure TypeScript, no framework/database imports (§2.2).
//
// P1.1: no business enum exists in TypeScript for a concept modelled here -- the option
// *values* for a set are data, seeded/administered at runtime, never a TS union type.

/** A dimension of choice (§10.2 `option_set`). Introduced by developers; its VALUES are
 *  managed by admins. */
export interface OptionSet {
  readonly setKey: string;
  readonly displayName: string;
  readonly helpText: string | null;
  readonly allowsCustom: boolean;
  readonly isMulti: boolean;
  readonly ownerModule: string;
}

/** One selectable value within an `OptionSet` (§10.2 `option_value`). */
export interface OptionValue {
  readonly optionValueId: string;
  readonly setKey: string;
  /** Stable, never reused (P1.3/P1.7) -- e.g. "BANK_TRANSFER". */
  readonly code: string;
  readonly displayName: string;
  readonly helpText: string | null;
  readonly groupLabel: string | null;
  readonly sortOrder: number;
  readonly isEnabled: boolean;
  readonly isDefault: boolean;
  readonly isSystem: boolean;
  /** P1.5: nullable permission key gating who may choose this value. */
  readonly minPermission: string | null;
  readonly searchTerms: string | null;
  readonly meta: Record<string, unknown> | null;
}
