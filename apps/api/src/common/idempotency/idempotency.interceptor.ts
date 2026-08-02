// Blueprint: docs/system-analysis/17-technical-blueprint.md §7.5 [BINDING] -- the full
// algorithm this interceptor implements (steps numbered to match the spec):
//   1. INSERT (status='in_progress'). On duplicate key: hash differs -> 422; in_progress -> 409
//      Retry-After: 2; succeeded -> replay verbatim with Idempotency-Replayed: true; failed ->
//      allow a fresh attempt.
//   2-3. Run the handler; record the outcome (TODO(real impl): on the SAME connection inside
//        the business commit -- see idempotency-store.ts).
//   4-5. Sweeper/expiry pruning: TODO(real impl), a `platform` module job.
import { createHash } from "node:crypto";

import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { HttpStatus, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Observable } from "rxjs";
import { from, of } from "rxjs";
import { switchMap, tap } from "rxjs/operators";

import { AppException } from "../errors/app.exception.js";
import { IdempotencyStore } from "./idempotency-store.js";
import { REQUIRE_IDEMPOTENCY_KEY } from "./require-idempotency-key.decorator.js";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: IdempotencyStore,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_IDEMPOTENCY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return next.handle();

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const response = context.switchToHttp().getResponse<FastifyReply>();
    const endpoint = `${request.method} ${request.routeOptions?.url ?? request.url}`;
    const idemKey = request.headers[IDEMPOTENCY_KEY_HEADER];

    if (!idemKey || Array.isArray(idemKey)) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: "IDEMPOTENCY.KEY_REQUIRED",
        title: "Idempotency-Key header required",
        detail: "This action must be retried safely. Include an Idempotency-Key header (a UUID minted once when the form is opened).",
        typeSlug: "idempotency-key-required",
      });
    }

    const requestHash = createHash("sha256").update(canonicalize(request.body)).digest("hex");

    return from(this.store.begin(idemKey, endpoint, requestHash)).pipe(
      switchMap((beginResult) => {
        switch (beginResult.outcome) {
          case "hash_mismatch":
            throw new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code: "idempotency_key_reuse",
              title: "Idempotency key already used",
              detail: "This key was used for a different request. Mint a new key for each new form/attempt.",
              typeSlug: "idempotency-key-reuse",
            });
          case "in_progress":
            void response.header("Retry-After", "2");
            throw new AppException({
              status: HttpStatus.CONFLICT,
              code: "IDEMPOTENCY.IN_PROGRESS",
              title: "Already being processed",
              detail: "The first attempt with this key is still running. Please wait a moment.",
              typeSlug: "idempotency-in-progress",
            });
          case "replay":
            void response.header("Idempotency-Replayed", "true");
            void response.status(beginResult.status);
            return of(beginResult.body);
          case "started":
            return next.handle().pipe(
              tap({
                next: (body: unknown) => {
                  void this.store.complete(idemKey, endpoint, response.statusCode, body);
                },
                error: () => {
                  void this.store.fail(idemKey, endpoint);
                },
              }),
            );
        }
      }),
    );
  }
}
