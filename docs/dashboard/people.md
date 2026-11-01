# People: who is connected and what they asked for

Your teammates, clients and guests reach your agents from their own channels and their own machines. **People** is a page of the [Hub](./hub.md) that lists every person, the machines each has paired, and what each asked the agents for. You can end one machine's access from it.

It shows what `agentx people` already records. There is nothing to set up: with nobody listed, the page shows you, the owner of this machine.

## Open it

1. **Browser:** open the dashboard. The Hub is the first page you see.
2. Select **People** in the nav on the left. The number next to it is how many people are listed. On a phone, select **More** in the bottom bar, then **People**. The page's address is `/hub#page=people`. Old links to the classic People page open it too.
3. Every person is one row: a round picture with their initials, their name, their handle (such as `@sara`), and their role (**Owner**, **Member**, **Client** or **Guest**). Under it, the channel identities you gave them, such as `gitlab:sara.b`, and the agents they may reach, when you limited them.
4. The last line counts their machines, how many of those wait for your approval, and their open requests on the Hub.
5. Under it, **Upload picture** gives them a picture in place of the initials; see [Give agents and people a picture](../jobs/profile-pictures.md).

![The People page on the Hub: one row per person with their role, identities, machines and open requests](/screenshots/wall/people.png)

*Fictional data; your people will differ.*

The page refreshes with the rest of the Hub, every minute, and when you select **Refresh**.

## What you see for one person

1. Select a person's name, or **Machines and requests** under it. Their details open under the row.
2. Select it again (**Hide machines and requests**) to close them.

![One person opened: their two machines with state, address and use, their open requests, and the latest turns they started](/screenshots/wall/people-person.png)

**Machines.** A machine is a computer the person paired with their own page: **My work** for a teammate (see [Invite a teammate to their work page](../jobs/members.md)), **Your project** for a client (see [Give a client a page of their own](../jobs/clients.md)). Each machine shows:

| What | What it means |
|---|---|
| Name | The name the person typed when pairing. |
| State | **Active**: it works. **Waiting for your approval**: its card is in Approvals; select **Approve** to go there. **Approved**: you said yes and the machine has not opened the page since. **Refused**: you said no, or the card ran out. **Ended**: its access was removed, with the reason. |
| Paired from | The address the pairing came from, and the login your private network reported for it. |
| First use | When the machine was paired. |
| Last use | The last time it opened the page, and from which address. |

**Requests.** What the person asked for that is still open, newest first, each with its state (in progress, waiting on you, waiting on another agent, needs attention), the agent, the channel and the time. Select a request to open its post on the Hub. Closed requests (done, declined, dropped) are folded under **earlier requests**: select that line to show them. This list needs [request tracking](../jobs/open-requests.md) turned on.

**Latest turns they started.** The last 20 messages they sent to an agent, on every channel, with the agent, the channel, the time, and whether the agent is still running. Select one to open that run on the Hub's **Task** page. This list fills without request tracking.

A person's work is found by the identities on their entry. A message from a login or number you did not list is not shown under anyone: see [Tell agents who is who](../jobs/people.md).

## See everything one person asked for

1. On the People page, select **open requests on the Hub** on the person's row.
2. The Hub's feed opens with only that person's open posts. The line under the title says **asked by** and their name.
3. Select **everyone** on that line to see every post again.

![The Hub's feed with only one person's open requests, and "everyone" to go back](/screenshots/wall/people-requests.png)

The same filter is **Asked by** in the Hub's search and filters, so you can also pick a person there and save it as your view.

## End one machine's access

1. **Browser:** open the person and find the machine.
2. Select **End access**, then confirm.
3. The machine stops at once: its next request is refused, and its line turns to **Ended**. The line at the top of the page says **Access ended**. The person's other machines keep working.

This does the same as `agentx people revoke-device <id>`. To let that machine in again, invite the person again with `agentx people invite <id>`.

Ending a machine does not remove the share in Tailscale. If the person should no longer reach this computer at all, remove the share there too.

## End one signed-in browser

Once sign-in by email link is set up (it is being built, see #1478), a person who signs in gets a session of their own in that browser. They are listed under **Signed-in browsers**, below the machines, with the browser's name, when it signed in and its last use. The heading shows only once someone has signed in.

1. **Browser:** open the person and find the browser under **Signed-in browsers**.
2. Select **End access**, then confirm.
3. That browser is signed out at once and its line turns to **Ended**. The person's other browsers and machines keep working, and they can sign in again.

![A person opened on People: under Machines, Signed-in browsers lists one ended browser and one signed in, with End access](/screenshots/wall/people-sessions.png)

A sign-in also ends by itself after 30 days, and at the next request once you take the person off the people list. A teammate's or a client's sign-in never counts as yours: it opens none of the owner's pages, settings or writes.

## Sign in as the owner from another browser

You can sign in to the whole dashboard from another computer with an email link, instead of typing the dashboard token at `/login`. You get the same rights as with the token. Before that, each new browser must be confirmed on **this computer**, the one that runs AgentX (the "home machine"). A phone card does not do it.

It needs three things: the [mail sender](../reference/config-operations.md#mail-sender), [`wall.signIn.origin`](../reference/config-operations.md#wall-sign-in), and a dashboard token (`dashboard.token`). Without a token, no link is sent to you. Your entry on the people list must have your address, for example `agentx people link <your id> email:you@example.com`.

1. **Other browser:** open `https://<your computer>/member/signin`, type your address and select **Send me a link**.
2. **Your mail:** open the link, give this browser a name and select **Sign in**.
3. **Other browser:** a new browser shows **Confirm on the home machine** with a six-digit code. Leave it open.

   ![The other browser waits: Confirm on the home machine, with a six-digit code](/screenshots/members/owner-confirm.png)

4. **Home machine, browser:** open the dashboard there. While a sign-in waits, the Hub shows **A new browser is signing in as you** at the top. Select **Confirm or refuse it**, or open `http://127.0.0.1:4202/signin-requests`.
5. **Home machine, browser:** check that the code under **Waiting** is the one on the other browser, then select **Confirm**. If you did not start this sign-in, select **Refuse**.

   ![Sign-in requests on the home machine: one browser waiting with its code, Confirm and Refuse, and one confirmed browser with End](/screenshots/wall/owner-signin-requests.png)

6. **Other browser:** within a few seconds it opens the Hub, signed in as you.

A sign-in waits 15 minutes for the confirm, then stops; ask for a new link. Once a browser is confirmed, its next link goes straight in. Under **Confirmed browsers**, **End** forgets one, so its next sign-in asks here again. End does not sign that browser out at once: its session lasts 30 days, as one from `/login` does. To sign out every browser now, change `dashboard.token`.

The page `/signin-requests` answers only on this computer. Opened from anywhere else, even from a browser signed in as you, it says **Open this on the home machine**.

Adding people, changing their role or identities, and inviting them stay with the `agentx people` commands in the terminal: the People page only reads, apart from **End access**.

## When nobody is paired

The page says **Nobody has paired a machine yet** and shows the three steps to invite someone: list them (with `--role client` for a client), make their one-time code, and say yes to their machine in Approvals.

![The People page with nobody paired: the three steps to invite someone, above the owner of this machine](/screenshots/wall/people-nobody-paired.png)

The full path, with the network setup, is in [Invite a teammate to their work page](../jobs/members.md).

## On a phone

The page is the same, one column wide. Each machine's facts stack under its name, and **End access** sits under the machine's state.

![The People page on a phone](/screenshots/wall/people-phone.png)

## Who can open this page

Only you. The page is part of the dashboard, which listens on your own computer. A teammate's machine reaches two paths and nothing else, `/member` and `/api/member`, and this page is under neither. If you set a dashboard token (`dashboard.token`), the page's data and **End access** need it, like the rest of the dashboard: anyone else is refused.

Never publish `/hub` or the whole dashboard with `tailscale serve`. `agentx people invite` refuses to make a code while a path other than the member page's and the phone app's (including the Android app's `/.well-known/assetlinks.json`) is published.

## Check it worked

1. **Browser:** open `http://127.0.0.1:4202/hub#page=people`. The Hub opens on **People**, and you see at least one row: yourself.
2. **Terminal:** run `agentx people list` and `agentx people devices` from the folder that holds `agentx.json`. The page shows the same people and the same machines.
3. **Browser:** select **open requests on the Hub** on a person who asked for something. The feed shows only their posts.
4. **Teammate's browser:** opening `https://<your computer>/hub` shows nothing of yours.
5. **Home machine, browser:** open `http://127.0.0.1:4202/signin-requests`. It lists the browsers you confirmed for yourself, and any sign-in waiting.

## If something is wrong

- **No link comes when you sign in as the owner:** check that `dashboard.token` is set and that your entry has your `email:` address (`agentx people show <your id>`). The page answers the same either way, on purpose.
- **"Confirm on the home machine" never moves on:** open `http://127.0.0.1:4202/signin-requests` on the computer that runs AgentX, not on a phone or another computer. After 15 minutes the sign-in stops; ask for a new link.
- **A sign-in waits that you did not start, or its code is not the one on your screen:** select **Refuse**. Someone opened a link sent to your address; check who can read that mailbox.

- **The page lists only "Owner of this machine":** nobody is in your people list yet. Add someone with `agentx people add`.
- **A person has no requests and no turns:** the identity they write from is not on their entry, so their messages were not recorded under them. Add it with `agentx people link <id> <channel:id>`. Work from before that stays unlisted.
- **Requests are empty but turns are listed:** request tracking is off. Turn it on with `agentx requests settings`.
- **"open requests on the Hub" says 0 but the person has open requests:** the Hub shows this node's requests and those of the nodes it reaches. Select **Refresh**; a node that does not answer is named under **Happening now**.
- **The page shows other people or machines than the terminal:** the dashboard reads the folder it was started in. Start `agentx board serve` from the folder that holds `agentx.json`.
- **A machine stays on "Approved" or "Refused":** its state is written the next time that machine opens the page. Nothing is wrong: an approved machine works when it comes back, a refused one is turned away.
- **"Could not read the people list":** the dashboard has a token and this browser tab was opened before it was set. Reload the page. The rest of the Hub keeps working meanwhile.
