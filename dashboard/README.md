# Dashboard de observabilidade

SPA (Vite + React + Tailwind + shadcn-style + Tabler icons) para acompanhar a
execução dos agents (Goose via ACP) do `yaoe-flow`: runs ao vivo,
histórico, auditoria de webhooks do Linear e logs — servida numa porta
secundária do próprio orchestrator (`DASHBOARD_PORT`, default `4791`).

## Dev local

```bash
# 1. Backend (porta 4790 + 4791), a partir de yaoe-flow/
bun run dev

# 2. Esta SPA, com HMR e proxy de /api -> :4791 (ver vite.config.ts)
bun run dev
```

Em produção/Docker, o backend serve o build estático desta SPA diretamente
(`dashboard/dist`) — não é preciso rodar os dois `dev` juntos fora do dia a dia
de desenvolvimento do front.

## Build

```bash
bun run build   # tsc -b && vite build -> dist/
```

## Limitações conhecidas

- **Runs via backend Hermes aparecem só como "despachado"** — sem etapas nem
  tokens. O Hermes despacha fire-and-report (`/v1/runs`); o orchestrator não
  recebe conclusão/consumo desses runs (limitação do protocolo, não da
  dashboard). Trace completo (etapas/tools/tokens) só existe para
  `AGENT_BACKEND=goose`.
- **Auditoria de comentários/labels do Linear** só aparece se o webhook
  cadastrado no Linear incluir esses tipos de recurso (`Issue comments`,
  `Issue labels`) — confira em Linear → Settings → API → Webhooks.
- **Mapeamento de `updatedFrom`** (diff de estado/label/título) foi
  implementado de forma defensiva a partir da documentação pública do Linear;
  valide contra o payload real do seu workspace (o backend já loga o envelope
  cru em `debug`) se o resumo ("Movida de X para Y") não bater.
