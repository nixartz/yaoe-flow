# Image for the ORCHESTRATION SERVICE (light — Bun only) + the observability
# dashboard (built SPA, served on a secondary port, see DASHBOARD_PORT). Does
# NOT include goose. Use this with AGENT_BACKEND=hermes (agents run on
# Hermes, outside this image). For AGENT_BACKEND=goose, use
# ../Dockerfile.goose instead (orchestrator + goose + recipes in the same
# image — also includes the dashboard).
#
# Build (from the yaoe-flow REPO ROOT, since it needs dashboard/ in context):
#   docker build -f app/Dockerfile -t yaoe-flow .
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
# Seed SOULs for the Agent entity — read from disk in Docker (EMBEDDED_SOULS
# is empty outside a `build --compile`). Without this, seedAgentsFromSouls at
# boot creates no agents.
COPY agents ./agents
COPY --from=dashboard-build /app/dashboard/dist ./dashboard/dist

RUN mkdir -p /app/data

# HOST=0.0.0.0 is required in a container: binding on "localhost" (the
# default meant for local dev) is not reachable from outside via
# `docker run -p`/a K8s Service.
ENV HOST=0.0.0.0 \
  PORT=4790 \
  DASHBOARD_PORT=4791

EXPOSE $PORT $DASHBOARD_PORT
CMD ["bun", "src/index.ts"]
