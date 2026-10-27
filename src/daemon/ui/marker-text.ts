// --- Internal markers, said plainly (#1443) ---
//
// Turns the daemon writes to an agent start with a marker for the agent
// and the daemon to read, such as `[agentx:delegation-result task=… from=…]`
// (a2a/delegation.ts) or `[agentx:plan-step id=… step=…]` (requests/plans.ts).
// A person on the Wall should never read one. plainMarkerText drops every
// marker from a text; a text that was only markers becomes one plain line
// ("Result from dev-session"), so a card still says what the run is.
//
// Shipped to the browser with injectFns (../inject.ts), so it must stay
// self-contained: no imports, no names from outside its own body.

export function plainMarkerText(text: unknown): string {
  const s = text == null ? "" : String(text)
  if (s.indexOf("[agentx:") === -1) return s
  // A marker runs to its "]"; a preview clipped inside one runs to the line's
  // end. A line that held only a marker goes with it.
  const re = /[ \t]*\[agentx:([a-z][a-z-]*)([^\]\n]*)(?:\]|$)[ \t]*(\n?)/gm
  const found: Array<{ kind: string; attrs: Record<string, string> }> = []
  const rest = s.replace(re, (_m, kind: string, raw: string, nl: string, at: number) => {
    const attrs: Record<string, string> = {}
    for (const m of raw.matchAll(/([a-z]+)=(\S+)/g)) attrs[m[1]] = m[2]
    found.push({ kind, attrs })
    return at === 0 || s.charAt(at - 1) === "\n" ? "" : nl
  })
  const left = rest.replace(/\n{3,}/g, "\n\n").trim()
  if (left || !found.length) return left
  const { kind, attrs } = found[0]
  const from = attrs.from
  const step = attrs.step && /^\d+$/.test(attrs.step) ? attrs.step : ""
  switch (kind) {
    case "delegation-result":
      if (!from) return "Result from another agent"
      return attrs.status === "waiting" ? `Update from ${from}: still under way`
        : attrs.status === "reply" ? `Reply from ${from}` : `Result from ${from}`
    case "plan-step": return step ? `Plan step ${step}` : "A plan step"
    case "plan-nudge": return step ? `Reminder: plan step ${step}` : "Reminder: a plan step"
    case "workflow-step": return "A workflow step"
    case "workflow-nudge": return "Reminder: a workflow step"
    case "request-pickup": return "A request picked up again"
    case "watcher": return "A watcher's alert"
    case "same-home": return "Another run works on the same thing"
    default: return "A message from AgentX"
  }
}
