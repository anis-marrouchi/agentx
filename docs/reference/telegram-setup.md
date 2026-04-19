---
title: "Telegram bots without the jargon"
---

# Telegram bots without the jargon

If you've never created a Telegram bot, this is the whole story. **30 seconds, no CLI, no code.** All of it happens inside Telegram itself.

## What you end up with

A **bot account** your customers can DM. It looks and behaves like a regular Telegram contact, except messages sent to it get answered by your AgentX agent instead of a human.

You also get a **bot token** — a 50-character string like `7841234567:AAFXabc...` — which AgentX uses to pull messages and reply. Think of it as the password Telegram gives you to control the bot.

## The walkthrough

### 1. Open Telegram and find @BotFather

Search for `BotFather` in Telegram. The real one has a **blue verified checkmark** next to its name. Any `@BotFather` without a checkmark is a fake — don't DM those.

Tap the chat, send `/start`. BotFather replies with a menu.

### 2. Create a new bot

Send the command `/newbot`.

BotFather asks two questions:

| Prompt | What to send |
|---|---|
| *"Alright, a new bot. How are we going to call it?"* | Your bot's **display name** — what people see at the top of the chat. e.g. `Sundial Café Support`. Can contain spaces and emoji. |
| *"Good. Now let's choose a username..."* | The **@handle** — must end in `bot` and be unique across all of Telegram. e.g. `@sundialcafe_bot`. No spaces; letters, numbers, and underscores only. |

When you pick a username that's free, BotFather replies with a congratulations message containing your **bot token**:

```
Done! Congratulations on your new bot. You will find it at t.me/sundialcafe_bot.

Use this token to access the HTTP API:
7841234567:AAFXabc-IgnoreTheRestOfThisItsYourSecret_xxx

Keep your token secure and store it safely …
```

Copy the whole token line (the `7841234567:AAF…` part). **This is the only time it's shown.** If you lose it, come back to BotFather → `/mybots` → your bot → **API Token** → **Revoke and regenerate**.

### 3. Paste it into AgentX

Back in your AgentX dashboard: **Settings → Channels → Telegram → Add a Telegram account**. The `channel add` CLI wizard asks for the same thing.

The token goes into `.env` — never into `agentx.json` — so you can commit the config to git without leaking secrets.

## Good-to-know defaults

These are optional but catch most of the "why doesn't my bot do X?" questions early.

### Let your bot read group messages

By default Telegram only lets bots see messages where they're **explicitly @mentioned**. For a group where the bot should read everything (so it can answer questions that don't start with `@`), turn off privacy mode:

1. DM **@BotFather** → `/mybots` → pick your bot
2. **Bot Settings** → **Group Privacy** → **Turn off**

AgentX still obeys your config — if you set `channels.telegram.policy.group` to `mention-required`, the bot only responds when tagged, even with privacy off. Privacy off just means the bot *can see* all messages. Whether it *replies* is up to AgentX.

### Commands menu (the `/` button)

Optional but nice. In BotFather: `/mybots` → your bot → **Edit Bot** → **Edit Commands**. Paste something like:

```
start - Start the bot
hours - Opening hours
menu - See the menu
book - Reserve a table
```

Now your bot has a little blue `/` button next to the message field — tapping it shows this list.

### Profile photo and description

`/mybots` → your bot → **Edit Bot**:

- **Edit Botpic** — upload your logo
- **Edit Description** — the short text that appears ABOVE the first message, before the user has interacted
- **Edit About** — the longer text on the bot's profile page

All three are optional but they make the bot feel less "spammy / auto" and more "our real support channel."

## Common mistakes

| Mistake | What happens | Fix |
|---|---|---|
| Username doesn't end in `bot` | BotFather rejects it | Pick a new one ending in `bot` (e.g. `sundial_bot` not `sundial`) |
| Token committed to git | Anyone who sees your repo controls your bot | Revoke via BotFather → `/mybots` → bot → **API Token → Revoke**, paste the new one into `.env` |
| Bot doesn't reply in a group | Privacy mode is on and users aren't @mentioning | Either turn privacy off (see above), or tell users to `@mention` the bot |
| `Conflict: terminated by other getUpdates request` | Two processes polling the same bot token | Stop the other one. If you don't know which, revoke+reissue the token — only your daemon will have the new one. |

## Multiple bots, one install

AgentX can run many Telegram bots at once — one per agent, or one shared bot with `mention-required` routing. Create more bots in BotFather the same way; add each as a separate account in **Settings → Channels → Telegram**. Each gets its own env-var so tokens stay isolated.

## What's next

- **Back to the install walkthrough** → [Journey 1 — Your first agent on Telegram](/journey/01-telegram-qa-bot)
- **Run the same agent across Telegram AND WhatsApp** → [Journey 4 — Cross-channel](/journey/04-cross-channel)
- **All channel options** → [Reference — Communication matrix](/reference/communication-matrix)
