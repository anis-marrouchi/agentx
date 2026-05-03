// --- Per-workflow-node concurrency gate ---
//
// Caps how many simultaneous executions a single node ID can have across
// concurrent workflow runs. Without this, N runs of the same workflow can
// each fan a hot node (e.g. agent invocations) at once, multiplying token
// spend and overwhelming downstream agents.
//
// Scope is `${workflowId}:${nodeId}` — different nodes don't share the
// budget; different workflows that happen to use the same node id stay
// independent.
//
// Used by `agentHandler` in nodes/handlers.ts. Activated only when the
// node config sets `maxConcurrent`. Without that field the gate no-ops.

interface Waiter {
  resolve: () => void
}

class NodeConcurrencyGate {
  private active: Map<string, number> = new Map()
  private waiters: Map<string, Waiter[]> = new Map()

  /** Acquire a slot. Resolves immediately if under cap; otherwise queues
   *  in FIFO order behind earlier waiters. The caller must invoke
   *  `release(key)` exactly once per acquire (use a try/finally). */
  async acquire(key: string, max: number): Promise<void> {
    const cur = this.active.get(key) ?? 0
    if (cur < max) {
      this.active.set(key, cur + 1)
      return
    }
    return new Promise<void>((resolve) => {
      const queue = this.waiters.get(key) ?? []
      queue.push({
        resolve: () => {
          this.active.set(key, (this.active.get(key) ?? 0) + 1)
          resolve()
        },
      })
      this.waiters.set(key, queue)
    })
  }

  release(key: string): void {
    const cur = this.active.get(key) ?? 0
    this.active.set(key, Math.max(0, cur - 1))
    const queue = this.waiters.get(key)
    if (queue && queue.length > 0) {
      const next = queue.shift()!
      next.resolve()
    }
  }

  /** For tests / observability. */
  stats(key: string): { active: number; waiting: number } {
    return {
      active: this.active.get(key) ?? 0,
      waiting: this.waiters.get(key)?.length ?? 0,
    }
  }
}

/** Process-singleton — workflow nodes share the same gate. */
export const nodeConcurrencyGate = new NodeConcurrencyGate()

export function nodeKey(workflowId: string, nodeId: string): string {
  return `${workflowId}:${nodeId}`
}
