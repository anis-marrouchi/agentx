# Settings — connect the team

Settings is where you manage agents, the apps they answer from, schedules and access. Everything here is saved to `agentx.json`, the AgentX settings file on your machine. When you save, the running daemon (the AgentX background service) picks up the change on its own. Saving does not start a stopped daemon.

![Settings agent list from the isolated demo](/screenshots/settings.png)

*The demo's agent is local and uses scripted replies.*

| Tab | What it's for |
|---|---|
| **Agents** | Your agents, with **Test drive** to try one and **Manage** to change it |
| **Channels** | The chat apps agents answer from (Telegram, WhatsApp, calls, GitLab, GitHub), and **Notifications routing** |
| **Schedules** | Jobs an agent runs on a timer. See [Send a daily report](../jobs/daily-report.md) |
| **Webhooks** | Addresses other services call when something happens there |
| **Mesh** | Other AgentX machines this one shares work with. See [Add a second machine](../jobs/second-machine.md) |
| **Boards** | The task boards shown in the dashboard |
| **Actions** | Reusable commands and web calls that workflows can run |
| **Tokens** | Access tokens: passwords for scripts and other machines that talk to AgentX |
| **Advanced** | The whole settings file, to read or edit directly |

A **Business** tab (org chart, projects, and which chat belongs to which client) appears only when the business features are switched on (`business.enabled` in `agentx.json`).

## Try an agent

1. **Browser:** open the dashboard and select the **Settings** tab.
2. On **Agents**, find the agent and select **Test drive**.
3. Type a small task with an answer you can check, and send it.
4. Read the reply in the panel. Test drives use the agent's real model, so they may cost money.

## Connect a chat app

![The Channels tab with Telegram configured](/screenshots/settings-channels.png)

1. **Browser:** in **Settings**, select **Channels**.
2. Select the app's card, such as **Telegram**, then **Set up** or **Manage**.
3. Follow that app's form. For Telegram, see [Connect Telegram](../connect-telegram.md): the form asks for the *name* of the setting that holds the bot token, and the token itself goes in the `.env` file next to `agentx.json`, never in the dashboard.

A configured card does not mean the connection is live: the card shows **live** only when the channel is switched on.

## Create an access token

![The Tokens tab](/screenshots/settings-tokens.png)

1. **Browser:** in **Settings**, select **Tokens**.
2. Under **Mint a new token**, type a **Name** that says who it's for.
3. Tick the **Scopes** it needs. Pick the fewest that work.
4. Optionally set **Expires after** a number of days.
5. Select **Create token**.
6. Copy the token straight away. It's shown only once.

Keep tokens out of screenshots, chats and support requests. See [Keep it safe](../jobs/keep-it-safe.md).

## Review schedules

![Disabled example schedules in Settings](/screenshots/settings-crons.png)

1. **Browser:** in **Settings**, select **Schedules**.
2. For each schedule, check it is switched on and that its time zone is the one you expect.

## Check it worked

1. **Browser:** after you save a change, reload **Settings**. Your change is still there.
2. **Browser:** open **Advanced**. The same value appears in the settings file.
3. For an agent or channel change, send the agent a test message and watch it on [Live](./live.md).

## If something is wrong

- **Saving shows an error:** the value isn't valid (for example, an agent id with spaces). Fix it as the message says and save again. Nothing is written until the value is valid.
- **The change doesn't take effect:** the daemon may be stopped. **Terminal:** run `agentx daemon status`. If it's running, restart it; some changes, such as an agent's model, only apply after a restart. See see [Restart without losing work](../jobs/restart-safely.md).
- **A channel card says off or not set up:** open it and finish its setup, and make sure its token is in `.env`.
- **Lost a token:** it can't be shown again. Create a new one, then select **Revoke** on the old one.
