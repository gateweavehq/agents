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
WORKDIR /workspace
CMD ["sleep", "infinity"]
