# Create your first agent

An agent is an AI model set up to do one job. This page creates one from the setup page, then checks that it answers. You need AgentX [installed](./install.md) and a model connection:

- **An API provider** (such as the Anthropic API) needs an API key.
- **A command-line tool** (Claude Code, Codex CLI or OpenCode) must be installed and signed in on the machine that runs AgentX. The setup page gives you the command to install or sign in to Claude Code.

Not sure which to get, or what it costs? See [Choose a model account](./help/costs.md#choose-a-model-account). In short: a Claude subscription works through Claude Code, and an API key needs billing set up with the provider first. No model yet? The scripted [demo](./see-it-first.md) lets you look around without one.

## Follow the setup page

The setup page takes you from nothing to a first answer in four steps, all in the browser. You don't edit any file by hand: AgentX writes `agentx.json` and `.env` for you.

1. **Terminal:** run `agentx start` (or `npx agentix-cli start`). On a first run it opens the setup page in your browser. To open it yourself, go to `/setup` on your dashboard, for example `http://127.0.0.1:4202/setup`.
2. **Browser:** under **Connect your AI model account**, read what AgentX found on this computer:
   - **Claude Code is installed and signed in** (or an API key, or Codex CLI): nothing to do, go on to the next step.
   - **A command to run:** select **Copy**. **Terminal:** paste the command and press Return, then sign in when asked. **Browser:** select **Check again**.
   - **Or paste an Anthropic API key:** paste your key and select **Save key**. It's saved in the `.env` file next to `agentx.json`, on this computer only.
   - **Use this account for my agent:** your agent's own engine isn't ready, but another account on this computer is. Select it to switch the agent to that account.
3. Under **Create your first agent**, enter an **Agent name**, such as `Assistant`. Leave **Its folder** empty to keep the agent's files in the `agents` folder next to `agentx.json`, or type a folder, such as `~/Projects/assistant`.
4. Select **Create agent**. AgentX saves the agent and starts the daemon (the background service that runs agents), or restarts it so it loads the new agent. This can take up to 30 seconds. If an agent already exists, this step shows it instead and makes no second one.
5. Under **Give it a first task**, keep the suggested task or write your own, then select **Send**. The answer appears under it as the agent writes. This uses your model and may cost money.
6. Under **Done**, select **Open the chat in the Hub** to keep talking to the agent in the same conversation.

![The setup page on a new computer: step 1 found Claude Code signed in, step 2 asks for the agent's name and folder, step 3 waits](/screenshots/setup/steps.png)

Add more agents, Telegram, or the agent's instructions later in the Hub's **Settings**.

## Try it out

1. **Browser:** open the Hub and select **Settings**. The **Agents** section opens first.
2. Select your new agent's card.
3. Under **Test drive**, send a small question with an answer you can check. This uses your model and may cost money.

![Settings › Agents on the Hub, with one card per agent](/screenshots/wall/settings.png)

Then [connect Telegram](./connect-telegram.md) if you want to talk to the agent from your phone.

## Check it worked

1. Step 3 of the setup page shows the agent's answer, and step 4 appears.
2. **Browser:** on the Hub, select **Agents** in the nav (under **More** on a phone). The agent is listed. While it works, the run shows on the Hub's **Live** page.
3. **Browser:** select **Activity** in the Hub's nav. It lists the finished run. See [Activity](./dashboard/activity.md).

## If something is wrong

Every step shows a red message saying what went wrong and what to do next. The common ones:

- **No AI model account was found on this computer:** run the command shown in Terminal and sign in, or paste an Anthropic API key. Then select **Check again**.
- **That does not look like an Anthropic API key:** copy the key again from the provider's console. Anthropic keys start with `sk-ant-`.
- **AgentX can't write to the folder:** choose a folder inside your home folder, or leave **Its folder** empty.
- **Port 18800 is used by another AgentX install** (or another program): stop the other one, or run this install on other ports: `agentx start --port 18810 --dashboard-port 4212`.
- **Your API account has no credits left:** add a payment method and buy credits in the provider's console. See [Choose a model account](./help/costs.md#choose-a-model-account).
- **The model account refused the request:** the CLI isn't signed in or the key is wrong. Go back to step 1 and connect it again.
- **AgentX's background service did not start** (or did not load your agent): the message names the log file, `.agentx/daemon.log`. **Terminal:** run `agentx daemon restart`, then select **Try again**. Then see [It's not answering](./help/its-not-answering.md).
- **Docker:** the daemon runs in its own container, so the setup page can't restart it. **Terminal:** run `docker compose restart daemon dashboard`, then select **Try again**.
