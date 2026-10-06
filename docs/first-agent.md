# Create your first agent

An agent is an AI model set up to do one job. This page creates one from the setup page, then checks that it answers. You need AgentX [installed](./install.md) and a model connection:

- **An API provider** (such as the Anthropic API) needs an API key.
- **A command-line tool** (Claude Code, Codex CLI or OpenCode) must be installed and signed in on the machine that runs AgentX. The setup page calls these **CLI engines**.

Not sure which to get, or what it costs? See [Choose a model account](./help/costs.md#choose-a-model-account). In short: a Claude subscription works through Claude Code, and an API key needs billing set up with the provider first. No model yet? The scripted [demo](./see-it-first.md) lets you look around without one.

## Fill in the setup page

1. **Browser:** open `/setup` on your dashboard, for example `http://127.0.0.1:4202/setup`.
2. Under **Team basics**, enter a **Team name**, such as `My Team`.
3. Under **First agent**, enter an **Agent name**, such as `Support`.
4. Enter an **Agent id**, such as `support`. Use lowercase letters, numbers and dashes, with no spaces.
5. Set **Trigger words** to `@support, support`. A message that contains a trigger word goes to this agent.
6. Choose an **AI engine**. For an API key, choose **Anthropic API (BYO key)**. For a CLI engine, choose the tool that's installed on the machine.
7. Leave **Model** as it is, unless you know which model you want.
8. Under **Personality / instructions**, describe one narrow job in plain words, for example: "Answer questions about our opening hours and returns policy. Keep replies short."
9. Leave **Connect Telegram now** unticked. You'll test the agent first.
10. If you chose **Anthropic API (BYO key)**, paste your key into **API key** under **Anthropic API key**. It's saved in the `.env` file next to `agentx.json`, not in the dashboard.
11. Select **Save and continue**.

![The setup page filled in for a Support agent that uses the Anthropic API engine](/screenshots/setup/filled.png)

## Start or restart the daemon

The daemon (the background service that runs agents) only loads new agents when it starts.

- **Nothing running yet (local install):** select **Start daemon now** on the setup page.
- **Docker:**
  1. **Terminal:** in the AgentX folder, run `docker compose restart daemon dashboard`.
- **The daemon was already running (local install):**
  1. **Terminal:** stop it with `agentx daemon stop`.
  2. **Terminal:** start it again with `agentx daemon start --detach`.

In a source checkout, type `node dist/cli.js` instead of `agentx`.

## Try it out

1. **Browser:** open the **Settings** tab. The **Agents** section opens first.
2. Select **Test drive** next to your new agent.
3. Send a small question with an answer you can check. This uses your model and may cost money.

![Settings, Agents tab, with a Test drive button beside each agent](/screenshots/settings.png)

Then [connect Telegram](./connect-telegram.md) if you want to talk to the agent from your phone.

## Check it worked

1. The **Test drive** window shows the agent's reply.
2. **Browser:** the **Live** tab shows the agent, and the run appears there while it works.
3. **Browser:** the **Activity** tab lists the finished run. See [Activity](./dashboard/activity.md).

## If something is wrong

- **Save and continue shows an error about the Agent id:** use only lowercase letters, numbers, `-` and `_`, starting with a letter or number.
- **The agent isn't listed in Settings or Live:** the daemon hasn't loaded it. Restart the daemon as above.
- **Test drive returns `Credit balance is too low`:** the API key's account has no credits. Add a payment method and buy credits in the provider's console. See [Choose a model account](./help/costs.md#choose-a-model-account).
- **Test drive returns an error about a key or login:** for **Anthropic API (BYO key)**, check `ANTHROPIC_API_KEY` in `.env`. For a CLI engine, check the tool on the machine, for example `claude --version`, and sign in to it.
- **Nothing happens at all:** run `agentx daemon status`. If it says `Daemon is not running`, start it. Then see [It's not answering](./help/its-not-answering.md).
