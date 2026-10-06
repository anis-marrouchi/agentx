# Install AgentX

A technical teammate installs AgentX and connects a model (the AI service that writes the agents' replies). Operators can then use the browser for setup and daily work.

Before installing, go through [Before you start](requirements.md) to choose an install method and prepare a model connection. There are three ways to install:

- **Docker** keeps AgentX in a sealed box (a container) and doesn't need Node.js on the machine. Choose it if you're unsure.
- **From source** builds AgentX from its code with Node.js.
- **From npm** installs the published package with Node.js.

AgentX runs on macOS and Linux. Windows is untested; try WSL or Docker (see [Before you start › Operating systems](requirements.md#operating-systems)). Plan on about 10 to 20 minutes for a first install, most of it downloads, plus the time to get a model key.

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

![The setup page with Anthropic API (BYO key) chosen as the AI engine and the Anthropic API key field below](/screenshots/setup/engine.png)

Keep the `agentx-data/` folder. It holds your settings, agent folders, credentials and task history. `docker compose down` stops AgentX without deleting it.

To use other ports, set `AGENTX_DASHBOARD_PORT` or `AGENTX_DAEMON_PORT` in `.env`. If you change keys in `.env`, apply them with `docker compose up -d --force-recreate`.

::: details Moving an existing install into Docker
Back up your data first. An existing `agentx.json` needs `node.bind: "0.0.0.0:18800"` and `dashboard.daemonUrl: "http://daemon:18800"` so the two containers can reach each other.
:::

## Run from source

1. Install **Node.js 22.19 or newer, up to 26**, and **pnpm 10**.
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

The npm package is called `agentix-cli`; the command it installs is `agentx`. It needs Node.js 22.19 or newer, up to 26 (Node 20 is too old).

1. **Terminal:** install it:
   ```sh
   npm install -g agentix-cli@latest
   ```
   It takes a minute or two and may print `npm warn deprecated …` lines. Those warnings are harmless.
2. **Terminal:** open the setup page:
   ```sh
   agentx setup
   ```
3. **Browser:** fill in the setup page as described in [Your first agent](./first-agent.md), select **Save and continue**, then **Start daemon now**.

You can also do steps 1 and 2 with one command. **Terminal:**

```sh
curl -fsSL https://raw.githubusercontent.com/anis-marrouchi/agentx/main/install.sh | bash
```

It installs the same npm package and opens the setup page. The script checks for Node.js 22.19 or newer, up to 26. If your Node.js is missing or outside that range, it installs Node 22 for you when nvm (a tool that manages Node.js versions) is on your computer, and makes it the default. Without nvm, it stops and tells you which version to install.

Continue with [Your first agent](./first-agent.md).

## Uninstall

These steps delete your settings, agents and task history. Copy anything you want to keep first.

**Docker:**

1. **Terminal:** in the `agentx` folder, stop AgentX and remove its containers:
   ```sh
   docker compose down -v
   ```
2. **Terminal:** delete the data folder:
   ```sh
   rm -rf agentx-data
   ```
3. Delete the `agentx` folder itself if you no longer need it.

**npm or source:**

1. **Terminal:** in the folder that holds your `agentx.json`, stop the daemon (from source: `node dist/cli.js daemon stop`):
   ```sh
   agentx daemon stop
   ```
2. **Terminal:** for an npm install, remove the package:
   ```sh
   npm uninstall -g agentix-cli
   ```
   For a source install, delete the `agentx` source folder instead.
3. Delete `agentx.json`, `.env` and the `.agentx` folder from that folder. Agent folders (each agent's `workspace` in `agentx.json`) are yours to keep or delete.

## Check it worked

1. **Terminal:** check the daemon. In Docker, run `docker compose ps`: `daemon` and `dashboard` are both running. Otherwise run `agentx daemon status` (from source: `node dist/cli.js daemon status`). It prints `Status: running` and lists your agent.
2. **Browser:** open `http://127.0.0.1:4202/live`. Your agent appears on the **Live** tab.

## If something is wrong

- **Docker: something failed to start:** read the last lines of the logs with `docker compose logs --tail=50 daemon dashboard`.
- **The agent doesn't appear in Live:** the daemon was already running when you added it. Restart the daemon (Docker: `docker compose restart daemon dashboard`; otherwise `agentx daemon stop`, then `agentx daemon start --detach`).
- **npm install fails with `MODULE_NOT_FOUND`:** you have version 0.27.0, which was published with a missing file. Install `agentix-cli@latest`.
- **`Unsupported engine` or other Node.js errors:** check `node --version`. AgentX needs 22.19 or newer, up to 26.
- **Uninstall: `rm -rf agentx-data` says `Permission denied`:** the containers created some files as another user. On Linux, run `sudo rm -rf agentx-data`.
- **The page loads but messages get no reply:** follow [It's not answering](./help/its-not-answering.md).
