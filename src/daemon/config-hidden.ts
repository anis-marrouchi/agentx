// --- agentx.json with its literal secrets hidden (#1428) ---
//
// The Hub's Settings › Advanced edits agentx.json as text, like classic
// Settings' Advanced tab, but a secret typed into the file (a bot token, a
// password, the dashboard token) never reaches the page. The read gives the
// file with each such value replaced by HIDDEN_SECRET; a `${NAME}` reference
// stays as it is, since it names a .env variable and holds no secret. On
// save, each HIDDEN_SECRET still in the same place gets the file's value
// back, so a secret is kept without ever leaving the machine.

/** What a hidden literal secret reads as in the editor. */
export const HIDDEN_SECRET = "[hidden secret: kept on save]"

/** A key that holds a secret: a token, secret, password or key. A key that
 *  names where a secret lives (tokenEnv, secretEnv, passwordRef …) does not. */
const SECRET_KEY = /(token|secret|password|passwd|apikey|api_key|privatekey|private_key)/i
const NAMES_A_PLACE = /(env|ref|name|names|dir|path|file|url|id|ids|scopes?)$/i
const REFERENCE = /^\$\{\w+\}$/

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) && !NAMES_A_PLACE.test(key)
}
function isLiteral(v: unknown): v is string {
  return typeof v === "string" && v !== "" && !REFERENCE.test(v)
}

/** A copy of the config with each literal secret replaced, and how many. */
export function hideConfigSecrets(cfg: unknown): { config: unknown; hidden: number } {
  let hidden = 0
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (!v || typeof v !== "object") return v
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (isSecretKey(k) && isLiteral(x)) { out[k] = HIDDEN_SECRET; hidden++ }
      else out[k] = walk(x)
    }
    return out
  }
  return { config: walk(cfg), hidden }
}

/** The edited config with each HIDDEN_SECRET given back the value the file
 *  holds at the same place. Throws when one sits where the file has no
 *  secret (moved or renamed): writing the marker would lose the secret. */
export function restoreConfigSecrets(edited: unknown, current: unknown): unknown {
  const walk = (v: unknown, cur: unknown, at: string): unknown => {
    if (v === HIDDEN_SECRET) {
      if (isLiteral(cur) && cur !== HIDDEN_SECRET) return cur
      throw new Error(`${at || "the file"} says "${HIDDEN_SECRET}", but agentx.json holds no secret there. Put the secret's \${NAME} reference there instead.`)
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, Array.isArray(cur) ? cur[i] : undefined, `${at}[${i}]`))
    if (!v || typeof v !== "object") return v
    const c = cur && typeof cur === "object" && !Array.isArray(cur) ? (cur as Record<string, unknown>) : {}
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, c[k], at ? `${at}.${k}` : k)
    return out
  }
  return walk(edited, current, "")
}
