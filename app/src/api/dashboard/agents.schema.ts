import { z } from "zod";

export const createAgentBody = z.object({
  role: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  soulMarkdown: z.string(),
  comment: z.string().optional(),
  harnessId: z.string().optional(),
  activate: z.boolean().optional(),
});

export const updateAgentBody = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
});

export const createVersionBody = z.object({
  soulMarkdown: z.string(),
  comment: z.string().optional(),
  activate: z.boolean().optional(),
});

export const updateHarnessConfigBody = z.object({
  model: z.string().nullable().optional(),
  settingsJson: z.string().optional(),
  mcpServersJson: z.string().optional(),
});

export const activateHarnessBody = z.object({
  harnessId: z.string(),
});

// Empty/omitted `roles` = every role in the plan (the dashboard button applies
// all of them at once); a subset is accepted for parity with `sync-souls --role`.
export const soulSyncBody = z.object({
  roles: z.array(z.string()).optional(),
});
