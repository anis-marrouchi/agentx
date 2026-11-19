import { getEventBus, type AgentXEvents } from "@/events/bus"

// --- The `on:situation` hook event (#1892, phase 4) ---
//
// For user workflows that want to react to a talk's phase change:
//
//   - id: start
//     type: trigger.hook
//     config:
//       event: on:situation
//       filter: { phase: [ended] }     # optional: only these new phases
//
// One emit point (design 3.3): this one listener on the store's bus event
// `situation:phase` fires the hook, nothing else does. The bus event is
// emitted once per committed change, so the hook fires once per change.
// The store's own expiry and close runs are NOT started by this hook
// (3.4, N1): the store starts them itself.

type PhaseEvent = AgentXEvents["situation:phase"]

/** The hook context for one phase change. `phase` is the new phase
 *  (`to`), the field `filter.phase` matches. */
export function situationHookContext(p: PhaseEvent): Record<string, unknown> {
  return {
    situationId: p.situationId, key: p.key, channel: p.channel, chatId: p.chatId, template: p.template,
    endGeneration: p.endGeneration, from: p.from, to: p.to, phase: p.to, cause: p.cause, setBy: p.setBy,
    ...(p.endReason ? { endReason: p.endReason } : {}),
    ...(p.agentId ? { agentId: p.agentId } : {}),
    at: p.at,
  }
}

/** Fire `on:situation` for each committed phase change. Returns the
 *  function that detaches it. A failing hook never reaches the store. */
export function attachSituationHook(hooks: { execute(event: "on:situation", ctx: Record<string, unknown>): Promise<unknown> }): () => void {
  const bus = getEventBus()
  const listener = (p: PhaseEvent) => {
    try {
      void hooks.execute("on:situation", situationHookContext(p)).catch(() => { /* a hook's failure is its own */ })
    } catch { /* never breaks the emit */ }
  }
  bus.on("situation:phase", listener)
  return () => { bus.off("situation:phase", listener) }
}
