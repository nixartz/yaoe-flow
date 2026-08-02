import { z } from "zod";
import { errorBody } from "../shared/schemas";

export const healthResponse = z.object({
  ok: z.literal(true),
  backend: z.string(),
});

export { errorBody };
