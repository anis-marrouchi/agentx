import type Database from "better-sqlite3"
import { claimResume, recordResumeDecision, type InterruptedRun } from "@/storage/traces"
import type { RunOrigin } from "./origin"
import { buildResumeNote } from "./note"
import { planResume, type ResumePlan, type ResumeSettings } from "./policy"

// --- Carry out the resume plan, without letting it hurt the daemon ---
//
// The code that starts a kind of run registers a Resumer for it (the router
// for chat messages). The coordinator:
//   - runs after the daemon is fully up, one run at a time, spaced out;
//   - claims each run atomically before acting on it, so two boots on the
//     same database can't both resume it or both tell its chat;
//   - treats every run separately: an error is logged and recorded on that
//     run as resume-failed, and never reaches the caller;
//   - tells the run's chat what happened, or the operator when no chat can
//     be reached.

export interface Resumer {
  /** Re-enter the run with the note prepended. Resolves once the run has
   *  been handed over, not when it finishes. */
  resume(input: { origin: RunOrigin; run: InterruptedRun; note: string; attempt: number; rootId?: string }): Promise<void>
  /** One line to the chat the run came from. */
  tell?(origin: RunOrigin, text: string): Promise<void>
}

export interface ResumeOutcome {
  taskId: string
  agentId: string
  channel: string | null
  decision: "resumed" | "reported" | "skipped" | "resume-failed" | "already-claimed"
  reason: string
}

export const RESUMED_TEXT = "AgentX restarted while working on this. Picking it up again."
export function reportedText(reason: string): string {
  return `AgentX restarted while working on this, and it wasn't picked up again (${reason}). Send it again if you still need it.`
}

export class ResumeCoordinator {
  private resumers = new Map<RunOrigin["kind"], Resumer>()

  register(kind: RunOrigin["kind"], resumer: Resumer): void {
    this.resumers.set(kind, resumer)
  }

  async run(input: {
    db: Database.Database
    runs: InterruptedRun[]
    settings: ResumeSettings
    now: number
    boots: number[]
    /** One message for the operator, for runs no chat could be told about. */
    notifyOperator?: (text: string) => Promise<void>
    log: (msg: string) => void
    staggerMs?: number
    /** Runs another part of the daemon picks up itself (see planResume). */
    handledElsewhere?: (run: InterruptedRun) => string | null
  }): Promise<ResumeOutcome[]> {
    const outcomes: ResumeOutcome[] = []
    let plans: ResumePlan[] = []
    try {
      plans = planResume(input.runs, input.settings, { now: input.now, boots: input.boots, handledElsewhere: input.handledElsewhere })
    } catch (e: any) {
      input.log(`[resume] planning failed, nothing resumed: ${e?.message ?? e}`)
      return outcomes
    }
    const untold: string[] = []

    for (const plan of plans) {
      const { run } = plan
      const outcome = (decision: ResumeOutcome["decision"], reason: string) => {
        outcomes.push({ taskId: run.taskId, agentId: run.agentId, channel: run.channel, decision, reason })
        input.log(`[resume] ${run.agentId} ${run.channel ?? "-"} ${run.taskId}: ${decision} — ${reason}`)
      }
      try {
        // Claim before any action — skip, report or resume — so a second
        // process can't repeat it (or tell the chat twice).
        if (!claimResume(input.db, run.taskId)) {
          outcome("already-claimed", "another process claimed it")
          continue
        }
        if (plan.action === "skip") {
          recordResumeDecision(input.db, run.taskId, "skipped", plan.reason)
          outcome("skipped", plan.reason)
          continue
        }
        const report = async (origin: RunOrigin | null, reason: string) => {
          recordResumeDecision(input.db, run.taskId, "reported", reason)
          outcome("reported", reason)
          const told = origin ? await this.tell(origin, reportedText(reason), input.log) : false
          if (!told) untold.push(`- ${run.agentId} (${run.channel ?? "no channel"}): ${preview(run)} — ${reason}`)
        }
        if (plan.action === "report") {
          await report(plan.origin, plan.reason)
          continue
        }
        const resumer = this.resumers.get(plan.origin.kind)
        if (!resumer) {
          await report(plan.origin, `no resumer for "${plan.origin.kind}" runs`)
          continue
        }
        await this.tell(plan.origin, RESUMED_TEXT, input.log)
        await resumer.resume({ origin: plan.origin, run, note: buildResumeNote(run), attempt: run.resumeAttempt + 1 })
        recordResumeDecision(input.db, run.taskId, "resumed", plan.reason)
        outcome("resumed", plan.reason)
      } catch (e: any) {
        const reason = `resume failed: ${e?.message ?? e}`
        try { recordResumeDecision(input.db, run.taskId, "resume-failed", reason) } catch { /* db gone: logged below */ }
        outcome("resume-failed", reason)
        untold.push(`- ${run.agentId} (${run.channel ?? "no channel"}): ${preview(run)} — ${reason}`)
      }
      if (input.staggerMs) await new Promise((r) => setTimeout(r, input.staggerMs))
    }

    if (untold.length && input.notifyOperator) {
      const text = [`AgentX restarted and didn't resume ${untold.length} run(s):`, ...untold].join("\n")
      try { await input.notifyOperator(text) } catch (e: any) { input.log(`[resume] operator notice failed: ${e?.message ?? e}`) }
    }
    return outcomes
  }

  /** Re-enter one run outside the boot pass: a task a stop signal paused
   *  (agents/signals, #857). Same resumers as a restart, so the answer lands
   *  where a live one would. `rootId` keeps the run under its original root.
   *  Throws when no resumer handles the origin, or the resumer refuses. */
  async resumeOne(input: { origin: RunOrigin; run: InterruptedRun; note: string; rootId?: string }): Promise<void> {
    const resumer = this.resumers.get(input.origin.kind)
    if (!resumer) throw new Error(`no resumer for "${input.origin.kind}" runs`)
    // attempt 0: a stop is not a restart, so a restart that later cuts the
    // resumed run off may still resume it.
    await resumer.resume({ origin: input.origin, run: input.run, note: input.note, attempt: 0, rootId: input.rootId })
  }

  /** One line to the chat a run came from; false when there's no way to. */
  tellOrigin(origin: RunOrigin, text: string, log: (m: string) => void): Promise<boolean> {
    return this.tell(origin, text, log)
  }

  /** Tell the run's chat; false when there's no way to. Never throws. */
  private async tell(origin: RunOrigin, text: string, log: (m: string) => void): Promise<boolean> {
    const resumer = this.resumers.get(origin.kind)
    if (!resumer?.tell) return false
    try {
      await resumer.tell(origin, text)
      return true
    } catch (e: any) {
      log(`[resume] couldn't tell the chat: ${e?.message ?? e}`)
      return false
    }
  }
}

function preview(run: InterruptedRun): string {
  return (run.originalMessage ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "(no message recorded)"
}
