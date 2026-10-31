# The machine each conversation's sandbox runs (RunnerSandbox in packages/runtime/src/sandbox.ts).
# The donor image ships the shim that @cloudflare/sandbox talks to: keep its tag equal to the
# version of @cloudflare/sandbox in packages/runtime/package.json.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.3
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates coreutils curl git jq python3 python3-pip python3-venv ripgrep \
  && rm -rf /var/lib/apt/lists/*
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# Claude Code, for agents whose engine it is (packages/runtime/src/claude-code.ts). Anthropic's,
# under its own terms; the image installs it when it is built, and pins it, since its auto-updater
# is off in the sandbox.
ARG CLAUDE_CODE_VERSION=2.1.308
# Codex, for agents whose engine it is (packages/runtime/src/codex.ts). OpenAI's, under Apache-2.0;
# pinned for the same reason, and its settings there take for granted what this version reads.
ARG CODEX_VERSION=0.165.0
RUN npm install --global \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force
# OpenCode, for agents whose engine it is (packages/runtime/src/opencode.ts). MIT, pinned for the
# same reason. Its build for this machine alone: `opencode-ai` installs one for every variant of
# Linux. With the package it installs into its settings folder when it starts, which a new
# container would otherwise fetch from npm on its first turn.
ARG OPENCODE_VERSION=1.19.5
RUN npm install --global "opencode-linux-x64@${OPENCODE_VERSION}" \
  && ln -s "$(npm root --global)/opencode-linux-x64/bin/opencode" /usr/local/bin/opencode \
  && mkdir -p /root/.config/opencode \
  && cd /root/.config/opencode \
  && npm install --no-fund --no-audit "@opencode-ai/plugin@${OPENCODE_VERSION}" \
  && npm cache clean --force \
  && opencode --version
# pnpm and Yarn, through Corepack: a repository gets the version its `packageManager` names,
# downloaded from npm when first used (packages/runtime/src/sandbox.ts tells Corepack to, without
# asking). pnpm's current version comes with the image, with the native binary it fetches on its
# first run, so a repository on it, or naming none, needs no download.
ARG PNPM_VERSION=12.4.2
RUN corepack enable \
  && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack install --global "pnpm@${PNPM_VERSION}" \
  && pnpm --version
WORKDIR /workspace
CMD ["sleep", "infinity"]
