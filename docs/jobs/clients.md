# Give a client a page of their own

A **client** is someone you do work for: not a teammate, not another organisation running AgentX. When a client asks your agents for something on WhatsApp, Telegram, GitLab or GitHub, they have no way to see whether it is being worked on, waiting on you, or finished. This page gives them one small window of their own, **Your project**: what they asked you for, and where it stands, in plain words. It names none of your agents and shows nothing of yours or of anyone else's.

A client is listed in [people](./people.md) with the role `client`. Everything else works like [a teammate's page](./members.md): one page served on your private network, a one-time code to pair, a key per machine, and nothing opens until you say yes to the machine. The difference is the page behind the door. A teammate gets **My work**, with their agents and what each is doing. A client gets **Your project**, with their own requests only.

What the page does not do yet: let the client share a folder with you, record their agreement before your agent touches their files, or let them pause that work. Those parts come once [the sharing structure](https://github.com/anis-marrouchi/agentx/issues/445) is settled.

The whole path, from your first step to the client's desktop:

![How a client gets their page: you prepare in six steps, the client pairs in four, you say yes on a decision card, and the page becomes Your project](/diagrams/client-join.svg)

## What you need

- The client listed in [people](./people.md) with `--role client`, and the identity they write from on the channel they use.
- [Request tracking](./open-requests.md) turned on, so there is something to show.
- Tailscale on your computer and on theirs. Their machine joins your network through a **share** of this one computer; no public address is used.
- Only the member page published on the network, and shared users limited to port 443: follow [Serve only the member page](./members.md#serve-only-the-member-page) once. The client's page lives under the same two paths, `/member` and `/api/member`, so nothing more is published for it.
- The dashboard running from the folder that holds `agentx.json`.

## Invite

1. **Terminal (computer):** from the folder that holds `agentx.json`, list the client with their role and the identity they write from:

   ```sh
   agentx people add acme --name "Acme Bakery" --role client --identity whatsapp:21620123456
   ```

   To turn a person already listed into a client, edit `people` in `agentx.json` and set their `role` to `client`. Their page changes the next time they open it.
2. **Terminal (computer):** make their one-time code:

   ```sh
   agentx people invite acme
   ```

   It prints the share step, the address of the page, a **pairing code** such as `7KQ4-M2XH`, and the name of the page the person gets, **Your project**. The code works once, for 10 minutes. The command refuses to go on if `tailscale serve` publishes the whole dashboard.
3. **Browser (Tailscale admin console):** open **Machines**, this computer, **Share**, and send the link to the client. Do this once per person; the invite reminds you.
4. Send the client the address and the code on a channel you know is theirs.

## The client pairs their machine

The pairing pages are the same ones a teammate sees.

1. **Their machine:** install Tailscale and accept the share.
2. **Their browser:** open the address, for example `https://your-mac.tailnet-name.ts.net/member`.
3. The page asks for a name for the machine and the code. They type both and press **Pair this machine**.

   ![The "Pair this machine" page with a field for the machine's name and one for the code](/screenshots/members/pair.png)
4. The page says **Waiting for the owner**.

   ![The "Waiting for the owner" page](/screenshots/members/waiting.png)

If the code does not work, the page tells them to ask the person who invited them for a new one. It never sends them to a terminal: they have none on your computer.

## Approve the machine

1. A decision card **New machine for Acme Bakery** arrives in your [Approvals inbox](../dashboard/approvals.md): the address it came from, the login the network reported, and the name the machine gave itself.
2. Answer **Yes** if the client told you they just paired. **No** ends that key at once; a card nobody answers is treated as no after three days.
3. **Their browser:** the waiting page turns into **Your project** by itself.

## Your project

The page shows, for that client only:

- **One sentence** at the top: how many of their requests are being worked on, how many wait on you, and how many need a look from you. With nothing in progress, how many finished this week.
- **What you asked for** in the last 7 days: each request they made, where they asked it (WhatsApp, Telegram, a GitLab or GitHub thread, as a link), and its state in their words: **Being worked on**, **Waiting on us**, **Needs a look from us**, **Finished**, **Stopped**, **Not taken on** or **Set aside**. A finished request links to what was delivered. A request that waits on you is in the same list, not in a box of its own: the question your agent asked you is yours, not theirs.
- **About this page**: two lines that say what the page shows and whom to ask when something looks wrong.

![The Your project page: the summary sentence, then the requests the client made with their state](/screenshots/clients/your-project.png)

No agent id and no word about your other work appears on the page or in the data behind it. "Us" means you and your agents together; the client does not need to tell them apart.

It refreshes every 30 seconds. Opened without a connection, it shows what was last loaded and says it is offline. When the connection is up but your computer does not answer, the page says it can't reach the server, tries again every 20 seconds, and shows a **Try now** button.

### Keep it on the desktop

1. **Their browser (Edge or Chrome, Windows or Mac):** open the browser menu, then **Apps**, then **Install this site as an app**.
2. It opens in its own window named **Your project**, like a small program, and stays in the Start menu or Dock.

## Manage machines

A client's machines are managed like a teammate's: in the dashboard's [People](../dashboard/people.md) tab, where the client's row carries the badge **Client**, or from a terminal with `agentx people devices`, `agentx people revoke-device <id>` and `agentx people remove acme`. See [Manage machines](./members.md#manage-machines). A machine's key lasts 90 days; invite again after that.

## Check it worked

1. **Terminal:** run `agentx people list`. The client's line ends with `· client`.
2. **Terminal:** run `agentx people devices`. The client's machine is listed as `active`. The **People** tab of the dashboard shows it as **Active**, under a row with the badge **Client**.
3. **Their browser:** **Your project** shows a request they made on their channel, with the right state, and the title bar reads **Your project**, not **My work**.
4. **Their browser:** opening `https://<your computer>/`, `/people` or `/app` shows nothing of yours: only `/member` answers.

## If something is wrong

- **The client sees My work instead of Your project:** their role is not `client`. Run `agentx people list` and check the word after their name; set `role` to `client` in `agentx.json` if it is not. The page changes on the next open.
- **`--role must be one of: owner, member, client, guest`:** the role was mistyped. Write `client`.
- **"That code didn't work":** the code was mistyped, is older than 10 minutes, or was already used. Run `agentx people invite acme` again and send the new code.
- **"The private network says someone else is connecting":** the login Tailscale reports for their machine is not among the person's `tailscale:` identities. Check with `agentx people show acme` and fix the identity, or remove it to accept whatever login is reported.
- **"Waiting for the owner" does not end:** the card is still in your Approvals inbox. Answer it.
- **The page says "Nothing asked for yet" although they asked:** request tracking is off (`agentx requests settings`), or the client's identity on that channel is not on their person entry, so their requests were not stamped with their id.
- **The client can open other pages or ports of yours:** your access rules let shared users reach more than port 443. Follow [Serve only the member page](./members.md#serve-only-the-member-page).
