# ─────────────────────────────────────────────────────────────────────────────
# "orchestrator + Goose" image — use this when AGENT_BACKEND=goose.
#
# Bundles the orchestration service (Bun) + the goose CLI + pre-installed
# recipes in a single image (simple deploy). The service spawns `goose acp`
# per dispatch and speaks ACP (JSON-RPC/stdio). There is no separate goose
# server.
#
# Build (from the repo root, since it needs recipes/ and dashboard/ in
# context):
#   docker build -f Dockerfile.goose -t yaoe-flow-goose .
#
# Credentials (OPENROUTER_API_KEY for the model; LINEAR_API_KEY / GitHub for
# the MCPs) come from .env at runtime (env_file in compose or --env-file) —
# inherited by the service and forwarded to `goose acp`. See docs/harnesses.md.
#
# Also includes the observability dashboard (built SPA, served on
# DASHBOARD_PORT — see .env.example and docker-compose.yml).
# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1 AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package.json ./
RUN bun install
COPY dashboard/ ./
RUN bun run build

FROM oven/bun:latest

# System deps: goose extraction, Node/npx (Linear MCP stdio), git/gh (worker/merge).
RUN apt-get update && apt-get install -y --no-install-recommends \
  curl ca-certificates bzip2 xz-utils tar git nodejs npm \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) — used by the merge agent.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Official GitHub MCP Server (binary) — replaces the deprecated npm package
# `@modelcontextprotocol/server-github`. Recipes call `github-mcp-server stdio`
# (see recipes/build.ts EXT_GITHUB). Version pin: bump deliberately, not "latest".
# Asset names are `github-mcp-server_<OS>_<ARCH>.tar.gz` (version only in the tag).
ARG GITHUB_MCP_VERSION=1.6.0
RUN ARCH="$(dpkg --print-architecture)" \
  && case "$ARCH" in \
       amd64) GHARCH=x86_64 ;; \
       arm64) GHARCH=arm64 ;; \
       *) echo "unsupported arch for github-mcp-server: $ARCH" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://github.com/github/github-mcp-server/releases/download/v${GITHUB_MCP_VERSION}/github-mcp-server_Linux_${GHARCH}.tar.gz" \
     | tar -xz -C /usr/local/bin github-mcp-server \
  && chmod +x /usr/local/bin/github-mcp-server \
  && github-mcp-server --version

# RTK (Rust Token Killer) — CLI proxy that filters noisy stdout before it goes
# back to the LLM. The SOULs call `rtk …` / `rtk proxy …` (protocol §13).
# Goose has no transparent hook yet; the binary on PATH + the SOUL instruction
# is the way. Version pin: bump deliberately.
ARG RTK_VERSION=0.43.0
RUN ARCH="$(dpkg --print-architecture)" \
  && case "$ARCH" in \
       amd64) RTK_ASSET=rtk-x86_64-unknown-linux-musl.tar.gz ;; \
       arm64) RTK_ASSET=rtk-aarch64-unknown-linux-gnu.tar.gz ;; \
       *) echo "unsupported arch for rtk: $ARCH" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/${RTK_ASSET}" \
     | tar -xz -C /usr/local/bin rtk \
  && chmod +x /usr/local/bin/rtk \
  && rtk --version

# goose CLI (headless), no provider configured (comes from env at runtime).
# Pin ≥1.41: OPENROUTER_PARAMETERS (session_id in the OpenRouter body).
# The floating "stable" tag should already be new enough, but pinning avoids
# a silent regression if the tag moves.
ARG GOOSE_VERSION=v1.43.0
RUN curl -fsSL "https://github.com/block/goose/releases/download/${GOOSE_VERSION}/download_cli.sh" \
  | CONFIGURE=false GOOSE_BIN_DIR=/usr/local/bin bash \
  && goose --version

# Minimal GLOBAL goose config: only the `developer` extension stays on (the
# ~16 bundled ones — analyze/todo/tom/memory/… — stay OFF). A lean toolset
# means better model tool-selection and less scope leakage. Per-role MCPs
# (linear/github) come from the RECIPE. `goose acp` inherits HOME=/root, so it
# reads from here.
RUN mkdir -p /root/.config/goose
COPY goose/config.yaml /root/.config/goose/config.yaml

WORKDIR /app

# Orchestration service.
COPY app/package.json ./
RUN bun install
COPY app/tsconfig.json ./
COPY app/src ./src
COPY app/drizzle ./drizzle
# Seed SOULs for the Agent entity — read from disk in Docker (EMBEDDED_SOULS
# is empty outside a `build --compile`).
COPY agents ./agents

# Recipes (generated from the SOULs) — read by the backend to build the ACP deeplink.
COPY recipes ./recipes

# Observability dashboard (SPA built in the previous stage).
COPY --from=dashboard-build /app/dashboard/dist ./dashboard/dist

# Goose backend defaults (overridable via .env):
#   • session cwd is /workspace (where the worker clones/edits)
#   • default provider/model = OpenRouter; the KEY comes from .env (OPENROUTER_API_KEY)
#   • HOST=0.0.0.0 is required in a container (the config default is
#     "localhost", meant for dev outside Docker — a loopback bind is not
#     reachable via `docker run -p`/a K8s Service)
ENV AGENT_BACKEND=goose \
  GOOSE_BIN=goose \
  GOOSE_RECIPES_DIR=/app/recipes \
  GOOSE_WORKING_DIR=/workspace \
  GOOSE_PROVIDER=openrouter \
  GOOSE_MODEL=qwen/qwen3-coder \
  HOST=0.0.0.0 \
  PORT=4790 \
  DASHBOARD_PORT=4791
RUN mkdir -p /workspace /app/data

EXPOSE $PORT $DASHBOARD_PORT
CMD ["bun", "src/index.ts"]
