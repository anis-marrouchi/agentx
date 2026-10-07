// --- Inbound auth decision for the daemon's mesh surface ---
//
// Pure decision logic, kept out of the daemon class so it can be unit
// tested. The daemon wraps this with logging and the 401 response.
//
// Model: mesh peers have always sent `Authorization: Bearer <token>`
// (a2a/mesh.ts sendTask), so verifying it server-side is compatible with
// existing paired meshes. Loopback callers (CLI, same-host dashboard,
// local tools) are exempt. Installs with no token configured anywhere
// pass with a warning — that grace path is scheduled for removal.

export interface MeshAuthRequest {
  /** req.socket.remoteAddress */
  remoteAddress: string
  /** Raw Authorization header value ("" when absent). */
  authorizationHeader: string
  /** All tokens this node accepts: MESH_TOKEN, peer tokens, dashboard.token. */
  acceptedTokens: ReadonlySet<string>
  /** AGENTX_MESH_AUTH=off escape hatch. */
  enforcementDisabled?: boolean
  /** A browser says the request comes from another origin's page (see
   *  browser-origin.ts). Such a page is not the operator, even though the
   *  browser that sends it sits on loopback. */
  foreignBrowser?: boolean
}

export type MeshAuthDecision =
  | { allowed: true; reason: "disabled" | "loopback" | "token" | "no-tokens-configured" }
  | { allowed: false; reason: "missing-or-invalid-token" | "foreign-browser-origin" }

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

/** Routes gated for every method, reads included. Agent memory is
 *  injected into every future session of its agent, so an off-box write
 *  is a persistent prompt injection and an off-box read can leak what an
 *  agent noted down. Agents reach it with `curl localhost` from their own
 *  Bash, which the loopback exemption keeps working. */
export function isMeshGatedPath(path: string): boolean {
  return path === "/api/memory" || path.startsWith("/api/memory/") ||
    // Approvals list held memory facts and draft wiki articles, and a card
    // written from off-box would ask the operator in an agent's name.
    path === "/approvals" || path.startsWith("/approvals/") ||
    path === "/requests" || path.startsWith("/requests/") ||
    // Recent events name agents, chats and errors across the node.
    path === "/events/recent" || /^\/agents\/[^/]+\/events$/.test(path) ||
    // Delegations name which agents are working for which others.
    path === "/a2a/delegations" || path.startsWith("/a2a/delegations/") ||
    // Traces carry each task's full prompt and final answer.
    path === "/traces" || path.startsWith("/traces/") ||
    // Past voice exchanges: what was asked and answered out loud. A
    // replay under it makes this host speak.
    path === "/voice/history" || path.startsWith("/voice/history/") ||
    // The phone app's voice: runs speech to text on this host and spends
    // its ElevenLabs quota (voice-io-api.ts).
    path === "/voice/transcribe" || path === "/voice/speak" ||
    // Files agents declared for the phone app: whatever an agent saved in
    // its workspace (app-files-api.ts).
    path === "/app-files" ||
    // Calls agents place to the owner (calls-api.ts): the reasons are
    // agent-written text, and a call makes this host ring and speak.
    path === "/calls" || path.startsWith("/calls/") ||
    // An agent watching the phone camera (camera-api.ts): a look runs the
    // agent's turn, and a snapshot writes a picture of the owner's
    // surroundings to disk.
    path === "/webrtc/camera" || path.startsWith("/webrtc/camera/") ||
    // The host's panel of guest meshes (guests/daemon-api.ts): names the
    // other organisations let in, what they may reach and what they did.
    path === "/mesh/guests" || path.startsWith("/mesh/guests/") ||
    // The wiki routes peers sync from: every raw entry is a task's text,
    // and articles include ones marked private to their agent.
    path === "/wiki/agents" || path === "/wiki/entries" ||
    path === "/wiki/articles" || path === "/wiki/article"
}

/** Control POSTs that act as this daemon: reload its config, switch a
 *  schedule on or off, stop or steer a running task, kill an agent process,
 *  send a message on one of its channels, or announce to the mesh. The CLI, TUI and same-host dashboard reach them over
 *  loopback; an off-box caller needs a mesh token. */
export function isControlPost(path: string): boolean {
  return path === "/reload" || path === "/api/processes/kill" ||
    path === "/send" || path === "/send/agent" || path === "/send/contact" ||
    // A note to the whole mesh, published in this node's name.
    path === "/mesh/announce" ||
    // AgentX Voice's settings window: rewrites agentx.json, and speaks.
    path === "/voice/settings" || path === "/voice/preview" ||
    /^\/api\/tasks\/[^/]+\/(cancel|followup)$/.test(path) ||
    // Pausing, widening, narrowing or ending a guest mesh's grant.
    /^\/mesh\/guests\/[^/]+\/(pause|resume|end|update)$/.test(path) ||
    /^\/crons\/[^/]+\/enabled$/.test(path)
}

/** True when the socket peer is on this host. Used by loopback-only
 *  endpoints (e.g. the guard hook) that must never be reachable off-box. */
export function isLoopback(remoteAddress: string): boolean {
  return LOOPBACK.has(remoteAddress)
}

export function decideMeshAuth(req: MeshAuthRequest): MeshAuthDecision {
  // Checked before every exemption: loopback, the no-token grace path and
  // the off switch all exist for the operator's own tools, not for pages.
  if (req.foreignBrowser) return { allowed: false, reason: "foreign-browser-origin" }
  if (req.enforcementDisabled) return { allowed: true, reason: "disabled" }
  if (LOOPBACK.has(req.remoteAddress)) return { allowed: true, reason: "loopback" }
  if (req.acceptedTokens.size === 0) return { allowed: true, reason: "no-tokens-configured" }

  const header = req.authorizationHeader || ""
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  if (token && req.acceptedTokens.has(token)) return { allowed: true, reason: "token" }

  return { allowed: false, reason: "missing-or-invalid-token" }
}

/** Config shape this module needs. Structural so callers can pass a full
 *  DaemonConfig without this module importing it. */
export interface MeshTokenSources {
  mesh?: { peers?: Array<{ token?: string }> }
  dashboard?: { token?: string }
}

/**
 * Every token accepted on a mesh WRITE path.
 *
 * MESH_TOKEN and per-peer tokens only. `dashboard.token` is deliberately
 * NOT included: it is the most widely handled secret in the config — it
 * sits in dashboard settings and travels alongside peer entries — and
 * accepting it here made it sufficient to POST /task, /channel/send, and
 * the peer-identity forwards that make the daemon act as its own GitLab
 * and GitHub bot.
 *
 * A dashboard on the same host reaches the daemon over loopback, which
 * decideMeshAuth exempts before tokens are consulted. A dashboard on a
 * different host needs a real mesh credential instead.
 */
export function collectAcceptedMeshTokens(
  config: MeshTokenSources,
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const accepted = new Set<string>()
  if (env.MESH_TOKEN) accepted.add(env.MESH_TOKEN)
  for (const p of config.mesh?.peers || []) if (p.token) accepted.add(p.token)
  return accepted
}

/**
 * Bearer token the dashboard sends to `target` (a normalized node URL).
 *
 * The primary daemon gets dashboard.token and a configured
 * dashboard.daemons[] entry gets its own token. Without one (a peer the
 * dashboard only learned about through /mesh, or a primary with no
 * dashboard.token) it falls back to MESH_TOKEN, the credential every node
 * in the mesh accepts.
 */
export function dashboardTokenForNode(
  dashboard: { daemonUrl: string; token?: string; daemons: Array<{ url: string; token?: string }> },
  target: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const norm = (u: string) => u.replace(/\/+$/, "")
  const configured = target === norm(dashboard.daemonUrl)
    ? dashboard.token
    : dashboard.daemons.find((d) => norm(d.url) === target)?.token
  return configured || env.MESH_TOKEN || undefined
}
