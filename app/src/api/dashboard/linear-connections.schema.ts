import { z } from "zod";

export const probeBody = z.object({ apiKey: z.string() });

export const probeGithubBody = z.object({ token: z.string() });

export const probeGithubAppBody = z.object({
  appId: z.string(),
  privateKey: z.string(),
  installationId: z.string().optional(),
});

export const createConnectionBody = z.object({
  name: z.string(),
  apiKey: z.string(),
  organizationId: z.string(),
  organizationKey: z.string().optional(),
  webhookSecret: z.string().optional(),
  teamId: z.string().nullable().optional(),
  teamKey: z.string().nullable().optional(),
  githubAuthMode: z.union([z.literal("pat"), z.literal("app"), z.null()]).optional(),
  githubToken: z.string().nullable().optional(),
  githubAppId: z.string().nullable().optional(),
  githubInstallationId: z.string().nullable().optional(),
  githubAppPrivateKey: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

export const updateConnectionBody = createConnectionBody.partial();
