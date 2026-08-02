// Blueprint: docs/system-analysis/17-technical-blueprint.md §8.3 Decision D-06 -- "TanStack
// Query v5 as the only mechanism for server data." Retry/backoff and refetch-on-focus are
// deliberate: a counter PC is left unattended and returned to, and the LAN may be flaky
// (§8.3, D13 offline posture -- read-degraded, write-blocked).
import { QueryClient } from "@tanstack/react-query";

import { ApiError } from "./api-client.js";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Don't burn retries on a request that was correctly rejected (4xx) -- only retry
        // network failures and 5xx/503 (FBR-style "dependency unavailable", §9.4 E-7).
        if (error instanceof ApiError && error.problem.status < 500) return false;
        return failureCount < 3;
      },
      refetchOnWindowFocus: true,
      staleTime: 30_000,
    },
    mutations: {
      // Financial mutations must never retry silently -- a retried POST without an
      // idempotency key could double-post (§7.5). Non-financial mutations opt in explicitly.
      retry: false,
    },
  },
});
