// --- Correlator ---
//
// Thread `workflowRunId` through IncomingMessage / AgentTask / agent reply
// without modifying those types until the integration-seam commit lands.
//
// Phase 1 strategy: piggyback on an existing free-form field (`sender.id`
// is stable across the pipeline) and carry a separate in-memory mapping
// here. When the integration seam adds a typed field we drop this module.

type RunId = string
type CorrelationKey = string  // stable key derived from channel + chatId (+agentId)

// Purely in-memory — runs are short-lived, daemon restart re-creates the
// mapping when webhooks re-arrive. If a reply comes back after a restart we
// look it up via the run-store's entity index instead; this cache is just
// for the common case.
const cache = new Map<CorrelationKey, RunId>()

export function keyFor(args: { channel: string; chatId: string; agentId?: string }): CorrelationKey {
  return `${args.channel}|${args.chatId}|${args.agentId || "*"}`
}

export function remember(key: CorrelationKey, runId: RunId): void {
  cache.set(key, runId)
}

export function lookup(key: CorrelationKey): RunId | undefined {
  return cache.get(key)
}

export function forget(key: CorrelationKey): void {
  cache.delete(key)
}

/** Convenience: stash the runId against the expected reply key, so the
 *  post:response hook (once the seam lands) can look it up by (channel, chatId).
 *  Safe to call even before the seam exists — just writes to the cache. */
export function stampDispatch(args: { channel: string; chatId: string; agentId: string; runId: RunId }): void {
  remember(keyFor(args), args.runId)
}
