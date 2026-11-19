import type { SituationsConfig } from "./config"
import type { SituationRow, SituationStore } from "./store"

// --- The store starts and cancels its two workflow runs (#1892, phase 4) ---
//
// Design 3.4 (N1, S3, S13, S14). After every committed change of a talk
// that has closing steps, the store (through this part, attached with
// `store.onChange`) does, in this order:
//
//   1. the change itself is already written (the end generation first);
//   2. startRun of `situation-expiry` for the new phase (not for `ended`),
//      or of `situation-close` for a change into `ended`;
//   3. stores the run id with a conditional write: the expiry run only for
//      the phase it was started for, the close only once per end
//      generation. A write that matches no row cancels the new run;
//   4. cancels the run it replaces: the old expiry run, or on a reopen the
//      close run of the old generation. A close step already past the
//      cancel is stopped by the generation check on each message (S7).
//
// No hook, cron or poll: the expiry is a paused workflow run (timer), and
// both runs show on the Workflows page. The runs are started without a
// follow-up summary (`followUp: false`): the close's own owner message is
// the one message, and the expiry has nothing to tell.
//
// What starts nothing:
//   - `situations.closing.enabled` false (the default);
//   - a talk with no closing steps: phases 1 to 3 are unchanged, a plain
//     conversation is still ended lazily by the gate at its next message;
//   - an end another organisation's agent reported (`setBy: "peer"`,
//     owner's answer to Q4): it may only make ours go quiet, never act.
// A stale end starts the close with `inwardOnly: yes`: notes and promises,
// no owner message, nothing outward (3.4, "Stale owner").
//
// S14: at daemon start, `resumeOnStart` starts a missing expiry run for
// every open talk with closing steps.

export const CLOSE_WORKFLOW = "situation-close"
export const EXPIRY_WORKFLOW = "situation-expiry"

interface Dispatcher {
  startRun(args: { workflowId: string; inputs?: Record<string, unknown>; meta?: Record<string, unknown>; entityRef?: { backend: string; id: string } }): Promise<{ run: { id: string } | null; error?: string }>
  cancelRun(runId: string, reason?: string): Promise<boolean>
}

export interface SituationRunsDeps {
  store: SituationStore
  settings: () => SituationsConfig
  /** Null until the workflow engine has started. */
  dispatcher: () => Dispatcher | null
  /** Installs the two workflows when they are missing (workflows.ts). */
  ensureWorkflows?: () => void
  /** A run's status, or null when there is no such run. */
  runStatus: (runId: string) => string | null
  log: (m: string) => void
}

const LIVE = new Set(["running", "paused"])

export class SituationRuns {
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: SituationRunsDeps) {}

  /** Listen to the store's committed changes. */
  attach(): void {
    this.deps.store.onChange((c) => this.enqueue(() => this.changed(c.row, c.from, c.cleared)))
  }

  detach(): void {
    this.deps.store.onChange(null)
  }

  /** Resolves when every change seen so far has been handled. */
  idle(): Promise<void> {
    return this.chain
  }

  /** S14: an open talk with closing steps and no live expiry run gets one. */
  async resumeOnStart(): Promise<number> {
    let started = 0
    await this.enqueue(async () => {
      if (!this.on()) return
      for (const row of this.deps.store.openWithClosing()) {
        if (row.expiryRunId && LIVE.has(this.deps.runStatus(row.expiryRunId) ?? "")) continue
        if (await this.startExpiry(row)) started++
      }
    })
    if (started) this.deps.log(`[situation] restarted ${started} expiry run(s) of open talks`)
    return started
  }

  private on(): boolean {
    try { return this.deps.settings().closing?.enabled === true && this.deps.settings().mode !== "off" } catch { return false }
  }

  /** One change at a time, in the order they were committed. Never rejects. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn).catch((e: any) => this.deps.log(`[situation] closing runs: ${e?.message ?? e}`))
    return this.chain
  }

  private async changed(row: SituationRow, from: SituationRow["phase"] | null, cleared: boolean): Promise<void> {
    if (!this.on()) return
    if (cleared) {
      await this.cancel(row.expiryRunId, "situation cleared")
      if (row.phase !== "ended") await this.cancel(row.closeRunId, "situation cleared")
      return
    }
    const now = this.deps.store.getById(row.id)
    // The phase moved again since this change: the next change starts its runs.
    if (!now || now.phaseChangedAt !== row.phaseChangedAt || now.phase !== row.phase) return
    // Closing steps count for a change only when the talk had them when the
    // change was written (`row`, the record at the commit) and still has
    // them: steps given later have a change of their own.
    if (!row.closing || !now.closing) {
      if (!now.closing) await this.cancel(now.expiryRunId, "closing steps removed")
      return
    }
    // A close of an older end generation never goes on (the talk reopened
    // since; a reopen change the queue skipped is caught here).
    if (now.closeRunId && now.closeGeneration !== now.endGeneration) await this.cancel(now.closeRunId, "situation reopened")
    if (now.phase === "ended") {
      await this.cancel(now.expiryRunId, "situation ended")
      // Closing steps given to a talk that had already ended: they are for
      // its next end, not this one.
      if (from === "ended") return
      if (now.setBy === "peer") {
        this.deps.log(`[situation] ${now.id}: ended by a peer's word; no closing steps (a peer may only make us quiet)`)
        return
      }
      if (now.closeGeneration !== now.endGeneration) await this.startClose(now)
      return
    }
    // A change that kept the phase (closing steps set) keeps a live run.
    if (from === now.phase && now.expiryRunId && LIVE.has(this.deps.runStatus(now.expiryRunId) ?? "")) return
    await this.startExpiry(now)
  }

  private async start(workflowId: string, row: SituationRow, inputs: Record<string, unknown>, entity: string): Promise<string | null> {
    const d = this.deps.dispatcher()
    if (!d) { this.deps.log(`[situation] ${row.id}: no workflow engine yet; ${workflowId} not started`); return null }
    try { this.deps.ensureWorkflows?.() } catch (e: any) { this.deps.log(`[situation] installing ${workflowId} failed: ${e?.message ?? e}`) }
    const r = await d.startRun({
      workflowId, inputs,
      entityRef: { backend: "situation", id: entity },
      meta: { startedBy: "situation", followUp: false, title: `${workflowId === CLOSE_WORKFLOW ? "Close" : "Max age"}: ${row.closing?.purpose ?? row.template}`.slice(0, 80), tags: [`situation:${row.id}`] },
    })
    if (!r.run) { this.deps.log(`[situation] ${row.id}: ${workflowId} not started: ${r.error ?? "unknown error"}`); return null }
    return r.run.id
  }

  private async startExpiry(row: SituationRow): Promise<boolean> {
    const s = this.deps.settings()
    const minutes = row.phase === "ending" ? s.maxAge.endingMinutes : s.maxAge.duringHours * 60
    const runId = await this.start(EXPIRY_WORKFLOW, row, {
      situationId: row.id, phaseChangedAt: row.phaseChangedAt, after: `PT${Math.max(1, Math.round(minutes))}M`,
    }, `${row.id}:expiry:${row.phaseChangedAt}`)
    if (!runId) return false
    const before = this.deps.store.getById(row.id)?.expiryRunId ?? null
    if (!this.deps.store.setExpiryRun(row.id, row.phaseChangedAt, runId)) {
      await this.cancel(runId, "situation phase changed meanwhile")
      return false
    }
    if (before && before !== runId) await this.cancel(before, "situation phase changed")
    return true
  }

  private async startClose(row: SituationRow): Promise<void> {
    const c = row.closing!
    const [channel, account, ...chat] = row.key.split("|")
    const agent = c.agent || row.ownerAgent
    if (!agent) { this.deps.log(`[situation] ${row.id}: no agent to write the closing note; close not started`); return }
    const runId = await this.start(CLOSE_WORKFLOW, row, {
      situationId: row.id, endGeneration: row.endGeneration, reason: row.endReason ?? "closed",
      inwardOnly: row.endReason === "stale" ? "yes" : "no",
      agent, purpose: c.purpose, home: c.home,
      channel, chatId: c.chatId || chat.join("|"),
      ...(account && account !== "*" && account !== "default" ? { accountId: account } : {}),
      ...(c.message ? { message: c.message } : {}),
    }, `${row.id}:close:${row.endGeneration}`)
    if (!runId) return
    if (!this.deps.store.setCloseRun(row.id, row.endGeneration, runId)) await this.cancel(runId, "a close for this end already runs, or the talk reopened")
  }

  private async cancel(runId: string | null | undefined, reason: string): Promise<void> {
    if (!runId) return
    if (!LIVE.has(this.deps.runStatus(runId) ?? "")) return
    try { await this.deps.dispatcher()?.cancelRun(runId, reason) } catch (e: any) { this.deps.log(`[situation] cancel ${runId} failed: ${e?.message ?? e}`) }
  }
}
