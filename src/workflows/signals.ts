// --- Signal bus (in-memory) ---
//
// Process-to-process eventing for workflows. Any running daemon instance
// has one bus; `signal.emit` nodes post, `signal.wait` pauses subscribe
// via the dispatcher's resume-on-signal callback. Two scopes:
//
//   - workflow: a signal is only delivered to waiters in the same workflow
//     definition (workflowId). Default.
//   - global: delivered to every waiter matching name + match filter,
//     regardless of workflow.
//
// The bus is intentionally in-memory: signals fire now or never. Cross-
// node delivery (mesh) is Phase 3. Durable "signal log" is out of scope.

export interface SignalEmission {
  name: string
  scope: "workflow" | "global"
  workflowId: string
  payload: Record<string, unknown>
  emittedAt: string
}

export type SignalHandler = (emission: SignalEmission) => void | Promise<void>

export class SignalBus {
  private handlers: Set<SignalHandler> = new Set()

  subscribe(h: SignalHandler): () => void {
    this.handlers.add(h)
    return () => this.handlers.delete(h)
  }

  emit(emission: SignalEmission): void {
    for (const h of this.handlers) {
      try { void Promise.resolve(h(emission)).catch(() => {}) }
      catch { /* swallow — listeners must be robust */ }
    }
  }
}

/** Does a signal emission match a waiter's filter?
 *  - Name must match exactly.
 *  - If waiter scope is "workflow", the emission's workflowId must match
 *    the waiter's workflowId.
 *  - The match-record is shallow equality: every key in match must equal
 *    the emission's payload at that key. Empty match accepts anything. */
export function matchesSignal(
  waiter: { name: string; scope: "workflow" | "global"; workflowId: string; match: Record<string, unknown> },
  emission: SignalEmission,
): boolean {
  if (waiter.name !== emission.name) return false
  if (waiter.scope === "workflow" && waiter.workflowId !== emission.workflowId) return false
  for (const [k, v] of Object.entries(waiter.match ?? {})) {
    if (v === undefined || v === "" || v === "*") continue
    if ((emission.payload as Record<string, unknown>)[k] !== v) return false
  }
  return true
}
