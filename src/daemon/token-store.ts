import { createHash, randomBytes } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve, dirname } from "path"

// --- Scoped API tokens ---
//
// Tokens let external services (other agentx instances, webhook senders, custom
// apps) talk to this daemon with explicit scopes instead of sharing a single
// all-powerful dashboard token.
//
// We only ever store the sha256 of each token + its printable prefix. The full
// token is shown exactly once, at creation time, and the operator copies it.
// Format:  agx_live_<hex(32)>   — prefix lets secret-scanners catch leaks.
//
// Scopes (string equality; "agent:*" grants any agent):
//   dashboard:read   — /api/live, /api/agents, /api/task/history
//   dashboard:write  — /api/admin/*, config mutation endpoints
//   agent:<id>       — /api/public/agents/<id>/messages
//   agent:*          — any agent
//   mesh:peer        — cross-node mesh (forward-compatible — not enforced yet)

export const TOKEN_PREFIX = "agx_live_"
const DEFAULT_FILE = ".agentx/tokens.json"

export interface TokenRecord {
  id: string                 // short public id (shown in lists)
  name: string
  prefix: string             // full printable prefix (TOKEN_PREFIX + first-4 chars of body)
  hash: string               // sha256 of the full token
  scopes: string[]
  createdAt: string
  expiresAt?: string
  revokedAt?: string
  lastUsedAt?: string
}

export class TokenStore {
  private file: string

  constructor(baseDir: string = process.cwd(), fileRel: string = DEFAULT_FILE) {
    this.file = resolve(baseDir, fileRel)
  }

  private load(): TokenRecord[] {
    if (!existsSync(this.file)) return []
    try { return JSON.parse(readFileSync(this.file, "utf-8")) as TokenRecord[] } catch { return [] }
  }

  private save(records: TokenRecord[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(records, null, 2) + "\n", "utf-8")
  }

  /**
   * Mint a new token. Returns the full token string AND the record.
   * The full token is the only place the secret is ever exposed — the caller
   * must surface it to the operator immediately; after this call the store only
   * knows the hash.
   */
  create(input: {
    name: string
    scopes: string[]
    expiresInDays?: number
  }): { token: string; record: TokenRecord } {
    if (!input.name?.trim()) throw new Error("Token name is required.")
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
      throw new Error("At least one scope is required.")
    }
    for (const s of input.scopes) {
      if (!isValidScope(s)) throw new Error(`Invalid scope: ${s}`)
    }
    const body = randomBytes(32).toString("hex")
    const token = TOKEN_PREFIX + body
    const record: TokenRecord = {
      id: "tok_" + randomBytes(4).toString("hex"),
      name: input.name.trim(),
      prefix: TOKEN_PREFIX + body.slice(0, 4),
      hash: hashToken(token),
      scopes: [...input.scopes],
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 86400 * 1000).toISOString()
        : undefined,
    }
    const records = this.load()
    records.push(record)
    this.save(records)
    return { token, record }
  }

  list(): TokenRecord[] {
    return this.load()
  }

  revoke(id: string): TokenRecord | null {
    const records = this.load()
    const rec = records.find((r) => r.id === id)
    if (!rec) return null
    rec.revokedAt = new Date().toISOString()
    this.save(records)
    return rec
  }

  /**
   * Look up a token string. Returns the record on success, null on unknown /
   * revoked / expired. Updates lastUsedAt opportunistically (write-on-success).
   */
  verify(token: string): TokenRecord | null {
    if (!token || !token.startsWith(TOKEN_PREFIX)) return null
    const hash = hashToken(token)
    const records = this.load()
    const rec = records.find((r) => r.hash === hash)
    if (!rec) return null
    if (rec.revokedAt) return null
    if (rec.expiresAt && Date.parse(rec.expiresAt) < Date.now()) return null
    // Throttle lastUsedAt updates to at most once per minute to avoid disk churn.
    const now = Date.now()
    const last = rec.lastUsedAt ? Date.parse(rec.lastUsedAt) : 0
    if (now - last > 60_000) {
      rec.lastUsedAt = new Date(now).toISOString()
      try { this.save(records) } catch { /* best-effort */ }
    }
    return rec
  }
}

/**
 * Check whether a record has a given required scope. "agent:<id>" required
 * matches either itself or "agent:*". "dashboard:write" implicitly grants
 * "dashboard:read" for convenience.
 */
export function recordHasScope(record: TokenRecord, required: string): boolean {
  if (record.scopes.includes(required)) return true
  if (required.startsWith("agent:") && record.scopes.includes("agent:*")) return true
  if (required === "dashboard:read" && record.scopes.includes("dashboard:write")) return true
  return false
}

function isValidScope(s: string): boolean {
  return (
    s === "dashboard:read" ||
    s === "dashboard:write" ||
    s === "agent:*" ||
    /^agent:[a-z0-9][a-z0-9_-]*$/.test(s) ||
    s === "mesh:peer"
  )
}

export function hashToken(token: string): string {
  return "sha256:" + createHash("sha256").update(token).digest("hex")
}

/**
 * Extract a bearer token from the request headers. Falls back to the
 * `?token=` query param so EventSource (which can't set headers in most
 * browsers) can still authenticate.
 */
export function extractToken(req: { headers: Record<string, string | string[] | undefined>; url?: string }): string | null {
  const auth = req.headers["authorization"]
  const authHeader = Array.isArray(auth) ? auth[0] : auth
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim()
  }
  if (req.url) {
    try {
      const u = new URL(req.url, "http://localhost")
      const tok = u.searchParams.get("token")
      if (tok) return tok
    } catch { /* */ }
  }
  return null
}
