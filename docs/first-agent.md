# Create your first agent

::: info In the browser
Open `/setup` on your dashboard. Enter a **Team name**, an **Agent name**, and an **Agent id** such as `support` (lowercase, no spaces). Set **Trigger words** to `@support, support`. Give it one narrow job under **Personality / instructions**, such as answering questions from your approved support material.

Choose an **AI engine**. For **Anthropic API (BYO key)**, enter your Anthropic key in the last section. For a CLI engine, have the installer sign in to that tool on the host first. Leave **Connect Telegram now** unchecked if you want to test the agent before connecting a channel. Select **Save and continue**.
:::

A model is required for real replies. An API provider needs a key. Claude Code, Codex CLI, and OpenCode need their corresponding CLI installed and authenticated on the host. The scripted [demo](./see-it-first.md) is the way to explore without either.

::: info Terminal
Start the daemon if it is not running. If you added an agent to an already running daemon, restart it so the new agent loads. In Docker, use `docker compose restart daemon dashboard`. For a local install, stop and start the daemon from the installation directory (`agentx daemon stop`, then `agentx daemon start --detach`). In a source checkout, replace `agentx` with `node dist/cli.js`.
:::

Open **Settings → Agents** and select **Test drive** beside the new agent. Send a small task with an answer you can check. This uses the configured model and may consume paid usage. Check [Live](./dashboard/live.md) for the run and [Activity](./dashboard/activity.md) for its record. Then [connect Telegram](./connect-telegram.md) if you want to talk to the agent from your phone.
