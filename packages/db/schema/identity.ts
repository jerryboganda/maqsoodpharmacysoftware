// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md §T11 `app_user`, §T12
// `user_session`; docs/system-analysis/09-roles-permissions.md Part F (legacy has NO server-side
// authentication at all -- `Missing`, Verified) and Part I.5 (recommended non-negotiable
// controls); docs/system-analysis/00b-owner-decisions-and-requirements.md D16/R6 (tenant_id) and
// D21 (owner is a platform-level admin across all tenants; staff are per-tenant).
import { sql } from "drizzle-orm";
import { boolean, char, datetime, index, mysqlTable, smallint, uniqueIndex, varbinary, varchar } from "drizzle-orm/mysql-core";
import { auditColumns, fkBigInt, idPk, softDeleteColumns, TIMESTAMP_FSP } from "./_shared";
import { branches, tenants } from "./tenant";

/**
 * A person who can sign in. §T11: legacy `Users` (9 rows) stores `Password varchar(60)` in
 * **plaintext** (`06` §6.8 L1, Verified, Critical; migration risk MR-3) -- never migrated. Every
 * user is force-reset at first login (09 §I.5, §I.6 step 5).
 *
 * `tenant_id` is NULLABLE, unlike almost every other tenant-owned table in this package.
 * // TODO(blueprint): 00b D21 ("Both -- me across sites, staff per-site") establishes that the
 * // owner administers the platform across ALL tenants while site staff belong to exactly one
 * // tenant, but neither 00b nor 19-mysql-schema-blueprint.md (which predates D16) specifies the
 * // column-level mechanism. This schema models it as `tenant_id IS NULL` = platform-level user
 * // (the owner / platform admin), `tenant_id IS NOT NULL` = scoped to that tenant -- needs
 * // architect/owner confirmation before this table is relied on for real access control, since a
 * // NULL-tenant user with a broad role is a deliberate cross-tenant capability and must be rare
 * // and audited (mirrors the legacy's own `fn_GetGroupCode` MIN(GroupCode) danger, 09 §C.1,
 * // which this design must NOT repeat -- see access.ts `userRoles` for the union-of-grants fix).
 */
export const appUsers = mysqlTable(
  "app_user",
  {
    userId: idPk("user_id"),
    tenantId: fkBigInt("tenant_id").references(() => tenants.tenantId),
    defaultBranchId: fkBigInt("default_branch_id").references(() => branches.branchId),
    username: varchar("username", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    displayNameUr: varchar("display_name_ur", { length: 120 }),
    // Argon2id per 09 §I.5 ("argon2id (or bcrypt cost >= 12)"); 19 §T11 same. Never the legacy
    // plaintext value -- see class comment.
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    passwordAlgo: varchar("password_algo", { length: 32 }).notNull().default("argon2id"),
    passwordChangedAt: datetime("password_changed_at", { fsp: TIMESTAMP_FSP })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    mustChangePassword: boolean("must_change_password").notNull().default(true),
    failedLoginCount: smallint("failed_login_count", { unsigned: true }).notNull().default(0),
    lockedUntil: datetime("locked_until", { fsp: TIMESTAMP_FSP }),
    // 09 §I.5: "MFA required for sys_admin, owner, accountant, pharmacy_manager." Encrypted at
    // rest; NULL = not enrolled.
    mfaSecretEnc: varbinary("mfa_secret_enc", { length: 255 }),
    email: varchar("email", { length: 190 }),
    phone: varchar("phone", { length: 32 }),
    fatherName: varchar("father_name", { length: 120 }),
    address: varchar("address", { length: 255 }),
    isActive: boolean("is_active").notNull().default(true),
    locale: varchar("locale", { length: 12 }).notNull().default("en-PK"), // D15: bilingual English/Urdu
    legacyId: smallint("legacy_id", { unsigned: true }), // legacy Users.UserCode
    ...auditColumns(),
    ...softDeleteColumns(),
  },
  (table) => ({
    // NOTE: username uniqueness is intentionally NOT scoped by tenant_id. A platform-wide unique
    // username keeps sign-in simple (username alone resolves a user, no tenant selector needed)
    // and sidesteps the "multiple NULL tenant_id values are distinct under UNIQUE" MySQL
    // behaviour that would otherwise let two platform-level admins collide silently.
    usernameUnique: uniqueIndex("uk_app_user_username").on(table.username),
    legacyUnique: uniqueIndex("uk_app_user_legacy").on(table.legacyId),
    tenantActiveIdx: index("ix_app_user_tenant_active").on(table.tenantId, table.isActive),
  }),
);

/**
 * §T12 `user_session` -- server-side session register enabling revocation and "who is logged in
 * right now". `Missing` in the legacy system: "legacy authentication is entirely client-side and
 * there is no server-side authentication at all" (09 §F.1, Verified). `tenant_id`/`branch_id` are
 * denormalised from the owning user at issue time (not just derivable via a join) so that
 * tenant-scoped session queries and revocation-by-tenant do not require joining to `app_user` --
 * the isolation requirement in R6 ("one tenant must never be able to see or affect another's
 * data, even through a bug") is cheaper to enforce when the session row carries its own tenant.
 */
export const userSessions = mysqlTable(
  "user_session",
  {
    sessionId: char("session_id", { length: 36 }).primaryKey(),
    userId: fkBigInt("user_id").notNull().references(() => appUsers.userId),
    tenantId: fkBigInt("tenant_id").references(() => tenants.tenantId),
    branchId: fkBigInt("branch_id").references(() => branches.branchId),
    issuedAt: datetime("issued_at", { fsp: TIMESTAMP_FSP }).notNull(),
    expiresAt: datetime("expires_at", { fsp: TIMESTAMP_FSP }).notNull(),
    lastSeenAt: datetime("last_seen_at", { fsp: TIMESTAMP_FSP }).notNull(),
    revokedAt: datetime("revoked_at", { fsp: TIMESTAMP_FSP }),
    revokedBy: fkBigInt("revoked_by").references(() => appUsers.userId),
    ipAddress: varbinary("ip_address", { length: 16 }),
    userAgent: varchar("user_agent", { length: 255 }),
    machineName: varchar("machine_name", { length: 64 }), // successor to legacy SaleLedger.MachineName
  },
  (table) => ({
    userIdx: index("ix_user_session_user").on(table.userId, table.issuedAt),
    liveIdx: index("ix_user_session_live").on(table.expiresAt, table.revokedAt),
    tenantIdx: index("ix_user_session_tenant").on(table.tenantId, table.expiresAt),
  }),
);
