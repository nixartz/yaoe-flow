import { z } from "zod";

export const setupStatusResponse = z.object({ needsSetup: z.boolean() });

export const setupBody = z.object({
  name: z.string(),
  email: z.string().optional(),
  username: z.string(),
  password: z.string(),
});

export const loginBody = z.object({
  username: z.string().optional(),
  user: z.string().optional(),
  password: z.string(),
});

export const loginResponse = z.object({
  ok: z.literal(true),
  user: z.record(z.string(), z.unknown()),
});

export const meResponse = z.union([
  z.object({ authenticated: z.literal(false) }),
  z.object({ authenticated: z.literal(true), user: z.record(z.string(), z.unknown()) }),
]);
