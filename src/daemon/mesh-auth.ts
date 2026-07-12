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

export function decideMeshAuth(req: MeshAuthRequest): MeshAuthDecision {
  if (req.enforcementDisabled) return { allowed: true, reason: "disabled" }
  if (LOOPBACK.has(req.remoteAddress)) return { allowed: true, reason: "loopback" }
  if (req.acceptedTokens.size === 0) return { allowed: true, reason: "no-tokens-configured" }

  const header = req.authorizationHeader || ""
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  if (token && req.acceptedTokens.has(token)) return { allowed: true, reason: "token" }

  return { allowed: false, reason: "missing-or-invalid-token" }
}
