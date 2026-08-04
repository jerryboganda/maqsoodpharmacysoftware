// Blueprint: docs/system-analysis/17-technical-blueprint.md §3.1 "apps/api/src/app.module.ts
// -- imports the 17 feature modules" (2 built so far, Phase 1 -- see modules/identity,
// modules/settings). Cross-cutting concerns (§9) are wired here as global providers so no
// controller can forget to opt in (§4.3).
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";

import { SessionGuard } from "./common/auth/session.guard.js";
import { SessionRepository } from "./common/auth/session.repository.js";
import { PermissionGuard } from "./common/authz/permission.guard.js";
import { PermissionsService } from "./common/authz/permissions.service.js";
import { GlobalExceptionFilter } from "./common/errors/global-exception.filter.js";
import { IdempotencyInterceptor } from "./common/idempotency/idempotency.interceptor.js";
import { IdempotencyStore, MySqlIdempotencyStore } from "./common/idempotency/idempotency-store.js";
import { ZodValidationPipe } from "./common/validation/zod-validation.pipe.js";
import { DocflowModule } from "./common/docflow/index.js";
import { AuthModule } from "./modules/auth/index.js";
import { CatalogModule } from "./modules/catalog/index.js";
import { IdentityModule } from "./modules/identity/index.js";
import { InventoryModule } from "./modules/inventory/index.js";
import { PurchasingModule } from "./modules/purchasing/index.js";
import { SalesModule } from "./modules/sales/index.js";
import { SettingsModule } from "./modules/settings/index.js";

@Module({
  imports: [
    DocflowModule,
    AuthModule,
    IdentityModule,
    SettingsModule,
    CatalogModule,
    InventoryModule,
    PurchasingModule,
    SalesModule,
  ],
  providers: [
    // Order matters: SessionGuard attaches `request.actor` before PermissionGuard reads it.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    // SessionGuard is registered as a global APP_GUARD (not via a module's own `providers`),
    // so its own constructor deps -- SessionRepository -- must be resolvable from this root
    // module's provider graph too.
    SessionRepository,
    PermissionsService,

    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_PIPE, useClass: ZodValidationPipe },

    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: IdempotencyStore, useClass: MySqlIdempotencyStore },
  ],
})
export class AppModule {}
