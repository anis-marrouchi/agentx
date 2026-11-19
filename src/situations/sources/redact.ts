// --- What a per-request read gave stays out of traces and live views (#1892 phase 7) ---
//
// The agentx_sources tool's read answer (open apps, tab titles and
// addresses, headlines) goes to the agent's turn, which the person's yes
// covers. It must not also be kept: every tool result becomes a trace step
// (sqlite, SSE, mesh-gated /traces) and a line of the live process view.
// The tool starts its answer with this mark; those paths keep only the
// text before it and a note. No imports: the agent registry uses it.

// The agent's own session file (e.g. ~/.claude/projects/**.jsonl) still
// holds the full tool result, so the marks claim only AgentX's own paths.
export const SOURCES_READ_MARK = "[agentx_sources read: the person's screen or news, for this request only; left out of AgentX traces, hooks and live views]"

export const SOURCES_READ_REDACTED = "[agentx_sources read: content left out of AgentX traces]"

/** The text with any per-request read answer cut out. */
export function redactSourcesRead(text: string): string {
  const at = text.indexOf(SOURCES_READ_MARK)
  return at < 0 ? text : `${text.slice(0, at)}${SOURCES_READ_REDACTED}`
}
