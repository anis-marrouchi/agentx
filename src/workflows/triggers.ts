import { getNextCronDate } from "@/crons/scheduler"
import type { WorkflowDispatcher } from "./dispatcher"
import type { WorkflowStore } from "./store"
import type { HookEvent } from "@/hooks/types"
import type { HookRegistry } from "@/hooks"

// --- Trigger wiring for Phase 3 ---
//
// Workflows with `trigger.cron` or `trigger.hook` nodes don't map to
// channel events, so the regular hook subscribers in hooks.ts don't fire
// them. This module wires those two sources:
//
//   - trigger.cron: compute next fire time via getNextCronDate + chain
//     setTimeout. On fire, call dispatcher with a synthetic trigger event.
//     Each workflow gets its own timer loop; rescheduled on every fire.
//
//   - trigger.hook: register a HookRegistry handler on whichever on:* event
//     the trigger node configures. On fire, map the hook context payload
//     directly into a trigger event.
//
// Called once from daemon boot after the dispatcher is constructed. Teardown
// isn't wired for v1 — daemon restart clears timers.

export interface CronTriggerOptions {
  workflowId: string
  triggerNodeId: string
  spec: string
  timezone: string
}

export function startWorkflowTriggers(args: {
  store: WorkflowStore
  dispatcher: WorkflowDispatcher
  hooks: HookRegistry
  log: (msg: string) => void
}): { cronTimers: number; hookSubscribers: number } {
  const workflows = args.store.list()
  let cronTimers = 0
  let hookSubscribers = 0

  for (const wf of workflows) {
    // Lifecycle gate: don't register triggers for non-active workflows. A
    // disabled or quarantined workflow's cron must not fire and its
    // trigger.hook subscribers must not run. State changes that flip a
    // workflow back to `active` re-run this registrar.
    if (wf.state && wf.state !== "active") {
      args.log(`[workflows] ${wf.id} state=${wf.state} — skipping trigger registration`)
      continue
    }
    const trigger = wf.nodes.find((n) => n.type.startsWith("trigger."))
    if (!trigger) continue

    if (trigger.type === "trigger.cron") {
      const cfg = trigger.config as { spec?: string; timezone?: string }
      if (!cfg.spec) { args.log(`[workflows] ${wf.id} trigger.cron missing config.spec — skipping`); continue }
      scheduleCron({
        workflowId: wf.id,
        triggerNodeId: trigger.id,
        spec: cfg.spec,
        timezone: cfg.timezone ?? "UTC",
      }, args.dispatcher, args.log)
      cronTimers++
    } else if (trigger.type === "trigger.hook") {
      const cfg = trigger.config as {
        event?: string
        passthrough?: boolean
        filter?: {
          /** Restrict to specific actions (gitlab-issue / gitlab-mr).
           *  Example: ["open", "reopen"] keeps the workflow off update/close events. */
          action?: string[]
          /** Restrict on:gitlab-note to comments that @-mention at least one of
           *  these usernames. Without this, every note on the project fires the
           *  workflow — including ones that don't address any agent. Match is
           *  case-insensitive on the bare username (no leading @). */
          mentions?: string[]
          /** Fire only when one of these usernames was newly added as an
           *  assignee. The adapter computes the diff from
           *  `changes.assignees.{previous,current}` and exposes it as
           *  `ctx.assigneesAdded`. Lets a "coder-pickup" workflow target the
           *  moment a coder is assigned without the workflow needing to
           *  re-derive the diff in its prompt. Username comparison is
           *  case-insensitive, leading @ stripped. */
          assigneesAdded?: string[]
          /** Same shape, for MR reviewers. `ctx.reviewersAdded`. */
          reviewersAdded?: string[]
          /** Fire only when one of these labels was newly added on an
           *  update event. The adapter computes the diff from
           *  `changes.labels.{previous,current}` and exposes it as
           *  `ctx.labelsAdded`. Labels are matched case-insensitive. */
          labelsAdded?: string[]
        }
      }
      if (!cfg.event || !cfg.event.startsWith("on:")) {
        args.log(`[workflows] ${wf.id} trigger.hook config.event must start with "on:" — skipping`)
        continue
      }
      args.hooks.registerHandler(cfg.event as HookEvent, `workflows:${wf.id}`, async (ctx) => {
        try {
          // Project-scope gate. The hook subscriber is registered per-workflow,
          // so we go direct (skipping matchByTrigger) — but the workflow's
          // top-level `project:` still has to be honored, otherwise an
          // on:gitlab-issue from project A reaches every workflow tagged
          // for project B. matchByTrigger has the same gate; this is the
          // companion check on the per-workflow hook path.
          const ctxProject = typeof ctx.project === "string" ? ctx.project : undefined
          if (wf.project && ctxProject && wf.project !== ctxProject) return {}
          // Trigger-level filters. These move the "ONLY ACT when …; exit
          // cleanly otherwise" prompt-level guard up to the dispatch gate,
          // which means the agent isn't woken up + billed for a turn just
          // to print "exit cleanly".
          if (cfg.filter) {
            // filter.action — gitlab-issue / gitlab-mr action gate.
            if (Array.isArray(cfg.filter.action) && cfg.filter.action.length > 0) {
              const action = typeof ctx.action === "string" ? ctx.action : undefined
              if (!action || !cfg.filter.action.includes(action)) return {}
            }
            // filter.mentions — gitlab-note mention gate. Without this, the
            // workflow's hard-coded `agentId` runs no matter who the comment
            // @-mentioned, so e.g. ksi-mr-fix-loop spawns ksi-v2 even on a
            // comment addressed @pm-ksi. The legacy @-mention resolver still
            // routes those to the right agent on the second pass when the
            // workflow doesn't claim the event.
            if (Array.isArray(cfg.filter.mentions) && cfg.filter.mentions.length > 0) {
              const ctxMentions = Array.isArray(ctx.mentions)
                ? (ctx.mentions as string[]).map((m) => m.toLowerCase().replace(/^@/, ""))
                : []
              const wanted = cfg.filter.mentions.map((m) => m.toLowerCase().replace(/^@/, ""))
              const hit = wanted.some((w) => ctxMentions.includes(w))
              if (!hit) return {}
            }
            // filter.assigneesAdded — coder-pickup-style trigger. Fires only
            // when one of the listed usernames appears in ctx.assigneesAdded
            // (computed by the gitlab adapter from changes.assignees diff).
            if (Array.isArray(cfg.filter.assigneesAdded) && cfg.filter.assigneesAdded.length > 0) {
              const ctxAdded = Array.isArray(ctx.assigneesAdded)
                ? (ctx.assigneesAdded as string[]).map((u) => u.toLowerCase().replace(/^@/, ""))
                : []
              const wanted = cfg.filter.assigneesAdded.map((u) => u.toLowerCase().replace(/^@/, ""))
              const hit = wanted.some((w) => ctxAdded.includes(w))
              if (!hit) return {}
            }
            // filter.reviewersAdded — MR review-on-assignment trigger.
            if (Array.isArray(cfg.filter.reviewersAdded) && cfg.filter.reviewersAdded.length > 0) {
              const ctxAdded = Array.isArray(ctx.reviewersAdded)
                ? (ctx.reviewersAdded as string[]).map((u) => u.toLowerCase().replace(/^@/, ""))
                : []
              const wanted = cfg.filter.reviewersAdded.map((u) => u.toLowerCase().replace(/^@/, ""))
              const hit = wanted.some((w) => ctxAdded.includes(w))
              if (!hit) return {}
            }
            // filter.labelsAdded — fires when a specific label was added on
            // an update event. Useful for "Blocked"-label workflows.
            if (Array.isArray(cfg.filter.labelsAdded) && cfg.filter.labelsAdded.length > 0) {
              const ctxAdded = Array.isArray(ctx.labelsAdded)
                ? (ctx.labelsAdded as string[]).map((l) => l.toLowerCase())
                : []
              const wanted = cfg.filter.labelsAdded.map((l) => l.toLowerCase())
              const hit = wanted.some((w) => ctxAdded.includes(w))
              if (!hit) return {}
            }
          }
          // Go direct: this hook subscriber is registered per-workflow,
          // so we already know which workflow to fire. Going through
          // dispatch() + matchByTrigger() would drop the event unless the
          // workflow's trigger.hook node had a matching `source` field —
          // which users don't set (the event IS the filter).
          const entityId = entityKeyFromHookContext(wf.id, cfg.event!, ctx)
          await args.dispatcher.dispatchWorkflow({
            workflowId: wf.id,
            entityRef: { backend: "hook", id: entityId },
            event: {
              id: `hook:${cfg.event}:${Date.now().toString(36)}`,
              payload: { hookEvent: cfg.event, ...ctx },
            },
          })
          // Signal claim. When a workflow claims a project-scoped event,
          // the GitLab adapter (and other future adapters) must suppress
          // their legacy "@-mention dispatch" / "default-route dispatch"
          // path — otherwise the same agent gets spawned twice for one
          // event (once via the workflow run, once via the legacy
          // resolver). Read from `combinedModified.__workflowClaimed`
          // already accumulated by earlier per-workflow handlers; append
          // this workflow's id.
          // Opt-out: `trigger.config.passthrough = true` — the workflow is
          // observability-only and the legacy reply should still fire.
          if (cfg.passthrough) return {}
          const prevClaimed = (ctx as { __workflowClaimed?: unknown }).__workflowClaimed
          const claimedList = Array.isArray(prevClaimed) ? (prevClaimed as string[]) : []
          return { modified: { __workflowClaimed: [...claimedList, wf.id] } }
        } catch (e: any) {
          args.log(`[workflows] ${wf.id} hook dispatch failed: ${e.message}`)
          return {}
        }
      }, 60)
      hookSubscribers++
    }
  }

  return { cronTimers, hookSubscribers }
}

/** Derive a per-event entity id for a hook fire. Two unrelated issues
 *  (or MRs, or messages) MUST resolve to different entities — otherwise
 *  the second one collides with the first's paused/running run and
 *  either gets dropped or hijacks the paused state. Falls back to a
 *  per-fire unique id so unknown hook shapes never silently collide. */
function entityKeyFromHookContext(workflowId: string, event: string, ctx: Record<string, unknown>): string {
  const project = typeof ctx.project === "string" ? ctx.project : ""
  const iid = ctx.iid != null ? String(ctx.iid) : ""
  if (event === "on:gitlab-issue" && project && iid) return `${workflowId}:${event}:${project}#${iid}`
  if (event === "on:gitlab-mr" && project && iid)    return `${workflowId}:${event}:${project}!${iid}`
  if (event === "on:gitlab-pipeline" && project) {
    const pid = ctx.pipelineId != null ? String(ctx.pipelineId) : ""
    if (pid) return `${workflowId}:${event}:${project}@pipeline:${pid}`
  }
  // Unknown / shapeless hook payloads: per-fire entity so each fire spawns
  // its own run rather than colliding on a single shared key. Authors who
  // want stickiness can move to a custom matcher later.
  return `${workflowId}:${event}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function scheduleCron(
  opts: CronTriggerOptions,
  dispatcher: WorkflowDispatcher,
  log: (msg: string) => void,
): void {
  const tick = () => {
    let next: Date
    try { next = getNextCronDate(opts.spec, new Date(), opts.timezone) }
    catch (e: any) { log(`[workflows] ${opts.workflowId} cron spec invalid: ${e.message}`); return }

    const delay = Math.max(1000, next.getTime() - Date.now())
    setTimeout(() => {
      void (async () => {
        const eventId = `cron:${opts.workflowId}:${next.toISOString()}`
        try {
          await dispatcher.dispatchWorkflow({
            workflowId: opts.workflowId,
            trigger: { source: "cron" },
            // Each scheduled fire gets a distinct entity so multiple runs
            // can coexist. If authors want a single "rolling" entity keyed
            // by the workflow, they can override via a transform node.
            entityRef: { backend: "cron", id: `${opts.workflowId}@${next.toISOString()}` },
            event: {
              id: eventId,
              payload: { now: next.toISOString(), spec: opts.spec, workflowId: opts.workflowId },
            },
          })
        } catch (e: any) {
          log(`[workflows] ${opts.workflowId} cron dispatch failed: ${e.message}`)
        } finally {
          // Reschedule for the next fire window regardless of success.
          tick()
        }
      })()
    }, delay)
  }
  tick()
}
