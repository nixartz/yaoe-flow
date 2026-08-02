import { z } from "zod";

export const runsQuery = z.object({
  status: z.string().optional(),
  role: z.string().optional(),
  backend: z.string().optional(),
  issueId: z.string().optional(),
  page: z.coerce.number().optional(),
  pageSize: z.coerce.number().optional(),
});

export const stopRunBody = z.object({
  reason: z.string().optional(),
});

export const dispatchResponse = z.record(z.string(), z.unknown());
