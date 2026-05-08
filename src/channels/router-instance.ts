import type { MessageRouter } from "./router"

// --- Singleton accessor for the live MessageRouter ---
//
// Mirrors src/agents/registry-instance.ts. The daemon registers its
// router at boot; tier-3 procedure code (channel.reply built-in
// action, MCP-exposed channel tools) reads it via getMessageRouter()
// to send outbound messages without going through HTTP or knowing
// which adapter implements the channel.
//
// Documented seam under the three-tier discipline rule — listed in
// test/tier-discipline.test.ts:DOCUMENTED_SEAMS. Reusing the router's
// dedupe + marker + identity-resolution + ledger-recording is exactly
// why this exists: agents that post via channel.reply get those for
// free; agents that bypass to raw curl don't, which is the bug the
// reimplementation is meant to retire.

let _router: MessageRouter | null = null

export function getMessageRouter(): MessageRouter | null {
  return _router
}

export function setMessageRouter(r: MessageRouter | null): void {
  _router = r
}

/** Test-only — clean slate between cases. */
export function resetMessageRouterForTesting(): void {
  _router = null
}
