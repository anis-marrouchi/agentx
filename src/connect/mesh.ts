import { randomBytes } from "crypto"
import chalk from "chalk"
import prompts from "prompts"
import { applyConfigMutation, getAtPath, setAtPath } from "@/daemon/config-mutator"
import { getDotEnv, setDotEnv } from "@/utils/dotenv-mutator"

// --- agentx connect mesh ---
//
// One-command mesh pairing for two AgentX nodes on the same private network
// (Tailscale / WireGuard / VPN). Replaces the manual "generate a MESH_TOKEN,
// copy it to both .env files, add peer to each agentx.json" sequence.
//
//   Node A: agentx connect mesh invite
//           → prints agentx-mesh://join/<base64({url, token, name})>
//   Node B: agentx connect mesh join <link>
//           → persists the shared token + adds A as a peer

const PROTOCOL = "agentx-mesh:"
const PATH_PREFIX = "//join/"

export interface MeshInvitePayload {
  url: string
  token: string
  name: string
  version: 1
}

function b64urlEncode(input: string): string {
  return Buffer.from(input, "utf-8").toString("base64url")
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf-8")
}

export function encodeInvite(payload: MeshInvitePayload): string {
  return `${PROTOCOL}${PATH_PREFIX}${b64urlEncode(JSON.stringify(payload))}`
}

export function decodeInvite(link: string): MeshInvitePayload {
  if (!link.startsWith(`${PROTOCOL}${PATH_PREFIX}`)) {
    throw new Error(`Not a mesh invite link — expected ${PROTOCOL}${PATH_PREFIX}…`)
  }
  const raw = link.slice(PROTOCOL.length + PATH_PREFIX.length)
  const parsed = JSON.parse(b64urlDecode(raw))
  if (parsed.version !== 1) throw new Error(`Unsupported invite version: ${parsed.version}`)
  if (typeof parsed.url !== "string" || typeof parsed.token !== "string" || typeof parsed.name !== "string") {
    throw new Error("Invite payload missing required fields (url, token, name)")
  }
  return parsed
}

function generateToken(): string {
  // 32 bytes → 64-char hex; plenty of entropy and stays readable in a URL.
  return randomBytes(32).toString("hex")
}

function resolveBindUrl(raw: any): string {
  const bind: string = raw?.node?.bind || "127.0.0.1:18800"
  const [host, port] = bind.split(":")
  // Invites need a routable address, not 0.0.0.0. We don't know the Tailscale IP,
  // so we let the user confirm before sending.
  return `http://${host}:${port}`
}

function nodeName(raw: any): string {
  return raw?.node?.name || raw?.node?.id || "node"
}

/**
 * invite() — produce a join link for the OTHER node to consume.
 * Creates a MESH_TOKEN in .env if one doesn't exist yet.
 */
export async function invite(opts: { url?: string; configPath?: string }): Promise<void> {
  // Read the raw config to get node info + existing token ref
  const { readFileSync, existsSync } = await import("fs")
  const { resolve } = await import("path")
  const cfgPath = opts.configPath || resolve(process.cwd(), "agentx.json")
  if (!existsSync(cfgPath)) {
    console.log(chalk.red(`  No agentx.json at ${cfgPath}. Run: agentx init`))
    process.exit(1)
  }
  const raw = JSON.parse(readFileSync(cfgPath, "utf-8"))

  // 1. Ensure a token exists
  let token = getDotEnv("MESH_TOKEN")
  if (!token) {
    token = generateToken()
    setDotEnv("MESH_TOKEN", token)
    console.log(chalk.dim(`  Generated new MESH_TOKEN (32 bytes) and saved to .env`))
  }

  // 2. Resolve the URL — default from node.bind, but confirm because 0.0.0.0 isn't routable.
  let url = opts.url || resolveBindUrl(raw)
  const needsHint = url.includes("0.0.0.0") || url.includes("127.0.0.1") || url.includes("localhost")
  if (needsHint && !opts.url) {
    const { url: entered } = await prompts({
      type: "text",
      name: "url",
      message: "This node's URL as peers should reach it (e.g. http://100.x.x.x:18800):",
      initial: url,
      validate: (v: string) => /^https?:\/\//.test(v) || "must start with http:// or https://",
    })
    if (!entered) { console.log(chalk.red("  Aborted")); process.exit(1) }
    url = entered
  }

  // 3. Make sure mesh is enabled
  const result = await applyConfigMutation((cfg) => {
    setAtPath(cfg, "mesh.enabled", true)
  }, { configPath: opts.configPath })
  if (!result.success) {
    console.log(chalk.red(`  ✗ ${result.error}`))
    process.exit(1)
  }

  const link = encodeInvite({ url, token, name: nodeName(raw), version: 1 })

  console.log()
  console.log(chalk.bold("  Mesh invite"))
  console.log()
  console.log(`  ${chalk.cyan(link)}`)
  console.log()
  console.log(chalk.dim(`  Run on the other node:`))
  console.log(chalk.dim(`    agentx connect mesh join "${link}"`))
  console.log()
  console.log(chalk.yellow(`  Share over a trusted channel only — whoever holds this link can join your mesh.`))
  console.log()
}

/**
 * join(link) — consume a join link on the OTHER node. Adds the sender as a
 * peer and stores the shared token in .env.
 */
export async function join(link: string, opts: { configPath?: string } = {}): Promise<void> {
  let payload: MeshInvitePayload
  try {
    payload = decodeInvite(link)
  } catch (e: any) {
    console.log(chalk.red(`  ✗ ${e.message}`))
    process.exit(1)
  }

  // Store the shared token (or confirm overwrite if MESH_TOKEN already exists but differs)
  const existing = getDotEnv("MESH_TOKEN")
  if (existing && existing !== payload.token) {
    const { overwrite } = await prompts({
      type: "confirm",
      name: "overwrite",
      message: "A different MESH_TOKEN already exists in .env. Overwrite with the invite's token?",
      initial: false,
    })
    if (!overwrite) { console.log(chalk.red("  Aborted (keeping existing .env)")); process.exit(1) }
  }
  setDotEnv("MESH_TOKEN", payload.token)

  // Add the peer (idempotent on name)
  const result = await applyConfigMutation((cfg) => {
    setAtPath(cfg, "mesh.enabled", true)
    const peers: any[] = getAtPath(cfg, "mesh.peers") as any || []
    const idx = peers.findIndex((p) => p.name === payload.name)
    const peer = { name: payload.name, url: payload.url, token: "${MESH_TOKEN}" }
    if (idx >= 0) peers[idx] = peer
    else peers.push(peer)
    setAtPath(cfg, "mesh.peers", peers)
  }, { configPath: opts.configPath })

  if (!result.success) {
    console.log(chalk.red(`  ✗ ${result.error}`))
    process.exit(1)
  }

  console.log(chalk.green(`  ✓ Joined mesh`))
  console.log(chalk.dim(`    Peer: ${payload.name} @ ${payload.url}`))
  console.log(chalk.dim(`    Shared token stored in .env as MESH_TOKEN`))
  if (result.reloaded) console.log(chalk.dim("    Daemon hot-reloaded."))
  else console.log(chalk.dim("    Restart the daemon to start the mesh (agentx daemon start)."))
  console.log()

  // Health check against the peer — advisory only
  try {
    const res = await fetch(`${payload.url.replace(/\/$/, "")}/.well-known/agent-card.json`, {
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const card: any = await res.json()
      const agents = Array.isArray(card.agents) ? card.agents.length : "?"
      console.log(chalk.dim(`    Reachable — ${payload.name} exposes ${agents} agents`))
    } else {
      console.log(chalk.yellow(`    Peer returned HTTP ${res.status} — double-check the URL`))
    }
  } catch (e: any) {
    console.log(chalk.yellow(`    Could not reach ${payload.url} right now (${e?.cause?.code || e.message}) — verify VPN / Tailscale when the peer daemon is up`))
  }
}
