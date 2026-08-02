import { z } from "zod";

export const createChannelBody = z.object({
  type: z.string(),
  name: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const updateChannelBody = z.object({
  name: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const setRuleBody = z.object({
  enabled: z.boolean().optional(),
});
