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

  // Dev-time CORS for apps/web (Vite on :5173) talking to apps/api (:3000). Tighten this to
  // an explicit allow-list before any non-development deployment.
  app.enableCors({ origin: true, credentials: true });

  const port = Number(process.env["PORT"] ?? 3000);
  const host = process.env["HOST"] ?? "0.0.0.0";

  await app.listen(port, host);
  logger.log(`Pharmacy API listening on http://${host}:${port}`);
}

bootstrap().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error during bootstrap:", error);
  process.exitCode = 1;
});
