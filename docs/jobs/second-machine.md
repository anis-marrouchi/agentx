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

![The Nodes section of the Operations tab, listing each paired machine as online (three demo machines here)](/screenshots/operations/nodes.png)

## Check it worked

1. **Terminal, on either machine:** run `agentx mesh list`. The other machine is listed as `healthy`, with its number of agents.
2. **Browser:** open the **Operations** tab. Both machines appear. See [Operations](../dashboard/operations.md).
3. Send a small test task to an agent on the other machine: see [Agent-to-agent (A2A)](../reference/a2a.md).

Agents on the second machine sometimes need your yes or no. If your screen is on the first machine, tell the second one to send its decision cards there: see [Approvals › Agents on another machine](../dashboard/approvals.md#agents-on-another-machine).

## If something is wrong

- **`join` says it could not reach the peer:** the second machine can't reach the first machine's address. Check the address in the invite, the network and any firewall.
- **`agentx mesh list` shows the peer as `unreachable`:** check that its daemon is running (`agentx daemon status`) and listens on an address the other machine can reach. See [Tailscale setup](tailscale.md).
- **`agentx mesh list` says `Mesh: disabled`:** this machine hasn't joined a mesh yet, or its daemon settings weren't saved. Run the join step again.
- **An authentication error:** the machines hold different mesh tokens, or a daemon wasn't restarted after joining. Restart both daemons.
- **`401` when you reload, send a message, stop a task or kill a process on the other machine:** these control calls need the mesh token when they come from another machine. On the same machine they need no token. From another machine, pass `--token` with the mesh token. The dashboard token is not accepted.
- **Only one machine sees the other:** pairing was done in one direction. Repeat it the other way.
