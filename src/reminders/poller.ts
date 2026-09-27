import { parseTrailer, type ReminderTrailer } from "./trailer"
import { pruneClaims, readClaims, writeClaims, type ClaimState } from "./store"
import type { Reminder, ReminderSource } from "./source"

// --- Hand due Apple Reminders back to the agent that created them ---
//
// Every poll, for each open reminder in the configured lists:
//   - no agentx trailer, or its agent isn't on this node → left alone, logged once;
//   - due → claimed in the store, dispatched to the agent, and ticked off
//     once the task is accepted (queued or started), not when it finishes;
//   - dispatch refused (budget cap, agent busy…) → left open, retried with backoff;
//   - overdue past `lookbackHours` with no record (the daemon was down) →
//     not run; the agent gets one message listing them.
// A claimed reminder is never dispatched again, even across restarts.

export interface ReminderSettings {
  lists: string[]
  pollSeconds: number
  lookbackHours: number
}

export type DispatchResult = { accepted: true } | { accepted: false; error: string }

export type ReminderEventType = "reminder:due" | "reminder:dispatched" | "reminder:skipped"

export interface PollerDeps {
  settings: ReminderSettings
  source: ReminderSource
  claimsPath: string
  hasAgent: (agentId: string) => boolean
  /** Hand a task to the agent. Resolves once it is accepted or refused. */
  dispatch: (input: { agentId: string; message: string; reminder?: Reminder; trailer?: ReminderTrailer }) => Promise<DispatchResult>
  publish?: (type: ReminderEventType, agentId: string | undefined, summary: string, reminderId: string) => void
  log: (msg: string) => void
  now?: () => number
}

const MAX_BACKOFF_MS = 60 * 60 * 1000

function utcMinute(iso: string | number): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC"
}

export function taskMessage(r: Reminder, t: ReminderTrailer): string {
  const lines = [`[Reminder due ${utcMinute(r.dueDate!)} · id ${r.id}]`, r.title]
  if (t.detail) lines.push("", t.detail)
  if (t.context) lines.push("", `Context: ${t.context} (your answer is delivered there).`)
  lines.push("", "The reminder is ticked off already; nothing else to do in Reminders.")
  return lines.join("\n")
}

export function staleMessage(items: Array<{ r: Reminder; t: ReminderTrailer }>, lookbackHours: number): string {
  return [
    "[Reminders overdue while AgentX was down]",
    `These fell due more than ${lookbackHours} h ago and were not run. They are still open in Reminders: do them now, reschedule them, or tick them off.`,
    ...items.map(({ r, t }) => `- ${r.title} (due ${utcMinute(r.dueDate!)}, id ${r.id}${t.context ? `, context ${t.context}` : ""})`),
  ].join("\n")
}

export class ReminderPoller {
  private logged = new Set<string>()
  private readonly now: () => number

  constructor(private deps: PollerDeps) {
    this.now = deps.now ?? Date.now
  }

  private logOnce(key: string, msg: string): boolean {
    if (this.logged.has(key)) return false
    this.logged.add(key)
    this.deps.log(msg)
    return true
  }

  private publish(type: ReminderEventType, agentId: string | undefined, summary: string, id: string): void {
    try { this.deps.publish?.(type, agentId, summary, id) } catch { /* observability never breaks the poll */ }
  }

  async poll(): Promise<void> {
    const { settings, source, claimsPath, log } = this.deps
    const now = this.now()
    let state: ClaimState = readClaims(claimsPath)
    const save = () => writeClaims(claimsPath, state)

    const open: Reminder[] = []
    for (const list of settings.lists) {
      try {
        open.push(...await source.listOpen(list))
      } catch (e: any) {
        this.logOnce(`list:${list}:${e?.message}`, `[reminders] can't read list "${list}": ${e?.message ?? e}`)
      }
    }

    const lookbackMs = settings.lookbackHours * 3_600_000
    const stale = new Map<string, Array<{ r: Reminder; t: ReminderTrailer }>>()

    for (const r of open) {
      const due = r.dueDate ? Date.parse(r.dueDate) : NaN
      if (!(due <= now)) continue
      const t = parseTrailer(r.notes)
      const skip = t ? (this.deps.hasAgent(t.agent) ? null : `agent "${t.agent}" is not on this node`) : "no agentx trailer"
      if (skip) {
        if (this.logOnce(`skip:${r.id}`, `[reminders] ${r.id} "${r.title}": skipped, ${skip}`)) {
          this.publish("reminder:skipped", t?.agent, `${r.title}: ${skip}`, r.id)
        }
        continue
      }
      const trailer = t!
      const rec = state[r.id]
      if (rec?.status === "reported") continue
      if (rec?.status === "claimed" || rec?.status === "done") {
        await this.tickOff(r, state, save, "handed over before; ticking it off")
        continue
      }
      if (rec?.status === "retry" && rec.nextAt && Date.parse(rec.nextAt) > now) continue
      if (!rec && due < now - lookbackMs) {
        const list = stale.get(trailer.agent) ?? []
        list.push({ r, t: trailer })
        stale.set(trailer.agent, list)
        continue
      }

      this.publish("reminder:due", trailer.agent, r.title, r.id)
      const attempts = (rec?.attempts ?? 0) + 1
      state[r.id] = { agent: trailer.agent, status: "claimed", at: new Date(now).toISOString(), attempts }
      save()
      const result = await this.dispatchSafely({ agentId: trailer.agent, message: taskMessage(r, trailer), reminder: r, trailer })
      if (result.accepted) {
        log(`[reminders] ${r.id} "${r.title}": dispatched to ${trailer.agent}`)
        this.publish("reminder:dispatched", trailer.agent, `${r.title} → ${trailer.agent}`, r.id)
        await this.tickOff(r, state, save, "done")
      } else {
        const delay = Math.min(settings.pollSeconds * 1000 * 2 ** (attempts - 1), MAX_BACKOFF_MS)
        state[r.id] = {
          agent: trailer.agent, status: "retry", at: new Date(now).toISOString(), attempts,
          nextAt: new Date(now + delay - 1000).toISOString(), error: result.error.slice(0, 300),
        }
        save()
        log(`[reminders] ${r.id} "${r.title}": dispatch to ${trailer.agent} refused (attempt ${attempts}), retrying in ${Math.round(delay / 1000)}s: ${result.error}`)
      }
    }

    for (const [agentId, items] of stale) {
      for (const { r } of items) log(`[reminders] ${r.id} "${r.title}": overdue past ${settings.lookbackHours} h, reporting to ${agentId} instead of running it`)
      const result = await this.dispatchSafely({ agentId, message: staleMessage(items, settings.lookbackHours) })
      if (!result.accepted) {
        log(`[reminders] overdue report to ${agentId} refused, trying again next poll: ${result.error}`)
        continue
      }
      for (const { r } of items) {
        state[r.id] = { agent: agentId, status: "reported", at: new Date(now).toISOString() }
        this.publish("reminder:skipped", agentId, `${r.title}: overdue past ${settings.lookbackHours} h, reported`, r.id)
      }
      save()
    }

    state = pruneClaims(state, new Set(open.map((r) => r.id)), now)
    save()
  }

  private async dispatchSafely(input: Parameters<PollerDeps["dispatch"]>[0]): Promise<DispatchResult> {
    try {
      return await this.deps.dispatch(input)
    } catch (e: any) {
      return { accepted: false, error: e?.message ?? String(e) }
    }
  }

  /** Tick it off; on failure it stays claimed and the next poll tries again. */
  private async tickOff(r: Reminder, state: ClaimState, save: () => void, why: string): Promise<void> {
    try {
      await this.deps.source.complete(r.id)
      state[r.id] = { ...state[r.id], status: "done", at: new Date(this.now()).toISOString() }
      save()
      this.deps.log(`[reminders] ${r.id} ticked off (${why})`)
    } catch (e: any) {
      this.logOnce(`complete:${r.id}`, `[reminders] ${r.id} couldn't be ticked off, will retry: ${e?.message ?? e}`)
    }
  }
}
