import { z } from "zod";

export const overviewQuery = z.object({
  days: z.coerce.number().min(1).max(90).optional(),
});
