# Connect machines with Tailscale

Use the [network prerequisites checklist](../requirements.md#two-machines-and-a2a) before pairing.

Tailscale supplies the private network between your AgentX machines. AgentX mesh pairing supplies peer addresses and authentication. Set up both before expecting agents on different machines to communicate.

## 1. Join the same private network

Install Tailscale on both machines and sign into the intended tailnet using the [official installation guide](https://tailscale.com/docs/install). Check each machine's address and connectivity:

```sh
tailscale status
tailscale ip -4
tailscale ping <other-machine-name-or-IP>
```

These commands are described in the [Tailscale CLI reference](https://tailscale.com/docs/reference/tailscale-cli). Your tailnet access policy and host firewall must permit the intended peers to reach AgentX's TCP port, normally `18800`.

## 2. Make the daemon reachable

For a native installation, set `node.bind` in each machine's `agentx.json` to its own Tailscale IPv4 address and daemon port, for example `100.64.0.10:18800`. Restart that daemon after changing its bind address. Update local clients' daemon URLs, including `dashboard.daemonUrl`, if they previously used loopback.

From the other machine, check:

```sh
curl http://100.64.0.10:18800/health
```

Replace the example address with your machine's address. A successful Tailscale ping alone does not establish that the daemon's HTTP port is reachable.

The supplied Docker Compose file publishes ports on host loopback. For a Docker node, adapt the daemon's host port mapping to your host's Tailscale address, for example `100.64.0.10:18800:18800`, while retaining `0.0.0.0:18800` **inside** the daemon container. Recreate that service. The dashboard can remain local; it does not need to be published to pair agents.

## 3. Pair AgentX in both directions

Run commands from the configuration directory on each machine. On machine A:

```sh
agentx connect mesh invite --url http://100.64.0.10:18800
```

On machine B, consume the printed link:

```sh
agentx connect mesh join '<invite-from-A>'
```

Joining adds A to B's peer list. For two-way discovery, create an invite on B with B's address and join it on A. After B joins A, its invite reuses the shared token. Invite links contain a credential: share them privately.

Restart both daemons after first pairing so newly written `.env` tokens are loaded. For Docker, run the pairing commands inside the daemon container from `/data`, and restart the services afterward.

## 4. Verify and send a task

```sh
agentx mesh list
agentx mesh health
```

Open **Operations** and check the peer nodes, then follow [Agent-to-agent communication](../reference/a2a.md) to send a small test task. An unreachable peer points to address, bind, firewall, or tailnet policy problems; an authentication error points to mismatched tokens or a daemon that has not reloaded its environment.
