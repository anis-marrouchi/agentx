# Triage WhatsApp messages

Pick the WhatsApp chats you want watched: a customer, a supplier, a team group. When a message arrives in one of them, an agent reads it and sorts it:

- **ack**: it only needs an acknowledgement.
- **action**: a bug, a request, or a question about data or a report. You get a notification.
- **fyi**: worth knowing, no reply needed.
- **ignore**: nothing for you.

If a reply would help, the agent writes a draft. The draft waits in **Approvals** until you say yes. **Nothing is ever sent to a contact without your yes.** Messages from chats you didn't pick are dropped and not stored.

AgentX gets the messages from **wacli**, a free program that connects to WhatsApp as a linked device, like WhatsApp Web. wacli sends each new message to AgentX through a **webhook**: a message one program sends to an address the other listens on.

You need:

- A Mac or Linux computer where the AgentX daemon runs.
- Your phone with WhatsApp, to link wacli.
- An agent that will do the sorting.

## 1. Install and link wacli

1. **Terminal:** install wacli:
   ```sh
   brew install openclaw/tap/wacli
   ```
2. **Terminal:** link it to your WhatsApp account:
   ```sh
   wacli auth
   ```
3. **Phone:** open WhatsApp, then **Settings › Linked devices › Link a device**, and scan the code the terminal shows.
4. **Terminal:** wait until wacli says it has caught up, then press `Ctrl+C`.

## 2. Choose a secret

The secret proves a message really comes from your wacli. AgentX refuses anything without it.

1. **Terminal:** make a long random value:
   ```sh
   openssl rand -hex 32
   ```
2. Open the `.env` file next to `agentx.json`.
3. Add a line with the value, then save the file:
   ```sh
   WACLI_WEBHOOK_SECRET=paste-the-value-here
   ```
4. **Terminal:** restart the daemon so it reads the new line: `agentx daemon restart`.

## 3. Pick the chats to watch

Each watched chat is a **rule**: which chat, and which agent sorts it.

1. **Browser:** open the dashboard and select **Approvals**.
2. Open **WhatsApp triage: watched chats** at the bottom of the page.
3. Tick **Triage is on** and select **Save**.
4. Under **Add a rule**, fill in:
   - **Rule name**: a short name such as `customer-support`.
   - **Agent**: the agent that sorts these messages.
   - **Chat**: the contact's phone number, such as `+1 555 010 0000`. For a group, fill in **Group** with its exact name instead.
   - **Instructions for the agent** (optional): what counts as a request, where to open a tracker issue, which language to reply in.
   - **Quiet hours** (optional): a time window with no notifications.
5. Select **Add rule**.

You can do the same in a terminal:

1. **Terminal:** turn triage on: `agentx wacli settings --enable`
2. **Terminal:** add a rule: `agentx wacli rules add customer-support --chat "+1 555 010 0000" --agent support`

## 4. Start wacli with the webhook

1. **Terminal:** in the folder that holds `agentx.json`, run `agentx wacli status` and copy the **Webhook URL** it prints.
2. **Terminal:** start wacli, with the URL and the secret from step 2:
   ```sh
   wacli sync --follow --download-media --webhook-allow-private \
     --webhook http://127.0.0.1:18800/webhook/wacli \
     --webhook-secret "$WACLI_WEBHOOK_SECRET"
   ```
   Use your own URL if it differs. `--webhook-allow-private` lets wacli post to this computer. `--download-media` lets the agent see images and hear voice notes.
3. Leave it running. To keep it running after you log out, run it as a service, the same way you run the daemon.

## Settings

Everything is in the `wacli` section of `agentx.json`; see the [settings reference](/reference/config-automation#wacli).

- **Batch window** (`batchSeconds`, default 30): messages from one chat that arrive this close together become one task, so a burst of five short messages is read once.
- **Read images and voice notes** (`media`, default on): images are opened by the agent; voice notes are turned into text when this computer has speech to text (see [voice](/dashboard/voice)).
- **Send acknowledgements without asking** (`autoAck`, per rule, default off): for an `ack` message, the agent's short reply goes out without waiting for you. Leave it off unless you trust the agent with that chat. It never applies during quiet hours.
- **Quiet hours**: no notifications and no automatic acknowledgements in this window. Messages are still sorted and drafts still wait in Approvals.

## Check it worked

1. **Terminal:** send a test message as if it came from a watched chat (use the number from your rule):
   ```sh
   agentx wacli test --chat "+1 555 010 0000" --text "The monthly report is empty"
   ```
   It prints `✓ stored`.
2. Wait for the batch window (30 seconds by default) and the agent's answer.
3. **Browser:** open **Approvals**. A card **WhatsApp reply to Test contact** shows the draft reply.
4. Select **No**. Nothing is sent.
5. Ask the watched contact to send you a real message. When its card appears in Approvals, select **Yes**: within a minute, the reply appears in the WhatsApp chat.
6. **Terminal:** send a request without the secret:
   ```sh
   curl -i -X POST http://127.0.0.1:18800/webhook/wacli -d '{}'
   ```
   It answers `401`.

## If something is wrong

- **`agentx wacli test` says `no secret`:** the terminal doesn't have `WACLI_WEBHOOK_SECRET`. Run `export WACLI_WEBHOOK_SECRET=…` with the value from `.env`, then try again.
- **It says `401: invalid signature`:** the secret in the terminal differs from the one the daemon read. Check `.env` and restart the daemon.
- **It says `404: WhatsApp triage is off`:** tick **Triage is on**, or run `agentx wacli settings --enable`.
- **It says `no rule watches …`:** the number doesn't match any rule. Check it with `agentx wacli status`.
- **Stored, but no card appears:** the agent classified the message without drafting a reply, which is fine for `fyi` and `ignore`. Run `agentx daemon logs` and look for a `[wacli]` line with the class. A line saying `gave no verdict` means the agent didn't finish its answer; try again or check the agent works in chat.
- **You said yes but nothing arrived:** run `agentx daemon logs` and look for `[approvals] … wacli.send failed`. Check that `wacli sync --follow` is still running. A failed send is never retried; send it yourself.
- **Real messages never arrive:** wacli isn't posting. Check the `wacli sync` terminal for `sync webhook failed`, and that the URL and `--webhook-allow-private` are right.
- **Still stuck:** follow [It's not answering](../help/its-not-answering.md).
