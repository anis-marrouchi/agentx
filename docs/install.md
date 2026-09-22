# Install AgentX

Before installing, use the [prerequisites checklist](requirements.md) to choose Docker or Node.js and prepare a model connection.

A technical teammate installs AgentX and connects a model. Operators can then use the browser for setup and daily work. Choose Docker for a contained installation, or run the Node.js application directly.

::: warning Registry package 0.27.0
The published `0.27.0` package is missing a file used during installation (`scripts/postinstall.mjs`). This checkout fixes that packaging error. Until a corrected package is published, use the Docker or source instructions below; the npm installer may fail with `MODULE_NOT_FOUND`.
:::

## Docker: build this checkout

::: info Terminal
Install and start Docker Desktop (or Docker Engine with Compose on Linux), then run:

```sh
git clone https://github.com/anis-marrouchi/agentx.git
cd agentx
git checkout docs-v2
cp .env.example .env
docker compose up --build -d
```
:::

The first build downloads dependencies and compiles AgentX. It does not require Node.js on the host. An initialization service creates an empty team in `agentx-data/`, then the daemon and dashboard run in separate containers. Existing configuration is retained. Host ports are restricted to `127.0.0.1`.

::: info In the browser
Open `http://127.0.0.1:4202/setup`. Add your first agent. The simplest path in the default Docker image is **Anthropic API (BYO key)**: select it under **AI engine** and fill in **Anthropic API key**. Other providers need corresponding configuration. Claude Code, Codex CLI, and OpenCode are not installed in the default image; an installer must add and authenticate those tools before choosing them.
:::

Compose already runs the daemon, so you do not need the wizard's **Start daemon now** button. Adding an agent requires a daemon restart. After saving setup, restart the two application services, then open **Live** and confirm the agent appears:

::: info Terminal
```sh
docker compose restart daemon dashboard
docker compose ps
docker compose logs --tail=50 daemon dashboard
```
:::

Keep `agentx-data/`: it contains configuration, workspaces, credentials, and task history. `docker compose down` stops the services without deleting that bind-mounted directory. If you change provider keys in the Compose `.env` file, recreate the services with `docker compose up -d --force-recreate`.

For another local port, set `AGENTX_DASHBOARD_PORT` or `AGENTX_DAEMON_PORT` in `.env`. An existing non-Docker configuration needs `node.bind: "0.0.0.0:18800"` and `dashboard.daemonUrl: "http://daemon:18800"` so the containers can reach each other. Back up the data before adapting an existing install.

## Run from source

::: info Terminal
Use **Node.js 22.x** and pnpm 10. From the checked-out repository:

```sh
pnpm install
pnpm build
node dist/cli.js setup
```
:::

The wizard opens at `http://127.0.0.1:4202/setup`. Keep that terminal open while it serves the dashboard. In another terminal, start the daemon from the same directory:

::: info Terminal
```sh
node dist/cli.js daemon start --detach
node dist/cli.js daemon status
```
:::

Alternatively, the setup confirmation's **Start daemon now** button can start it on a local install. The dashboard and daemon are still separate processes: `setup` does not start the daemon merely by opening the wizard.

## Install a corrected npm release

Once the packaging fix is released, the npm package is `agentix-cli` and the executable is `agentx`:

```sh
npm install -g agentix-cli
agentx setup
```

The one-line `install.sh` installer also installs that npm package and opens setup, so it is affected by the same release issue. Node 20 is too old; the package requires `>=22 <23`.

Continue with [Your first agent](./first-agent.md). If the browser loads but messages do not run, follow [It's not answering](./help/its-not-answering.md).
