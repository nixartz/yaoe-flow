import { z } from "zod";

export const recipeResponse = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  extensions: z.unknown().optional(),
  instructions: z.string().optional(),
});
