# Install AgentX

A technical teammate installs AgentX and connects a model (the AI service that writes the agents' replies). Operators can then use the browser for setup and daily work.

Before installing, go through [Before you start](requirements.md) to choose an install method and prepare a model connection. There are three ways to install:

- **Docker** keeps AgentX in a sealed box (a container) and doesn't need Node.js on the machine. Choose it if you're unsure.
- **From source** builds AgentX from its code with Node.js.
- **From npm** installs the published package with Node.js.

AgentX runs on macOS and Linux. Windows is untested; try WSL or Docker (see [Before you start › Operating systems](requirements.md#operating-systems)). With Node.js already on the machine, `npx agentix-cli start` reaches a first agent reply in about **23 seconds** on Linux and **24 seconds** on macOS (median of 3 runs each, October 2026, with a model key ready). A check in our automated tests times it again on Linux and macOS on every change and fails above 5 minutes. Add the time to get a model key if you don't have one yet. Docker and source installs take longer, mostly downloads.

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

The quickest way is one command. **Terminal**, in the folder AgentX should live in:

```sh
npx agentix-cli start
```

It creates `agentx.json` with one agent (Claude Code when the `claude` command is installed, otherwise the built-in engine with an Anthropic API key), starts the daemon and the dashboard in the background, and opens that agent's chat in your browser. If no model is set up yet, the chat asks for an API key, which it saves to `.env` in that folder, or tells you to log in to the CLI. Then the same chat answers. Logs go to `.agentx/daemon.log` and `.agentx/board.log`.

Running it again is safe: an existing `agentx.json` is left as it is, and a daemon or dashboard that already answers is reused. If ports 18800 or 4202 are taken by another AgentX, give a new folder its own: `npx agentix-cli start --port 18810 --dashboard-port 4212`.

To install the `agentx` command globally and use the setup page instead:

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

The installer does step 1 and then runs `agentx start`. **Terminal:**

```sh
curl -fsSL https://raw.githubusercontent.com/anis-marrouchi/agentx/main/install.sh | bash
```

The script checks for Node.js 22.19 or newer, up to 26. If your Node.js is missing or outside that range:

- With nvm (a tool that manages Node.js versions) on your computer, it installs Node 22 through nvm and makes it the default.
- Without nvm, it downloads the official Node 22 from nodejs.org into `~/.agentx/node`, checks the download against its published checksum, and adds that folder to the PATH in your shell's startup file (`~/.zshrc`; `~/.bashrc` and `~/.profile` for bash on Linux; `~/.bash_profile` for bash on macOS; otherwise `~/.profile`). It doesn't need administrator rights. With no Node.js at all, the whole install takes about 40 seconds.

Settings for the script, set before `bash` (for example `curl … | AGENTX_SKIP_SETUP=1 bash`):

| Setting | What it does |
|---|---|
| `AGENTX_SKIP_SETUP=1` | Installs without starting anything. |
| `AGENTX_INSTALL_NODE=0` | Doesn't download Node.js. Without a supported Node.js or nvm, the script stops with one line saying what to install. |
| `AGENTX_VERSION` | The npm version or tag to install (default `latest`). |

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
- **`agentx: command not found` after the installer added Node.js:** open a new terminal, so it reads the PATH line the installer added. Or run `export PATH="$HOME/.agentx/node/bin:$PATH"` in the current one.
- **Uninstall: `rm -rf agentx-data` says `Permission denied`:** the containers created some files as another user. On Linux, run `sudo rm -rf agentx-data`.
- **The page loads but messages get no reply:** follow [It's not answering](./help/its-not-answering.md).
