// --- A daemon-started run that waits for a slot instead of being queued ---
//
// A run the daemon starts and awaits itself (a schedule's goal-check wake,
// #863) must wait for a free slot when its agent is busy. If it were
// queued, execute() would return at once, the daemon would read that as
// "the turn ended", and act on a turn that never ran. The mark is a symbol
// key, so a caller of /task cannot set it from a JSON body.

const AWAIT_SLOT = Symbol("agents.awaitSlot")

/** Marks `ctx` as the context of a run that waits for a slot. */
export function markAwaitSlot<T extends object>(ctx: T): T {
  return Object.assign(ctx, { [AWAIT_SLOT]: true })
}

/** Whether this run was marked to wait for a slot. */
export function awaitsSlot(ctx: object | undefined | null): boolean {
  return !!ctx && (ctx as Record<symbol, unknown>)[AWAIT_SLOT] === true
}
