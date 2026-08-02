// Blueprint: docs/system-analysis/17-technical-blueprint.md §7.1 rules TX-1/TX-2.
// "The application service owns the transaction. Repositories never open one." The unit of
// work is propagated via AsyncLocalStorage so a repository can find "the current transaction"
// without it being threaded through every function call.
import { AsyncLocalStorage } from "node:async_hooks";

export interface UnitOfWork {
  /** TODO(real txn): the Drizzle `tx` handle from `db.transaction()`, once @pharmacy/db lands.
   *  Repositories read this instead of the pool when it is present (§7.1). */
  readonly tx: unknown;
  readonly startedAt: Date;
}

const storage = new AsyncLocalStorage<UnitOfWork>();

export const TransactionContext = {
  run<T>(uow: UnitOfWork, fn: () => T): T {
    return storage.run(uow, fn);
  },

  /** Read-paths may run outside a transaction; this is `undefined` for them. */
  current(): UnitOfWork | undefined {
    return storage.getStore();
  },

  /** Repositories on write-paths call this and fail loudly if it is missing -- a
   *  mutating repository method invoked outside `@Transactional()` is a programming error
   *  (TX-1), not a case to silently fall back to an ad-hoc connection. */
  require(): UnitOfWork {
    const uow = storage.getStore();
    if (!uow) {
      throw new Error(
        "No transaction is open on this async context. Repositories that write must only be " +
          "called from a method decorated with @Transactional() (§7.1, rule TX-1).",
      );
    }
    return uow;
  },
};
