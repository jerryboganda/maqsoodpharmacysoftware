// Blueprint: docs/system-analysis/17-technical-blueprint.md §4.3 "Zod as the single validation
// source"; 09-roles-permissions.md §I.5 ("Min 12 chars ... no reuse of last 5, 90-day rotation
// for privileged roles" -- the length floor is enforced here; breach-list/reuse/rotation are not
// built yet, see auth.service.ts).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { ROLE_KEYS } from "../../../../common/auth/actor.js";

const ROLE_KEY_TUPLE = [...ROLE_KEYS] as [string, ...string[]];

export const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
export class LoginDto extends createZodDto(LoginSchema) {}

export const LoginResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  userId: z.string(),
  username: z.string(),
  displayName: z.string(),
  roles: z.array(z.enum(ROLE_KEY_TUPLE)),
  mustChangePassword: z.boolean(),
});
export class LoginResponseDto extends createZodDto(LoginResponseSchema) {}

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    // 09 §I.5 "Min 12 chars". Breach-list check (k-anonymity HIBP), no-reuse-of-last-5 and
    // 90-day rotation for privileged roles are recommended controls not implemented yet.
    newPassword: z.string().min(12).max(256),
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: "New password must be different from the current password.",
    path: ["newPassword"],
  });
export class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}
