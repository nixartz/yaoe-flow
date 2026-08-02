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
