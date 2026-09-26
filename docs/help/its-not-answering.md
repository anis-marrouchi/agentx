# It's not answering

You sent an agent a message and nothing came back. This page walks through the checks in order, from the most common cause to the least.

AgentX runs as two separate programs:

- The **daemon** is the background service that receives messages, runs agents and sends replies.
- The **dashboard** is the website you open in the browser.

The dashboard can load while the daemon is stopped. A working browser page does not prove that messages are being handled.

## Find where the message stopped

1. **Terminal:** check that the daemon is running:
   ```sh
   agentx daemon status
   ```
2. **Terminal:** if it says the daemon is not running, start it:
   ```sh
   agentx daemon start --detach
   ```
3. **Browser:** open `/admin/health` on your dashboard (for example `http://127.0.0.1:4202/admin/health`). The older address `/admin/observability` takes you to the same page.
4. Select the **Routing** tab. Each row is one message and the agent AgentX chose for it (a "route trace").
5. Look for your message. If it isn't there, the message never reached AgentX: check the channel's connection (see [If something is wrong](#if-something-is-wrong)).
6. If the row names the wrong agent, open **Settings** › **Channels** and change which agent the channel is bound to.
7. Select the **Errors** tab. A failed model login, a missing API key or a missing workspace folder shows up here.
8. **Browser:** open the **Activity** tab of the dashboard to see whether the agent started a run for your message.
9. **Terminal:** run the health check:
   ```sh
   agentx doctor
   ```
   It checks your settings, credentials and whether the daemon answers. See [Run a health check](./doctor.md).
10. If you ask your installer for help, share the doctor output after removing any keys or tokens.

<!-- Screenshot needed: the Health page (/admin/health) with the Routing tab open. Not defined in docs/.scripts/capture.mjs yet. -->

## Just added an agent?

A new agent only loads when the daemon restarts.

**With Docker:**

1. **Terminal:** from the folder you installed AgentX in, run:
   ```sh
   docker compose restart daemon dashboard
   ```

**Without Docker:**

1. **Terminal:** stop the daemon:
   ```sh
   agentx daemon stop
   ```
2. **Terminal:** start it again:
   ```sh
   agentx daemon start --detach
   ```

In a source checkout, type `node dist/cli.js` instead of `agentx`.

## Check it worked

1. Send the agent a new, short message, such as "What is 2 + 2?".
2. **Browser:** in **Activity**, a new run appears for that agent.
3. The reply arrives in the same chat you wrote from.

## If something is wrong

- **The daemon won't stay running:** run `agentx daemon logs` in a terminal and read the last lines. A configuration error names the setting at fault.
- **A Telegram bot stays silent:** send it a fresh message; earlier messages are not replayed. Then run `agentx daemon logs`. A line ending in `not in allowlist` means the bot is set up but your Telegram account isn't allowed to talk to it yet. See [Connect Telegram](../connect-telegram.md).
- **A GitLab message gets no reply:** in GitLab, open the project's webhook settings and check the recent deliveries. A failed delivery means GitLab can't reach the daemon's address.
- **The agent answers, but Monitor shows failed reviews:** that is the separate reviewer described on the [Monitor page](../dashboard/monitor.md), not the agent itself.
- **`agentx doctor` reports errors:** fix them in the order shown, then run it again.
