import type { SituationsConfig } from "./config"
import type { SituationRow, SituationStore } from "./store"
import type { SituationWorkflowsState } from "./workflows"
import { quoted, situationTemplate } from "./templates"

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
// every open talk with closing steps, and a missing close for a talk with
// closing steps that ended in the last RECOVER_CLOSE_MS (the daemon was
// down when it ended).
//
// Only the record starts these two workflows: `situationStartGuard`, given
// to the dispatcher, refuses a run of them started by anyone else (an
// agent's agentx_workflow, a manual run), so no one can feed them inputs.

export const CLOSE_WORKFLOW = "situation-close"
export const EXPIRY_WORKFLOW = "situation-expiry"
/** Who starts them: the run's `meta.startedBy`. */
export const SITUATION_STARTER = "situation"
/** A close missed while the daemon was down is started at start only for
 *  an end this recent. */
export const RECOVER_CLOSE_MS = 24 * 3600_000

/** The dispatcher's start guard: the two situation workflows run only when
 *  the situation record starts them. Null: allowed. */
export function situationStartGuard(workflowId: string, meta: { startedBy?: unknown } | undefined): string | null {
  if (workflowId !== CLOSE_WORKFLOW && workflowId !== EXPIRY_WORKFLOW) return null
  if (meta?.startedBy === SITUATION_STARTER) return null
  return `workflow "${workflowId}" is started only by the situation record (agentx situation closing), not by hand or by an agent`
}

/** The talk's purpose as a person reads it (owner message, run title).
 *  Words the agent named (phase 6) are quoted and marked as its own. */
function purposeOf(row: SituationRow): string {
  const c = row.closing
  if (!c) return row.template
  return c.setBy === "agent" ? `${quoted(c.purpose, 200)} (as the agent named it)` : c.purpose
}

const TITLE_MAX = 80

/** The run's title (Workflows page, the owner's send card). Words the
 *  agent named: the label first, then the quote, cut inside the quotes so
 *  the label and the closing quote always survive the length cap. */
function runTitle(prefix: string, row: SituationRow): string {
  const c = row.closing
  if (c?.setBy === "agent") {
    const head = `${prefix} (named by the agent): `
    return head + quoted(c.purpose, TITLE_MAX - head.length - 2)
  }
  return `${prefix}: ${c?.purpose ?? row.template}`.slice(0, TITLE_MAX)
}

interface Dispatcher {
  startRun(args: { workflowId: string; inputs?: Record<string, unknown>; meta?: Record<string, unknown>; entityRef?: { backend: string; id: string } }): Promise<{ run: { id: string } | null; error?: string }>
  cancelRun(runId: string, reason?: string): Promise<boolean>
}

export interface SituationRunsDeps {
  store: SituationStore
  settings: () => SituationsConfig
  /** Null until the workflow engine has started. */
  dispatcher: () => Dispatcher | null
  /** Installs the two workflows when they are missing, and says which do
   *  not load or were deleted (workflows.ts). */
  ensureWorkflows?: () => SituationWorkflowsState | void
  /** Is this a known agent of this node? The close's agent must be. */
  isAgent?: (id: string) => boolean
  /** A run's status, or null when there is no such run. */
  runStatus: (runId: string) => string | null
  log: (m: string) => void
}

const LIVE = new Set(["running", "paused"])

export class SituationRuns {
  private chain: Promise<void> = Promise.resolve()
  /** Problems already logged, so each is logged once until it clears. */
  private readonly told = new Set<string>()

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
    let closes = 0
    await this.enqueue(async () => {
      if (!this.on()) return
      for (const row of this.deps.store.openWithClosing()) {
        if (row.expiryRunId && LIVE.has(this.deps.runStatus(row.expiryRunId) ?? "")) continue
        if (await this.startExpiry(row)) started++
      }
      // L5: a close missed while the daemon was down (recent ends only).
      for (const row of this.deps.store.endedWithClosing(Date.now() - RECOVER_CLOSE_MS)) {
        if (row.setBy === "peer" || row.closeGeneration === row.endGeneration) continue
        if (await this.startClose(row)) closes++
      }
    })
    if (started) this.deps.log(`[situation] restarted ${started} expiry run(s) of open talks`)
    if (closes) this.deps.log(`[situation] started ${closes} close run(s) missed while the daemon was down`)
    return started + closes
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
      await this.cancel(row.closeRunId, "situation cleared")
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
    let state: SituationWorkflowsState | void = undefined
    try { state = this.deps.ensureWorkflows?.() } catch (e: any) { this.deps.log(`[situation] installing ${workflowId} failed: ${e?.message ?? e}`) }
    // M1: the owner's file is never overwritten. A broken or deleted
    // workflow stops its runs, said once in the log.
    const broken = state?.broken.find((b) => b.id === workflowId)
    const problem = broken ? `${workflowId} does not load: ${broken.why}; no ${workflowId} run starts until it is fixed`
      : state?.deleted.includes(workflowId) ? `${workflowId} was deleted from the workflow folder; no ${workflowId} run starts (it is not written again)` : null
    if (problem) {
      if (!this.told.has(problem)) { this.told.add(problem); this.deps.log(`[situation] ${problem}`) }
      return null
    }
    for (const t of [...this.told]) if (t.startsWith(`${workflowId} `)) this.told.delete(t)
    const r = await d.startRun({
      workflowId, inputs,
      entityRef: { backend: "situation", id: entity },
      meta: { startedBy: SITUATION_STARTER, followUp: false, title: runTitle(workflowId === CLOSE_WORKFLOW ? "Close" : "Max age", row), tags: [`situation:${row.id}`] },
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

  private async startClose(row: SituationRow): Promise<boolean> {
    const c = row.closing!
    const [channel, account, ...chat] = row.key.split("|")
    const agent = c.agent || row.ownerAgent
    if (!agent) { this.deps.log(`[situation] ${row.id}: no agent to write the closing note; close not started`); return false }
    if (this.deps.isAgent && !this.deps.isAgent(agent)) { this.deps.log(`[situation] ${row.id}: "${agent}" is not an agent of this node; close not started`); return false }
    // Phase 6: the template's guidance for the note (templates on), and
    // the agent's own words marked as such where the owner reads them.
    const s = this.deps.settings()
    const tpl = s.templates?.enabled ? situationTemplate(row.template) : null
    const purpose = purposeOf(row)
    const runId = await this.start(CLOSE_WORKFLOW, row, {
      situationId: row.id, endGeneration: row.endGeneration, reason: row.endReason ?? "closed",
      inwardOnly: row.endReason === "stale" ? "yes" : "no",
      agent, purpose, home: c.home,
      // With its leading space: the prompt reads "the talk.{{guidance}}".
      guidance: tpl?.noteGuidance ? ` ${tpl.noteGuidance}` : "",
      channel, chatId: c.chatId || chat.join("|"),
      ...(account && account !== "*" && account !== "default" ? { accountId: account } : {}),
      ...(c.message ? { message: c.message } : {}),
    }, `${row.id}:close:${row.endGeneration}`)
    if (!runId) return false
    if (!this.deps.store.setCloseRun(row.id, row.endGeneration, runId)) {
      await this.cancel(runId, "a close for this end already runs, or the talk reopened")
      return false
    }
    return true
  }

  private async cancel(runId: string | null | undefined, reason: string): Promise<void> {
    if (!runId) return
    if (!LIVE.has(this.deps.runStatus(runId) ?? "")) return
    try { await this.deps.dispatcher()?.cancelRun(runId, reason) } catch (e: any) { this.deps.log(`[situation] cancel ${runId} failed: ${e?.message ?? e}`) }
  }
}
