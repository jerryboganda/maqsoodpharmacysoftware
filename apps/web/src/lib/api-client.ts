// Blueprint: docs/system-analysis/17-technical-blueprint.md §9.4 -- the client-side half of
// the RFC 9457 error contract (`ProblemDetails`), and §8.3 (TanStack Query is the only
// mechanism for server state; this is the `queryFn`/`mutationFn` transport it calls).
//
// TODO(real client): once `packages/contracts` exists, replace the ad-hoc `ApiProblemError`
// shape below with the shared Zod schema so the server and client agree on one definition
// (§3.2 "packages/contracts as a separate package").

/** Mirrors apps/api/src/common/errors/problem-details.ts -- kept in sync by hand until the
 *  two apps share `packages/contracts`. */
export interface ApiProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly instance: string;
  readonly traceId: string;
  readonly errors?: readonly { path: string; code: string; message: string }[];
}

export class ApiError extends Error {
  readonly problem: ApiProblemDetails;

  constructor(problem: ApiProblemDetails) {
    super(problem.detail);
    this.name = "ApiError";
    this.problem = problem;
  }
}

/** All API calls go through `/api/...`, which `vite.config.ts`'s dev-server proxy forwards to
 *  apps/api (stripping the `/api` prefix). In production this is served by the same reverse
 *  proxy (§11.2), so the path shape never changes between environments. */
const API_BASE = "/api";

export interface ApiRequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  /** §7.5: every mutating financial request must carry one. Not yet required for the
   *  read-only endpoints this client calls in Phase 1. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    credentials: "include",
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (options.signal !== undefined) init.signal = options.signal;

  const response = await fetch(`${API_BASE}${path}`, init);

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json") || contentType.includes("application/problem+json");
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    if (isJson && payload && typeof payload === "object" && "code" in payload) {
      throw new ApiError(payload as ApiProblemDetails);
    }
    throw new ApiError({
      type: "https://errors.pharmacy.local/network-error",
      title: "Request failed",
      status: response.status,
      code: "CLIENT.UNKNOWN_ERROR",
      detail: typeof payload === "string" && payload ? payload : `Request to ${path} failed with status ${response.status}.`,
      instance: path,
      traceId: "n/a",
    });
  }

  return payload as T;
}
