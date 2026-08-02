# Serviço de Orquestração — Linear ⇄ Hermes

Ponte entre o **Linear** (gestão de estado das tasks) e o **Hermes Agent**
(execução). Ouve os webhooks do Linear, decide o que pode rodar em paralelo com
segurança, e despacha os agents do Hermes via REST.

É o **artefato #1** do blueprint. Os SOULs dos agents, o gerador de `PROJECT_MAP`
e os guias de configuração do Linear/Hermes são artefatos separados.

## O que ele faz

Funciona como um **controller de reconciliação** (estilo Kubernetes). A cada
webhook e a cada `TICK_INTERVAL_MS`, ele reconcilia (nesta ordem):

0. **Refiners (PMO)** — preenche os seats livres (`MAX_REFINERS`) com tasks em
   `To Do` que **também** têm a label `ready-to-refine` (gate de curadoria), move
   p/ `Refining` e despacha o PMO. Refinar vem antes de implementar.
1. **Workers** — preenche os seats livres (`MAX_WORKERS`) com tasks em `Planned`
   ou `Reopened`, respeitando:
   - **Camada 1** — dependências declaradas no Linear (`blocked by`). Só despacha
     se todas as bloqueadoras estão `Completed`.
   - **Camada 2** — colisão de footprint. Pede ao Orquestrador-agent (planning
     pass) os arquivos que a task vai tocar; se colidir com uma task em
     andamento, serializa (dependência implícita).
2. **Reviewers** — preenche os seats livres (`MAX_REVIEWERS`) com tasks em
   `Code Review`, mas **antes** roda o **scope-check determinístico**: lê o diff da
   PR anexada e confere `diff ⊆ footprint`. Se vazar (ou faltar PR), comenta 🚧/🛑
   e move p/ `Reopened` sem gastar o seat do reviewer.
3. **Merge** — se nenhum merge está em voo, mergeia **um** `Pending Merge` por vez.
4. **Reclaim de liveness** — seat preso além do timeout (agent morto/travado, sem
   heartbeat) é reclamado: `Refining`→`To Do`, `In Progress`→`Reopened`,
   `In Review`→`Code Review`, e merge travado libera o mutex. Combina com o
   **circuit breaker**: após `MAX_ATTEMPTS` ciclos de retrabalho a task vai p/
   `Blocked` (humano), em vez de loopar. Cada **retry** (`🔁 N/M`), o **breaker**
   (`🛑`) e cada **reclaim** (`⚠️`) são comentados na issue (fase `Reliability`),
   para você acompanhar o desempenho do agent.
5. **Labels `agent:*`** — reconcilia as labels decorativas órfãs (toda issue fora de
   `Refining`/`In Progress`/`In Review` não deveria ter `agent:*` → remove).

A contagem de seats ocupados é **derivada do Linear** (issues em `Refining` /
`In Progress` / `In Review`), não de contadores em memória — então é self-healing:
webhook perdido é corrigido no próximo tick.

## Fluxo de status

```
To Do(+ready-to-refine) ─► (scheduler) ─► Refining ─► [PMO] ─► Planned
Planned  ─┐
Reopened ─┴─► (scheduler) ─► In Progress ─► [worker] ─► Code Review
Code Review ─► (scope-check) ─► In Review ─► [reviewer] ─► Pending Merge ✅ | Reopened ❌
Pending Merge ─► (scheduler) ─► [merge] ─► Completed
```

`Refining`, `In Progress` e `In Review` são estados de "seat ocupado". O footprint
lock vive de `In Progress` até `Completed`, sobrevivendo aos ciclos
`Code Review ⇄ Reopened`.

## Backend de AI Agents (Hermes ou Goose)

Quem **executa** os papéis é plugável. O scheduler fala só com a interface
`AgentBackend` (`src/agent/`); o backend é escolhido por `AGENT_BACKEND`:

| `AGENT_BACKEND` | Como dispara | Recipe/perfil por papel | Imagem Docker |
|---|---|---|---|
| `hermes` (default) | perfis + `POST /v1/runs` (+ `/v1/chat/completions` p/ planning) | `HERMES_<PAPEL>_MODEL` | `app/Dockerfile` |
| `goose` | recipes via **ACP** (spawna `goose acp`, JSON-RPC/stdio) | `GOOSE_<PAPEL>_RECIPE` | `Dockerfile.goose` |

Em ambos cada papel (PMO, Worker, Reviewer, Orchestrator) carrega a **mesma SOUL** e é
invocado **por referência** — o serviço nunca manda a SOUL on-demand. Trocar de backend
**não muda nenhuma regra de orquestração** (status, locks, scope-check, reliability).
Guias: `docs/hermes-setup.md` e `docs/goose-setup.md`.

> **Goose via ACP:** o serviço spawna `goose acp` por dispatch e fala o protocolo
> padronizado (estável, ao contrário da API HTTP do goose). O recipe entra por deeplink
> (`_meta.recipeDeeplink` = base64 do recipe) no `newSession`; coletamos os
> `agent_message_chunk` do stream. Tudo isolado em `src/agent/goose.ts`. Como o turno é
> síncrono, se o serviço reiniciar no meio o reclaim de liveness recupera o seat.

## Como o serviço invoca o Hermes (perfis)

Cada papel é um **perfil** do Hermes (`hermes profile create <model>`, com a SOUL.md),
invocado **por referência** (`model` id) — o serviço nunca manda a SOUL on-demand:

| Chamada | Corpo | Modo | Perfil |
|---|---|---|---|
| `POST {url}/v1/chat/completions` | `{ model: "orchestrator", messages:[…"mode: planning\nissueId"…] }` | **síncrono** — o conteúdo é o JSON `{ footprint }` | orchestrator |
| `POST {url}/v1/runs` | `{ model: "pmo", input: "issueId: …" }` | fire-and-report | pmo |
| `POST {url}/v1/runs` | `{ model: "senior-engineer", input: "issueId: …\nmode: implement\|fix" }` | fire-and-report | worker |
| `POST {url}/v1/runs` | `{ model: "reviewer", input: "issueId: …" }` | fire-and-report | reviewer |
| `POST {url}/v1/runs` | `{ model: "orchestrator", input: "mode: merge\nissueId: …" }` | fire-and-report | orchestrator |

**Fire-and-report**: `/v1/runs` devolve `run_id` na hora; o agent roda em background e,
ao terminar, ele mesmo muda o status no Linear — o webhook fecha o ciclo. Se um run
morrer silenciosamente, o **reclaim de liveness** recupera o seat.

Config por perfil no `.env`: `HERMES_BASE_URL`/`HERMES_API_KEY` (gateway compartilhado)
+ `HERMES_<PAPEL>_MODEL`; ou `HERMES_<PAPEL>_URL`/`_KEY` se cada perfil tem seu gateway.

> O `planning` é a única chamada síncrona: precisamos do footprint **antes** de
> decidir despachar, para checar colisão.

## Rodando

```bash
bun install
bun run setup          # wizard interativo → gera o .env (recomendado)
bun run dev            # ou: bun run start
```

Sem o wizard: `cp .env.example .env` e preencha as chaves à mão.

### Docker — duas imagens

Escolha a imagem conforme o `AGENT_BACKEND`:

```bash
# AGENT_BACKEND=hermes — imagem leve (só o orchestrator), build daqui:
docker build -t yaoe-flow .
docker run --env-file .env -p 4790:4790 -p 4791:4791 yaoe-flow

# AGENT_BACKEND=goose — imagem com o goose embutido (orchestrator + goose CLI +
# recipes). Build a partir da RAIZ do yaoe-flow (precisa de recipes/):
cd ..
docker build -f Dockerfile.goose -t orchestrator-goose .
docker run --env-file app/.env -p 4790:4790 -p 4791:4791 orchestrator-goose
# 4790 = API do orchestrator · 4791 = dashboard de observabilidade
```

Ou via `docker-compose.yml` (Valkey + serviço) — veja o comentário lá sobre como
apontar o `build` para `Dockerfile.goose`.

> **Um `.env`, dois consumidores.** O serviço carrega o `.env` (via `--env-file`/
> `env_file`); no backend `goose`, esse mesmo ambiente é **repassado ao processo
> `goose acp`** — então `OPENROUTER_API_KEY` (model), `LINEAR_API_KEY` e
> `GITHUB_PERSONAL_ACCESS_TOKEN` (MCPs) servem ao orchestrator **e** ao goose sem
> duplicação. Para segredos só-do-agente, aponte `GOOSE_ENV_FILE` a um arquivo extra.

Health check: `GET /health` → `{ "ok": true, "backend": "hermes" | "goose" }`.

## Configuração no Linear (resumo — guia completo é outro artefato)

O `bun run setup` faz tudo isto interativamente (incl. criar a label e o webhook).
Manual:

1. **Settings → API → Personal API keys** → gere a key → `LINEAR_API_KEY`.
2. Escolha o **time** do pipeline → `LINEAR_TEAM_ID` + `LINEAR_TEAM_KEY`
   (o wizard lista via API; o scheduler só processa issues desse time).
3. **Settings → API → Webhooks** → novo webhook:
   - URL: `https://SEU_HOST/webhook/linear`
   - Evento: **Issues**
   - Copie o **Signing secret** → `LINEAR_WEBHOOK_SECRET`.
4. Confira que os **10 issue statuses do time** existem e batem com `config.states`
   (Settings → Teams → [time] → Issue statuses — **não** Projects → Statuses;
   senão ajuste as variáveis `STATE_*`). Crie a label de curadoria
   `ready-to-refine` (as `agent:*` o serviço cria sozinho).

## Pontos de atenção / limites desta versão

- **Instância única.** O `tick` usa um guard em memória (`running`) e Valkey p/ os
  locks. Para rodar réplicas, mover o guard de reentrância p/ um lock distribuído
  no Valkey.
- **Colisão de footprint** usa match por prefixo de path. Se as tasks usarem globs
  complexos, troque por `micromatch` em `dag.ts`.
- **Direção da relação `blocked by`** no Linear pode variar por workspace; o filtro
  está em `linear.ts → normalize()` com comentário de como ajustar.
- **Planning pass** é chamado por candidato (com cache em Valkey). Se ficar caro,
  dá p/ degradar para heurística determinística antes de chamar o agent.
- O **merge** em si é feito pelo Orquestrador-agent (ambiente efêmero com git);
  o serviço só serializa e dispara.

## Estrutura

```
setup.ts         wizard interativo de configuração (gera o .env)
src/
  index.ts       app Hono + webhook + tick periódico
  config.ts      env + nomes de status + capacidades + labels
  webhook.ts     verificação HMAC + parsing do payload
  scheduler.ts   ★ controller de reconciliação (o cérebro): refiners, workers,
                 reviewers+scope-check, merge, reconciliação de labels
  linear.ts      cliente GraphQL do Linear (status, comentários, labels, anexos)
  agent/         backend plugável de AI agents (seleção por AGENT_BACKEND)
    backend.ts   interface AgentBackend + extração do footprint
    hermes.ts    backend Hermes (perfis: /v1/runs + /v1/chat/completions)
    goose.ts     backend Goose via ACP (spawna `goose acp`; recipe por deeplink)
    index.ts     seleciona o backend e reexporta a API p/ o scheduler
  github.ts      cliente REST do GitHub (arquivos da PR, comentar) — scope-check
  scope.ts       diff ⊆ footprint (repo-qualificado) — scope-check determinístico
  locks.ts       footprint locks + mutex de merge (Valkey)
  dag.ts         colisão de footprint (Camada 2) + isWithinFootprint
  types.ts       tipos compartilhados
```
