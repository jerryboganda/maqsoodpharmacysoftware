// Proves the two apps can actually talk to each other (or fails honestly if apps/api isn't
// running -- §D13's "read-degraded" posture in miniature): calls GET /identity/health through
// the shared `apiFetch` client and TanStack Query, and renders whatever comes back.
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { apiFetch, ApiError } from "../lib/api-client.js";

interface IdentityHealth {
  readonly status: "ok";
  readonly service: "identity";
  readonly time: string;
}

export function HomeRoute() {
  const { t } = useTranslation();
  const health = useQuery({
    queryKey: ["identity", "health"],
    queryFn: ({ signal }) => apiFetch<IdentityHealth>("/identity/health", { signal }),
  });

  return (
    <section className="mx-auto max-w-xl">
      <h1 className="text-2xl font-semibold">Pharmacy Platform -- Phase 1 Foundations</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        apps/web talking to apps/api via <code>GET /identity/health</code>.
      </p>

      <div className="mt-4 rounded-lg border border-slate-200 p-4 dark:border-slate-800" aria-live="polite">
        {health.isPending && <p>{t("shell.loading")}</p>}

        {health.isError && (
          <div role="alert" className="text-red-700 dark:text-red-400">
            <p className="font-medium">{t("shell.apiUnreachable")}</p>
            <p className="mt-1 text-sm">
              {health.error instanceof ApiError ? health.error.problem.detail : health.error.message}
            </p>
            <p className="mt-1 text-xs text-slate-500">Start apps/api (`pnpm --filter @pharmacy/api dev`) and reload.</p>
          </div>
        )}

        {health.isSuccess && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="font-medium">status</dt>
            <dd>{health.data.status}</dd>
            <dt className="font-medium">service</dt>
            <dd>{health.data.service}</dd>
            <dt className="font-medium">time</dt>
            <dd>{health.data.time}</dd>
          </dl>
        )}
      </div>
    </section>
  );
}
