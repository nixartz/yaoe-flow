import { z } from "zod";

export const readinessQuery = z.object({
  connectionId: z.string().min(1).optional(),
});

const reasonSchema = z.object({
  code: z.string(),
  detail: z.string(),
  label: z.string().optional(),
  deps: z
    .array(
      z.object({
        issueId: z.string(),
        identifier: z.string(),
        stateName: z.string(),
      })
    )
    .optional(),
  collidingIssueIds: z.array(z.string()).optional(),
  collisions: z
    .array(
      z.object({
        issueId: z.string(),
        identifier: z.string(),
        stateName: z.string().nullable(),
        overlappingEntries: z.array(z.object({ ours: z.string(), theirs: z.string() })),
      })
    )
    .optional(),
  attempts: z.number().optional(),
  maxAttempts: z.number().optional(),
  mergingIssueId: z.string().nullable().optional(),
  mergingIssueIdentifier: z.string().nullable().optional(),
  prOwner: z.string().optional(),
});

const issueSchema = z.object({
  issueId: z.string(),
  identifier: z.string(),
  title: z.string(),
  stateName: z.string(),
  phase: z.enum(["refine", "implement", "review", "merge", "blocked"]),
  status: z.enum(["ready", "waiting_capacity", "blocked_by_rule", "estimating", "waiting_human"]),
  reasons: z.array(reasonSchema),
  tier: z.enum(["reopened", "planned"]).nullable(),
  attempts: z.number(),
  maxAttempts: z.number(),
  hasFootprint: z.boolean(),
  hasLock: z.boolean(),
  blockedComment: z.string().nullable(),
});

const seatSchema = z.object({
  occupied: z.number(),
  max: z.number(),
  free: z.number(),
});

export const readinessSnapshotSchema = z.object({
  updatedAt: z.number(),
  connectionId: z.string(),
  connectionName: z.string(),
  organizationId: z.string(),
  organizationKey: z.string().nullable(),
  capacity: z.object({
    refine: seatSchema,
    implement: seatSchema,
    review: seatSchema,
    merge: z.object({
      max: z.number(),
      busy: z.boolean(),
      mergingIssueId: z.string().nullable(),
    }),
  }),
  flags: z.object({
    autoDispatchIssues: z.boolean(),
    autoMergeIssues: z.boolean(),
    orchestratorEnabled: z.boolean(),
  }),
  issues: z.array(issueSchema),
});

export const readinessListResponse = z.object({
  ttlSeconds: z.number(),
  snapshots: z.array(readinessSnapshotSchema),
  /** Connections ativas sem snapshot ainda (aguardando tick). */
  missingConnectionIds: z.array(z.string()),
});
