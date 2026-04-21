---
title: "Tailscale mesh VPN for AgentX"
---

# Tailscale mesh VPN for AgentX

AgentX nodes talk to each other over the network. If your nodes are on different LANs (a laptop at home, a droplet on DigitalOcean), you need a way to connect them securely without opening ports to the public internet. **Tailscale** gives you that — a zero-config mesh VPN where every device gets a stable private IP.

This guide walks you through the setup and explains a common gotcha: **how to receive webhooks from external services** (GitHub, GitLab, Telegram) when your daemon sits behind a Tailscale IP.

## 1. Create a Tailscale account

1. Go to [tailscale.com](https://tailscale.com) and sign up.
2. Choose an auth provider — Google, GitHub, Microsoft, or email all work.
3. You land on the **Admin Console**. No devices yet.

That's it. The free tier covers up to 100 devices, which is more than enough for any AgentX deployment.

## 2. Add devices to your tailnet

Install Tailscale on every machine that runs an AgentX daemon (or needs to reach one).

### Linux (DigitalOcean droplet, any VPS)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

A URL prints to the terminal. Open it in your browser, authenticate, and the device appears in the admin console.

### macOS

```bash
# Via Homebrew
brew install --cask tailscale

# Or download from the Mac App Store
```

Open the Tailscale app from the menu bar and sign in.

### Android (Termux edge node)

Install **Tailscale** from the Play Store. Sign in. Done.

### Verify connectivity

Once two or more devices are authenticated, they can reach each other by Tailscale IP:

```bash
# From your laptop, ping the droplet
ping 100.67.108.119

# From the droplet, ping the laptop
ping 100.88.42.7
```

Every device also gets a MagicDNS name (e.g. `clawd-server`, `macbook-local`) so you can use hostnames instead of IPs.

## 3. How the mesh works

Tailscale creates a **WireGuard tunnel** between every pair of devices. Traffic goes peer-to-peer when possible (even through NAT) and falls back through Tailscale relay servers (DERPs) when it can't.

For AgentX this means:

- **Daemon-to-daemon mesh traffic** (port 19900) flows over encrypted Tailscale tunnels. No firewall rules needed.
- **API and dashboard access** (port 18800) stays private — only devices on your tailnet can reach it.
- **SSH** between nodes works over Tailscale IPs without exposing port 22 to the public internet.

### MagicDNS

Enable MagicDNS in the Tailscale admin console (**DNS → Enable MagicDNS**). This lets you use device names:

```bash
# Instead of
curl http://100.67.108.119:19900/health

# You can use
curl http://clawd-server:19900/health
```

### Subnet routing (optional)

If you need AgentX to reach services on a private LAN behind one of your nodes (e.g. a database on 192.168.1.0/24), enable subnet routing on that node:

```bash
sudo tailscale up --advertise-routes=192.168.1.0/24
```

Then approve the route in the admin console.

## 4. Allowing public access for webhooks

Here's the common gotcha: **Tailscale IPs are private.** External services like GitHub, GitLab Cloud, and Telegram cannot send webhooks to `100.x.x.x` addresses. They need a public IP.

### The rule

| Traffic type | Bind to | Accessible from |
|---|---|---|
| Mesh (daemon-to-daemon) | Tailscale IP | Tailnet only |
| API / Dashboard | Tailscale IP | Tailnet only |
| **Webhooks** | **Public IP** | **Internet (filtered)** |

### How to set it up

**Step 1 — Keep the daemon bound to `0.0.0.0`**

By default AgentX binds to all interfaces. This means it listens on both the Tailscale interface and the public interface. Don't change this — it's what you want.

```jsonc
// agentx.json — no bindAddress needed, 0.0.0.0 is the default
{
  "port": 18810
}
```

**Step 2 — Use the server's public IP for webhook URLs**

When registering webhooks with GitHub, GitLab, or Telegram, use the server's **public IP** (or a DNS name that points to it), not the Tailscale IP:

```
# Correct — public IP
https://yourserver.example.com:18810/webhook/github

# Wrong — Tailscale IP (unreachable from the internet)
http://100.67.108.119:18810/webhook/github
```

**Step 3 — Lock down the webhook port with UFW**

You don't want the entire internet hitting your webhook port. Whitelist only the IP ranges of the services that send you webhooks.

#### Find GitHub webhook IPs

```bash
curl -s https://api.github.com/meta | jq '.hooks'
```

This returns a list like:

```json
[
  "192.30.252.0/22",
  "185.199.108.0/22",
  "140.82.112.0/20",
  "143.55.64.0/20"
]
```

#### Find GitLab.com webhook IPs

GitLab publishes their IPs in their docs. As of writing, the relevant range is `34.74.90.64/28` — but check [GitLab's IP list](https://docs.gitlab.com/ee/user/gitlab_com/#ip-range) for the latest.

#### Apply UFW rules

```bash
# Default: deny incoming on the webhook port
sudo ufw deny in on eth0 to any port 18810

# Allow GitHub webhook IPs
sudo ufw allow in on eth0 from 192.30.252.0/22 to any port 18810 proto tcp
sudo ufw allow in on eth0 from 185.199.108.0/22 to any port 18810 proto tcp
sudo ufw allow in on eth0 from 140.82.112.0/20 to any port 18810 proto tcp
sudo ufw allow in on eth0 from 143.55.64.0/20 to any port 18810 proto tcp

# Allow GitLab.com webhook IPs
sudo ufw allow in on eth0 from 34.74.90.64/28 to any port 18810 proto tcp

# Allow Telegram bot API servers (if using webhooks instead of polling)
# Telegram uses 149.154.160.0/20 and 91.108.4.0/22
sudo ufw allow in on eth0 from 149.154.160.0/20 to any port 18810 proto tcp
sudo ufw allow in on eth0 from 91.108.4.0/22 to any port 18810 proto tcp

# Verify
sudo ufw status numbered
```

> **Note:** These rules apply to `eth0` (the public interface). Tailscale traffic on the `tailscale0` interface is unaffected — mesh communication keeps working regardless of UFW rules on `eth0`.

#### Telegram note

AgentX uses **long polling** for Telegram by default (the bot calls Telegram, not the other way around). You only need the Telegram webhook rules above if you've switched to webhook mode.

## 5. Security best practices

### Expose only what must be public

| Port | Interface | Purpose | Public? |
|---|---|---|---|
| 18810 | eth0 | Webhooks from GitHub/GitLab/Telegram | Yes (IP-filtered) |
| 18800 | tailscale0 | API + Dashboard | No — tailnet only |
| 19900 | tailscale0 | Mesh federation | No — tailnet only |
| 22 | tailscale0 | SSH | No — tailnet only |

### Checklist

- **SSH:** Disable password auth. Use key-based auth only. Consider [Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh) to eliminate SSH keys entirely.
- **Firewall:** Start with `ufw default deny incoming`, then open only what's needed.
- **Webhook secrets:** Always set a webhook secret in GitHub/GitLab and verify the signature in AgentX. A matching IP is not enough.
- **ACLs:** Use Tailscale ACLs (in the admin console) to restrict which devices can reach which ports. E.g. only your laptop should access the dashboard.
- **Key expiry:** Tailscale keys expire by default. Don't disable expiry on servers — re-authenticate periodically.
- **Updates:** Keep Tailscale, AgentX, and your OS packages up to date. `sudo tailscale update` handles the Tailscale side.

### Example ACL snippet

```jsonc
// In Tailscale admin → Access Controls
{
  "acls": [
    // All devices can reach AgentX mesh port
    { "action": "accept", "src": ["*"], "dst": ["*:19900"] },
    // Only admin devices can reach the dashboard
    { "action": "accept", "src": ["tag:admin"], "dst": ["*:18800"] },
    // Block everything else by default
  ]
}
```

## Quick reference

```bash
# Check Tailscale status
tailscale status

# Find your Tailscale IP
tailscale ip -4

# Check if a peer is reachable
tailscale ping clawd-server

# See current UFW rules
sudo ufw status verbose

# Fetch latest GitHub webhook IPs
curl -s https://api.github.com/meta | jq '.hooks'
```
