import { z } from "zod";

export const configResponse = z.object({
  backend: z.string(),
  groups: z.array(z.record(z.string(), z.unknown())),
  recipes: z.array(z.record(z.string(), z.unknown())),
});
