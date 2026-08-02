# ─────────────────────────────────────────────────────────────────────────────
# Imagem "orchestrator + Goose" — use esta quando AGENT_BACKEND=goose.
#
# Traz o serviço de orquestração (Bun) + o goose CLI + os recipes pré-instalados,
# numa única imagem (deploy simples). O serviço spawna `goose acp` por dispatch e
# fala ACP (JSON-RPC/stdio). Não há servidor goose separado.
#
# Build (a partir da repo root, pois precisa de recipes/ e dashboard/ no
# contexto):
#   docker build -f Dockerfile.goose -t yaoe-flow-goose .
#
# As credenciais (OPENROUTER_API_KEY p/ o model; LINEAR_API_KEY / GitHub p/ os MCPs)
# vêm do .env em runtime (env_file no compose ou --env-file) — herdadas pelo serviço
# e repassadas ao `goose acp`. Veja docs/goose-setup.md.
#
# Também inclui a dashboard de observabilidade (SPA buildada, servida na porta
# DASHBOARD_PORT — ver .env.example e docker-compose.yml).
# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1 AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package.json ./
RUN bun install
COPY dashboard/ ./
RUN bun run build

FROM oven/bun:latest

# Deps de sistema: extração do goose, Node/npx (Linear MCP stdio), git/gh (worker/merge).
RUN apt-get update && apt-get install -y --no-install-recommends \
  curl ca-certificates bzip2 xz-utils tar git nodejs npm \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) — usado pelo agente de merge.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# GitHub MCP Server oficial (binário) — substitui o npm deprecado
# `@modelcontextprotocol/server-github`. Recipes chamam `github-mcp-server stdio`
# (ver recipes/build.ts EXT_GITHUB). Pin da versão: bump consciente, não "latest".
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

# RTK (Rust Token Killer) — proxy de CLI que filtra stdout ruidoso antes de
# voltar pro LLM. As SOULs pedem `rtk …` / `rtk proxy …` (protocol §13). Goose
# não tem hook transparente ainda; o binário no PATH + instrução na SOUL é o
# caminho. Pin da versão: bump consciente.
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

# goose CLI (headless), sem configurar provider (vem por env em runtime).
# Pin ≥1.41: OPENROUTER_PARAMETERS (session_id no body OpenRouter). stable flutuante
# já deve ser novo, mas pin evita regressão silenciosa se o tag mudar.
ARG GOOSE_VERSION=v1.43.0
RUN curl -fsSL "https://github.com/block/goose/releases/download/${GOOSE_VERSION}/download_cli.sh" \
  | CONFIGURE=false GOOSE_BIN_DIR=/usr/local/bin bash \
  && goose --version

# Config GLOBAL mínima do goose: só a extension `developer` fica ligada (as ~16
# bundled — analyze/todo/tom/memory/… — ficam OFF). Set de tools enxuto = melhor
# seleção do modelo e menos vazamento de escopo. Os MCPs por papel (linear/github)
# vêm do RECIPE. O `goose acp` herda HOME=/root, então lê daqui.
RUN mkdir -p /root/.config/goose
COPY goose/config.yaml /root/.config/goose/config.yaml

WORKDIR /app

# Serviço de orquestração.
COPY app/package.json ./
RUN bun install
COPY app/tsconfig.json ./
COPY app/src ./src
COPY app/drizzle ./drizzle
# SOULs de seed da entidade Agent (Fase 1) — lidas do disco em Docker
# (EMBEDDED_SOULS fica vazio fora do build --compile).
COPY agents ./agents

# Recipes (gerados das SOULs) — lidos pelo backend p/ montar o deeplink do ACP.
COPY recipes ./recipes

# Dashboard de observabilidade (SPA buildada no estágio anterior).
COPY --from=dashboard-build /app/dashboard/dist ./dashboard/dist

# Defaults do backend Goose (sobrescrevíveis pelo .env):
#   • o cwd das sessões é /workspace (onde o worker clona/edita)
#   • provider/model default = OpenRouter; a CHAVE vem do .env (OPENROUTER_API_KEY)
#   • HOST=0.0.0.0 é obrigatório em container (default do config é "localhost",
#     pensado pra dev fora do Docker — bind em loopback não é alcançável via
#     `docker run -p`/K8s Service)
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
