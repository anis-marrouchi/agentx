import { resolveScheduleCaller } from "@/crons/schedule-tool"

// --- Agent-facing `agentx_integration_read` tool (#1696) ---
//
// Lists the outside-API reads the agent may run, and runs one. It talks to
// the daemon's /integrations endpoints, which hold the tokens: the agent
// never sees one, and there is no action here that writes anywhere.

export interface IntegrationToolDeps {
  daemonUrl: string
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

export async function runIntegrationTool(args: Record<string, unknown>, deps: IntegrationToolDeps): Promise<string> {
  const doFetch = deps.fetch ?? fetch
  const base = deps.daemonUrl.replace(/\/$/, "")
  const caller = resolveScheduleCaller(args, deps.env ?? process.env)
  if (!caller) return "Error: couldn't tell which agent you are. Pass callerAgentId."
  const kind = str(args.kind)
  const read = str(args.read)

  try {
    if (!read) {
      const res = await doFetch(`${base}/integrations/reads?agent=${encodeURIComponent(caller.agentId)}`, { signal: AbortSignal.timeout(10_000) })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
      const list = (data.integrations ?? []).filter((i: any) => !kind || i.kind === kind)
      if (!list.length) return kind
        ? `You have no ${kind} integration with named reads. Ask the owner to connect one: agentx agent integrations connect <agent> ${kind}.`
        : "You have no integrations with named reads. Ask the owner to connect one with agentx agent integrations connect."
      const lines: string[] = []
      for (const i of list) {
        lines.push(`${i.kind} "${i.label}" (${i.title}):`)
        for (const r of i.reads) {
          const ps = Object.entries(r.params as Record<string, any>)
            .map(([k, p]) => `${k}${p.required ? "" : "?"}${p.allowed ? `=${p.allowed.join("|")}` : ""}`)
            .join(", ")
          lines.push(`- ${r.name}: ${r.description}${ps ? ` Params: ${ps}` : ""}`)
        }
      }
      lines.push("Run one with {kind, read, params}. Comma-separate list values (e.g. metric:'a,b').")
      return lines.join("\n")
    }

    if (!kind) return "Error: `kind` is required with `read`."
    const res = await doFetch(`${base}/integrations/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: caller.agentId, kind, label: str(args.label) || undefined, read, params: args.params }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json().catch(() => ({})) as any
    if (!res.ok) return `Error: ${data?.error || `HTTP ${res.status}`}`
    return `${data.body}${data.truncated ? "\n[truncated: narrow the read (fewer metrics, a shorter period)]" : ""}`
  } catch (e: any) {
    return `Error: couldn't reach the daemon (${e?.message ?? e}).`
  }
}
