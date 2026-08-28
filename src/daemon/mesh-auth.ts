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
}

export type MeshAuthDecision =
  | { allowed: true; reason: "disabled" | "loopback" | "token" | "no-tokens-configured" }
  | { allowed: false; reason: "missing-or-invalid-token" }

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

/** True when the socket peer is on this host. Used by loopback-only
 *  endpoints (e.g. the guard hook) that must never be reachable off-box. */
export function isLoopback(remoteAddress: string): boolean {
  return LOOPBACK.has(remoteAddress)
}

export function decideMeshAuth(req: MeshAuthRequest): MeshAuthDecision {
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
