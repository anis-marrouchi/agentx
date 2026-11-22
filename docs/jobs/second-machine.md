# Add a second machine

**This page is for a machine of your own.** A paired machine holds the mesh password, which lets it send work to every agent in the mesh and control the other machines' daemons. Never pair a teammate's or a client's machine this way: give a teammate [their own work page](./members.md), a client [a project page of their own](./clients.md), and another organisation [a guest grant](./guest-mesh.md). For your own phone, use the [phone app](../dashboard/mobile-app.md). The five ways side by side: [Who gets which way in](./keep-it-safe.md#who-gets-which-way-in).

You can keep all your agents on one machine. Add another only when an agent needs tools or files that live elsewhere.

Each machine runs its own AgentX daemon (the background service). Connected machines form a **mesh**, and each machine in it is a **peer** (or **node**) of the others. Peers need a private network path to each other; [Tailscale setup](tailscale.md) shows one way to get it.

## Pair the machines

1. **Terminal, on the first machine:** in the folder that holds `agentx.json`, create an invite:
   ```sh
   agentx connect mesh invite
   ```
   If the second machine reaches this one on a different address (such as a Tailscale address), add `--url http://<this-machine's-address>:18800`.
2. Copy the join link it prints. It contains the mesh password: share it only with the person setting up the second machine, never with a teammate or a client.
3. **Terminal, on the second machine:** install AgentX and run its setup. See [Install](../install.md).
4. **Terminal, on the second machine:** join with the link:
   ```sh
   agentx connect mesh join '<link>'
   ```
5. **Terminal, on both machines:** restart the daemon so it loads the new mesh settings: `agentx daemon restart`.

Joining adds the first machine to the second machine's peer list. For each machine to see the other, repeat steps 1–5 in the other direction. See [Tailscale setup › Pair AgentX in both directions](tailscale.md#_3-pair-agentx-in-both-directions).

Don't make the daemon reachable from the public internet just to get pairing working. Use a private network between the machines.

![Running now on the Hub: one card per connected machine, with what each runs now (demo machines here)](/screenshots/wall/running.png)

## Run an issue on another machine

A heavy issue can run on another machine of the mesh instead of this Mac. You choose it per issue, from its post on the Hub. Its agent keeps working on the issue the same way. Every run about the issue goes to the machine you chose: comments and other events on it, turns the Hub starts from its post (a comment, a hand-off, a wake from the job ledger), schedules whose `home` is the issue, and agent steps of workflows on it. This Mac waits for the answer and keeps the records, the post's thread and the reply on the issue, as for a run of its own. The choice stays until you change it. Its pull request or merge request is not moved: review comments and CI wakes on it run where they ran before, on its branch.

**Before you start**, the other machine needs, set up by whoever runs it:

- the same agent (same id) as the post's agent;
- a checkout of the issue's repository, named in a project rule's `runbook:` or as the agent's `workspace`;
- worktrees turned on for that agent: see [Give each coding task its own worktree](./task-worktrees.md).

Steps:

1. **Browser:** open the dashboard, then the Hub, and open the post whose home is the issue.
2. Under the comment box, in **Run on**, pick the machine. Only machines that host the agent, have the repository and run an AgentX that supports this are listed, each with its swap use and load (for example "clawd — swap 12%, load 0.8").
3. Select **Move**. The next run on the issue starts on that machine, in a worktree made from the issue's pushed branch `agentx/issue-<n>`. A worktree that is already there is brought up to that branch first.
4. To bring it back, select **Back to this Mac**. That is a choice too: the issue then stays on this Mac even if its agent is mapped to another machine (`agentMappings[].node`, or a webhook's `node`).

A move is refused, with the reason, while:

- a run is open on the issue on the machine that has it now;
- the issue's worktree there has uncommitted changes;
- its branch has commits not pushed, or was never pushed and has commits of its own. Push first, then move;
- the machine that has it now is offline: its work can't be checked. Start it again first. This applies to **Back to this Mac** too;
- a run opened there while the move was being made. The issue stays where it was.

What stays on this Mac: a run that a person with tool or skill limits starts is refused instead of running on the other machine, which can't apply those limits. The issue gets the reply "This issue runs on clawd, which can't apply your limits. Ask the owner to bring it back to this Mac." A workflow run that is already going on the issue keeps running where it is. A run that the other machine sent here is never sent on again.

When the other machine goes offline, comments on the issue wait for it. The issue gets one comment, "clawd is offline; this issue's runs wait for it.", and the post shows the machine as offline. Held comments are dropped after 30 minutes, or when more than 50 are waiting; the issue then gets one comment that says how many were dropped and why. Other runs (a Hub turn, a schedule) fail at once with the same reason. Nothing moves back on its own.

If the branch on this Mac and the pushed `agentx/issue-<n>` have both moved on (diverged), the run is refused, with both commits named. Reconcile the branch by hand, then run again.

## Check it worked

1. **Terminal, on either machine:** run `agentx mesh list`. The other machine is listed as `healthy`, with its number of agents.
2. **Browser:** open the dashboard. On the Hub, select **Running now** in the nav. Both machines have a card marked **up**. See [Running now](../dashboard/hub.md#running-now).
3. Send a small test task to an agent on the other machine: see [Agent-to-agent (A2A)](../reference/a2a.md).

4. After you move an issue (see [Run an issue on another machine](#run-an-issue-on-another-machine)): the post says **Runs on** and the machine's name. Comment on the issue: the reply comes from the agent on that machine, and its task shows on that machine's card in **Running now**. **Terminal, on that machine:** `git -C <checkout> worktree list` lists the issue's worktree on `agentx/issue-<n>`.

Agents on the second machine sometimes need your yes or no. If your screen is on the first machine, tell the second one to send its decision cards there: see [Approvals › Agents on another machine](../dashboard/approvals.md#agents-on-another-machine).

## If something is wrong

- **`join` says it could not reach the peer:** the second machine can't reach the first machine's address. Check the address in the invite, the network and any firewall.
- **`agentx mesh list` shows the peer as `unreachable`:** check that its daemon is running (`agentx daemon status`) and listens on an address the other machine can reach. See [Tailscale setup](tailscale.md).
- **`agentx mesh list` says `Mesh: disabled`:** this machine hasn't joined a mesh yet, or its daemon settings weren't saved. Run the join step again.
- **An authentication error:** the machines hold different mesh tokens, or a daemon wasn't restarted after joining. Restart both daemons.
- **`401` when you reload, send a message, stop a task or kill a process on the other machine:** these control calls need the mesh token when they come from another machine. On the same machine they need no token. From another machine, pass `--token` with the mesh token. The dashboard token is not accepted.
- **Only one machine sees the other:** pairing was done in one direction. Repeat it the other way.
- **Run on lists no other machine:** no other machine hosts the post's agent with a checkout of the issue's repository, or it runs an AgentX from before this choice (its card does not say `placement: 1`). On that machine, check that the agent exists, that a project rule's `runbook:` or the agent's `workspace` is a checkout of the repository, and update AgentX there.
- **Run on is not shown on a post:** the post has no issue as its home, it is closed, or you are not signed in as the owner.
- **"A run is open on this issue", "uncommitted changes" or "not pushed" when you move:** wait for the run to end, or commit and push the branch `agentx/issue-<n>` on the machine that has it, then move again.
- **The run was refused with "has no checkout":** the other machine has no checkout of the repository. Add one there (see above), or select **Back to this Mac**.
- **The issue says the machine is offline:** start its daemon there (`agentx daemon status`). The held comments run when it is back, if that is within 30 minutes. **Back to this Mac** is refused while it is offline.
- **The issue says held messages were dropped:** the machine was offline more than 30 minutes, or more than 50 messages waited. Write on the issue again once it is back.
- **The run was refused with "have diverged":** the issue's branch on this machine and the pushed one both have commits the other lacks. In the issue's worktree, merge or rebase onto `origin/agentx/issue-<n>` and push, then run again.
