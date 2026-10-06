# Answer customers on WhatsApp

Let an agent reply to your customers on WhatsApp by itself. A customer writes to a WhatsApp number you own, and the agent answers in the same chat within a minute, with no approval step.

![How an agent answers customers on WhatsApp: you get a separate number, pair it and list who may write; then each customer message is checked against the list, answered by the agent, and the answer is sent at once](/diagrams/answer-whatsapp.svg)

AgentX joins WhatsApp the way WhatsApp on a computer does: as a **linked device** (an extra screen signed in to your phone's WhatsApp account). You link it once by scanning a **QR code** (a square barcode) with the phone.

## Which WhatsApp page do I need?

AgentX has two separate ways to use WhatsApp. Pick one per job:

| You want | Use | What the contact gets |
|---|---|---|
| An agent that **replies to customers by itself** | This page (`agentx connect whatsapp`) | The agent's answer, sent at once |
| **Summaries and draft replies** for chats you keep answering yourself | [Watch a WhatsApp chat](./watch-whatsapp.md) (wacli triage) | Nothing, until you approve a draft |

You need:

- An agent with instructions for customers. See [Your first agent](../first-agent.md) and [Answer questions from a channel](./answer-questions.md).
- A phone with WhatsApp, signed in to the number customers will write to.
- A terminal in the folder with `agentx.json`.

## 1. Before you pair

Read these first. They are the price of answering from a normal WhatsApp account.

- **Use a separate number.** Every chat on the paired number can reach the agent. Pair a spare phone or a second SIM, never your personal number.
- **The number can be banned.** AgentX is not an official WhatsApp app and does not use the paid WhatsApp Business service. WhatsApp may block a number that it thinks is automated, for example one that sends many messages to people who never wrote first. Use a number you can afford to lose.
- **An empty allow-list answers everyone.** The **allow-list** is the list of phone numbers the agent may answer (step 3). While it is empty, the agent answers every person who writes to the number, and every group the number is in. This is the opposite of Telegram, which ignores everyone until you list them. Fill the list before you start the daemon.
- **Replies go out without you.** Give the agent clear instructions and only the tools it needs. Each message also costs model usage; see [Costs](../help/costs.md).

## 2. Pair the number

1. **Terminal:** stop the daemon (the AgentX background service), so pairing can sign in by itself:
   ```sh
   agentx daemon stop
   ```
2. **Terminal:** start pairing, naming the agent that should answer. `helper` is an example; use your agent's ID:
   ```sh
   agentx connect whatsapp --agent helper
   ```
3. A QR code appears in the terminal.
4. **Phone (the separate number):** open WhatsApp, go to **Settings › Linked devices › Link a device**, and scan the QR code. You have 2 minutes; run step 2 again if it runs out.
5. **Terminal:** wait for `✓ Paired`, then `✓ WhatsApp bound to agent "helper"`.

The paired session is kept in the `.agentx/whatsapp-sessions` folder. Don't start the daemon yet.

You can also pair from the dashboard: with the WhatsApp channel turned on and the daemon running, **Settings › Channels › WhatsApp** shows the QR code to scan. Fill the allow-list (step 3) before you turn the channel on.

![Settings › Channels, with the WhatsApp card under Chat apps](/screenshots/settings-channels.png)

## 3. List who may write

1. Collect the phone numbers of the customers the agent may answer. Write each one with its country code, digits only, no spaces, for example `15550001111`. A leading `+` is fine.
2. **Terminal:** save the list:
   ```sh
   agentx config set channels.whatsapp.allowFrom '["15550001111", "15550002222"]'
   ```
3. To test from your own phone, add your own number too.

Or in the browser: **Settings › Advanced › Edit**, find `"whatsapp"` under `"channels"`, add `"allowFrom": ["15550001111"]`, and select **Save**.

![Settings › Advanced, showing agentx.json with Tree, Raw and Edit views and a Save button](/screenshots/settings/advanced-tree.png)

A number matches when it contains an entry, so always write the full number. A short entry such as `555` would let in every number with `555` in it.

## 4. Start the daemon

1. **Terminal:** start the daemon:
   ```sh
   agentx daemon start --detach
   ```
2. **Terminal:** run `agentx daemon logs`. Look for the line `WhatsApp connected`.

Each reply starts with the agent's name in bold, so customers can see that an agent answered.

## Send some customers to another agent

By default, the agent you named in step 2 answers everyone on the list. A **route** sends one contact or one group to a different agent. The first route that matches wins.

1. **Terminal:** add the route. `15550002222` and `billing` are examples:
   ```sh
   agentx config set channels.whatsapp.routes '[{"contact": "15550002222", "agent": "billing"}]'
   ```
2. For a group, use `"group"` with part of the group's name instead of `"contact"`.
3. The contact must still be on the allow-list.

See every setting in [Settings: channels › WhatsApp](../reference/config-channels.md#whatsapp).

## Stop answering

- **For a while:** run `agentx config set channels.whatsapp.enabled false`, then `agentx daemon restart`. Set it back to `true` and restart again to resume.
- **For good:** on the phone, open **Settings › Linked devices**, select the AgentX device and select **Log out**. Then delete the `.agentx/whatsapp-sessions` folder.

## Check it worked

1. **Phone:** from a number on the allow-list, send the separate number a question the agent's material answers.
2. Within a minute, the reply arrives in the same chat, starting with the agent's name.
3. **Browser:** open **Activity**. The conversation shows under the agent.
4. **Phone:** from a number that is not on the list, send a message. No reply comes.

## If something is wrong

- **`agentx connect whatsapp` warns that the daemon is running:** answer **No**, run `agentx daemon stop`, then run it again.
- **`Timed out waiting for scan (2min)`:** run `agentx connect whatsapp` again and scan sooner.
- **No reply to a listed customer:** check the number in `allowFrom` has the country code and no spaces. Then follow [It's not answering](../help/its-not-answering.md).
- **The agent answers people who are not on the list:** `allowFrom` is empty or missing. Fill it (step 3).
- **The agent answers in a group:** someone on the list wrote there, or the list is empty. Remove the number from the group, or check the list.
- **The log says `Logged out. Delete session dir and restart to re-scan QR.`:** the phone unlinked AgentX, or WhatsApp signed it out. Run `agentx daemon stop`, delete `.agentx/whatsapp-sessions`, and pair again (step 2). If it keeps happening, WhatsApp may be limiting the number.
- **The log says `Another session is active for this number`:** another copy of AgentX uses the same session. Stop it, then restart the daemon.
- **You wanted drafts to approve, not automatic replies:** use [Watch a WhatsApp chat](./watch-whatsapp.md) instead, and turn this channel off.
