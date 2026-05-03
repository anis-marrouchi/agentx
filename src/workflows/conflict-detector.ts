// Static analyzer for the dispatch graph.
//
// A "conflict" is two dispatch paths that can fire for the same external
// event. The classic case (incident 2026-04-29 issue mtgl/mtgl-system-v2#709):
// a workflow `gitlab-sdlc-loop` triggers on `gitlab-issue` for project
// mtgl/mtgl-system-v2 AND the gitlab channel router has an agentMapping for
// `mtgl-v2` on the same project. Both fire on issue.create — two parallel
// agent runs on one issue.
//
// This module runs at workflow load and on config reload. It returns a list
// of detected conflicts. v0 covers only the trigger.channel(gitlab-issue) ↔
// gitlab.agentMappings case (the one that produced #709). The detector is
// designed to grow: each conflict kind is a single function, all wired into
// detectConflicts().
//
// The dispatcher and trigger registrar do NOT consult this module directly
// today — they honor `workflow.state`, which is set by the operator (manual
// `disabled`) or by an upcoming auto-quarantine layer (`quarantined`). This
// stub exists so that layer has a stable contract to build on.

import type { Workflow } from "./types"
import type { DaemonConfig } from "@/daemon/config"

export type ConflictSeverity = "warn" | "block"
export type ConflictKind = "workflow-vs-gitlab-agentmapping"

export interface Conflict {
  kind: ConflictKind
  severity: ConflictSeverity
  workflowId: string
  /** Brief one-liner suitable for log + admin panel summary. */
  summary: string
  /** What overlaps. Free-form so each conflict kind can carry its own data. */
  details: Record<string, unknown>
  /** Suggested resolution shown to the operator. Auto-applicable fixes set
   *  `autoFix: true` so an upcoming auto-fix layer can act without prompt. */
  suggestion: string
  autoFix: boolean
}

/**
 * Run all conflict checks for the current workflow set against the daemon
 * config. Pure function — does not mutate state, does not log. Callers
 * decide what to do with the result (log, surface, quarantine, auto-fix).
 */
export function detectConflicts(workflows: Workflow[], config: DaemonConfig): Conflict[] {
  const out: Conflict[] = []
  for (const wf of workflows) {
    out.push(...detectGitlabAgentMappingOverlap(wf, config))
  }
  return out
}

// --- Individual conflict checks ---------------------------------------------

/**
 * trigger.channel(source: gitlab-issue, filter.project: P) overlaps with
 * channels.gitlab.agentMappings entries that route the same project. Both
 * paths reach an agent on issue events for project P; the channel router's
 * default-target dispatch (`src/channels/gitlab.ts:712`) will fire alongside
 * the workflow's own dispatch.
 *
 * Auto-fix: set the workflow trigger's `hookBlocked: true` (or the matching
 * channel-router opt-out) so the channel router's default dispatch defers to
 * the workflow. Not applied here — the auto-fix engine consumes this result.
 */
function detectGitlabAgentMappingOverlap(wf: Workflow, config: DaemonConfig): Conflict[] {
  const out: Conflict[] = []
  const gitlab = config.channels.gitlab
  if (!gitlab?.enabled || !gitlab.agentMappings?.length) return out

  // Hook events whose source is the gitlab channel router. trigger.hook
  // workflows on these events race against gitlab.agentMappings dispatched
  // from the same webhook (gitlab.ts handleIssue/handleMR/handleNote).
  const GITLAB_HOOK_EVENTS = new Set(["on:gitlab-issue", "on:gitlab-mr", "on:gitlab-note"])

  for (const node of wf.nodes) {
    let triggerLabel: string | undefined
    let project: string | undefined

    if (node.type === "trigger.channel") {
      const cfg = node.config as { source?: string; filter?: { project?: string } } | undefined
      if (cfg?.source !== "gitlab-issue") continue
      project = cfg.filter?.project
      triggerLabel = `trigger.channel(gitlab-issue, project=${project ?? "*"})`
    } else if (node.type === "trigger.hook") {
      // trigger.hook fires on a HookRegistry event; project filter is not
      // part of the hook config (the event IS the filter), so any matching
      // hook races for every project the gitlab adapter dispatches to.
      const cfg = node.config as { event?: string } | undefined
      if (!cfg?.event || !GITLAB_HOOK_EVENTS.has(cfg.event)) continue
      project = undefined // hook fires for all projects
      triggerLabel = `trigger.hook(${cfg.event})`
    } else {
      continue
    }

    const overlaps = gitlab.agentMappings.filter((m) => {
      if (!project || project === "*") return true
      // The mapping itself doesn't carry a project field — gitlab routing is
      // by username + project routes. We approximate "this mapping handles
      // this project" by looking at gitlab.routes too.
      const projectRoute = gitlab.routes.find((r) => r.project === project)
      return projectRoute?.agent === m.agentId
    })
    if (overlaps.length === 0) continue

    out.push({
      kind: "workflow-vs-gitlab-agentmapping",
      severity: "warn",
      workflowId: wf.id,
      summary: `workflow "${wf.id}" ${triggerLabel} overlaps with gitlab agentMapping(s) ${overlaps.map((m) => m.agentId).join(", ")}`,
      details: {
        triggerNodeId: node.id,
        triggerType: node.type,
        project: project ?? "*",
        overlappingAgents: overlaps.map((m) => m.agentId),
      },
      suggestion: "set `hookBlocked: true` on the gitlab trigger so the channel router's default-target dispatch defers to the workflow",
      autoFix: true,
    })
  }
  return out
}
