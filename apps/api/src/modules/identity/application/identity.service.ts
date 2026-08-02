// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.2 "Application" layer --
// use-case orchestration, called by exactly one controller action per method.
import { Injectable, NotFoundException } from "@nestjs/common";

import type { User } from "../domain/user.js";
import { UserRepository } from "../infrastructure/user.repository.js";

export interface HealthStatus {
  readonly status: "ok";
  readonly service: "identity";
  readonly time: string;
}

@Injectable()
export class IdentityService {
  constructor(private readonly users: UserRepository) {}

  health(): HealthStatus {
    return { status: "ok", service: "identity", time: new Date().toISOString() };
  }

  async getUser(userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new NotFoundException(`No user with id "${userId}".`);
    }
    return user;
  }
}
