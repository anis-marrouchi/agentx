# People: who is connected and what they asked for

Your teammates and guests reach your agents from their own channels and their own machines. **People** is one page that lists every person, the machines each has paired, and what each asked the agents for. You can end one machine's access from it.

It shows what `agentx people` already records. There is nothing to set up: with nobody listed, the page shows you, the owner of this machine.

## Open it

1. **Browser:** open the dashboard and click the **People** tab (or go to `/people`).
2. Every person is one row: their name, their role (owner, member or guest), their id, and the channel identities you gave them, such as `gitlab:sara.b`. On the right, how many machines they have, and how many are waiting for your approval.
3. Click a person to open them. Click again to close.

![The People tab with one person open: three machines with their state, the address each paired from, first and last use, then their requests and latest turns](/screenshots/people/person.png)

The page refreshes every 30 seconds.

## What you see for one person

**Machines.** A machine is a computer the person paired with their own work page (see [Invite a teammate to their work page](../jobs/members.md)). Each line shows:

| Column | What it means |
|---|---|
| Machine | The name the person typed when pairing, and the machine's id. |
| State | **Active**: it works. **Waiting for your approval**: its card is in [Approvals](./approvals.md). **Approved**: you said yes and the machine has not opened the page since. **Refused**: you said no, or the card ran out. **Ended**: its access was removed, with the reason. |
| Paired from | The address the pairing came from, and the login your private network reported for it. |
| First use | When the machine was paired. |
| Last use | The last time it opened the page, and from which address. |

**Requests, newest first.** What the person asked for, each with the state it is in now: in progress, waiting on you, waiting on another agent, needs attention, done, declined or dropped. This list needs [request tracking](../jobs/open-requests.md) turned on.

**Latest turns they started.** The last 20 messages they sent to an agent, on every channel, with the agent, the channel, the time, and whether the agent is still running. This list fills without request tracking.

A person's work is found by the identities on their entry. A message from a login or number you did not list is not shown under anyone: see [Tell agents who is who](../jobs/people.md).

## End one machine's access

1. **Browser:** open the person and find the machine.
2. Click **End access**, then confirm.
3. The machine stops at once: its next request is refused, and its line turns to **Ended**. The person's other machines keep working.

This does the same as `agentx people revoke-device <id>`. To let that machine in again, invite the person again with `agentx people invite <id>`.

Ending a machine does not remove the share in Tailscale. If the person should no longer reach this computer at all, remove the share there too.

## When nobody is paired

The page says **Nobody has paired a machine yet** and shows the three steps to invite someone: list them, make their one-time code, and say yes to their machine in Approvals.

![The People tab with nobody paired: the three steps to invite someone, above the owner of this machine](/screenshots/people/nobody-paired.png)

The full path, with the network setup, is in [Invite a teammate to their work page](../jobs/members.md).

## Who can open this page

Only you. The page is part of the dashboard, which listens on your own computer. A teammate's machine reaches two paths and nothing else, `/member` and `/api/member`, and this page is under neither. If you set a dashboard token (`dashboard.token`), the page's data needs it, like the rest of the dashboard.

Never publish `/people` or the whole dashboard with `tailscale serve`. `agentx people invite` refuses to make a code while a path other than the member page's and the phone app's is published.

## Check it worked

1. **Browser:** open `http://127.0.0.1:4202/people`. You see at least one row: yourself.
2. **Terminal:** run `agentx people list` and `agentx people devices` from the folder that holds `agentx.json`. The page shows the same people and the same machines.
3. **Teammate's browser:** opening `https://<your computer>/people` shows nothing of yours.

## If something is wrong

- **The page lists only "Owner of this machine":** nobody is in your people list yet. Add someone with `agentx people add`.
- **A person has no requests and no turns:** the identity they write from is not on their entry, so their messages were not recorded under them. Add it with `agentx people link <id> <channel:id>`. Work from before that stays unlisted.
- **Requests are empty but turns are listed:** request tracking is off. Turn it on with `agentx requests settings`.
- **The page shows other people or machines than the terminal:** the dashboard reads the folder it was started in. Start `agentx board serve` from the folder that holds `agentx.json`.
- **A machine stays on "Approved" or "Refused":** its state is written the next time that machine opens the page. Nothing is wrong: an approved machine works when it comes back, a refused one is turned away.
- **"Could not read the people list":** the dashboard has a token and this browser tab was opened before it was set. Reload the page.
