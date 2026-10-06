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

AgentX keeps secrets in the `.env` file next to `agentx.json`, not in the dashboard. (In Docker, that's `agentx-data/.env`.)

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

1. **Browser:** in **Settings**, open the **Advanced** tab.
2. Select **Edit**.
3. Find `"telegram"` under `"channels"`, and add your Telegram username to `"allowFrom"` inside `"policy"`:
   ```json
   "policy": {
     "dm": "pair",
     "group": "mention-required",
     "allowFrom": ["@your_username"]
   }
   ```
   An entry can be a `@username`, a numeric Telegram user id, or a chat id (for a group).
4. Select **Save**.

To give one bot its own list, add `"allowFrom"` to that account instead, next to its `"token"`.

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
- **The daemon complains about the token, or the bot never connects:** the name in **Bot token env-var** must match the name in `.env` exactly. After fixing `.env`, restart the daemon (`agentx daemon stop`, then `agentx daemon start --detach`).
- **The bot answers in a private chat but not in a group:** mention the bot or use a trigger word, and add the group's chat id to `allowFrom`.
- **Still nothing:** run `agentx doctor`, then follow [It's not answering](./help/its-not-answering.md).
