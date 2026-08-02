-- Capacidade: preserva valores já configurados sob os novos nomes.
-- O rebuild do CHECK de agents.role (senior-engineer → dev) roda em
-- db/index.ts (normalizeAgentRoleDev): o migrator do Drizzle executa cada
-- statement isolado e o PRAGMA foreign_keys=OFF não sobrevive ao DROP.
UPDATE settings SET key = 'MAX_PMO_WORKERS' WHERE key = 'MAX_REFINERS';
--> statement-breakpoint
UPDATE settings SET key = 'MAX_DEV_WORKERS' WHERE key = 'MAX_WORKERS';
--> statement-breakpoint
UPDATE settings SET key = 'MAX_REVIEWER_WORKERS' WHERE key = 'MAX_REVIEWERS';
