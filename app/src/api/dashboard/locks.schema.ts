import { z } from "zod";

export const lockEntry = z.object({
  issueId: z.string(),
  footprint: z.array(z.string()),
});

export const connectionLocks = z.object({
  connectionId: z.string(),
  connectionName: z.string(),
  locks: z.array(lockEntry),
});

export const locksListResponse = z.object({
  connections: z.array(connectionLocks),
});

export const releaseLockParam = z.object({
  connectionId: z.string().min(1),
  issueId: z.string().min(1),
});
