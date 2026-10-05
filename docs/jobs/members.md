# Invite a teammate to their work page

**This page is for you, the owner.** It gives a teammate who asks your agents for things on GitLab, Telegram or WhatsApp a page of their own, **My work**: the agents they use, what they asked for, and where it stands. Of your own work they see only that an agent is busy with it, never what it is. The teammate's side is a page of its own, [Join your work page](./join-work-page.md), which you can send them as it is. For your own phone, use the [phone app](../dashboard/mobile-app.md); for another organisation that runs AgentX, [Let another organisation into part of your mesh](./guest-mesh.md). Never pair a teammate or client with the phone app or a mesh invite: both open everything of yours. The five ways side by side: [Who gets which way in](./keep-it-safe.md#who-gets-which-way-in).

It works like the phone app: one page served on your private network, a one-time code to pair, a key per machine. Two things are stricter, because a teammate is not you:

- the code is made for one person from your [people list](./people.md), and the key it gives opens that person's own work only;
- a new machine does nothing until you say yes to it on a decision card.

The whole path, from your first step to the teammate's desktop:

![How a teammate joins: you prepare in six steps, the teammate pairs in four, you say yes on a decision card, and the page becomes My work](/diagrams/teammate-join.svg)

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

   The dashboard answers only addresses written in their plain form. An address with `.` or `..` parts, or with a backslash, gets "not found" on every page. So a published path cannot be used to reach another page, even behind a proxy other than `tailscale serve` that passes such addresses on unchanged.
2. **Browser (Tailscale admin console):** in **Access controls**, make sure a shared user reaches this computer on port 443 and nothing else. Access rules only allow; none of them takes access away. So adding a rule is not enough while the default rule (`"src": ["*"], "dst": ["*:*"]`) is still there: `*` includes the people you share with, and they reach every port.

   - Narrow the allow-all rule so it covers your own users only, for example `"src": ["autogroup:member"]`. If you have tagged devices that relied on `*`, give them their own rule first.
   - Add one rule for shared users, with this computer's Tailscale address (from `tailscale ip -4`) and port 443:

   ```json
   { "action": "accept", "src": ["autogroup:member"], "dst": ["*:*"] },
   { "action": "accept", "src": ["autogroup:shared"], "dst": ["100.101.102.103:443"] }
   ```

   Until this is in place, a shared user can reach everything on this computer that listens on its Tailscale address: remote login, file sharing, a development server, and the daemon or the dashboard if you set `node.bind` or `dashboard.bind` to `0.0.0.0`. Check it from the teammate's machine before you rely on it: see [Check it worked](#check-it-worked).

## Invite

1. **Terminal (computer):** from the folder that holds `agentx.json`:

   ```sh
   agentx people invite sara
   ```

   It refuses to go on if `tailscale serve` publishes the whole dashboard.
2. It prints three things: the share step, the address of the page, and a **pairing code** such as `7KQ4-M2XH`. The code works once, for 10 minutes.
3. **Browser (Tailscale admin console):** open **Machines**, this computer, **Share**, and send the link to the teammate. Do this once per person; the invite reminds you.
4. Send the teammate the address and the code on a channel you know is theirs, with a link to [Join your work page](./join-work-page.md). That page has only their steps, written for someone who has never used AgentX.

If the teammate's Tailscale login is on their person entry as `tailscale:<login>` (for example `agentx people link sara tailscale:sara@example.com`), pairing is refused unless the network reports that very login. Without the entry, the login the network reports is recorded and shown to you on the card instead.

## The teammate pairs their machine

The teammate follows [Join your work page](./join-work-page.md). In short: they install Tailscale, accept the share and wait until Tailscale says **Connected**, open the address, type a name for the machine and the code, and the page says **Waiting for the owner**. Opening the address before Tailscale is connected gives them a "site can't be reached" error, which is the most common stumble.

![The "Waiting for the owner" page](/screenshots/members/waiting.png)

## Approve the machine

1. A decision card **New machine for Sara B** arrives in your [Approvals inbox](../dashboard/approvals.md): the Tailscale address it came from, the login the network reported, and the name the machine gave itself. The name is typed by whoever holds the code, so judge by the address and the login.
2. Answer **Yes** if the teammate told you they just paired. **No** ends that key at once; a card nobody answers is treated as no after three days.
3. **Their browser:** the waiting page turns into **My work** by itself.

## My work

The page shows, for that person only (the same description, written for them, is on [Join your work page](./join-work-page.md#my-work)):

- **One sentence** at the top: which of their agents is working on their task, and which is free.
- **Needs a person**, right under that sentence: present only when one of their requests waits on your answer or is stuck, with the question you were asked.
- **Your agents**: one card per agent they use (the agents you allowed them, or else the ones they talked to in the last 7 days). Each says **Working**, **Free** or **Blocked** in words, with a colour and a shape. A card on their own task shows what they asked, when, and where; **Show this request** opens it in place. A card busy with someone else's task says only that, and whether you or someone else started it. **Tell me when an agent is free**, under the cards, lets the browser show a notification each time one of these agents goes from Working to Free while the page is open.
- **What you sent** in the last 7 days: every turn they started, with its agent, where it was asked and its state (running, finished, waiting on the owner, stopped). A finished request links to what was delivered. A GitLab or GitHub thread is a link. Below the turns come their requests that no turn of the list stands for: one still open whose turn is older than 7 days, or one closed this week.

![The My work page: the summary sentence, a question waiting on the owner, four agent cards, and the list of what was sent](/screenshots/members/my-work.png)

It refreshes every 30 seconds. Opened without a connection, it shows what was last loaded and says it is offline. When the connection is up but your computer does not answer, the page says it can't reach the server, tries again every 20 seconds, and shows a **Try now** button. Either notice goes away as soon as a load works.

### Keep it on the desktop

1. **Their browser (Edge or Chrome, Windows or Mac):** open the browser menu, then **Apps**, then **Install this site as an app**.
2. It opens in its own window, like a small program, and stays in the Start menu or Dock.

## Manage machines

In the dashboard, open the [People](../dashboard/people.md) tab and click the teammate: every machine of theirs is listed with its state, the address it paired from, and its first and last use. **End access** on a line ends that machine at once.

![The People tab with a teammate open: their machines, each with an End access button](/screenshots/people/person.png)

The same from a terminal:

| Command | What it does |
|---|---|
| `agentx people devices` | Every paired machine: person, name, state, where it paired from, first and last use. `agentx people devices sara` for one person. |
| `agentx people revoke-device <id>` | Ends one machine at once. The id is in the list. |
| `agentx people remove sara` | Removes the person and ends every machine of theirs. Remove the share in Tailscale too. |

A machine's key lasts 90 days. After that, invite again.

Every invite, pairing, approval, refusal, sign-in and removal, every message a person sent to an agent they may not reach, and every tool or skill their work was stopped from using, is written to `.agentx/members-log.jsonl`, one line per event, with the person and the machine. Lines older than 90 days are dropped; `members.logRetentionDays` in `agentx.json` changes that. Only you, the owner, can read it: it sits next to `agentx.json` and is never served.

## Check it worked

1. **Terminal:** run `agentx people devices`. The teammate's machine is listed as `active`. The **People** tab of the dashboard shows it as **Active** too.
2. **Their browser:** **My work** shows a request they made on their channel, with the right state.
3. **Their browser:** opening `https://<your computer>/`, `/people` or `/app` shows nothing of yours: only `/member` answers. On **My work**, a card busy with your task shows no text of it.
4. **The access rule holds:** a port other than 443 does not answer the teammate. The daemon (18800) and the dashboard (4202) listen on your own computer only, so they refuse a teammate even with no rule at all and prove nothing here. Open a test port for a minute instead.

   **Terminal (yours):** serve an empty folder on port 8099, and confirm it answers on your Tailscale address:

   ```sh
   mkdir -p /tmp/agentx-port-check && cd /tmp/agentx-port-check && python3 -m http.server 8099
   curl -m 5 http://$(tailscale ip -4):8099/    # in a second terminal: prints a short page
   ```

   **Their terminal:**

   ```sh
   curl -m 5 http://<your computer>:8099/
   ```

   It must fail to connect. If it prints the page, your access rules still let shared users past port 443: fix them before the teammate keeps the page. Stop the test server with Ctrl+C either way. If your computer's firewall blocks incoming connections, turn it off for this one check, or the port stays silent whatever the rule says.

## If something is wrong

- **`tailscale serve publishes the whole dashboard`:** run `tailscale serve reset`, then the two `--set-path` lines above. The reset removes every served path, so add the phone app's two `/app` lines back if you use it.
- **`Could not read this machine's Tailscale name`:** Tailscale is not running on your computer. Start it, or pass `--url https://<address>` to `agentx people invite`.
- **The teammate's browser says the site can't be reached:** they opened the address before Tailscale on their machine said **Connected**, or before accepting the share. Once it is connected, they close the browser completely and open the address again.
- **"That code didn't work":** the code was mistyped, is older than 10 minutes, or was already used. Run `agentx people invite` again.
- **"The private network says someone else is connecting":** the login Tailscale reports for their machine is not among the person's `tailscale:` identities. Check with `agentx people show <id>` and fix the identity, or remove it to accept whatever login is reported.
- **"Waiting for the owner" does not end:** the card is still in your Approvals inbox. Answer it.
- **The page is empty:** request tracking is off (`agentx requests settings`), or the teammate's identity on that channel is not on their person entry, so their requests were not stamped with their id.
- **The teammate can open other pages or ports of yours:** your access rules let shared users reach more than port 443. Narrow the allow-all rule and add the shared-user rule above.
- **A link to a dashboard page answers `{"error":"not found"}` although the page exists:** the address has `.` or `..` parts, or a backslash. Open the page from the dashboard's menu, or remove those parts from the address.
- **A teammate added a moment ago cannot pair:** fixed after 0.82.0. On 0.82.0, restart the dashboard after `agentx people add`, then invite again.
