import { z } from "zod";

export const settingValueBody = z.object({ value: z.string() });
