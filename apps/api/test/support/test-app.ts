// Shared test-app bootstrap for every integration test in this suite. These are REAL integration
// tests against a REAL MySQL instance (whatever DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME the
// test process's environment points at -- packages/db/client.ts's own `env()` helper reads those,
// unchanged, no test-only override needed there) -- not mocked repositories. This mirrors this
// project's own established practice all the way through its build (every wave's own
// live-verification step): `tsc` passing is not evidence that money/stock/permission logic is
// actually correct.
//
// Built via `Test.createTestingModule({ imports: [AppModule] })` (the standard NestJS testing
// convention) rather than hand-assembling providers -- AppModule already registers every global
// guard/filter/pipe/interceptor (SessionGuard, PermissionGuard, GlobalExceptionFilter,
// ZodValidationPipe, IdempotencyInterceptor, AuditInterceptor -- see app.module.ts's own
// `APP_GUARD`/`APP_FILTER`/`APP_PIPE`/`APP_INTERCEPTOR` providers), so a test hitting a real route
// exercises the EXACT SAME request pipeline production traffic does, not a stripped-down stand-in.
//
// Uses Fastify's own `.inject()` (not a real listening port + supertest/undici) -- lighter weight,
// no port-binding/race concerns across parallel test files, and NestJS's FastifyAdapter exposes
// the underlying Fastify instance directly via `app.getHttpAdapter().getInstance()`.
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { InjectOptions, LightMyRequestResponse } from "fastify";

import { AppModule } from "../../src/app.module.js";

export interface TestApp {
  app: NestFastifyApplication;
  /** Raw Fastify inject -- prefer the typed `request` helper below for JSON bodies/bearer auth;
   *  this is here for the rare case a test needs full control (custom headers, raw payload). */
  inject: (opts: InjectOptions) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
}

/** Boots one real Nest+Fastify app instance. Call once per test FILE (in a `beforeAll`), not per
 *  test -- app construction (module graph resolution, DB pool creation via `getDb()`'s own
 *  singleton) is real setup work, not free, and `vitest.config.ts` already runs test files
 *  sequentially (`fileParallelism: false`) specifically so concurrent files never race on shared
 *  rows -- there is no benefit to a fresh app per test, only cost. */
export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    inject: (opts) => app.getHttpAdapter().getInstance().inject(opts),
    close: async () => {
      await app.close();
    },
  };
}

export interface JsonRequestOptions {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  body?: unknown;
  token?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export interface JsonResponse<T = unknown> {
  status: number;
  json: T;
  raw: LightMyRequestResponse;
}

/** JSON in, JSON out, with `Authorization: Bearer <token>` / `Idempotency-Key` attached when
 *  given -- matches the frontend's own `src/lib/api/client.ts` wrapper shape (the two codebases
 *  independently converged on the same "one small helper wraps every call" pattern), so test code
 *  reads like the real client code these tests are standing in for. */
export async function request<T = unknown>(testApp: TestApp, opts: JsonRequestOptions): Promise<JsonResponse<T>> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const res = await testApp.inject({
    method: opts.method,
    url: opts.url,
    headers,
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
  });

  let json: T;
  try {
    json = res.body ? JSON.parse(res.body) : (undefined as T);
  } catch {
    json = res.body as unknown as T;
  }
  return { status: res.statusCode, json, raw: res };
}

/** A fresh, collision-free UUID for `Idempotency-Key` headers -- every mutating test needs its
 *  own, the same way every live-verification curl call earlier in this project used
 *  `crypto.randomUUID()` per request rather than a fixed key that would 409/return-cached-result
 *  on a second real call. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
