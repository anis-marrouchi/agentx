# Build the checked-out source; Compose runs this image as two services.
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git tini python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /build
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml .npmrc ./
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" \
  && pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsup.config.ts tsup.web.config.ts ./
COPY src/ ./src/
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs
COPY agentx.example.json README.md LICENSE ./
RUN pnpm build && mkdir /package && npm pack --ignore-scripts --pack-destination /package

# Scripted demo for lessons and recordings: docker-compose.demo.yml.
# Runs from the source tree because the seeder uses the repo's fixtures.
FROM build AS demo
RUN pnpm rebuild
COPY docker/demo/start.sh /usr/local/bin/agentx-demo
COPY docs/.scripts/seed-demo.mjs ./docs/.scripts/
COPY docs/public/examples/demo-report.json ./docs/public/examples/
EXPOSE 18931
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["agentx-demo"]

FROM base AS runtime
ARG INSTALL_CLAUDE=0
COPY --from=build /package/ /tmp/agentx-package/
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" \
  && npm install -g --omit=dev /tmp/agentx-package/*.tgz \
  && if [ "${INSTALL_CLAUDE}" = "1" ]; then npm install -g --omit=dev @anthropic-ai/claude-code; fi \
  && rm -rf /tmp/agentx-package && npm cache clean --force
COPY docker/init.mjs /opt/agentx-docker/init.mjs
WORKDIR /data
EXPOSE 18800 4202
ENTRYPOINT ["/usr/bin/tini", "--", "agentx"]
CMD ["daemon", "start"]
