# Add a second machine

You can keep the first agent on one machine. Add another only when an agent needs access to tools or files that live elsewhere. Each machine runs its own AgentX daemon and needs a network path to its peer.

::: info Terminal, on the first machine
Run `agentx connect mesh invite`. It prints a join link. Treat the link as a credential and share it only with the person setting up the second machine.
:::

::: info Terminal, on the second machine
Install AgentX, run its setup, then run `agentx connect mesh join '<link>'` with the invite. Start the daemon on both machines.
:::

Use [Operations](../dashboard/operations.md) to confirm the two nodes appear. Run `agentx mesh health` if a peer does not connect. Do not expose the daemon publicly just to make pairing work; use a private network between hosts.

For network configuration and reciprocal pairing, follow [Tailscale setup](tailscale.md). Joining an invite adds the inviting node to the joining node's peer list; repeat in the other direction for two-way discovery. Then [send a peer task](../reference/a2a.md).
