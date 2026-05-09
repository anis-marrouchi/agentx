// --- Projects API: aggregated per-project view ---
//
// The /admin/projects page asks "for this project, what does the
// daemon know?" — agents, workflows, channels, contacts. This module
// is the read-side aggregator: it stitches together
//
//   - `.agentx/projects/<org>/<repo>.yaml` rule files (ProjectRulesStore)
//   - `channels.gitlab.routes` / `channels.gitlab.agentMappings`
//   - `channels.github.routes` / `channels.github.agentMappings`
//   - workflowStore filtered by `workflow.project == <project>`
//   - `.agentx/contacts.json` entries that name this project
//
// Output shape is one row per known project; the page renders a list,
// click-through opens a detail panel that consumes the same row. The
// answer is computed fresh on every request — projects rarely change
// at high frequency, and the cost is a few small reads + an in-memory
// filter over workflows.
//
// Gating: read-only. No mutations exposed yet — controls (edit rule,
// add agent, etc.) come in a follow-up once the read view is shaped.

import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import type { DaemonConfig } from "./config"
import { ProjectRulesStore, type ProjectRule, type ProjectKind } from "@/projects/rules"
import type { WorkflowStore } from "@/workflows"

export interface ProjectsApiContext {
  config: DaemonConfig
  rules: ProjectRulesStore
  workflowStore: WorkflowStore
  /** Working directory of the daemon — used to resolve contacts.json and
   *  any other relative path the aggregator needs to read. */
  cwd: string
}

export interface ProjectAggregateRow {
  /** Canonical project key — `<org>/<repo>` for vcs, operator slug otherwise. */
  project: string
  /** Source of this project, declared on the rule or inferred from
   *  clauses. Used for the badge/icon on the Projects page header. */
  kind: ProjectKind
  /** Optional human-friendly name. Falls back to `project` when unset. */
  displayName?: string
  /** Optional external URL — repo / board home. */
  homeUrl?: string
  /** Channel binding inferred from the project rule + channel routes. Often
   *  "gitlab" — but could be "github" or both ("gitlab,github") when a
   *  monorepo is mirrored. */
  channels: string[]
  /** Agents bound to this project. Sourced from rule.agent (preferred) +
   *  channels.gitlab.routes / .github.routes lookups + agentMappings cross-
   *  reference. Each entry includes the agent id, the channel that bound
   *  it, and the agent's displayName when available. */
  agents: Array<{ agentId: string; channel: string; via: string; gitlabUsername?: string }>
  /** Workflows whose top-level `project` field equals this project. */
  workflows: Array<{ id: string; title: string; status: string; trigger?: string }>
  /** Contacts associated with this project. Comes from contacts.json
   *  entries that carry a `project` field. Empty when the contact store
   *  doesn't tag projects. */
  contacts: Array<{ id: string; name: string; channels: string[] }>
  /** Runbook path resolved by the rule, if any. */
  runbook?: string
  /** Path to the source rule YAML for diagnostics. */
  rulePath?: string
  /** Raw rule clauses (gitlab.* and github.*) — surfaced so the
   *  channel-clause editor can pre-populate its form fields without a
   *  second round-trip. Both keys absent when the rule has none. */
  clauses?: {
    gitlab?: ProjectRule["gitlab"]
    github?: ProjectRule["github"]
  }
}

export interface ProjectsApiResponse {
  /** Sorted by project key for deterministic UI rendering. */
  projects: ProjectAggregateRow[]
  /** When the aggregator hit an unparseable contacts.json or similar
   *  soft failure, the message lands here so the operator sees it in the
   *  UI without surfacing a 500. Empty array on the happy path. */
  warnings: string[]
}

/**
 * Compute the per-project aggregate. Pure read — no side effects.
 *
 * Project membership rules:
 *   1. Every project that has a rule file in `.agentx/projects/` is a
 *      project, even if no workflow points at it yet.
 *   2. Every distinct `workflow.project` value is also a project, even
 *      when there's no rule file (legacy / WIP state).
 *   3. Every distinct `channels.gitlab.routes[].project` and
 *      `channels.github.routes[].repo` value is also a project (gives
 *      the operator a "you have a route but no rule" signal).
 *
 * The union becomes the project list. Each row's fields are filled in
 * from whichever sources had data; absent sources land as empty arrays
 * rather than missing keys, so the UI doesn't have to defensive-check.
 */
export function computeProjectsAggregate(ctx: ProjectsApiContext): ProjectsApiResponse {
  const warnings: string[] = []
  const projectKeys = new Set<string>()

  // 1. Rule-defined projects.
  const ruleByKey = new Map<string, ProjectRule>()
  for (const rule of ctx.rules.list()) {
    projectKeys.add(rule.project)
    ruleByKey.set(rule.project, rule)
  }

  // 2. Workflow-tagged projects.
  const workflowsByProject = new Map<string, ProjectAggregateRow["workflows"]>()
  const allWorkflows = ctx.workflowStore.list()
  for (const wf of allWorkflows) {
    if (!wf.project) continue
    projectKeys.add(wf.project)
    if (!workflowsByProject.has(wf.project)) workflowsByProject.set(wf.project, [])
    const triggerNode = (wf.nodes || []).find((n) => n?.type?.startsWith("trigger."))
    const triggerKey = triggerNode
      ? (triggerNode.config as { event?: string; source?: string } | undefined)?.event
        ?? (triggerNode.config as { source?: string } | undefined)?.source
        ?? triggerNode.type.replace("trigger.", "")
      : undefined
    workflowsByProject.get(wf.project)!.push({
      id: wf.id,
      title: wf.title || wf.id,
      status: wf.status || "active",
      trigger: triggerKey,
    })
  }

  // 3. Channel-route-defined projects.
  const gitlab = ctx.config.channels?.gitlab
  const github = ctx.config.channels?.github
  for (const r of gitlab?.routes ?? []) {
    if (r.project && r.project !== "*") projectKeys.add(r.project)
  }
  for (const r of github?.routes ?? []) {
    if ((r as { repo?: string }).repo && (r as { repo: string }).repo !== "*") {
      projectKeys.add((r as { repo: string }).repo)
    }
  }

  // Cache the agentMappings reverse-lookup once.
  const gitlabMappings = (gitlab?.agentMappings ?? []).map((m) => ({
    agentId: m.agentId,
    usernames: m.gitlabUsernames ?? [],
  }))
  const githubMappings = (github?.agentMappings ?? []).map((m) => ({
    agentId: m.agentId,
    usernames: (m as { githubUsernames?: string[] }).githubUsernames ?? [],
  }))

  // Contacts JSON — load once per call. Soft-fail.
  const contactsPath = resolve(ctx.cwd, ".agentx/contacts.json")
  let allContacts: Array<{ id: string; name?: string; project?: string; channels?: Record<string, unknown> }> = []
  if (existsSync(contactsPath)) {
    try {
      const raw = JSON.parse(readFileSync(contactsPath, "utf-8")) as
        { contacts?: Array<{ id: string; name?: string; project?: string; channels?: Record<string, unknown> }> }
        | Array<{ id: string; name?: string; project?: string; channels?: Record<string, unknown> }>
      allContacts = Array.isArray(raw) ? raw : (raw.contacts ?? [])
    } catch (e: any) {
      warnings.push(`failed to parse .agentx/contacts.json: ${e?.message ?? e}`)
    }
  }

  const rows: ProjectAggregateRow[] = []
  for (const key of Array.from(projectKeys).sort()) {
    const rule = ruleByKey.get(key)
    const channels: string[] = []
    const agents: ProjectAggregateRow["agents"] = []

    // Channel binding via routes.
    const glRoutes = (gitlab?.routes ?? []).filter((r) => r.project === key)
    if (glRoutes.length > 0) channels.push("gitlab")
    const ghRoutes = (github?.routes ?? []).filter((r) => (r as { repo?: string }).repo === key)
    if (ghRoutes.length > 0) channels.push("github")
    // Rule fallback when no explicit route — most rule projects are gitlab.
    if (channels.length === 0 && rule) channels.push("gitlab")

    // Agents: dedupe by agentId across (rule.agent, gitlab routes, github routes).
    const seenAgents = new Set<string>()
    if (rule?.agent && !seenAgents.has(rule.agent)) {
      seenAgents.add(rule.agent)
      const mapping = gitlabMappings.find((m) => m.agentId === rule.agent)
      agents.push({
        agentId: rule.agent,
        channel: channels[0] ?? "gitlab",
        via: "rule.agent",
        gitlabUsername: mapping?.usernames[0],
      })
    }
    for (const r of glRoutes) {
      if (seenAgents.has(r.agent)) continue
      seenAgents.add(r.agent)
      const mapping = gitlabMappings.find((m) => m.agentId === r.agent)
      agents.push({
        agentId: r.agent,
        channel: "gitlab",
        via: "channels.gitlab.routes",
        gitlabUsername: mapping?.usernames[0],
      })
    }
    for (const r of ghRoutes) {
      const a = (r as { agent: string }).agent
      if (seenAgents.has(a)) continue
      seenAgents.add(a)
      const mapping = githubMappings.find((m) => m.agentId === a)
      agents.push({
        agentId: a,
        channel: "github",
        via: "channels.github.routes",
        gitlabUsername: mapping?.usernames[0],
      })
    }

    // Contacts — match by exact `project` field on the contact entry.
    const contacts = allContacts
      .filter((c) => c.project === key)
      .map((c) => ({
        id: c.id,
        name: c.name ?? c.id,
        channels: Object.keys(c.channels ?? {}),
      }))

    // Merge contacts from BOTH sides of the link: rule.contacts (ids) and
    // .agentx/contacts.json entries with `project: <key>`. Dedup by id —
    // either side declaring the relationship is enough.
    const contactsMap = new Map<string, ProjectAggregateRow["contacts"][number]>()
    for (const c of contacts) contactsMap.set(c.id, c)
    if (rule?.contacts) {
      for (const cid of rule.contacts) {
        if (contactsMap.has(cid)) continue
        const found = allContacts.find((c) => c.id === cid)
        if (found) {
          contactsMap.set(cid, {
            id: cid,
            name: found.name ?? cid,
            channels: Object.keys(found.channels ?? {}),
          })
        } else {
          // Rule declares a contact id that doesn't exist in contacts.json.
          // Surface anyway so the operator can spot stale links.
          contactsMap.set(cid, { id: cid, name: cid + " (unknown)", channels: [] })
        }
      }
    }

    const clauses: ProjectAggregateRow["clauses"] = {}
    if (rule?.gitlab) clauses.gitlab = rule.gitlab
    if (rule?.github) clauses.github = rule.github

    rows.push({
      project: key,
      kind: rule ? ProjectRulesStore.inferKind(rule) : "other",
      displayName: rule?.displayName,
      homeUrl: rule?.homeUrl,
      channels,
      agents,
      workflows: workflowsByProject.get(key) ?? [],
      contacts: Array.from(contactsMap.values()),
      runbook: rule?.runbook,
      rulePath: rule?._path,
      clauses: (clauses.gitlab || clauses.github) ? clauses : undefined,
    })
  }

  return { projects: rows, warnings }
}
