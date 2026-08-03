-- Capacity: preserves already-configured values under the new names.
-- The agents.role CHECK rebuild (senior-engineer → dev) runs in
-- db/index.ts (normalizeAgentRoleDev): the Drizzle migrator executes each
-- statement in isolation and PRAGMA foreign_keys=OFF does not survive the DROP.
UPDATE settings SET key = 'MAX_PMO_WORKERS' WHERE key = 'MAX_REFINERS';
--> statement-breakpoint
UPDATE settings SET key = 'MAX_DEV_WORKERS' WHERE key = 'MAX_WORKERS';
--> statement-breakpoint
UPDATE settings SET key = 'MAX_REVIEWER_WORKERS' WHERE key = 'MAX_REVIEWERS';
