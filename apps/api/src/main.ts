// Blueprint: docs/system-analysis/17-technical-blueprint.md §3.1, Decision D-02 (§4.3).
// "NestJS 11 running on the Fastify adapter (@nestjs/platform-fastify)... HTTP layer and
// serialization from Fastify."
import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";

import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
  const logger = new Logger("Bootstrap");

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ logger: false }), {
    bufferLogs: true,
  });

  // §7.1 TX-5 / §11: a slow request must fail loudly, not hang the process indefinitely.
  app.enableShutdownHooks();

  // Dev-time CORS for the frontend (Vite on :5173) talking to apps/api (:3001). Tighten this to
  // an explicit allow-list before any non-development deployment.
  //
  // `methods` must be explicit: the Fastify CORS plugin's own default preflight allow-list
  // observed in practice was GET,HEAD,POST only (confirmed via a real browser PATCH request
  // failing `net::ERR_FAILED` after a successful-looking preflight -- curl doesn't enforce CORS
  // so it never surfaced there), which silently broke every edit/deactivate PATCH endpoint in
  // the browser despite them working perfectly over curl and in every backend typecheck/test.
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  // Default 3001, not 3000: on this dev machine port 3000 is already held by an unrelated
  // project (E:\Projects\SAMS\client's own Vite dev server) -- found live 2026-08-05 during a
  // smoke test (its React app came back instead of this API). 3001 is free; PORT in .env can
  // still override per-machine if 3001 ever collides too.
  const port = Number(process.env["PORT"] ?? 3001);
  const host = process.env["HOST"] ?? "0.0.0.0";

  await app.listen(port, host);
  logger.log(`Pharmacy API listening on http://${host}:${port}`);
}

bootstrap().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error during bootstrap:", error);
  process.exitCode = 1;
});
