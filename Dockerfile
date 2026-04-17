# AgentX Dockerfile — runs the agentx daemon + dashboard in a single container.
#
# Build:
#   docker build -t agentx:latest .
# Run (see docker-compose.yml for the friendlier path):
#   docker run --rm -it \
#     -p 18800:18800 -p 4202:4202 \
#     -v "$PWD/agentx-data":/data \
#     -e ANTHROPIC_API_KEY=sk-... \
#     agentx:latest
#
# The container treats /data as the working directory, so your agentx.json,
# .env, agents/, .agentx/, and task-history all live on the host via the
# bind mount. No state is kept inside the container itself.

FROM node:20-slim AS base

# Claude Code is an optional install target; we don't bake it in by default
# since many operators will use the SDK tier with just an API key. Set
# INSTALL_CLAUDE=1 at build time to pull it in.
ARG INSTALL_CLAUDE=0

# System deps: git is often needed by Claude Code tools; ca-certs for HTTPS;
# tini gives us a proper PID 1 so signals work.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/*

# Install AgentX globally. Pin via --build-arg AGENTX_VERSION=x.y.z for repeatable builds.
ARG AGENTX_VERSION=latest
RUN npm install -g --omit=dev "agentix-cli@${AGENTX_VERSION}" \
  && if [ "${INSTALL_CLAUDE}" = "1" ]; then npm install -g --omit=dev @anthropic-ai/claude-code; fi \
  && npm cache clean --force

WORKDIR /data

# Default: boot the daemon. Override with `docker run ... agentx <command>`
# to run other CLI commands (e.g. `agentx setup` hits the wizard).
EXPOSE 18800 4202
ENTRYPOINT ["/usr/bin/tini", "--", "agentx"]
CMD ["daemon", "start"]
