import { z } from "zod";

export const logsRecentQuery = z.object({
  limit: z.coerce.number().optional(),
});

export const logsRecentResponse = z.object({
  lines: z.array(z.string()),
});
