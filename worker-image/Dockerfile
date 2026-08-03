# Base image for the WORKERS (Dev) and the Orchestrator in merge mode, when
# running on the Hermes harness.
#
# Ephemeral environment: Hermes starts one container from this image per run,
# clones the repo, works/tests, and the workspace is destroyed after the
# merge. Contains the toolchain to run and test Node/Bun projects.
FROM oven/bun:1

# Node (LTS) alongside Bun — some projects/CLIs still depend on it — + git + gh.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates gnupg \
    # Node 22.x via NodeSource
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g pnpm \
    # GitHub CLI (official repo)
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Credentials are NOT baked into the image. They are injected at runtime via
# env when Hermes starts the container:
#   GIT_TOKEN / GH_TOKEN  → clone/push and PR operations (minimum scope)
# Configure git to use the token, e.g. in the agent's entrypoint:
#   git config --global url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf "https://github.com/"

CMD ["bash"]
