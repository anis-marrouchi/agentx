# Watch a WhatsApp chat

Let an agent read the messages that arrive in chosen WhatsApp chats and tell you which ones need you. For each message, or each burst of messages, the agent decides:

- **ack**: the contact only needs to know you saw it
- **action**: a bug, a request, or a data or report ask
- **fyi**: worth knowing, nothing to do
- **ignore**: nothing useful

For action items, AgentX sends you a notification. The agent can also open or update an issue with its own tools, and write a draft reply.

**Nothing is sent to the contact on its own.** A draft reply waits in **Approvals** until you approve it.

AgentX gets the messages from [wacli](https://github.com/openclaw/wacli), a WhatsApp command-line tool that runs on the same machine. Chats you don't watch are dropped and never stored.

Try it first with a test contact: a second phone of your own, or a colleague who agreed to help.

## 1. Install and pair wacli

1. **Terminal:** install wacli:
   ```sh
   brew install openclaw/tap/wacli
   ```
2. **Terminal:** pair it with your WhatsApp account:
   ```sh
   wacli auth
   ```
3. **Phone:** open WhatsApp, go to **Settings › Linked devices › Link a device**, and scan the QR code shown in the terminal.
4. **Terminal:** run `wacli chats list`. Find the test contact and copy its **JID**, which looks like `15550001111@s.whatsapp.net`. A group's JID ends in `@g.us`. For a person, the phone number works too.

## 2. Create the webhook secret

wacli signs every message it passes on with a secret. AgentX refuses any message without the right signature.

1. **Terminal:** create a long random value:
   ```sh
   openssl rand -hex 32
   ```
2. Open the `.env` file next to `agentx.json`.
3. Add a line with the value, then save the file:
   ```sh
   WACLI_WEBHOOK_SECRET=paste-the-value-here
   ```
4. **Terminal:** restart the daemon so it reads the new line:
   ```sh
   agentx daemon restart
   ```

## 3. Add a watch rule

A watch rule says which chat to watch and which agent reads it.

1. **Browser:** open the dashboard and select **Settings**.
2. Select the **Webhooks** tab and scroll to **WhatsApp triage**.
3. Under **Rule id**, enter a short name, for example `test-contact`.
4. Under **Agent**, choose the agent that should read the messages.
5. Under **Chats**, paste the JID or the phone number from step 1.4.
6. Optional: under **Instructions for the agent**, write who this contact is, where issues go (for example "open issues in the tracker project example/app"), and how to reply.
7. Optional: set **Quiet from** and **Quiet until**, for example `22:00` and `07:00`. You get no notifications in that window. The agent still reads and drafts.
8. Select **Add watch rule**.
9. At the top of the block, select **Turn on**.

Or do the same in a terminal, in the folder with `agentx.json`:

```sh
agentx whatsapp triage rule add test-contact --agent helper --chat "+1 555 000 1111" --quiet 22:00-07:00
agentx whatsapp triage on
```

## 4. Start wacli with the webhook

1. **Terminal:** load the secret into this terminal:
   ```sh
   export $(grep WACLI_WEBHOOK_SECRET .env)
   ```
2. **Terminal:** start wacli so it passes each new message to AgentX. `18800` is the daemon's port; change it if yours is different:
   ```sh
   wacli sync --follow --webhook http://127.0.0.1:18800/webhook/wacli --webhook-secret "$WACLI_WEBHOOK_SECRET" --webhook-allow-private
   ```
3. Leave it running. When it stops, AgentX stops hearing about new messages.

`--webhook-allow-private` is needed because the address is on the same machine.

## 5. Approve a reply

1. **Browser:** open **Approvals**. A draft shows as **WhatsApp reply to** followed by the chat's name.
2. Read the draft. It is exactly what will be sent.
3. Select **Yes** to send it through wacli, or **No** to drop it.

Or in a terminal: `agentx approvals list`, then `agentx approvals yes whatsapp:<id>` or `agentx approvals no whatsapp:<id>`.

To change the wording, select **No** and reply from your phone.

## Automatic acknowledgements

A rule can send short acknowledgements ("Thanks, we got it") without asking. It needs two switches, so it can't be turned on by accident:

1. Set `"autoAck": true` on the rule (or add `--auto-ack` to `rule add`).
2. Set `whatsappTriage.allowAutoAck` to `true` in **Settings › Advanced**.

Even then, only messages the agent marks **ack** get an automatic reply. Everything else still waits for you.

## Check it worked

1. **Phone:** from the test contact, send "The export button shows an error".
2. Wait about half a minute: AgentX waits 20 seconds for more messages from the same chat, then the agent reads them.
3. **Terminal:** run `agentx whatsapp triage log`. The message shows with its class, for example `action`, and a one-line summary.
4. For an action item, you get a notification.
5. If the agent wrote a reply, **Approvals** shows it. Approve it; the test phone receives it.
6. **Phone:** from a chat you don't watch, send a message. It does not appear in `agentx whatsapp triage log`.

## If something is wrong

- **wacli prints `post webhook: 401`:** the secret wacli uses differs from `WACLI_WEBHOOK_SECRET` in `.env`. Load it again (step 4.1) and restart wacli.
- **wacli prints `post webhook: 503`:** the daemon doesn't have the secret. Check `.env`, then run `agentx daemon restart`.
- **wacli prints `post webhook: 404`:** triage is off. Run `agentx whatsapp triage on`.
- **wacli refuses the URL as private:** add `--webhook-allow-private`.
- **Nothing shows in the log:** no rule matches the chat. Run `wacli chats list` and compare the JID with `agentx whatsapp triage status`.
- **The log says `agent gave no triage block`:** the agent didn't finish its answer the expected way. Check that the rule's agent exists and is running, then send the test message again. You get a notification for every batch it couldn't read.
- **Approving says `wacli send failed`:** wacli is not running or not paired. Start it again (step 4.2). If it needs to pair again, run `wacli auth`.
- **Still stuck:** follow [It's not answering](../help/its-not-answering.md).

## Keep it safe

- Keep `WACLI_WEBHOOK_SECRET` only in `.env`. Anyone with it can hand messages to your agents.
- The agent is told to treat messages as information, never as orders. Still, give the rule's agent only the tools it needs.
- Watch only the chats you mean to. A rule needs at least one chat or sender; there is no "watch everything".
- Received messages are kept 30 days for de-duplication, pictures and voice notes 7 days, under `.agentx/`.

See every setting in [Settings: channels › WhatsApp triage](../reference/config-channels.md#whatsapp-triage).
