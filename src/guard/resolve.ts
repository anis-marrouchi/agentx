import { existsSync, readFileSync, readdirSync } from "fs"
import { resolve as pathResolve } from "path"
import type { ProtectedSet } from "./types"

// --- Target resolution ---
//
// The incident's command never contained the string "production" — it read
// `--shadow-database-url "$DATABASE_URL"`, and $DATABASE_URL expanded (from a
// local .env.local) to the prod connection string. A literal-string guard is
// blind to that. So before matching, we expand `$VAR`/`${VAR}` using the
// live process env (the hook inherits the agent's env, which the daemon built
// with buildAgentEnv) plus any `.env*` files in the workspace, then extract
// the concrete targets (hosts, URLs, raw var values) the command resolves to.

/** Minimal dotenv parser — tolerates the `export KEY=VALUE` form and quotes,
 *  matching src/utils/workspace-env.ts:parseDotEnv (kept local to avoid
 *  widening that module's export surface for a security-path consumer). */
function parseDotEnv(content: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const stripped = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed
    const eq = stripped.indexOf("=")
    if (eq === -1) continue
    const key = stripped.slice(0, eq).trim()
    let value = stripped.slice(eq + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    if (key) out.push([key, value])
  }
  return out
}

/** Build the env map used for `$VAR` expansion: every `.env*` file in the
 *  workspace (`.env`, `.env.local`, `.env.production`, …) layered under the
 *  live process env (process env wins — it's what the command actually sees). */
export function buildResolveEnv(cwd?: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (cwd && existsSync(cwd)) {
    let files: string[] = []
    try {
      files = readdirSync(cwd).filter((f) => f === ".env" || f.startsWith(".env."))
    } catch {
      /* best-effort */
    }
    // Sort so plain `.env` loads first and more-specific `.env.*` override it.
    files.sort((a, b) => a.length - b.length)
    for (const f of files) {
      try {
        for (const [k, v] of parseDotEnv(readFileSync(pathResolve(cwd, f), "utf8"))) env[k] = v
      } catch {
        /* ignore unreadable env file */
      }
    }
  }
  // Live process env wins — the hook inherits exactly what the agent runs with.
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return env
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g

/** Expand `$VAR` and `${VAR}` in `str` using `env`. Unknown vars expand to
 *  empty (same as a shell). Returns the expanded string plus the set of var
 *  names that were referenced (their resolved values are candidate targets
 *  even if URL parsing later fails). */
export function expandVars(str: string, env: Record<string, string>): { expanded: string; vars: string[] } {
  const vars: string[] = []
  const expanded = str.replace(VAR_RE, (_m, braced, bare) => {
    const name = braced || bare
    vars.push(name)
    return env[name] ?? ""
  })
  return { expanded, vars }
}

/** Pull the host out of a connection string / URL, or return null. Handles
 *  postgres://, mysql://, mongodb://, redis://, http(s)://, and bare host:port. */
export function extractHost(token: string): string | null {
  const m = token.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^:/?\s]+)/i)
  if (m) return m[1].toLowerCase()
  // ssh-style user@host
  const at = token.match(/^[^@\s]+@([^:/\s]+)/)
  if (at) return at[1].toLowerCase()
  return null
}

export interface ResolvedTargets {
  /** The command with `$VAR`/`${VAR}` expanded. */
  expandedCommand: string
  /** Concrete candidate targets: full URLs, extracted hosts, and the raw
   *  resolved values of referenced env vars. Lowercased, de-duped. */
  candidates: string[]
}

/** Given a command and the resolve env, produce every concrete target the
 *  command could act on. Over-inclusive by design — matching is done against
 *  the declared protected sets, so extra candidates never cause false denies
 *  unless they genuinely appear in a protected set. */
export function resolveTargets(command: string, env: Record<string, string>): ResolvedTargets {
  const { expanded, vars } = expandVars(command, env)
  const set = new Set<string>()

  // 1. Resolved values of any referenced env var (e.g. $DATABASE_URL's value).
  for (const name of vars) {
    const v = env[name]
    if (v) {
      set.add(v.toLowerCase())
      const h = extractHost(v)
      if (h) set.add(h)
    }
  }

  // 2. Any URL / connection string appearing literally in the expanded command.
  const urlRe = /[a-z][a-z0-9+.-]*:\/\/[^\s"'`]+/gi
  for (const m of expanded.matchAll(urlRe)) {
    set.add(m[0].toLowerCase())
    const h = extractHost(m[0])
    if (h) set.add(h)
  }

  // 3. Bare host / IP tokens (covers --host api.hackathonat.com, ssh, IPs).
  const hostRe = /\b(?:\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b/gi
  for (const m of expanded.matchAll(hostRe)) set.add(m[0].toLowerCase())

  return { expandedCommand: expanded, candidates: [...set] }
}

/** Expand `${VAR}` in the declared protected values themselves, then return
 *  the normalized (lowercased) set of protected tokens: db_urls, hosts, and
 *  the hosts extracted from any db_urls. */
export function normalizeProtectedSet(set: ProtectedSet, env: Record<string, string>): Set<string> {
  const out = new Set<string>()
  const add = (raw: string) => {
    if (!raw) return
    const val = set.resolve_env ? expandVars(raw, env).expanded : raw
    if (!val) return
    out.add(val.toLowerCase())
    const h = extractHost(val)
    if (h) out.add(h)
  }
  for (const u of set.db_urls) add(u)
  for (const h of set.hosts) add(h.toLowerCase())
  for (const b of set.buckets) add(b.toLowerCase())
  for (const c of set.contexts) add(c.toLowerCase())
  return out
}

/** Does the command (via its candidate targets) touch this protected set?
 *  Match when a candidate exactly equals a protected token, or when either
 *  contains the other as a substring (a bare protected host matches inside a
 *  full candidate URL, and vice-versa). Returns the matched protected token. */
export function matchProtected(
  candidates: string[],
  protectedTokens: Set<string>,
): string | null {
  for (const tok of protectedTokens) {
    if (!tok) continue
    for (const cand of candidates) {
      if (cand === tok) return tok
      // Only substring-match on host/URL-ish tokens (length guard avoids a
      // 2-char bucket name spuriously matching inside an unrelated word).
      if (tok.length >= 4 && (cand.includes(tok) || tok.includes(cand))) return tok
    }
  }
  return null
}
