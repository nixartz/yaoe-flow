import { z } from "zod";

export const harnessListResponse = z.object({
  harnesses: z.array(z.record(z.string(), z.unknown())),
  banners: z.array(z.record(z.string(), z.unknown())),
});

export const harnessModelsResponse = z.object({
  harnessId: z.string(),
  modelSelection: z.string(),
  models: z.array(z.record(z.string(), z.unknown())),
  defaultModelId: z.string().nullable().optional(),
  checkedAt: z.string().nullable().optional(),
});

export const budgetsBody = z.object({
  dailyLimit: z.number().optional(),
  weeklyLimit: z.number().optional(),
  monthlyLimit: z.number().optional(),
  unit: z.enum(["usd", "tokens"]).optional(),
  action: z.enum(["avisar", "pausar"]).optional(),
});
