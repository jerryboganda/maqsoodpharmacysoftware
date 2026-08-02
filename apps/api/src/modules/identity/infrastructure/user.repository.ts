// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.2 "Infrastructure" layer;
// §3.1 (apps/api imports @pharmacy/db); 09-roles-permissions.md §I.2 `app_user`.
//
// TODO: wire to @pharmacy/db once the schema lands. This repository should become:
//   const [row] = await db.select().from(appUser).where(eq(appUser.userId, userId));
// joined through `user_role` -> `role` for the roles array (union semantics, 09 §I.1
// principle 5). Until then it resolves the same fixed dev users the SessionGuard stub
// authenticates as (common/auth/session.guard.ts), so the API is exercisable end-to-end.
import { Injectable } from "@nestjs/common";

import type { User } from "../domain/user.js";

const DEV_USERS: readonly User[] = [
  { userId: "dev-0", username: "dev.owner", displayName: "Dev Owner (stub)", roles: ["owner"], isActive: true },
];

@Injectable()
export class UserRepository {
  findById(userId: string): Promise<User | null> {
    return Promise.resolve(DEV_USERS.find((u) => u.userId === userId) ?? null);
  }
}
