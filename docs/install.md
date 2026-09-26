# Install AgentX

A technical teammate installs AgentX and connects a model (the AI service that writes the agents' replies). Operators can then use the browser for setup and daily work.

Before installing, go through [Before you start](requirements.md) to choose an install method and prepare a model connection. There are three ways to install:

- **Docker** keeps AgentX in a sealed box (a container) and doesn't need Node.js on the machine. Choose it if you're unsure.
- **From source** builds AgentX from its code with Node.js.
- **From npm** installs the published package with Node.js.

AgentX runs as two programs: the **daemon** (the background service that runs agents) and the **dashboard** (the website you open in the browser). Every method below starts both.

## Docker

1. Install and start Docker Desktop (on Linux: Docker Engine with the Compose plugin).
2. **Terminal:** download AgentX:
   ```sh
   git clone https://github.com/anis-marrouchi/agentx.git
   ```
3. **Terminal:** go into the folder:
   ```sh
   cd agentx
   ```
4. **Terminal:** create your settings file for Docker:
   ```sh
   cp .env.example .env
   ```
5. **Terminal:** build and start AgentX:
   ```sh
   docker compose up --build -d
   ```
   The first build downloads what AgentX needs and takes a few minutes. It creates an empty team in the `agentx-data/` folder, then starts the daemon and the dashboard in separate containers. They are reachable only from this machine (`127.0.0.1`).
6. **Browser:** open `http://127.0.0.1:4202/setup`.
7. **Browser:** fill in the setup page as described in [Your first agent](./first-agent.md). In the Docker image, the simplest **AI engine** is **Anthropic API (BYO key)** ("bring your own key"): choose it and paste your key under **Anthropic API key**. Claude Code, Codex CLI and OpenCode aren't installed in the image; someone must add and sign in to them first.
8. **Browser:** select **Save and continue**. Docker already runs the daemon, so you don't need the **Start daemon now** button.
9. **Terminal:** restart AgentX so it loads the new agent:
   ```sh
   docker compose restart daemon dashboard
   ```

<!-- Screenshot needed: the /setup page and the AI engine picker. Not defined in docs/.scripts/capture.mjs yet. -->

Keep the `agentx-data/` folder. It holds your settings, agent folders, credentials and task history. `docker compose down` stops AgentX without deleting it.

To use other ports, set `AGENTX_DASHBOARD_PORT` or `AGENTX_DAEMON_PORT` in `.env`. If you change keys in `.env`, apply them with `docker compose up -d --force-recreate`.

::: details Moving an existing install into Docker
Back up your data first. An existing `agentx.json` needs `node.bind: "0.0.0.0:18800"` and `dashboard.daemonUrl: "http://daemon:18800"` so the two containers can reach each other.
:::

## Run from source

1. Install **Node.js 22** and **pnpm 10**.
2. **Terminal:** download AgentX and go into the folder:
   ```sh
   git clone https://github.com/anis-marrouchi/agentx.git
   cd agentx
   ```
3. **Terminal:** install what AgentX needs:
   ```sh
   pnpm install
   ```
4. **Terminal:** build it:
   ```sh
   pnpm build
   ```
5. **Terminal:** open the setup page. Leave this terminal open; it runs the dashboard:
   ```sh
   node dist/cli.js setup
   ```
6. **Browser:** at `http://127.0.0.1:4202/setup`, fill in the page as described in [Your first agent](./first-agent.md), then select **Save and continue**.
7. **Browser:** select **Start daemon now**. Or, in a second terminal in the same folder, start it yourself:
   ```sh
   node dist/cli.js daemon start --detach
   ```

Opening the setup page doesn't start the daemon; one of the two options in step 7 does.

## Install from npm

The npm package is called `agentix-cli`; the command it installs is `agentx`. It needs Node.js 22 (Node 20 is too old).

1. **Terminal:** install it:
   ```sh
   npm install -g agentix-cli@latest
   ```
2. **Terminal:** open the setup page:
   ```sh
   agentx setup
   ```
3. **Browser:** fill in the setup page as described in [Your first agent](./first-agent.md), select **Save and continue**, then **Start daemon now**.

The one-line `install.sh` installer installs the same npm package and opens setup.

Continue with [Your first agent](./first-agent.md).

## Check it worked

1. **Terminal:** check the daemon. In Docker, run `docker compose ps`: `daemon` and `dashboard` are both running. Otherwise run `agentx daemon status` (from source: `node dist/cli.js daemon status`). It prints `Status: running` and lists your agent.
2. **Browser:** open `http://127.0.0.1:4202/live`. Your agent appears on the **Live** tab.

## If something is wrong

- **Docker: something failed to start:** read the last lines of the logs with `docker compose logs --tail=50 daemon dashboard`.
- **The agent doesn't appear in Live:** the daemon was already running when you added it. Restart the daemon (Docker: `docker compose restart daemon dashboard`; otherwise `agentx daemon stop`, then `agentx daemon start --detach`).
- **npm install fails with `MODULE_NOT_FOUND`:** you have version 0.27.0, which was published with a missing file. Install `agentix-cli@latest`.
- **`Unsupported engine` or other Node.js errors:** check `node --version`. AgentX needs 22.
- **The page loads but messages get no reply:** follow [It's not answering](./help/its-not-answering.md).
