# Imagem-base dos WORKERS (Senior Engineer) e do Orquestrador em modo merge.
#
# Ambiente efêmero: o Hermes sobe um container desta imagem por execução, clona o
# repo, trabalha/testa, e o workspace é destruído após o merge. Contém o toolchain
# para rodar e testar projetos Node/Bun.
FROM oven/bun:1

# Node (LTS) ao lado do Bun — alguns projetos/CLIs ainda dependem dele — + git + gh.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates gnupg \
    # Node 22.x via NodeSource
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g pnpm \
    # GitHub CLI (repositório oficial)
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Credenciais NÃO ficam na imagem. São injetadas em runtime via env quando o
# Hermes sobe o container:
#   GIT_TOKEN / GH_TOKEN  → clone/push e operações da PR (escopo mínimo)
# Configure o git para usar o token, ex. no entrypoint do agent:
#   git config --global url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf "https://github.com/"

CMD ["bash"]
