// --- Template rendering ---
//
// Named-helper substitution: {{a.b.c}} resolves dotted paths in a context
// object, returning the string form of the leaf value. Unknown paths render
// as "" (not left as literal {{...}}) so agents don't see template syntax.
// No arbitrary expressions in v1 — see types.ts for the rationale.
//
// `envAllow` is an allowlist of env-var names that {{env.X}} can reach; any
// other env access renders as "". Prevents leaking secrets through prompt
// text when a workflow author writes {{env.SUPER_SECRET}} by mistake.

export interface RenderOptions {
  envAllow?: string[]
}

function lookup(path: string, ctx: Record<string, unknown>, envAllow: Set<string>): string {
  const parts = path.split(".")
  // env.* is special: only allow-listed names are readable.
  if (parts[0] === "env") {
    if (parts.length !== 2) return ""
    const name = parts[1]
    if (!envAllow.has(name)) return ""
    const v = process.env[name]
    return typeof v === "string" ? v : ""
  }
  let cur: unknown = ctx
  for (const p of parts) {
    if (cur === null || cur === undefined) return ""
    if (typeof cur !== "object") return ""
    cur = (cur as Record<string, unknown>)[p]
  }
  if (cur === null || cur === undefined) return ""
  if (typeof cur === "object") return JSON.stringify(cur)
  return String(cur)
}

export function render(template: string, ctx: Record<string, unknown>, opts: RenderOptions = {}): string {
  const envAllow = new Set(opts.envAllow || [])
  // Character class matches the workflow node-id regex (letters, digits,
  // underscore, hyphen, plus the dotted-path separator). Without the
  // hyphen, auto-generated ids like "n-fcjwrx" silently fail to
  // resolve — the {{…}} literal leaks into rendered output.
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}/g, (_, path: string) => lookup(path, ctx, envAllow))
}

/** Walks a params object and renders every string-valued leaf. Used by
 *  actions so params like `{ body: "Issue #{{issue.iid}} done" }` work
 *  without per-action special-casing. */
export function renderParams(params: Record<string, unknown>, ctx: Record<string, unknown>, opts: RenderOptions = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") out[k] = render(v, ctx, opts)
    else if (Array.isArray(v)) out[k] = v.map((x) => typeof x === "string" ? render(x, ctx, opts) : x)
    else if (v && typeof v === "object") out[k] = renderParams(v as Record<string, unknown>, ctx, opts)
    else out[k] = v
  }
  return out
}
