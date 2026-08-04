// Blueprint: docs/system-analysis/18-api-plan.md §6.5 "Notifications" (fuller spec: rules/
// channels admin CRUD, a "test channel" endpoint, email/SMS/push delivery -- all explicitly
// DEFERRED, see notification.service.ts's own header comment). This wave delivers the in-app
// surface only: list-my-notifications + mark-read + mark-all-read. Field list/shape narrowed to
// exactly what `notification` (packages/db/schema/notifications.ts) actually carries, mirroring
// expense.dto.ts's own "build against the schema as it landed" convention.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);

export const NotificationIdParamSchema = z.object({ id: zIntString });
export class NotificationIdParamDto extends createZodDto(NotificationIdParamSchema) {}

/**
 * GET /notifications -- offset/limit pagination only (mirrors ListExpensesQuerySchema's shape).
 * No status/kind filter in this wave -- the endpoint always returns the current actor's own
 * visible set (own `recipientUserId` rows plus every `recipientRoleKey` row matching one of the
 * actor's roles), unread-first, exactly per this task's instruction; a narrower "show only
 * unread" toggle is easy to add later but wasn't asked for here.
 */
export const ListNotificationsQuerySchema = z.object({
  offset: zIntString.optional(),
  limit: zIntString.optional(),
});
export class ListNotificationsQueryDto extends createZodDto(ListNotificationsQuerySchema) {}
export type ListNotificationsInput = z.infer<typeof ListNotificationsQuerySchema>;
