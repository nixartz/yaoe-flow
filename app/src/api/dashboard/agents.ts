import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent } from "../shared/openapi";
import { errorBody, okBody, idParam, looseObject } from "../shared/schemas";
import {
  createAgentBody,
  updateAgentBody,
  createVersionBody,
  updateHarnessConfigBody,
  activateHarnessBody,
} from "./agents.schema";
import * as agentsRepo from "../../db/agents";
import { AgentError } from "../../db/agents";
import { AGENT_ROLES, ROLE_METAS } from "../../agent/recipe/defaults";
import { listHarnessIds } from "../../agent/harness/registry";
import { authUser } from "../../dashboard/auth";
import { log } from "../../logger";

export const agentsRoutes = new Hono();

function handleAgentError(e: unknown): { body: { error: string }; status: number } {
  if (e instanceof AgentError) return { body: { error: e.message }, status: e.status };
  throw e;
}

agentsRoutes.get(
  "/",
  describeRoute({
    tags: ["Agents"],
    summary: "List agents and roles",
    responses: { 200: jsonContent(looseObject, "Agentes") },
  }),
  (c) => c.json({ agents: agentsRepo.listAgents(), roles: AGENT_ROLES })
);

agentsRoutes.get(
  "/:id",
  describeRoute({
    tags: ["Agents"],
    summary: "Agent detail",
    responses: {
      200: jsonContent(looseObject, "Agente encontrado"),
      404: jsonContent(errorBody, "Não encontrado"),
    },
  }),
  validator("param", idParam),
  (c) => {
    const agent = agentsRepo.getAgent(c.req.valid("param").id);
    if (!agent) return c.json({ error: "agente não encontrado" }, 404);
    return c.json({
      agent,
      versions: agentsRepo.listVersions(agent.id),
      harnessConfigs: agentsRepo.listHarnessConfigs(agent.id),
      harnessIds: listHarnessIds(),
      roleMeta: ROLE_METAS[agent.role as keyof typeof ROLE_METAS],
    });
  }
);

agentsRoutes.post(
  "/",
  describeRoute({
    tags: ["Agents"],
    summary: "Create agent",
    responses: {
      200: jsonContent(okBody.extend({ agent: looseObject }), "Agente criado"),
      400: jsonContent(errorBody, "Erro de validação"),
    },
  }),
  validator("json", createAgentBody),
  async (c) => {
    const body = c.req.valid("json");
    try {
      const agent = agentsRepo.createAgent({
        role: body.role,
        name: body.name,
        description: body.description ?? null,
        soulMarkdown: body.soulMarkdown,
        comment: body.comment,
        harnessId: body.harnessId,
        createdBy: authUser(c).id,
        activate: Boolean(body.activate),
      });
      log.dashboard.info({ agentId: agent.id, role: agent.role, by: authUser(c).username }, "agent created via dashboard");
      return c.json({ ok: true as const, agent });
    } catch (e) {
      const { body: b, status } = handleAgentError(e);
      return c.json(b, status as 400);
    }
  }
);

agentsRoutes.patch(
  "/:id",
  describeRoute({
    tags: ["Agents"],
    summary: "Update the agent's metadata",
    responses: {
      200: jsonContent(okBody.extend({ agent: looseObject }), "Atualizado"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("param", idParam),
  validator("json", updateAgentBody),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      agentsRepo.updateAgentMeta(id, {
        name: body.name,
        description: body.description,
      });
      return c.json({ ok: true as const, agent: agentsRepo.getAgent(id) });
    } catch (e) {
      const { body: b, status } = handleAgentError(e);
      return c.json(b, status as 400);
    }
  }
);

agentsRoutes.post(
  "/:id/activate",
  describeRoute({
    tags: ["Agents"],
    summary: "Activate agent (atomic swap of the role's variant)",
    responses: {
      200: jsonContent(okBody.extend({ agent: looseObject }), "Ativado"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("param", idParam),
  (c) => {
    const { id } = c.req.valid("param");
    try {
      agentsRepo.activateAgent(id);
      log.dashboard.info({ agentId: id, by: authUser(c).username }, "agent activated via dashboard");
      return c.json({ ok: true as const, agent: agentsRepo.getAgent(id) });
    } catch (e) {
      const { body, status } = handleAgentError(e);
      return c.json(body, status as 400);
    }
  }
);

agentsRoutes.post(
  "/:id/deactivate",
  describeRoute({
    tags: ["Agents"],
    summary: "Deactivate agent",
    responses: {
      200: jsonContent(okBody.extend({ agent: looseObject }), "Desativado"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("param", idParam),
  (c) => {
    const { id } = c.req.valid("param");
    try {
      agentsRepo.deactivateAgent(id);
      return c.json({ ok: true as const, agent: agentsRepo.getAgent(id) });
    } catch (e) {
      const { body, status } = handleAgentError(e);
      return c.json(body, status as 400);
    }
  }
);

agentsRoutes.get(
  "/:id/versions",
  describeRoute({
    tags: ["Agents"],
    summary: "List SOUL versions",
    responses: { 200: jsonContent(looseObject, "Versões") },
  }),
  validator("param", idParam),
  (c) => c.json({ versions: agentsRepo.listVersions(c.req.valid("param").id) })
);

agentsRoutes.post(
  "/:id/versions",
  describeRoute({
    tags: ["Agents"],
    summary: "Create a SOUL version (append-only)",
    responses: {
      200: jsonContent(looseObject, "Versão criada"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("param", idParam),
  validator("json", createVersionBody),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const version = agentsRepo.createVersion(
        id,
        body.soulMarkdown,
        body.comment ?? "",
        authUser(c).id,
        { activate: body.activate !== false }
      );
      log.dashboard.info({ agentId: id, versionId: version.id, by: authUser(c).username }, "agent version created via dashboard");
      return c.json({ ok: true as const, version, agent: agentsRepo.getAgent(id) });
    } catch (e) {
      const { body: b, status } = handleAgentError(e);
      return c.json(b, status as 400);
    }
  }
);

agentsRoutes.get(
  "/:id/versions/:versionId",
  describeRoute({
    tags: ["Agents"],
    summary: "Version detail",
    responses: {
      200: jsonContent(looseObject, "Versão"),
      404: jsonContent(errorBody, "Não encontrada"),
    },
  }),
  (c) => {
    const version = agentsRepo.getVersion(c.req.param("versionId"));
    if (!version || version.agentId !== c.req.param("id")) return c.json({ error: "versão não encontrada" }, 404);
    return c.json({ version });
  }
);

agentsRoutes.post(
  "/:id/versions/:versionId/activate",
  describeRoute({
    tags: ["Agents"],
    summary: "Activate a specific version",
    responses: {
      200: jsonContent(okBody.extend({ agent: looseObject }), "Ativada"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  (c) => {
    try {
      agentsRepo.activateVersion(c.req.param("id"), c.req.param("versionId"));
      return c.json({ ok: true as const, agent: agentsRepo.getAgent(c.req.param("id")) });
    } catch (e) {
      const { body, status } = handleAgentError(e);
      return c.json(body, status as 400);
    }
  }
);

agentsRoutes.get(
  "/:id/versions/:versionId/export",
  describeRoute({
    tags: ["Agents"],
    summary: "Export the version's soulMarkdown (text/markdown)",
    responses: {
      200: { description: "SOUL markdown", content: { "text/markdown": { schema: { type: "string" as const } } } },
      404: jsonContent(errorBody, "Não encontrada"),
    },
  }),
  (c) => {
    const version = agentsRepo.getVersion(c.req.param("versionId"));
    if (!version || version.agentId !== c.req.param("id")) return c.json({ error: "versão não encontrada" }, 404);
    return c.text(version.soulMarkdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  }
);

agentsRoutes.get(
  "/:id/harness",
  describeRoute({
    tags: ["Agents"],
    summary: "List the agent's harness configs",
    responses: { 200: jsonContent(looseObject, "Configs") },
  }),
  validator("param", idParam),
  (c) => c.json({ configs: agentsRepo.listHarnessConfigs(c.req.valid("param").id) })
);

agentsRoutes.put(
  "/:id/harness/:harnessId",
  describeRoute({
    tags: ["Agents"],
    summary: "Update a harness config",
    responses: {
      200: jsonContent(okBody.extend({ config: looseObject }), "Config atualizada"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("json", updateHarnessConfigBody),
  async (c) => {
    const body = c.req.valid("json");
    try {
      const harnessConfig = agentsRepo.updateHarnessConfig(c.req.param("id"), c.req.param("harnessId"), {
        model: body.model,
        settingsJson: body.settingsJson,
        mcpServersJson: body.mcpServersJson,
      });
      return c.json({ ok: true as const, config: harnessConfig });
    } catch (e) {
      const { body: b, status } = handleAgentError(e);
      return c.json(b, status as 400);
    }
  }
);

agentsRoutes.delete(
  "/:id/harness/:harnessId",
  describeRoute({
    tags: ["Agents"],
    summary: "Delete a harness config",
    responses: {
      200: jsonContent(okBody, "Removida"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  (c) => {
    try {
      agentsRepo.deleteHarnessConfig(c.req.param("id"), c.req.param("harnessId"));
      return c.json({ ok: true as const });
    } catch (e) {
      const { body, status } = handleAgentError(e);
      return c.json(body, status as 400);
    }
  }
);

agentsRoutes.post(
  "/:id/activate-harness",
  describeRoute({
    tags: ["Agents"],
    summary: "Switch the agent's active harness",
    responses: {
      200: jsonContent(okBody.extend({ agent: looseObject }), "Harness trocado"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("param", idParam),
  validator("json", activateHarnessBody),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      agentsRepo.setActiveHarness(id, body.harnessId);
      log.dashboard.info({ agentId: id, harnessId: body.harnessId, by: authUser(c).username }, "agent active harness changed");
      return c.json({ ok: true as const, agent: agentsRepo.getAgent(id) });
    } catch (e) {
      const { body: b, status } = handleAgentError(e);
      return c.json(b, status as 400);
    }
  }
);
