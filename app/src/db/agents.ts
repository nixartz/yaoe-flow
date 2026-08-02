// Entidade Agent (Fase 1, §6): variantes por papel com SOUL versionada
// (append-only) e config POR HARNESS que nunca é apagada implicitamente (D3).
// A fonte da verdade em runtime é o BANCO; agents/*.SOUL.md são seed/interchange.
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { appDb } from "./index";
import { agents, agentVersions, agentHarnessConfigs } from "./schema";
import {
  AGENT_ROLES,
  ROLE_METAS,
  readSoulFile,
  toAgentRole,
  type AgentRole,
  type SchedulerRole,
  type McpServerConfig,
} from "../agent/recipe/defaults";
import { log } from "../logger";
import { config } from "../config";
import { decryptSecret, encryptSecret, isEncrypted } from "./secrets";

// Campos de settingsJson que carregam CREDENCIAL (ex.: keyOverride do hermes,
// apiKey de provider openai-compatible do goose) — cifrados at-rest (§5.2) na
// escrita e decifrados só na resolução do dispatch; a API devolve mascarado.
const SECRET_SETTINGS_FIELDS = new Set(["keyOverride", "apiKey"]);

function encryptSecretFields(settingsJson: string): string {
  try {
    const parsed = JSON.parse(settingsJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return settingsJson;
    for (const field of SECRET_SETTINGS_FIELDS) {
      const v = parsed[field];
      if (typeof v === "string" && v && !isEncrypted(v)) parsed[field] = encryptSecret(v);
    }
    return JSON.stringify(parsed);
  } catch {
    return settingsJson;
  }
}

export function decryptSecretFields(settings: Record<string, unknown>): Record<string, unknown> {
  const out = { ...settings };
  for (const field of SECRET_SETTINGS_FIELDS) {
    const v = out[field];
    if (typeof v === "string" && isEncrypted(v)) out[field] = decryptSecret(v);
  }
  return out;
}

export type AgentRow = typeof agents.$inferSelect;
export type AgentVersionRow = typeof agentVersions.$inferSelect;
export type HarnessConfigRow = typeof agentHarnessConfigs.$inferSelect;

export class AgentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function assertRole(role: string): asserts role is AgentRole {
  const normalized = toAgentRole(role);
  if (!AGENT_ROLES.includes(normalized)) {
    throw new AgentError(`papel inválido: ${role} (esperado ${AGENT_ROLES.join("|")})`);
  }
}

function normalizeRole(role: string): AgentRole {
  assertRole(role);
  return toAgentRole(role);
}

// ── Leitura ──

export function listAgents(): AgentRow[] {
  return appDb().orm.select().from(agents).all();
}

export function getAgent(id: string): AgentRow | undefined {
  return appDb().orm.select().from(agents).where(eq(agents.id, id)).get();
}

export function listVersions(agentId: string): AgentVersionRow[] {
  return appDb()
    .orm.select()
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId))
    .orderBy(desc(agentVersions.version))
    .all();
}

export function getVersion(versionId: string): AgentVersionRow | undefined {
  return appDb().orm.select().from(agentVersions).where(eq(agentVersions.id, versionId)).get();
}

export function listHarnessConfigs(agentId: string): HarnessConfigRow[] {
  return appDb().orm.select().from(agentHarnessConfigs).where(eq(agentHarnessConfigs.agentId, agentId)).all();
}

export function getHarnessConfig(agentId: string, harnessId: string): HarnessConfigRow | undefined {
  return appDb()
    .orm.select()
    .from(agentHarnessConfigs)
    .where(and(eq(agentHarnessConfigs.agentId, agentId), eq(agentHarnessConfigs.harnessId, harnessId)))
    .get();
}

/** Resolução usada pelo dispatch: agente ATIVO do papel + versão + config do harness ativo. */
export interface ActiveAgentResolution {
  agent: AgentRow;
  version: AgentVersionRow;
  harnessId: string;
  harnessConfig: HarnessConfigRow | undefined;
}

export function activeAgentForRole(role: SchedulerRole): ActiveAgentResolution | null {
  const agentRole = toAgentRole(role);
  const agent = appDb()
    .orm.select()
    .from(agents)
    .where(and(eq(agents.role, agentRole), eq(agents.isActive, 1)))
    .get();
  if (!agent || !agent.activeVersionId) return null;
  const version = getVersion(agent.activeVersionId);
  if (!version) return null;
  return {
    agent,
    version,
    harnessId: agent.activeHarnessId,
    harnessConfig: getHarnessConfig(agent.id, agent.activeHarnessId),
  };
}

// ── Escrita ──

export interface CreateAgentInput {
  role: string;
  name: string;
  description?: string | null;
  soulMarkdown: string;
  comment?: string;
  harnessId?: string;
  createdBy?: string | null;
  /** true = já nasce ativa (desativa a irmã ativa do papel, se houver). */
  activate?: boolean;
}

export function createAgent(input: CreateAgentInput): AgentRow {
  const role = normalizeRole(input.role);
  if (!input.name?.trim()) throw new AgentError("nome é obrigatório");
  if (!input.soulMarkdown?.trim()) throw new AgentError("soulMarkdown é obrigatório");

  const { sqlite } = appDb();
  const now = Date.now();
  const agentId = randomUUID();
  const versionId = randomUUID();
  const harnessId = input.harnessId ?? "goose";

  const tx = sqlite.transaction(() => {
    sqlite
      .query(
        `INSERT INTO agents (id, role, name, description, is_active, active_version_id, active_harness_id, created_at, updated_at)
         VALUES ($id, $role, $name, $description, 0, $versionId, $harnessId, $now, $now)`
      )
      .run({
        $id: agentId,
        $role: role,
        $name: input.name.trim(),
        $description: input.description?.trim() || null,
        $versionId: versionId,
        $harnessId: harnessId,
        $now: now,
      });
    sqlite
      .query(
        `INSERT INTO agent_versions (id, agent_id, version, soul_markdown, comment, created_at, created_by)
         VALUES ($id, $agentId, 1, $soul, $comment, $now, $by)`
      )
      .run({
        $id: versionId,
        $agentId: agentId,
        $soul: input.soulMarkdown,
        $comment: input.comment ?? "versão inicial",
        $now: now,
        $by: input.createdBy ?? null,
      });
  });
  tx.immediate();

  ensureHarnessConfig(agentId, harnessId);
  if (input.activate) activateAgent(agentId);
  return getAgent(agentId)!;
}

/** Nova versão da SOUL (append-only). `comment` é obrigatório — tipo commit msg (§6.5). */
export function createVersion(
  agentId: string,
  soulMarkdown: string,
  comment: string,
  createdBy: string | null,
  opts?: { activate?: boolean }
): AgentVersionRow {
  const agent = getAgent(agentId);
  if (!agent) throw new AgentError("agente não encontrado", 404);
  if (!soulMarkdown?.trim()) throw new AgentError("soulMarkdown é obrigatório");
  if (!comment?.trim()) throw new AgentError('comment é obrigatório ("o que mudou" — tipo mensagem de commit)');

  const { sqlite } = appDb();
  const id = randomUUID();
  const now = Date.now();
  // Transação IMMEDIATE: o próximo número de versão é lido e usado atomicamente —
  // duas edições concorrentes nunca disputam o mesmo `version`.
  const tx = sqlite.transaction(() => {
    const row = sqlite
      .query(`SELECT COALESCE(MAX(version), 0) AS v FROM agent_versions WHERE agent_id = $agentId`)
      .get({ $agentId: agentId }) as { v: number };
    sqlite
      .query(
        `INSERT INTO agent_versions (id, agent_id, version, soul_markdown, comment, created_at, created_by)
         VALUES ($id, $agentId, $version, $soul, $comment, $now, $by)`
      )
      .run({ $id: id, $agentId: agentId, $version: row.v + 1, $soul: soulMarkdown, $comment: comment.trim(), $now: now, $by: createdBy });
    if (opts?.activate !== false) {
      sqlite
        .query(`UPDATE agents SET active_version_id = $versionId, updated_at = $now WHERE id = $agentId`)
        .run({ $versionId: id, $now: now, $agentId: agentId });
    }
  });
  tx.immediate();
  return getVersion(id)!;
}

/** Ativa uma versão antiga (a "valer"); o histórico nunca é reescrito. */
export function activateVersion(agentId: string, versionId: string): void {
  const version = getVersion(versionId);
  if (!version || version.agentId !== agentId) throw new AgentError("versão não encontrada neste agente", 404);
  appDb().orm.update(agents).set({ activeVersionId: versionId, updatedAt: Date.now() }).where(eq(agents.id, agentId)).run();
}

/**
 * Troca atômica da variante ativa do papel (§6.5): desativa a irmã e ativa
 * esta na MESMA transação — o unique index parcial (role WHERE is_active=1)
 * garante que ativação concorrente nunca deixa duas ativas (critério §6.6).
 */
export function activateAgent(agentId: string): void {
  const agent = getAgent(agentId);
  if (!agent) throw new AgentError("agente não encontrado", 404);
  const { sqlite } = appDb();
  const now = Date.now();
  const tx = sqlite.transaction(() => {
    sqlite
      .query(`UPDATE agents SET is_active = 0, updated_at = $now WHERE role = $role AND is_active = 1`)
      .run({ $role: agent.role, $now: now });
    sqlite.query(`UPDATE agents SET is_active = 1, updated_at = $now WHERE id = $id`).run({ $id: agentId, $now: now });
  });
  tx.immediate();
}

/** Permitido, mas a UI mostra o aviso: o papel fica SEM agente (issues acumulam). */
export function deactivateAgent(agentId: string): void {
  const agent = getAgent(agentId);
  if (!agent) throw new AgentError("agente não encontrado", 404);
  appDb().orm.update(agents).set({ isActive: 0, updatedAt: Date.now() }).where(eq(agents.id, agentId)).run();
}

export function updateAgentMeta(agentId: string, input: { name?: string; description?: string | null }): void {
  const agent = getAgent(agentId);
  if (!agent) throw new AgentError("agente não encontrado", 404);
  const set: Partial<typeof agents.$inferInsert> = { updatedAt: Date.now() };
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new AgentError("nome é obrigatório");
    set.name = input.name.trim();
  }
  if (input.description !== undefined) set.description = input.description?.trim() || null;
  appDb().orm.update(agents).set(set).where(eq(agents.id, agentId)).run();
}

/**
 * Garante a linha de config do harness (D3): selecionar um harness ainda sem
 * config cria a linha com defaults sensatos — nunca copia de outro harness.
 */
export function ensureHarnessConfig(agentId: string, harnessId: string): HarnessConfigRow {
  const existing = getHarnessConfig(agentId, harnessId);
  if (existing) return existing;
  const agent = getAgent(agentId);
  if (!agent) throw new AgentError("agente não encontrado", 404);
  const meta = ROLE_METAS[agent.role as AgentRole];
  appDb()
    .orm.insert(agentHarnessConfigs)
    .values({
      id: randomUUID(),
      agentId,
      harnessId,
      model: null,
      settingsJson: "{}",
      mcpServersJson: JSON.stringify(meta?.defaultMcpServers ?? []),
      updatedAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
  return getHarnessConfig(agentId, harnessId)!;
}

/**
 * D3: trocar o harness ativo NÃO escreve nada nas configs dos outros harness —
 * só garante a linha do novo (defaults) e aponta o ponteiro.
 */
export function setActiveHarness(agentId: string, harnessId: string): void {
  ensureHarnessConfig(agentId, harnessId);
  appDb().orm.update(agents).set({ activeHarnessId: harnessId, updatedAt: Date.now() }).where(eq(agents.id, agentId)).run();
}

export function updateHarnessConfig(
  agentId: string,
  harnessId: string,
  input: { model?: string | null; settingsJson?: string; mcpServersJson?: string }
): HarnessConfigRow {
  ensureHarnessConfig(agentId, harnessId);
  for (const [field, value] of [
    ["settingsJson", input.settingsJson],
    ["mcpServersJson", input.mcpServersJson],
  ] as const) {
    if (value !== undefined) {
      try {
        JSON.parse(value);
      } catch {
        throw new AgentError(`${field}: JSON inválido`);
      }
    }
  }
  const set: Partial<typeof agentHarnessConfigs.$inferInsert> = { updatedAt: Date.now() };
  if (input.model !== undefined) set.model = input.model?.trim() || null;
  if (input.settingsJson !== undefined) set.settingsJson = encryptSecretFields(input.settingsJson);
  if (input.mcpServersJson !== undefined) set.mcpServersJson = input.mcpServersJson;
  appDb()
    .orm.update(agentHarnessConfigs)
    .set(set)
    .where(and(eq(agentHarnessConfigs.agentId, agentId), eq(agentHarnessConfigs.harnessId, harnessId)))
    .run();
  return getHarnessConfig(agentId, harnessId)!;
}

/** Delete SÓ explícito (D3) — a UI confirma antes ("isto apaga modelo/MCPs de X"). */
export function deleteHarnessConfig(agentId: string, harnessId: string): void {
  const agent = getAgent(agentId);
  if (!agent) throw new AgentError("agente não encontrado", 404);
  if (agent.activeHarnessId === harnessId) {
    throw new AgentError("não é possível apagar a config do harness ATIVO — troque o harness ativo antes", 409);
  }
  appDb()
    .orm.delete(agentHarnessConfigs)
    .where(and(eq(agentHarnessConfigs.agentId, agentId), eq(agentHarnessConfigs.harnessId, harnessId)))
    .run();
}

export function parseMcpServers(row: HarnessConfigRow | undefined): McpServerConfig[] {
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.mcpServersJson) as unknown;
    return Array.isArray(parsed) ? (parsed as McpServerConfig[]) : [];
  } catch {
    return [];
  }
}

export function parseHarnessSettings(row: HarnessConfigRow | undefined): Record<string, unknown> {
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.settingsJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Seed (§6.2) ──
// Primeiro boot da Fase 1: importa agents/*.SOUL.md como versão 1 de um agente
// por papel (ativo), activeHarnessId derivado do AGENT_BACKEND vigente e a
// config do harness montada a partir das ENVs atuais (GOOSE_*/HERMES_* — ver
// Apêndice A). Roda só com a tabela vazia — nunca sobrescreve nada.
export function seedAgentsFromSouls(): void {
  const { sqlite } = appDb();
  const count = (sqlite.query(`SELECT COUNT(*) AS c FROM agents`).get() as { c: number }).c;
  if (count > 0) return;

  const backend = config.agent.backend;
  for (const role of AGENT_ROLES) {
    const soul = readSoulFile(role);
    if (!soul) {
      log.server.warn({ role }, "seed de agents: SOUL não encontrada em agents/ — papel ficará sem agente (crie pela dashboard)");
      continue;
    }
    const agent = createAgent({
      role,
      name: role,
      description: ROLE_METAS[role].description,
      soulMarkdown: soul,
      comment: "seed inicial a partir de agents/*.SOUL.md (Fase 1 §6.2)",
      harnessId: backend,
      activate: true,
    });

    // Config do harness ativo a partir das ENVs vigentes (mapeamento Apêndice A).
    if (backend === "goose") {
      const model = process.env.GOOSE_MODEL ?? null;
      updateHarnessConfig(agent.id, "goose", {
        model,
        settingsJson: JSON.stringify({ provider: "openrouter" }),
      });
    } else {
      const roleEnv = role === "dev" ? "DEV" : role.toUpperCase();
      const model = process.env[`HERMES_${roleEnv}_MODEL`] ?? role;
      const urlOverride = process.env[`HERMES_${roleEnv}_URL`];
      const keyOverride = process.env[`HERMES_${roleEnv}_KEY`];
      updateHarnessConfig(agent.id, "hermes", {
        model,
        settingsJson: JSON.stringify({
          ...(urlOverride ? { urlOverride } : {}),
          ...(keyOverride ? { keyOverride } : {}),
        }),
      });
    }
    log.server.info({ role, agentId: agent.id, harness: backend }, "agent seedado a partir da SOUL do git");
  }
}
