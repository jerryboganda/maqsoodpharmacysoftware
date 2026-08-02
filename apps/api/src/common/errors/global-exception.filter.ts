// Blueprint: docs/system-analysis/17-technical-blueprint.md §9.4.
//
// The one place any error becomes an HTTP response. Maps AppException (typed domain
// failures), Nest's built-in HttpException (thrown by guards/pipes, e.g. ForbiddenException),
// and genuinely unexpected errors (E-5: "nothing internal leaks") onto RFC 9457
// application/problem+json.
import { randomUUID } from "node:crypto";

import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { Catch, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { AppException } from "./app.exception.js";
import { problemType, type ProblemDetails } from "./problem-details.js";

const PROBLEM_CONTENT_TYPE = "application/problem+json";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const traceId = randomUUID();

    const problem = this.toProblemDetails(exception, request.url ?? request.raw?.url ?? "", traceId);

    // E-5: full detail goes to the structured log against traceId; the response body never
    // contains SQL, stack traces, or table names.
    if (problem.status >= 500) {
      this.logger.error(`[${traceId}] ${problem.code}: ${(exception as Error)?.message ?? exception}`, (exception as Error)?.stack);
    } else {
      this.logger.warn(`[${traceId}] ${problem.code}: ${problem.detail}`);
    }

    void response
      .status(problem.status)
      .header("Content-Type", PROBLEM_CONTENT_TYPE)
      .send(problem);
  }

  private toProblemDetails(exception: unknown, instance: string, traceId: string): ProblemDetails {
    if (exception instanceof AppException) {
      return {
        type: problemType(exception.typeSlug),
        title: exception.message,
        status: exception.getStatus(),
        code: exception.code,
        detail: exception.detailMessage,
        instance,
        traceId,
        errors: exception.fieldErrors,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: problemType(httpStatusSlug(status)),
        title: exception.name.replace(/Exception$/, ""),
        status,
        code: `HTTP.${status}`,
        detail: extractHttpMessage(exception),
        instance,
        traceId,
      };
    }

    // E-6/E-7: anything unrecognised is a 500 with no internal detail leaked.
    return {
      type: problemType("internal-error"),
      title: "Something went wrong",
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: "SYSTEM.INTERNAL_ERROR",
      detail: "An unexpected error occurred. Please try again, and quote the reference below if it persists.",
      instance,
      traceId,
    };
  }
}

function extractHttpMessage(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === "string") return body;
  if (body && typeof body === "object" && "message" in body) {
    const msg = (body as { message: unknown }).message;
    if (typeof msg === "string") return msg;
    if (Array.isArray(msg)) return msg.join(" ");
  }
  return exception.message;
}

function httpStatusSlug(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return "bad-request";
    case HttpStatus.UNAUTHORIZED:
      return "unauthenticated";
    case HttpStatus.FORBIDDEN:
      return "forbidden";
    case HttpStatus.NOT_FOUND:
      return "not-found";
    case HttpStatus.CONFLICT:
      return "conflict";
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return "unprocessable";
    case HttpStatus.TOO_MANY_REQUESTS:
      return "rate-limited";
    case HttpStatus.SERVICE_UNAVAILABLE:
      return "unavailable";
    default:
      return "http-error";
  }
}
