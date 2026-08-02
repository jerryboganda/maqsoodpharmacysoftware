// Blueprint: docs/system-analysis/17-technical-blueprint.md §9.3 "Validation", layer 1 (Edge).
//
// Every mutating endpoint validates its body/query/params against a Zod schema (nestjs-zod's
// `ZodDto`). Rejects, never coerces (§9.3). On failure, the raw `ZodError` is converted into
// our `AppException` shape so the response is an RFC 9457 problem document with per-field
// `errors[]` (E-4) instead of nestjs-zod's default flat 400 body.
import { HttpStatus } from "@nestjs/common";
import { createZodValidationPipe } from "nestjs-zod";
import type { ZodError } from "zod";

import { AppException } from "../errors/app.exception.js";
import type { ProblemFieldError } from "../errors/problem-details.js";

function toFieldErrors(error: ZodError): ProblemFieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    code: `VALIDATION.${issue.code.toUpperCase()}`,
    message: issue.message,
  }));
}

/** Nest pipe: `@UsePipes(ZodValidationPipe)` or applied globally in `main.ts`. */
export const ZodValidationPipe = createZodValidationPipe({
  createValidationException: (error: ZodError) =>
    new AppException({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: "VALIDATION.FAILED",
      title: "Some fields need attention",
      detail: "One or more fields did not pass validation. See errors[] for details.",
      typeSlug: "validation-failed",
      errors: toFieldErrors(error),
    }),
});
