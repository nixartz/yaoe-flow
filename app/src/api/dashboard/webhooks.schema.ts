import { z } from "zod";

export const webhooksQuery = z.object({
  issueId: z.string().optional(),
  teamId: z.string().optional(),
  projectId: z.string().optional(),
  q: z.string().optional(),
  page: z.coerce.number().optional(),
  pageSize: z.coerce.number().optional(),
});
