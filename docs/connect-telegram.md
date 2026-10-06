# Connect Telegram

Telegram lets you message an agent from your phone or computer and get its reply in the same chat. You create a Telegram **bot** (an account that a program controls), tell AgentX its **token** (the bot's password), and say who is allowed to talk to it.

You need:

- An agent. See [Your first agent](./first-agent.md).
- The AgentX daemon (the background service) running.
- The Telegram app, signed in.

Treat the bot token like a password. Never put it in an issue, a screenshot or a shared config example.

## 1. Create the bot

1. **Telegram app:** open a chat with **@BotFather**, Telegram's official bot for creating bots.
2. Send `/newbot`.
3. Send a display name for the bot, for example `Support Helper`.
4. Send a username for the bot. It must end in `bot`, for example `example_support_bot`.
5. Copy the token that BotFather sends back. It looks like `123456:ABC…`.

![The BotFather chat in Telegram after sending /newbot, asking for a name for the bot](/screenshots/telegram/botfather-newbot.png)

## 2. Store the token

AgentX keeps secrets in the `.env` file next to `agentx.json`, not in the dashboard.

::: info Running AgentX with Docker?
Use the `.env` file next to `docker-compose.yml` instead. That is the file Docker Compose hands to AgentX when the containers start. After you save it, apply the change in a terminal, from that folder, with `docker compose up -d --force-recreate`.
:::

1. Open the `.env` file in a text editor.
2. Add a line with a name of your choice and the token, then save:
   ```sh
   TG_SUPPORT_BOT_TOKEN=123456:ABC…
   ```

If you connect Telegram from the setup page instead (**Connect Telegram now** on `/setup`), you paste the token into **Bot token** there and AgentX writes this line for you. Then continue with step 4.

## 3. Add the bot in the dashboard

1. **Browser:** open the **Settings** tab.
2. Select **Channels**.
3. Select the **Telegram** card.
4. Under **Add a Telegram account**, enter an **Account id**: a short label of your choice, such as `support`.
5. In **Bind to agent**, choose the agent that should answer.
6. Optionally enter the **Bot username**.
7. In **Bot token env-var**, enter the name you used in `.env`, such as `TG_SUPPORT_BOT_TOKEN`. Enter the name, not the token itself.
8. Select **Add account**.

AgentX saves the change and the running daemon picks it up.

![Settings, Channels tab, with the Telegram card](/screenshots/settings-channels.png)

## 4. Allow people to talk to the bot

A new bot ignores everyone until you list who may use it. This stops strangers who find your bot from using your agent and your model account.

The dashboard has no form for this list yet. You add it to the settings file, `agentx.json`, from the dashboard's text editor. The file is written in **JSON**, a text format where each setting is a name in quotes, a colon, and a value.

1. **Browser:** in **Settings**, open the **Advanced** tab.
2. Select **Edit**. The whole settings file opens as text.
3. Find the `"telegram"` block inside `"channels"`. It already has a `"policy"` block that setup wrote for you.
4. Add an `"allowFrom"` line with your own Telegram username, so the block looks like this. Keep the commas exactly as shown:
   ```json
   "policy": {
     "dm": "pair",
     "group": "mention-required",
     "allowFrom": ["@REPLACE-WITH-YOUR-USERNAME"]
   }
   ```
   Replace `@REPLACE-WITH-YOUR-USERNAME` with your own username. Until you do, the bot answers nobody: real Telegram usernames can't contain hyphens, so the placeholder never matches anyone.
5. Select **Save**. If AgentX says the JSON is not valid, look for a missing or extra comma or quote.

What each line means:

| Line | What it does | Allowed values |
|---|---|---|
| `"allowFrom"` | The list of who may talk to the bot. Messages from anyone else are dropped. If the list is missing, every message is dropped. | Any mix of a `@username`, a numeric Telegram user id (such as `"123456789"`), or a group's chat id (a negative number, such as `"-1001234567890"`). Put each one in quotes and separate them with commas. The single entry `"*"` lets everyone in: see [a public bot](#let-anyone-talk-to-the-bot-a-public-bot). |
| `"group"` | How the bot behaves in group chats. | `"mention-required"` (the default): it answers only messages that contain one of the agent's `@` names, such as `@helper` (the entries that start with `@` in the agent's `mentions` list). `"all"`: it also answers group messages without an `@` name. |
| `"dm"` | The rule for private, one-to-one chats. | `"pair"` (the default) or `"block"`. Setup writes `"pair"`; leave it as it is. Today this line changes nothing: who may write to the bot in private is decided by `"allowFrom"` alone. |

For example, to let yourself and one colleague talk to the bot, and also let it answer in one team group:

```json
"allowFrom": ["@your_username", "@colleague_username", "-1001234567890"]
```

To give one bot its own list, add `"allowFrom"` to that account instead, next to its `"token"`. An account's own list replaces the shared one. Every setting is listed in [Settings: channels › Telegram](./reference/config-channels.md#telegram).

### Let anyone talk to the bot (a public bot)

For a bot that answers customers or the public, use the single entry `"*"`. It means "everyone".

1. **Browser:** in **Settings**, open the **Advanced** tab.
2. Select **Edit**.
3. Find the account of the public bot under `"channels"` › `"telegram"` › `"accounts"`, and add `"allowFrom": ["*"]` next to its `"token"`:
   ```json
   "support": {
     "token": "${TG_SUPPORT_BOT_TOKEN}",
     "agentBinding": "support-agent",
     "allowFrom": ["*"]
   }
   ```
4. Select **Save**.

Put `"*"` on the public bot's account, not in `"policy"`, so your other bots stay private. Anyone who finds the bot can then use its agent, and every reply costs your model account. Give a public bot an agent made for that job: no access to your private files, tools or other channels. When the daemon starts, `agentx daemon logs` shows a line `Telegram: public — anyone can message support`, so you can see which bots are open.

`"*"` also lets the bot work in any group someone adds it to, not only in private chats. There, the `"group": "mention-required"` setting in `"policy"` is the only limit: the bot answers only when a message mentions it or uses one of the agent's trigger words. Keep that setting for a public bot, and don't change it to `"all"`. To keep the bot out of groups entirely, send `/setjoingroups` to @BotFather in Telegram and choose **Disable**.

## Check it worked

1. **Telegram app:** send your bot a short message, such as `hello`.
2. The bot replies in the same chat, within a minute.
3. **Browser:** the **Activity** tab lists the conversation.
4. For a public bot: ask someone who is not on any list to message it. The bot answers them too.

## If something is wrong

- **The bot doesn't reply at all:** check that the daemon runs. **Terminal:** `agentx daemon status` must say `Status: running`. The dashboard alone doesn't receive Telegram messages.
- **The log says `not in allowlist`:** **Terminal:** run `agentx daemon logs`. A line like `dropped message from 123456789 (@your_username) … not in allowlist` means you're not in `allowFrom`. Copy the number or `@username` from that line into `allowFrom`, as in step 4.
- **A public bot still ignores strangers:** the entry must be exactly `"*"`, on the bot's own account or in `"policy"`. A bot with its own `"allowFrom"` ignores the list in `"policy"`, so a `"*"` in `"policy"` doesn't open a bot that has its own list.
- **The daemon complains about the token, or the bot never connects:** the name in **Bot token env-var** must match the name in `.env` exactly. After fixing `.env`, restart the daemon. **Terminal:** run `agentx daemon restart` (with Docker: `docker compose up -d --force-recreate`).
- **The bot answers in a private chat but not in a group:** start the message with the agent's `@` name, such as `@helper`, and add the group's chat id to `allowFrom`.
- **Still nothing:** run `agentx doctor`, then follow [It's not answering](./help/its-not-answering.md).
