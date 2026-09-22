# Connect Telegram

Telegram is one way to send an agent a message and get its reply in the same conversation. You need a Telegram bot token, an AgentX agent, and a running daemon.

::: info In Telegram
Create a bot with BotFather and copy the token. Treat it like a password. Send your new bot a test message after setup.
:::

::: info In the browser
Open **Settings → Channels** and add Telegram. Paste the bot token into the channel setup, choose the agent that should answer, and save. Use the wizard's test or status information to check the connection.
:::

::: info Terminal
If the bot stays silent, run `agentx daemon status` and then `agentx doctor`. The dashboard alone does not receive Telegram messages.
:::

Do not put a real bot token in an issue, screenshot, or config example. See [It's not answering](./help/its-not-answering.md) for a step-by-step check.
