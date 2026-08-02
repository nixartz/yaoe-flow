# Recipes do Goose

Recipes do [Goose](https://goose-docs.ai) usados quando o yaoe-flow roda
com `AGENT_BACKEND=goose`. Um recipe por papel do pipeline, com a **SOUL** embutida no
campo `instructions`:

| Recipe | Papel | Gerado de |
|---|---|---|
| `pmo.yaml` | refino (To Do→Refining→Planned) | `agents/pmo.SOUL.md` |
| `dev.yaml` | implementa/corrige | `agents/dev.SOUL.md` |
| `reviewer.yaml` | revisa a PR | `agents/reviewer.SOUL.md` |
| `orchestrator.yaml` | planning + merge | `agents/orchestrator.SOUL.md` |

## Fonte única da verdade

**Não edite os `.yaml` à mão.** Eles são gerados a partir das SOULs em `agents/`
(+ `agents/COMMUNICATION_PROTOCOL.md`, concatenado em `instructions`). Para mudar o
comportamento de um agent, edite a SOUL e regenere:

```bash
bun recipes/build.ts        # rode a partir da raiz do yaoe-flow
```

O gerador valida o YAML resultante (via `Bun.YAML`, quando disponível).

## O que cada recipe traz

- `instructions` — a SOUL + o protocolo de comunicação (system prompt do agent).
- `prompt` — instrução de partida (headless); via ACP o input real chega na mensagem
  do `prompt` (`issueId`/`mode`).
- `settings.goose_provider` / `goose_model` — configuráveis na geração via env
  (defaults: `openrouter` + `qwen/qwen3-coder`). Ver `docs/goose-setup.md` §1 e §3.
- `extensions` — MCPs por papel (Linear / GitHub / `developer`). As **credenciais**
  entram via **`env_keys`** (só o nome: `LINEAR_API_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN`);
  o Goose resolve o valor do keyring/ambiente do goose — o segredo **não fica no
  `.yaml`**. Ver `docs/goose-setup.md` §2.

## Input da task (issueId / mode)

Não é parâmetro do recipe: chega na **mensagem** do `prompt` (`issueId: …\nmode: …`),
exatamente como a SOUL já espera — igual ao backend Hermes. Mantém os dois backends
simétricos.

## Como são usados (ACP)

O serviço roda com `AGENT_BACKEND=goose` e **spawna `goose acp`** por dispatch,
passando o recipe por **deeplink** (`base64(JSON(recipe))`) no `newSession` — o serviço
computa isso do próprio `.yaml` (não precisa registrar nada num servidor). O papel→recipe
é mapeado por `GOOSE_<PAPEL>_RECIPE` no `.env`. Use a imagem `Dockerfile.goose`
(orchestrator + goose + estes recipes). Detalhes, provider e checklist em
[`docs/goose-setup.md`](../docs/goose-setup.md).
