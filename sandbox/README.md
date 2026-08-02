# Sandbox — smoke test por harness real (§9.2)

> Requisito do blueprint: testes CONTRA o CLI/binário de verdade, um por
> harness, fora do CI (exige credenciais e CLIs instalados na máquina do
> operador). O contract suite (`bun test`, mock ACP) já cobre a lógica do
> cliente/normalização/liveness sem custo de LLM — isto aqui é o passo humano
> de confiança antes de ativar um harness novo em produção.

## Pré-requisitos

1. **Repositório de sandbox** no GitHub — um repo pequeno e descartável (não
   um repo real do produto) onde os agents podem clonar, criar branch e abrir
   PR sem risco. Crie um `sandbox-orchestrator` vazio na sua conta/org de
   testes.
2. **Time de sandbox no Linear** com o workflow padrão (`To Do`, `Refining`,
   `Planned`, `In Progress`, `Code Review`, `In Review`, `Pending Merge`,
   `Reopened`, `Completed`, `Blocked` — ver `STATE_*` em `.env.example`) e as
   labels `ready-to-refine`/`ready-to-implement`/`ready-to-merge`.
3. **Issue de teste** nesse time, descrevendo uma tarefa trivial e segura
   (ex.: "adicionar um comentário no README explicando o propósito do repo").
4. O harness a testar **instalado e logado/com API key** na máquina do
   operador (ver tela Harness → detecção/instruções por harness).
5. `.env` do `app/` apontando pro time/repo de sandbox (`LINEAR_TEAM_ID`,
   `AGENT_AUTHORIZED_ORGS` incluindo a org do repo de sandbox).

## Roteiro mínimo por harness

Com o serviço rodando (`bun run dev` em `app/`) e a issue de sandbox com a
label `ready-to-refine`:

1. **detect** — tela Harness confirma instalado + logado pro harness em teste.
2. **planning** — mova/aguarde a issue entrar em `Refining`; confira que o
   footprint foi estimado (dashboard → Histórico → run do PMO).
3. **implement** — com `ready-to-implement` na issue em `Planned`, aguarde o
   dispatch do worker (ou use **dispatch manual** na tela Ao vivo); confirme
   que a PR foi aberta no repo de sandbox e o link anexado à issue.
4. **review + merge** — acompanhe o ciclo até `Completed`; confira
   `costSource`/tokens/refs externas no RunDetailSheet.
5. **kill no meio de um segundo run** — dispare um novo dispatch (modo `fix`,
   reabrindo a issue) e use o botão "Encerrar" no RunDetailSheet enquanto o
   run está `running`; confirme que o processo morre (harness com
   `capabilities.kill`) e que o reclaim/circuit breaker reage no próximo tick.

Registre o resultado (versão do CLI testada, quirks observados) em
[`../docs/harness-notes.md`](../docs/harness-notes.md).

## Por que isto não roda no CI

Precisa de: CLI instalado e autenticado (contas pessoais, D5), credenciais
reais do Linear/GitHub, e produz efeitos reais num repositório (branch, PR) —
tudo isso é exatamente o que o CI (§9.4) evita de propósito. O contract suite
(`bun test`) é o substituto seguro pra CI; este roteiro é o complemento manual
antes de promover um harness novo pra produção.
