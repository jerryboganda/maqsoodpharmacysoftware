// Blueprint: docs/system-analysis/17-technical-blueprint.md §7.1-7.3.
//
// `@Transactional()` marks the ONE method per business operation that owns a MySQL
// transaction (TX-2: "One transaction per business operation"). Applied to application
// services only -- never to controllers (no user interaction inside a transaction, TX-4) and
// never to repositories (TX-1).
//
// TODO(real txn): this currently opens an AsyncLocalStorage scope with no real database
// transaction attached (`tx: undefined`). Once @pharmacy/db lands, replace the body with:
//   return dbPool.transaction(async (tx) => TransactionContext.run({ tx, startedAt: new Date() }, () => original.apply(this, args)));
// and add: READ-COMMITTED isolation (§7.3), the deadlock/lock-wait retry policy (max 3
// attempts, jittered backoff, only for MySQL 1213/1205 and only with an idempotency key,
// §7.3), and the deterministic lock order TX-6 (doc_counter -> item -> stock_lot -> gl_entry).
import { TransactionContext } from "./txn-context.js";

export function Transactional(): MethodDecorator {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (_target: object, _propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => unknown;
    descriptor.value = function (this: unknown, ...args: unknown[]) {
      return TransactionContext.run({ tx: undefined, startedAt: new Date() }, () => original.apply(this, args));
    };
    return descriptor;
  };
}
