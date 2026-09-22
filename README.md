<div align="center">

<img src="docs/public/agentx-symbol.png" alt="AgentX" width="96" />

# AgentX

**Put an AI teammate on the tools your team already uses.**

[![npm](https://img.shields.io/npm/v/agentix-cli?label=npm%20%C2%B7%20agentix-cli)](https://www.npmjs.com/package/agentix-cli)
[![CI](https://github.com/anis-marrouchi/agentx/actions/workflows/ci.yml/badge.svg)](https://github.com/anis-marrouchi/agentx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22.x-brightgreen)](package.json)

[See the demo](#see-it-without-an-account) · [Install](#install) · [Read the guide](docs/index.md)

</div>

AgentX routes messages and scheduled jobs to AI agents you host. Connect Telegram, WhatsApp, GitLab, GitHub, or a webhook. Give each agent a clear job. Watch the result in a browser dashboard.

![Three agents on three local demo nodes in the Live dashboard](docs/public/screenshots/live.png)

*The isolated scripted demo, after a cross-node task. No live fleet data is shown.*

## See it without an account

From a built source checkout with Node.js 22.x, run:

```sh
node dist/cli.js demo
```

The demo starts three local AgentX daemons and sends a task between them. Routing, network calls, and the event record are real. Model responses are scripted, so the demo makes no billable model calls. The terminal prints the dashboard addresses. [What to expect](docs/see-it-first.md).

## What it does

- **Answers where your team works.** Connect a channel and assign its messages to an agent.
- **Runs scheduled work.** Ask an agent for a daily report or another recurring task.
- **Shows what happened.** Live shows current work; Activity records completed runs; Monitor shows reviewed work that needs a person and work agents can handle.
- **Grows across machines.** Start with one host, then pair another when a job needs its tools or files.

## Describe an automation, get an automation

The Workflows editor has a chat control. Describe the timing, source, and destination in ordinary language. An authoring agent can propose a workflow and show an **Apply to canvas** action. Read the proposed steps before applying them: this replaces the current graph. Real authoring needs a working model. The demo includes a fixed example for **Build the demo report workflow**. [Walk through it](docs/automations/describe-it.md).

![The demo workflow assistant proposing a report](docs/public/screenshots/editor-chat-reply.png)

## Install

A technical teammate needs a terminal for installation, model setup, and starting the services. The web wizard handles the rest of the initial setup; daily inspection is in the browser. AgentX requires **Node.js 22.x**.

```sh
git clone https://github.com/anis-marrouchi/agentx.git
cd agentx
git checkout docs-v2
cp .env.example .env
docker compose up --build -d
```

Open **http://127.0.0.1:4202/setup**. Compose builds this checkout and starts both services; its default image uses an API model rather than a preinstalled model CLI.

Without Docker, install Node 22.x and pnpm 10, then build and open the wizard:

```sh
pnpm install
pnpm build
node dist/cli.js setup
```

On a source install, the wizard serves the dashboard and **the daemon is a separate process**. Start it in another terminal, or use the wizard's **Start daemon now** button:

```sh
node dist/cli.js daemon start --detach
node dist/cli.js daemon status
```

The npm package is `agentix-cli`; the installed executable is `agentx`. **Published version 0.27.0 has an installation error:** its postinstall script is missing from the package. Version 0.28.0 includes the fix; use 0.28.0 or newer, or build from source/Docker. Follow the [installation guide](docs/install.md) for details.

## One machine is enough to start

When an agent needs to work on another machine, pair the nodes with `agentx connect mesh invite` and `agentx connect mesh join <link>`. A connected agent can pass work to another node. For example:

```text
You:     "@cx CI is red on GitLab — find the cause"
CX:      sends the build investigation to @builder on another node
Builder: checks the project and reports the result
CX:      replies in the original thread
```

The [second-machine guide](docs/jobs/second-machine.md) covers pairing. You do not need mesh for a one-agent setup.

## The dashboard

The six top-level tabs are **Live, Operations, Monitor, Activity, Workflows, and Settings**. [Dashboard guide](docs/dashboard/index.md). The dashboard and daemon must both be running for messages to be handled.

## Channels and models

Telegram and WhatsApp have pairing flows. GitLab, GitHub, and generic webhooks can bring in events. **Slack and Discord are not supported as live channel adapters in this build.** [Channel reference](docs/reference/channels.md).

Real agents need a configured model. An API provider needs a key; Claude Code, Codex CLI, and OpenCode need their CLI installed and authenticated on the host. Model-provider charges or subscription terms depend on your chosen provider.

## Help and development

- [Start here](docs/index.md) · [Troubleshooting](docs/help/its-not-answering.md) · [CLI reference](docs/reference/cli.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md)

AgentX is released under the [MIT License](LICENSE).
