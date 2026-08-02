# Imagem do SERVIÇO DE ORQUESTRAÇÃO (leve — só Bun) + a dashboard de observabilidade
# (SPA buildada + servida numa porta secundária, ver DASHBOARD_PORT). NÃO inclui o
# goose. Use esta com AGENT_BACKEND=hermes (os agents rodam no Hermes, fora desta
# imagem). Para AGENT_BACKEND=goose, use a imagem ../Dockerfile.goose (orchestrator +
# goose + recipes na mesma imagem — também já inclui a dashboard).
#
# Build (a partir da RAIZ yaoe-flow, pois precisa de dashboard/ no contexto):
#   docker build -f app/Dockerfile -t orchestrator .
FROM oven/bun:1 AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package.json ./
RUN bun install
COPY dashboard/ ./
RUN bun run build

FROM oven/bun:1
WORKDIR /app

COPY app/package.json ./
RUN bun install

COPY app/tsconfig.json ./
COPY app/src ./src
COPY app/drizzle ./drizzle
# SOULs de seed da entidade Agent (Fase 1) — lidas do disco em Docker
# (EMBEDDED_SOULS fica vazio fora do build --compile). Sem isto o
# seedAgentsFromSouls no boot não cria nenhum agente.
COPY agents ./agents
COPY --from=dashboard-build /app/dashboard/dist ./dashboard/dist

RUN mkdir -p /app/data

# HOST=0.0.0.0 é obrigatório em container: bind em "localhost" (default do
# config p/ dev local) não é alcançável de fora via `docker run -p`/K8s Service.
ENV HOST=0.0.0.0 \
  PORT=4790 \
  DASHBOARD_PORT=4791

EXPOSE $PORT $DASHBOARD_PORT
CMD ["bun", "src/index.ts"]
