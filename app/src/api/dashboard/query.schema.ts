import { z } from "zod";

export const queryBody = z.object({
  fields: z.array(z.string()).optional(),
  filters: z
    .array(
      z.object({
        field: z.string(),
        op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
        value: z.union([z.string(), z.number()]),
      })
    )
    .optional(),
  query: z.string().optional(),
  q: z.string().optional(),
  from: z.number().optional(),
  to: z.number().optional(),
  sort: z
    .array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]) }))
    .optional(),
  limit: z.number().optional(),
  page: z.number().optional(),
});

export const entityParam = z.object({
  entity: z.enum(["log_lines", "runs", "webhook_events"]),
});
