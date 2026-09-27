import { getEventBus } from "@/events/bus"
import type { AgentResponse, AgentTask } from "@/agents/runtime"
import { ReminderPoller, type DispatchResult, type ReminderSettings } from "./poller"
import { remindctlSource, type ReminderSource } from "./source"
import { claimFile } from "./store"
import { splitContext } from "./trailer"

// --- Daemon wiring for the reminders poller ---
//
// A task counts as accepted at its first stream event (it started), or when
// it has neither started nor been refused after ACCEPT_AFTER_MS (it's
// queued). A run that ends in an error before either is a refusal (budget
// cap, overage gate, unknown agent) and the reminder stays open.
//
// The agent's answer goes to the trailer's context when that names a
// connected channel ("telegram:<chatId>"), otherwise to
// notifications.destination, otherwise it stays in the agent's session.

const ACCEPT_AFTER_MS = 30_000

// Shared by every poller in the process: a config reload starts a new one
// while the old one may still be mid-poll, and two polls reading the claims
// file at once could both hand over the same reminder.
let polling = false

type Destination = { channel: string; chatId: string; accountId?: string }

export interface RemindersDaemonDeps {
  settings: ReminderSettings & { enabled: boolean; command: string }
  root: string
  execute: (task: AgentTask, onDelta?: undefined, onThinking?: undefined, onEvent?: (e: unknown) => void) => Promise<AgentResponse>
  hasAgent: (agentId: string) => boolean
  send: (msg: Destination & { text: string; agentId?: string }) => Promise<unknown>
  fallbackDestination?: Destination
  isStopping: () => boolean
  log: (msg: string) => void
  platform?: NodeJS.Platform
  /** Tests: stands in for remindctl. */
  source?: ReminderSource
}

/** Start polling; returns a stop function, or null when disabled or unavailable. */
export function startRemindersPoller(deps: RemindersDaemonDeps): (() => void) | null {
  const { settings, log } = deps
  if (!settings.enabled) return null
  if ((deps.platform ?? process.platform) !== "darwin") {
    log("[reminders] reminders.enabled is set, but Apple Reminders is only available on macOS; not polling")
    return null
  }

  const deliver = async (context: string | undefined, agentId: string, res: AgentResponse, ref: string) => {
    const text = res.error ? `Reminder task on ${agentId} failed: ${res.error}` : res.content?.trim()
    if (!text) return
    const target = splitContext(context)
    if (target) {
      try {
        await deps.send({ ...target, text, agentId })
        return
      } catch (e: any) {
        log(`[reminders] ${ref}: couldn't deliver to ${context}: ${e?.message ?? e}`)
      }
    }
    if (!deps.fallbackDestination) {
      log(`[reminders] ${ref}: no deliverable context and no notifications.destination; answer stays in ${agentId}'s session`)
      return
    }
    try {
      await deps.send({ ...deps.fallbackDestination, text, agentId })
    } catch (e: any) {
      log(`[reminders] ${ref}: couldn't deliver to notifications.destination: ${e?.message ?? e}`)
    }
  }

  const poller = new ReminderPoller({
    settings,
    source: deps.source ?? remindctlSource(settings.command),
    claimsPath: claimFile(deps.root),
    hasAgent: deps.hasAgent,
    log,
    publish: (type, agentId, summary, ref) => {
      getEventBus().publish({ kind: "reminder", type, agentId, summary, ref })
    },
    dispatch: ({ agentId, message, reminder, trailer }) => new Promise<DispatchResult>((resolve) => {
      const ref = reminder?.id ?? "overdue report"
      let settled = false
      const settle = (r: DispatchResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => settle({ accepted: true }), ACCEPT_AFTER_MS)
      timer.unref?.()
      deps.execute(
        { agentId, message, context: { channel: "reminder", chatId: `reminder:${ref}`, sender: "reminders" } },
        undefined, undefined, () => settle({ accepted: true }),
      ).then((res) => {
        if (!settled) {
          settle(res.error ? { accepted: false, error: res.error } : { accepted: true })
          if (res.error) return
        }
        return deliver(trailer?.context, agentId, res, ref)
      }).catch((e: any) => {
        if (!settled) settle({ accepted: false, error: e?.message ?? String(e) })
        else log(`[reminders] ${ref}: run on ${agentId} failed: ${e?.message ?? e}`)
      })
    }),
  })

  const tick = async () => {
    if (polling || deps.isStopping()) return
    polling = true
    try {
      await poller.poll()
    } catch (e: any) {
      log(`[reminders] poll failed: ${e?.message ?? e}`)
    } finally {
      polling = false
    }
  }
  log(`[reminders] watching ${settings.lists.join(", ")} every ${settings.pollSeconds}s`)
  const interval = setInterval(() => { void tick() }, settings.pollSeconds * 1000)
  interval.unref?.()
  void tick()
  return () => clearInterval(interval)
}
