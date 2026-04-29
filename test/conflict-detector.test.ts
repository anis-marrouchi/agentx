import { describe, it, expect } from "vitest"
import { detectConflicts } from "../src/workflows/conflict-detector"
import type { Workflow } from "../src/workflows/types"
import type { DaemonConfig } from "../src/daemon/config"

// Minimal config + workflow factories. We don't go through zod parsers here
// because conflict-detector is a pure function over already-parsed shapes —
// keeping the test inputs typed as the runtime shape is enough to pin the
// behavior and avoids dragging in the full DaemonConfig schema (which has
// 200+ optional fields).

function gitlabConfig(overrides: Partial<{
  enabled: boolean
  routes: Array<{ project: string; agent: string }>
  agentMappings: Array<{ agentId: string; gitlabUsernames: string[]; keywords: string[] }>
}> = {}): DaemonConfig {
  return {
    channels: {
      gitlab: {
        enabled: overrides.enabled ?? true,
        webhookPort: 18810,
        host: "https://gitlab.com",
        routes: overrides.routes ?? [],
        agentMappings: overrides.agentMappings ?? [],
      },
    },
  } as unknown as DaemonConfig
}

function workflow(opts: { id: string; project?: string; state?: "active" | "disabled" | "quarantined" }): Workflow {
  return {
    id: opts.id,
    version: 2,
    title: opts.id,
    state: opts.state ?? "active",
    priority: 0,
    fanOut: false,
    nodes: [{
      id: "t1",
      type: "trigger.channel" as any,
      position: { x: 0, y: 0 },
      config: { source: "gitlab-issue", filter: opts.project ? { project: opts.project } : undefined },
    } as any],
    edges: [],
    envAllow: [],
    retention: { maxRuns: 500, maxDays: 90 },
    maxChildDepth: 5,
    mesh: { allowRemote: false },
  } as Workflow
}

describe("detectConflicts — workflow vs gitlab agentMapping", () => {
  it("no conflict when gitlab is disabled", () => {
    const wf = workflow({ id: "wf-a", project: "noqta/repo" })
    const cfg = gitlabConfig({ enabled: false, agentMappings: [{ agentId: "a", gitlabUsernames: [], keywords: [] }] })
    expect(detectConflicts([wf], cfg)).toEqual([])
  })

  it("no conflict when gitlab has no agentMappings", () => {
    const wf = workflow({ id: "wf-a", project: "noqta/repo" })
    const cfg = gitlabConfig({ agentMappings: [] })
    expect(detectConflicts([wf], cfg)).toEqual([])
  })

  it("flags overlap when workflow project is routed to a mapped agent", () => {
    // Reproduces the #709 incident: workflow `gitlab-sdlc-loop` triggers on
    // gitlab-issue for project `mtgl/mtgl-system-v2`; the gitlab channel
    // router has agentMapping mtgl-v2 routed to that project.
    const wf = workflow({ id: "gitlab-sdlc-loop", project: "mtgl/mtgl-system-v2" })
    const cfg = gitlabConfig({
      routes: [{ project: "mtgl/mtgl-system-v2", agent: "mtgl-v2" }],
      agentMappings: [{ agentId: "mtgl-v2", gitlabUsernames: ["coding-mtgl-v2"], keywords: [] }],
    })
    const conflicts = detectConflicts([wf], cfg)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].kind).toBe("workflow-vs-gitlab-agentmapping")
    expect(conflicts[0].workflowId).toBe("gitlab-sdlc-loop")
    expect(conflicts[0].details.overlappingAgents).toEqual(["mtgl-v2"])
    expect(conflicts[0].autoFix).toBe(true)
  })

  it("flags overlap with all mappings when workflow has no project filter", () => {
    // No project filter = matches every project = races against every
    // agentMapping that handles any routed project.
    const wf = workflow({ id: "broad-wf" })
    const cfg = gitlabConfig({
      agentMappings: [
        { agentId: "agent-a", gitlabUsernames: [], keywords: [] },
        { agentId: "agent-b", gitlabUsernames: [], keywords: [] },
      ],
    })
    const conflicts = detectConflicts([wf], cfg)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].details.overlappingAgents).toEqual(["agent-a", "agent-b"])
  })

  it("does not flag when project has no matching route", () => {
    // Workflow is project-scoped to a project that's not in gitlab.routes —
    // no overlap because no mapping is currently the default for that project.
    const wf = workflow({ id: "wf-a", project: "other/repo" })
    const cfg = gitlabConfig({
      routes: [{ project: "noqta/repo", agent: "a" }],
      agentMappings: [{ agentId: "a", gitlabUsernames: [], keywords: [] }],
    })
    expect(detectConflicts([wf], cfg)).toEqual([])
  })
})
