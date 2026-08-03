import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const ListAdjustmentReasonsQuerySchema = z.object({
  direction: z.enum(["increase", "decrease", "both"]).optional(),
});
export class ListAdjustmentReasonsQueryDto extends createZodDto(ListAdjustmentReasonsQuerySchema) {}
