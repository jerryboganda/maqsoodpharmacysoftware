// Blueprint: §2.5 -- exports only the public surface. `SessionRepository` is registered on the
// root `AppModule` (it also backs the global `SessionGuard`) rather than provided again here.
import { Module } from "@nestjs/common";

import { SessionRepository } from "../../common/auth/session.repository.js";
import { AuthController } from "./api/auth.controller.js";
import { AuthService } from "./application/auth.service.js";
import { CredentialsRepository } from "./infrastructure/credentials.repository.js";

@Module({
  controllers: [AuthController],
  providers: [AuthService, CredentialsRepository, SessionRepository],
  exports: [AuthService],
})
export class AuthModule {}
