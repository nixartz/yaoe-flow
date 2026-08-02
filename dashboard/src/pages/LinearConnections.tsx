import { useState, type Dispatch, type SetStateAction } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconPlug,
  IconPlus,
  IconCheck,
  IconTrash,
  IconLoader2,
  IconPencil,
  IconSend,
  IconX,
  IconBrandGithub,
} from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  linearConnectionsApi,
  ApiError,
  type GithubAppProbeResult,
  type GithubAuthPayload,
  type LinearConnection,
  type LinearProbeResult,
} from "@/lib/api";

function probeOrgs(probe: LinearProbeResult | null) {
  if (!probe?.ok) return [];
  if (probe.organizations?.length) return probe.organizations;
  return probe.organization ? [probe.organization] : [];
}

// ── Auth GitHub por connection (1:1 com o workspace Linear) ──
//
// Três modos, mutuamente exclusivos: "global" (GITHUB_TOKEN da tela Config),
// "pat" (token de bot/usuário desta org) e "app" (GitHub App instalado na org
// — commits e PRs saem como `App[bot]`). O backend guarda tudo na própria row
// da connection, então cada workspace Linear pode apontar pra uma org/App
// diferente.
type GithubUiMode = "global" | "pat" | "app";

interface GithubAuthState {
  mode: GithubUiMode;
  /** PAT novo; vazio em modo edição = manter o que está salvo. */
  token: string;
  clearToken: boolean;
  appId: string;
  installationId: string;
  /** PEM nova; vazia em modo edição = manter a que está salva. */
  privateKey: string;
}

function initialGithubState(initial?: LinearConnection): GithubAuthState {
  return {
    mode: initial?.githubAuthMode ?? (initial?.hasGithubToken ? "pat" : "global"),
    token: "",
    clearToken: false,
    appId: initial?.githubAppId ?? "",
    installationId: initial?.githubInstallationId ?? "",
    privateKey: "",
  };
}

function githubAuthValid(gh: GithubAuthState, initial?: LinearConnection): boolean {
  if (gh.mode === "global") return true;
  if (gh.mode === "pat") return Boolean(gh.token.trim() || (initial?.hasGithubToken && !gh.clearToken));
  return Boolean(
    gh.appId.trim() && gh.installationId.trim() && (gh.privateKey.trim() || initial?.hasGithubAppKey)
  );
}

function githubAuthPayload(gh: GithubAuthState): GithubAuthPayload {
  // "Global" limpa as credenciais da connection de propósito: o backend, em modo
  // legado, ainda prefere o PAT da row se ele existir — deixar o token salvo
  // faria a UI mentir sobre qual credencial o run vai usar.
  if (gh.mode === "global") {
    return {
      githubAuthMode: null,
      githubToken: null,
      githubAppId: null,
      githubInstallationId: null,
      githubAppPrivateKey: null,
    };
  }
  if (gh.mode === "pat") {
    // Campos do App ficam salvos (o modo é quem decide o que vale) — assim dá
    // pra alternar de volta sem recolar a PEM.
    return {
      githubAuthMode: "pat",
      githubToken: gh.clearToken ? null : gh.token.trim() || undefined,
    };
  }
  return {
    githubAuthMode: "app",
    githubAppId: gh.appId.trim(),
    githubInstallationId: gh.installationId.trim(),
    githubAppPrivateKey: gh.privateKey.trim() || undefined,
  };
}

function GithubAuthSection({
  value,
  onChange,
  initial,
  onError,
}: {
  value: GithubAuthState;
  /** Updater (não valor): o `onSuccess` do probe roda com o `value` do render em
   *  que o botão foi clicado — aplicar `{...value}` de lá descartaria o que o
   *  operador digitou enquanto a requisição estava em voo. */
  onChange: Dispatch<SetStateAction<GithubAuthState>>;
  initial?: LinearConnection;
  onError: (message: string | null) => void;
}) {
  const [tokenProbeLogin, setTokenProbeLogin] = useState<string | null>(null);
  const [appProbe, setAppProbe] = useState<GithubAppProbeResult | null>(null);
  const patch = (next: Partial<GithubAuthState>) => onChange((prev) => ({ ...prev, ...next }));

  const probeToken = useMutation({
    mutationFn: () => linearConnectionsApi.probeGithub(value.token.trim()),
    onSuccess: (data) => {
      setTokenProbeLogin(data.ok && data.user ? data.user.login : null);
      onError(data.ok ? null : (data.error ?? "GitHub token inválido"));
    },
    onError: (e) => {
      setTokenProbeLogin(null);
      onError(e instanceof ApiError ? e.message : "falha ao validar GitHub token");
    },
  });

  // Sem installation escolhida, o probe devolve a LISTA (o dado mais chato de
  // achar no GitHub); com ela, minta um token de verdade e prova o fluxo todo.
  const probeApp = useMutation({
    mutationFn: () =>
      linearConnectionsApi.probeGithubApp({
        appId: value.appId.trim(),
        privateKey: value.privateKey,
        installationId: value.installationId.trim() || undefined,
      }),
    onSuccess: (data) => {
      setAppProbe(data);
      onError(data.ok ? null : (data.error ?? "credenciais do App inválidas"));
      const only = data.ok && data.installations?.length === 1 ? data.installations[0]! : null;
      if (only) {
        // Guard dentro do updater: se o operador digitou um Installation ID
        // enquanto o probe estava em voo, o valor dele ganha.
        onChange((prev) => (prev.installationId ? prev : { ...prev, installationId: String(only.id) }));
      }
    },
    onError: (e) => {
      setAppProbe(null);
      onError(e instanceof ApiError ? e.message : "falha ao validar GitHub App");
    },
  });

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium">Credencial GitHub</span>
        <Tabs value={value.mode} onValueChange={(v) => patch({ mode: v as GithubUiMode })}>
          <TabsList>
            <TabsTrigger value="global">Global</TabsTrigger>
            <TabsTrigger value="pat">Usuário / PAT</TabsTrigger>
            <TabsTrigger value="app">GitHub App</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {value.mode === "global" && (
        <p className="text-xs text-muted-foreground">
          Usa o <code>GITHUB_TOKEN</code> configurado na tela Config para todos os workspaces. Salvar neste modo
          remove a credencial própria desta connection.
        </p>
      )}

      {value.mode === "pat" && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                Token{initial?.hasGithubToken ? ` (atual: ${initial.githubTokenMasked})` : ""}
              </label>
              <Input
                className="w-72"
                type="password"
                placeholder={initial?.hasGithubToken ? "colar novo token (vazio = manter)" : "ghp_… / github_pat_…"}
                value={value.token}
                onChange={(e) => {
                  patch({ token: e.target.value, clearToken: false });
                  setTokenProbeLogin(null);
                }}
                disabled={value.clearToken}
              />
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={probeToken.isPending || !value.token.trim() || value.clearToken}
              onClick={() => probeToken.mutate()}
            >
              {probeToken.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconSend className="size-4" />}{" "}
              Testar token
            </Button>
            {tokenProbeLogin && <Badge variant="secondary">OK — @{tokenProbeLogin}</Badge>}
          </div>
          {initial?.hasGithubToken && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={value.clearToken}
                onChange={(e) => patch({ clearToken: e.target.checked, token: e.target.checked ? "" : value.token })}
              />
              Remover o token salvo
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            PAT de um bot da org (ou fine-grained com Contents + Pull requests). Os commits saem com a identidade
            desse usuário.
          </p>
        </div>
      )}

      {value.mode === "app" && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">App ID</label>
              <Input
                className="w-32"
                placeholder="123456"
                value={value.appId}
                onChange={(e) => patch({ appId: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Installation ID</label>
              {appProbe?.ok && appProbe.installations?.length ? (
                <Select
                  value={value.installationId || undefined}
                  onValueChange={(v) => patch({ installationId: v })}
                >
                  <SelectTrigger className="h-9 w-64">
                    <SelectValue placeholder="Selecione a installation" />
                  </SelectTrigger>
                  <SelectContent>
                    {appProbe.installations.map((i) => (
                      <SelectItem key={i.id} value={String(i.id)}>
                        {i.account ?? "conta"} ({i.accountType ?? "?"}) — {i.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="w-64"
                  placeholder="teste o App para listar"
                  value={value.installationId}
                  onChange={(e) => patch({ installationId: e.target.value })}
                />
              )}
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              Private key (PEM){initial?.hasGithubAppKey ? " — salva; cole uma nova só para rotacionar" : ""}
            </label>
            <Textarea
              className="h-28 font-mono text-xs"
              placeholder={
                initial?.hasGithubAppKey
                  ? "vazio = manter a chave salva"
                  : "-----BEGIN RSA PRIVATE KEY-----\n…"
              }
              value={value.privateKey}
              onChange={(e) => patch({ privateKey: e.target.value })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={probeApp.isPending || !value.appId.trim() || !value.privateKey.trim()}
              onClick={() => probeApp.mutate()}
            >
              {probeApp.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconSend className="size-4" />}{" "}
              {value.installationId.trim() ? "Testar App (minta token)" : "Buscar installations"}
            </Button>
            {appProbe?.ok && appProbe.app && <Badge variant="secondary">App: {appProbe.app.slug}</Badge>}
            {appProbe?.ok && appProbe.installation && (
              <Badge variant="success">
                Token OK — {appProbe.installation.account ?? "installation"} até{" "}
                {new Date(appProbe.installation.expiresAt).toLocaleTimeString()}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Só App ID + Installation ID + private key: o token de installation é server-to-server, não usa Client ID
            nem Client Secret. Para testar, cole a PEM (ela não volta do servidor depois de salva). Commits e PRs
            saem como <code>App[bot]</code>.
          </p>
        </div>
      )}
    </div>
  );
}

function ConnectionForm({
  mode,
  initial,
  webhookUrl,
  onDone,
}: {
  mode: "create" | "edit";
  initial?: LinearConnection;
  webhookUrl: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [github, setGithub] = useState<GithubAuthState>(() => initialGithubState(initial));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [probe, setProbe] = useState<LinearProbeResult | null>(null);
  const [organizationId, setOrganizationId] = useState(initial?.organizationId ?? "");
  const [teamId, setTeamId] = useState(initial?.teamId ?? "");
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyProbe = (data: LinearProbeResult) => {
    setProbe(data);
    setError(null);
    const orgs = probeOrgs(data);
    if (organizationId && orgs.some((o) => o.id === organizationId)) {
      /* mantém seleção atual se ainda válida */
    } else if (orgs.length === 1) {
      setOrganizationId(orgs[0]!.id);
    } else {
      setOrganizationId("");
    }
    if (teamId && data.teams?.some((t) => t.id === teamId)) {
      /* mantém time */
    } else if (data.teams?.length === 1) {
      setTeamId(data.teams[0]!.id);
    } else if (!data.teams?.some((t) => t.id === teamId)) {
      setTeamId("");
    }
  };

  const doProbe = useMutation({
    mutationFn: async () => {
      if (apiKey.trim()) return linearConnectionsApi.probe(apiKey.trim());
      if (mode === "edit" && initial) return linearConnectionsApi.test(initial.id);
      throw new ApiError(400, "Informe a API key para testar");
    },
    onSuccess: applyProbe,
    onError: (e) => {
      setProbe(null);
      setError(e instanceof ApiError ? e.message : "falha ao validar API key");
    },
  });

  const canTest = Boolean(apiKey.trim()) || (mode === "edit" && Boolean(initial));
  const orgs = probeOrgs(probe);
  const selectedOrg = orgs.find((o) => o.id === organizationId);
  const selectedTeam = probe?.teams?.find((t) => t.id === teamId);
  const canSave =
    Boolean(name.trim()) &&
    Boolean(probe?.ok) &&
    Boolean(organizationId) &&
    Boolean(selectedOrg) &&
    githubAuthValid(github, initial) &&
    (mode === "edit" || Boolean(apiKey.trim()));

  const save = useMutation({
    mutationFn: async (): Promise<{ webhookSecret?: string }> => {
      if (!selectedOrg) throw new ApiError(400, "Selecione a organização após testar a API key");
      if (mode === "create") {
        const created = await linearConnectionsApi.create({
          name: name.trim(),
          apiKey: apiKey.trim(),
          organizationId: selectedOrg.id,
          organizationKey: selectedOrg.urlKey,
          teamId: teamId || null,
          teamKey: selectedTeam?.key ?? null,
          webhookSecret: webhookSecret.trim() || undefined,
          ...githubAuthPayload(github),
          enabled,
        });
        return { webhookSecret: created.webhookSecret };
      }
      await linearConnectionsApi.update(initial!.id, {
        name: name.trim(),
        apiKey: apiKey.trim() || undefined,
        webhookSecret: webhookSecret.trim() || undefined,
        organizationId: selectedOrg.id,
        organizationKey: selectedOrg.urlKey,
        teamId: teamId || null,
        teamKey: selectedTeam?.key ?? null,
        ...githubAuthPayload(github),
        enabled,
      });
      return {};
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["linear-connections"] });
      if (data.webhookSecret) {
        setCreatedSecret(data.webhookSecret);
      } else {
        onDone();
      }
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "falha ao salvar connection"),
  });

  if (createdSecret) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Connection criada — configure o webhook no Linear</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            Cole este secret no webhook do Linear (Settings → API → Webhooks). A URL é a mesma para todos os
            workspaces:
          </p>
          <code className="block rounded bg-muted px-2 py-1 text-xs break-all">{webhookUrl}</code>
          <code className="block rounded bg-muted px-2 py-1 text-xs break-all">{createdSecret}</code>
          <p className="text-muted-foreground">Este secret só aparece agora. Depois edite a connection para colar um novo.</p>
          <Button size="sm" onClick={onDone}>
            Fechar
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          {mode === "create" ? "Nova connection Linear" : `Editar: ${initial?.name}`}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Nome</label>
            <Input className="w-44" placeholder="ex.: Nixartz" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              API key{mode === "edit" ? ` (atual: ${initial?.apiKeyMasked})` : ""}
            </label>
            <Input
              className="w-72"
              type="password"
              placeholder={mode === "edit" ? "colar nova key (vazio = manter)" : "lin_api_…"}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setProbe(null);
                setOrganizationId("");
              }}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              Webhook secret{mode === "edit" ? ` (atual: ${initial?.webhookSecretMasked})` : " (opcional)"}
            </label>
            <Input
              className="w-64"
              type="password"
              placeholder={mode === "edit" ? "colar novo secret (vazio = manter)" : "gerar automático se vazio"}
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} id="conn-enabled" />
            <label htmlFor="conn-enabled" className="text-sm">
              Ativa
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={doProbe.isPending || !canTest}
            onClick={() => doProbe.mutate()}
          >
            {doProbe.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconSend className="size-4" />}{" "}
            Testar API key
          </Button>
          {probe?.ok && probe.viewer && (
            <Badge variant="secondary">
              OK — {probe.viewer.name} ({probe.viewer.email})
            </Badge>
          )}
        </div>

        {probe?.ok && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Organização (obrigatório)</label>
              <Select value={organizationId || undefined} onValueChange={setOrganizationId}>
                <SelectTrigger className="h-9 w-72">
                  <SelectValue placeholder="Selecione a organização" />
                </SelectTrigger>
                <SelectContent>
                  {orgs.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name} ({o.urlKey})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Time (opcional)</label>
              <Select value={teamId || "__none__"} onValueChange={(v) => setTeamId(v === "__none__" ? "" : v)}>
                <SelectTrigger className="h-9 w-56">
                  <SelectValue placeholder="Sem filtro de time" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Sem filtro de time</SelectItem>
                  {(probe.teams ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} ({t.key})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        <GithubAuthSection value={github} onChange={setGithub} initial={initial} onError={setError} />

        <p className="text-xs text-muted-foreground max-w-2xl">
          A credencial GitHub é 1:1 com este workspace Linear e é injetada no harness (clone/push/PR/MCP) — cada
          connection pode apontar para uma organização ou GitHub App diferente.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={save.isPending || !canSave} onClick={() => save.mutate()}>
            {save.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconCheck className="size-4" />}{" "}
            {mode === "create" ? "Criar" : "Salvar"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>
            <IconX className="size-4" /> Cancelar
          </Button>
          {!probe?.ok && (
            <span className="text-xs text-muted-foreground">Teste a API key e selecione a organização antes de salvar.</span>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {probe && !probe.ok && <p className="text-sm text-destructive">{probe.error ?? "API key inválida"}</p>}
      </CardContent>
    </Card>
  );
}

function ConnectionRow({
  connection,
  onEdit,
}: {
  connection: LinearConnection;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => linearConnectionsApi.update(connection.id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["linear-connections"] }),
  });
  const remove = useMutation({
    mutationFn: () => linearConnectionsApi.remove(connection.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["linear-connections"] }),
  });
  const test = useMutation({
    mutationFn: () => linearConnectionsApi.test(connection.id),
    onSuccess: (data) =>
      setTestMsg(
        data.ok
          ? `OK — ${data.viewer?.name ?? "viewer"} / ${probeOrgs(data)[0]?.urlKey ?? "?"}`
          : (data.error ?? "falhou")
      ),
    onError: (e) => setTestMsg(e instanceof ApiError ? e.message : "falhou"),
  });
  const testGithub = useMutation({
    mutationFn: () => linearConnectionsApi.testGithub(connection.id),
    onSuccess: (data) =>
      setTestMsg(
        data.ok
          ? `GitHub ${data.source} OK — ${data.committer?.name ?? data.user?.login ?? "credencial válida"}`
          : (data.error ?? "falhou")
      ),
    onError: (e) => setTestMsg(e instanceof ApiError ? e.message : "falhou"),
  });

  return (
    <TableRow>
      <TableCell className="font-medium">{connection.name}</TableCell>
      <TableCell className="font-mono text-xs">
        {connection.organizationKey ?? connection.organizationId.slice(0, 8)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {connection.teamKey ?? connection.teamId ?? "—"}
      </TableCell>
      <TableCell>
        <Switch
          checked={connection.enabled}
          disabled={toggle.isPending}
          onCheckedChange={(v) => toggle.mutate(v)}
        />
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{connection.apiKeyMasked}</TableCell>
      <TableCell className="text-xs">
        {connection.githubAuthMode === "app" ? (
          <Badge variant="default">App #{connection.githubAppId}</Badge>
        ) : connection.hasGithubToken ? (
          <Badge variant="secondary">PAT {connection.githubTokenMasked}</Badge>
        ) : (
          <Badge variant="outline">global</Badge>
        )}
      </TableCell>
      <TableCell className="space-x-1 whitespace-nowrap">
        <Button size="sm" variant="ghost" onClick={onEdit} title="Editar">
          <IconPencil className="size-4" />
        </Button>
        <Button size="sm" variant="ghost" disabled={test.isPending} onClick={() => test.mutate()} title="Testar Linear">
          {test.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconSend className="size-4" />}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={testGithub.isPending}
          onClick={() => testGithub.mutate()}
          title="Testar credencial GitHub (mesmo caminho do dispatch)"
        >
          {testGithub.isPending ? (
            <IconLoader2 className="size-4 animate-spin" />
          ) : (
            <IconBrandGithub className="size-4" />
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          disabled={remove.isPending}
          onClick={() => {
            if (confirm(`Apagar connection "${connection.name}"?`)) remove.mutate();
          }}
          title="Apagar"
        >
          <IconTrash className="size-4" />
        </Button>
        {testMsg && <span className="mt-1 block text-xs text-muted-foreground">{testMsg}</span>}
      </TableCell>
    </TableRow>
  );
}

export function LinearConnections() {
  const [form, setForm] = useState<"create" | { edit: LinearConnection } | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["linear-connections"],
    queryFn: linearConnectionsApi.list,
  });

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        <IconPlug className="size-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Conexões Linear</h1>
        {!form && (
          <Button size="sm" variant="outline" className="ml-auto gap-1" onClick={() => setForm("create")}>
            <IconPlus className="size-4" /> Nova connection
          </Button>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        Um workspace Linear por connection (API key + webhook secret). A URL do webhook é a mesma para todos — o
        roteamento usa <code className="text-xs">organizationId</code>. Antes de salvar, teste a API key e
        selecione a organização retornada.
      </p>

      {data?.legacyFallbackActive && (
        <p className="rounded border border-dashed px-3 py-2 text-sm text-muted-foreground">
          Nenhuma connection cadastrada — o serviço usa <code className="text-xs">LINEAR_*</code> legado (Config).
          Crie uma connection para migrar.
        </p>
      )}

      {data?.webhookUrl && (
        <p className="text-xs text-muted-foreground">
          URL do webhook: <code className="rounded bg-muted px-1">{data.webhookUrl}</code>
        </p>
      )}

      {form === "create" && (
        <ConnectionForm
          mode="create"
          webhookUrl={data?.webhookUrl ?? "/webhook/linear"}
          onDone={() => setForm(null)}
        />
      )}
      {form && typeof form === "object" && "edit" in form && (
        <ConnectionForm
          mode="edit"
          initial={form.edit}
          webhookUrl={data?.webhookUrl ?? "/webhook/linear"}
          onDone={() => setForm(null)}
        />
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {isError && <p className="text-sm text-destructive">Falha ao carregar connections.</p>}

      {data && data.connections.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Org</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Ativa</TableHead>
                <TableHead>API key</TableHead>
                <TableHead>GitHub</TableHead>
                <TableHead>Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.connections.map((c) => (
                <ConnectionRow key={c.id} connection={c} onEdit={() => setForm({ edit: c })} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {data && data.connections.length === 0 && !form && !data.legacyFallbackActive && (
        <p className="text-sm text-muted-foreground">Nenhuma connection ainda. Clique em Nova connection para adicionar.</p>
      )}
    </div>
  );
}
