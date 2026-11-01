import type { DaemonConfig, Integration } from "@/daemon/config"
import { getIntegration } from "./resolve"
import { connectCommand, resolveAccessToken, type TokenDeps } from "./resolve"
import { safeProviderText } from "./oauth"
import { BUILTIN_PROVIDERS, providerFor, type ProviderRegistry } from "./providers"
import type { ProviderSpec, ReadSpec } from "./providers/types"

// --- Named, read-only calls to an outside API (`agentx_integration_read`) ---
//
// An agent names an integration kind, a read from that provider's spec and
// a few parameters. This module checks every parameter against the spec,
// builds the URL itself and sends a GET with the integration's token. There
// is no way to send another method, another path or a parameter the spec
// does not list. An integration can narrow its reads further with
// metadata.reads ("read_a,read_b").
//
// The answer is bounded (MAX_BODY characters) and never carries the token.

export const MAX_BODY = 16_000

export interface ReadDeps extends TokenDeps {
  providers?: ProviderRegistry
}

export interface ReadRequest {
  agentId: string
  kind: string
  label?: string
  read: string
  params?: Record<string, unknown>
}

export type ReadResult =
  | { ok: true; status: number; body: string; truncated: boolean }
  | { ok: false; status: number; error: string }

const ID_PARAM = /^[A-Za-z0-9_.:@-]{1,200}$/

/** The reads an integration allows: the spec's, narrowed by metadata.reads. */
export function allowedReads(i: Integration, spec: ProviderSpec): string[] {
  const all = Object.keys(spec.reads)
  const only = i.metadata?.reads
  if (typeof only !== "string" || !only.trim()) return all
  const pick = new Set(only.split(",").map((s) => s.trim()).filter(Boolean))
  return all.filter((r) => pick.has(r))
}

/** Check the agent's params against a read spec. Returns the path and query
 *  to send, or the first problem found. Exported for tests. */
export function buildReadUrl(
  spec: ProviderSpec,
  read: ReadSpec,
  params: Record<string, unknown>,
  metadata: Record<string, unknown>,
): { ok: true; url: URL; values: Record<string, string> } | { ok: false; error: string } {
  for (const k of Object.keys(params)) {
    if (!read.params[k]) return { ok: false, error: `unknown parameter "${k}". Allowed: ${Object.keys(read.params).join(", ") || "none"}` }
  }
  const values: Record<string, string> = {}
  for (const [name, p] of Object.entries(read.params)) {
    let raw = params[name]
    if ((raw === undefined || raw === null || raw === "") && p.fromMetadata) raw = metadata[name]
    if ((raw === undefined || raw === null || raw === "") && p.default !== undefined) raw = p.default
    if (raw === undefined || raw === null || raw === "") {
      if (p.required) return { ok: false, error: `parameter "${name}" is required: ${p.description}` }
      continue
    }
    const value = Array.isArray(raw) ? raw.map(String).join(",") : String(raw)
    if (value.length > 1000) return { ok: false, error: `parameter "${name}" is too long` }
    const items = p.list ? value.split(",").map((s) => s.trim()).filter(Boolean) : [value]
    for (const item of items) {
      if (p.enum && !p.enum.includes(item)) return { ok: false, error: `"${item}" is not allowed for "${name}". Allowed: ${p.enum.join(", ")}` }
      if (p.pattern && !new RegExp(`^(?:${p.pattern.source})$`, p.pattern.flags).test(item)) return { ok: false, error: `"${item}" is not a valid value for "${name}"` }
    }
    values[name] = p.list ? items.join(",") : value
  }
  const used = new Set<string>()
  let pathError = ""
  const path = read.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, name: string) => {
    const v = values[name]
    if (!v) { pathError ||= `parameter "${name}" is required for the path`; return "" }
    // "." and ".." are dot segments: the URL parser would climb out of the path.
    if (!ID_PARAM.test(v) || /^\.+$/.test(v)) { pathError ||= `"${name}" must be a plain id`; return "" }
    used.add(name)
    return encodeURIComponent(v)
  })
  if (pathError) return { ok: false, error: pathError }
  const base = new URL(spec.baseUrl)
  const url = new URL(spec.baseUrl + path)
  if (url.origin !== base.origin) return { ok: false, error: "the read left the provider's address" }
  // Belt and braces: no dot segment in the read's own path, and the parsed
  // path still sits under the base path, so nothing climbed out.
  if (path.split("/").some((s) => s === "." || s === "..") || !url.pathname.startsWith(base.pathname)) {
    return { ok: false, error: "the read left the provider's address" }
  }
  for (const [k, v] of Object.entries(values)) if (!used.has(k)) url.searchParams.set(k, v)
  for (const [k, v] of Object.entries(read.fixedQuery ?? {})) url.searchParams.set(k, v)
  return { ok: true, url, values }
}

/** Run one named read for an agent. */
export async function runIntegrationRead(config: DaemonConfig, req: ReadRequest, deps: ReadDeps = {}): Promise<ReadResult> {
  const providers = deps.providers ?? BUILTIN_PROVIDERS
  const spec = providerFor(req.kind, providers)
  if (!spec) return { ok: false, status: 400, error: `no provider for kind "${req.kind}". Known: ${Object.keys(providers).join(", ") || "none yet"}` }
  const found = getIntegration(config, req.agentId, req.kind, req.label)
  if (!found) return { ok: false, status: 404, error: `agent "${req.agentId}" has no enabled ${req.kind} integration${req.label ? ` labelled "${req.label}"` : ""}` }
  const i = found.integration
  const read = Object.prototype.hasOwnProperty.call(spec.reads, req.read) ? spec.reads[req.read] : undefined
  if (!read) return { ok: false, status: 400, error: `unknown read "${req.read}". Allowed: ${allowedReads(i, spec).join(", ")}` }
  if (!allowedReads(i, spec).includes(req.read)) return { ok: false, status: 403, error: `read "${req.read}" is not allowed for ${req.kind} "${i.label}" (metadata.reads)` }

  const built = buildReadUrl(spec, read, req.params ?? {}, i.metadata ?? {})
  if (!built.ok) return { ok: false, status: 400, error: built.error }

  const token = await resolveAccessToken(req.agentId, i, spec, deps)
  if (token.status !== "ok") return { ok: false, status: 409, error: token.reason }

  const f = deps.fetch ?? fetch
  let sendToken = token.token
  if (spec.readToken) {
    try {
      sendToken = await spec.readToken({ read: req.read, values: built.values, token: token.token, fetch: f, now: (deps.now ?? Date.now)() })
    } catch (e: any) {
      const why = safeProviderText(String(e?.message ?? e)).split(token.token).join("[redacted]")
      return { ok: false, status: 403, error: `${spec.title}: ${why}` }
    }
  }
  const headers: Record<string, string> = { Accept: "application/json" }
  if ((spec.tokenIn ?? "header") === "header") headers.Authorization = `Bearer ${sendToken}`
  else built.url.searchParams.set(spec.tokenParam ?? "access_token", sendToken)

  let res: Response
  try {
    res = await f(built.url.toString(), { method: "GET", headers, signal: AbortSignal.timeout(20_000), redirect: "error" })
  } catch (e: any) {
    return { ok: false, status: 502, error: `couldn't reach ${spec.title}: ${safeProviderText(String(e?.message ?? e))}` }
  }
  let text = (await res.text().catch(() => "")).split(token.token).join("[redacted]")
  if (sendToken !== token.token) text = text.split(sendToken).join("[redacted]")
  if (!res.ok) {
    let why = text
    try { const j = JSON.parse(text); why = j?.error?.message || j?.error_description || j?.error || text } catch {}
    const hint = res.status === 401
      ? ` Connect again: ${connectCommand(req.agentId, i)}.`
      : res.status === 403 ? " The account or app may lack a permission or scope this read needs." : ""
    return { ok: false, status: res.status, error: `${spec.title} said ${res.status}: ${safeProviderText(String(why))}.${hint}` }
  }
  const truncated = text.length > MAX_BODY
  return { ok: true, status: res.status, body: truncated ? text.slice(0, MAX_BODY) : text, truncated }
}

export interface ReadCatalogEntry {
  kind: string
  label: string
  title: string
  reads: Array<{ name: string; description: string; params: Record<string, { description: string; required: boolean; allowed?: readonly string[] }> }>
}

/** The reads an agent can run, for the tool's list action. */
export function readCatalog(config: DaemonConfig, agentId: string, providers: ProviderRegistry = BUILTIN_PROVIDERS): ReadCatalogEntry[] {
  const list = ((config.agents?.[agentId] as any)?.integrations ?? []) as Integration[]
  const out: ReadCatalogEntry[] = []
  for (const i of list) {
    if (i.enabled === false) continue
    const spec = providerFor(i.kind, providers)
    if (!spec) continue
    out.push({
      kind: i.kind,
      label: i.label,
      title: spec.title,
      reads: allowedReads(i, spec).map((name) => {
        const r = spec.reads[name]
        return {
          name,
          description: r.description,
          params: Object.fromEntries(Object.entries(r.params).map(([k, p]) => [k, {
            description: p.description,
            required: !!p.required && !(p.fromMetadata && i.metadata?.[k] !== undefined) && p.default === undefined,
            ...(p.enum ? { allowed: p.enum } : {}),
          }])),
        }
      }),
    })
  }
  return out
}
