// Chamadas GraphQL do wizard `yaoe-flow setup` (docs/daemon-binary.md §5
// Passo 3) que precisam de escopo de WORKSPACE (listar times, criar label,
// criar webhook) — anteriores à escolha do time, por isso não reaproveitam
// src/linear.ts (cliente já escopado a um único LINEAR_TEAM_ID em runtime).
const API = "https://api.linear.app/graphql";

async function gql<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (!res.ok || json.errors) {
    throw new Error(json.errors?.map((e) => e.message).join("; ") ?? `Linear API HTTP ${res.status}`);
  }
  return json.data as T;
}

export interface LinearViewer {
  id: string;
  name: string;
  email: string;
}

export async function fetchViewer(apiKey: string): Promise<LinearViewer> {
  const data = await gql<{ viewer: LinearViewer }>(apiKey, `{ viewer { id name email } }`);
  return data.viewer;
}

export interface LinearOrganization {
  id: string;
  urlKey: string;
  name: string;
}

export async function fetchOrganization(apiKey: string): Promise<LinearOrganization> {
  const data = await gql<{ organization: LinearOrganization }>(
    apiKey,
    `{ organization { id urlKey name } }`
  );
  return data.organization;
}

/** Lista de orgs acessíveis pela key — Linear expõe a org ativa; devolvemos como lista p/ a UI selecionar. */
export async function listOrganizations(apiKey: string): Promise<LinearOrganization[]> {
  const org = await fetchOrganization(apiKey);
  return org ? [org] : [];
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export async function listTeams(apiKey: string): Promise<LinearTeam[]> {
  const data = await gql<{ teams: { nodes: LinearTeam[] } }>(
    apiKey,
    `{ teams(first: 250) { nodes { id key name } } }`
  );
  return data.teams.nodes;
}

export async function listTeamStates(apiKey: string, teamId: string): Promise<string[]> {
  const data = await gql<{ team: { states: { nodes: { name: string }[] } } }>(
    apiKey,
    `query($teamId: String!) { team(id: $teamId) { states { nodes { name } } } }`,
    { teamId }
  );
  return data.team.states.nodes.map((s) => s.name);
}

export async function listTeamLabels(apiKey: string, teamId: string): Promise<string[]> {
  const data = await gql<{ team: { labels: { nodes: { name: string }[] } } }>(
    apiKey,
    `query($teamId: String!) { team(id: $teamId) { labels(first: 250) { nodes { name } } } }`,
    { teamId }
  );
  return data.team.labels.nodes.map((l) => l.name);
}

export async function createLabel(apiKey: string, teamId: string, name: string): Promise<void> {
  await gql(
    apiKey,
    `mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success } }`,
    { input: { teamId, name } }
  );
}

export async function createWebhook(apiKey: string, teamId: string, url: string, secret: string): Promise<void> {
  await gql(
    apiKey,
    `mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { success } }`,
    {
      input: {
        teamId,
        url,
        secret,
        resourceTypes: ["Issue"],
        enabled: true,
      },
    }
  );
}
