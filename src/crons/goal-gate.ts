// --- A cron hangs off a goal (#1568 part 3) ---
//
// `crons.<id>.goal` names a goal record. Before each run the scheduler
// reads it: a goal that is done or dropped skips the run (the job's config
// is left alone; the Wall asks the owner whether to turn it off), and an
// active one puts its current state ahead of the prompt, so the prompt
// need not carry numbers that go stale. A goal id with no record on this
// node runs as before, with one line saying so.

export interface CronGoalView {
  /** active, done or dropped. */
  state: string
  /** The goal's state in a few lines, for the prompt. */
  brief: string
}

/** Reads a goal by id; null when this node has no record of it. */
export type CronGoalSource = (goalId: string) => CronGoalView | null

export interface CronGoalGate {
  /** Why the run is skipped, or null to run it. */
  skip: { state: string; why: string } | null
  /** What goes ahead of the prompt; empty for no goal. */
  brief: string
}

export function cronGoalGate(goalId: string | undefined, source: CronGoalSource | undefined): CronGoalGate {
  if (!goalId) return { skip: null, brief: "" }
  let view: CronGoalView | null = null
  try {
    view = source?.(goalId) ?? null
  } catch {
    view = null
  }
  if (!view) return { skip: null, brief: `[Goal] ${goalId}: no record of this goal on this node.` }
  if (view.state !== "active") return { skip: { state: view.state, why: `goal "${goalId}" is ${view.state}` }, brief: "" }
  return { skip: null, brief: view.brief }
}

/** The goal's state ahead of the job's own prompt. */
export function withGoalFirst(brief: string, prompt: string): string {
  return brief ? `${brief}\n\n${prompt}` : prompt
}
