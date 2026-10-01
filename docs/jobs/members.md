# Invite a teammate to their work page

A teammate who asks your agents for things on GitLab, Telegram or WhatsApp has no dashboard. They cannot see whether the agent is working, waiting or stuck. This page gives them one small window of their own: **My work**, a list of what they asked for and where it stands. Nothing else of yours is reachable from it.

It works like the [phone app](../dashboard/mobile-app.md): one page served on your private network, a one-time code to pair, a key per machine. Two things are stricter, because a teammate is not you:

- the code is made for one person from your [people list](./people.md), and the key it gives opens that person's own work only;
- a new machine does nothing until you say yes to it on a decision card.

## What you need

- The teammate listed in [people](./people.md), with the identity they use on the channel they write on.
- [Request tracking](./open-requests.md) turned on, so there is something to show.
- Tailscale on your computer and on theirs. Their machine joins your network through a **share** of this one computer; no public address is used.
- The dashboard running from the folder that holds `agentx.json`.

## Serve only the member page

The dashboard trusts anything that reaches it from your own computer, so only the member page may be published on the network.

1. **Terminal:** publish the two member paths and nothing else:

   ```sh
   tailscale serve --bg --set-path /member http://127.0.0.1:4202/member
   tailscale serve --bg --set-path /api/member http://127.0.0.1:4202/api/member
   ```

   If you also use the phone app, keep its two `/app` lines. Never run `tailscale serve --bg 4202`: that shares the whole dashboard.
2. **Browser (Tailscale admin console):** in **Access controls**, limit what shared users can reach on this computer to port 443. For example:

   ```json
   { "action": "accept", "src": ["autogroup:shared"], "dst": ["autogroup:self:443"] }
   ```

   Without this, a shared user can reach every port of the computer, including the daemon on 18800 and the dashboard on 4202.

## Invite

1. **Terminal (computer):** from the folder that holds `agentx.json`:

   ```sh
   agentx people invite sara
   ```

   It refuses to go on if `tailscale serve` publishes the whole dashboard.
2. It prints three things: the share step, the address of the page, and a **pairing code** such as `7KQ4-M2XH`. The code works once, for 10 minutes.
3. **Browser (Tailscale admin console):** open **Machines**, this computer, **Share**, and send the link to the teammate. Do this once per person; the invite reminds you.
4. Send the teammate the address and the code on a channel you know is theirs.

If the teammate's Tailscale login is on their person entry as `tailscale:<login>` (for example `agentx people link sara tailscale:sara@example.com`), pairing is refused unless the network reports that very login. Without the entry, the login the network reports is recorded and shown to you on the card instead.

## The teammate pairs their machine

1. **Their machine:** install Tailscale and accept the share.
2. **Their browser:** open the address, for example `https://your-mac.tailnet-name.ts.net/member`.
3. The page asks for a name for the machine and the code. They type both and press **Pair**.
4. The page says **Waiting for the owner**.

## Approve the machine

1. A decision card **New machine for Sara B** arrives in your [Approvals inbox](../dashboard/approvals.md): the machine's name, where it came from, and the login the network reported.
2. Answer **Yes** if the teammate told you they just paired. **No** ends that key at once; a card nobody answers is treated as no after three days.
3. **Their browser:** the waiting page turns into **My work** by itself.

## My work

The page lists, for that person only:

- **Open**: each request with the agent, its state (in progress, waiting on the owner, waiting on another agent, stuck), how long it has been open, and where it was asked. A GitLab or GitHub thread is a link.
- **Finished in the last 7 days**, with the link to what was delivered.
- **Latest turns** they started.

It refreshes every 30 seconds. Opened without a connection, it shows what was last loaded and says it is offline.

### Keep it on the desktop

1. **Their browser (Edge or Chrome, Windows or Mac):** open the browser menu, then **Apps**, then **Install this site as an app**.
2. It opens in its own window, like a small program, and stays in the Start menu or Dock.

## Manage machines

| Command | What it does |
|---|---|
| `agentx people devices` | Every paired machine: person, name, state, where it paired from, first and last use. `agentx people devices sara` for one person. |
| `agentx people revoke-device <id>` | Ends one machine at once. The id is in the list. |
| `agentx people remove sara` | Removes the person and ends every machine of theirs. Remove the share in Tailscale too. |

A machine's key lasts 90 days. After that, invite again.

Every invite, pairing, approval, refusal, sign-in and removal is written to `.agentx/members-log.jsonl`, one line per event, with the person and the machine.

## Check it worked

1. **Terminal:** run `agentx people devices`. The teammate's machine is listed as `active`.
2. **Their browser:** **My work** shows a request they made on their channel, with the right state.
3. **Their browser:** opening `https://<your computer>/` or `/app` shows nothing of yours: only `/member` answers.

## If something is wrong

- **`tailscale serve publishes the whole dashboard`:** run `tailscale serve reset`, then the two `--set-path` lines above.
- **`Could not read this machine's Tailscale name`:** Tailscale is not running on your computer. Start it, or pass `--url https://<address>` to `agentx people invite`.
- **"That code didn't work":** the code was mistyped, is older than 10 minutes, or was already used. Run `agentx people invite` again.
- **"The private network says someone else is connecting":** the login Tailscale reports for their machine is not among the person's `tailscale:` identities. Check with `agentx people show <id>` and fix the identity, or remove it to accept whatever login is reported.
- **"Waiting for the owner" does not end:** the card is still in your Approvals inbox. Answer it.
- **The page is empty:** request tracking is off (`agentx requests settings`), or the teammate's identity on that channel is not on their person entry, so their requests were not stamped with their id.
- **The teammate can open other pages of yours:** your access rules let shared users reach more than port 443. Add the rule above.
