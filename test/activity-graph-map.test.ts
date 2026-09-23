import { describe, it, expect } from "vitest"
import { buildMapGraph, itemsFor, linkFor, projectLabel } from "../src/web/activity-graph/map-graph"
import type { FleetDispatch, FleetSnapshot } from "../src/web/activity-graph/api"
import { inferProject, projectFromChatId, projectFromPreview } from "../src/daemon/activity-graph-attribution"
import { mergeFleetSnapshots } from "../src/daemon/activity-graph-panel"

let seq = 0
function dispatch(p: Partial<FleetDispatch>): FleetDispatch {
  seq++
  return {
    id: `d${seq}`, agentId: "coder-agent", clientId: "noqta", projectId: "noqta/minbar",
    channelId: "gitlab", initiatorId: "saber", initiatorKind: "gitlab", subject: "Issue #152", intent: "mesh.gitlab",
    startedAt: 1_000 + seq, resolvedAt: 2_000, duration: 1_000, active: false, outcome: "completed",
    tokens: 0, inputPreview: "", system: false, nodeId: "mac", ...p,
  }
}

function snapshot(dispatches: FleetDispatch[]): FleetSnapshot {
  return {
    now: 10_000, windowH: 24, localNodeId: "mac",
    clients: [{ id: "noqta", name: "noqta", color: "#111111", projects: [] }, { id: "mtgl", name: "mtgl", color: "#222222", projects: [] }],
    agents: ["coder-agent", "secretary-agent", "devops-agent", "mtgl-v2", "idle-agent"].map((id) => ({ id, name: id, tier: "lead" as const, model: "", role: "" })),
    channels: [], initiators: [], dispatches,
    forges: { gitlab: "https://gitlab.example.com", github: "https://github.com" },
  }
}

// Today's shape: voice → secretary → devops-agent (local) / mtgl-v2 (peer) → MTGL; GitLab → coder → Minbar.
const traffic = [
  dispatch({ agentId: "secretary-agent", channelId: "voice", initiatorId: "Voice", initiatorKind: "voice", clientId: "unmapped", projectId: "unmapped/_mesh", subject: "chat:voice:secretary-agent" }),
  dispatch({ agentId: "devops-agent", channelId: "a2a", initiatorId: "secretary-agent", initiatorKind: "a2a", clientId: "mtgl", projectId: "mtgl/mtgl-system-v2", subject: "→ devops-agent" }),
  dispatch({ agentId: "mtgl-v2", channelId: "mesh", initiatorId: "secretary-agent", initiatorKind: "a2a", clientId: "mtgl", projectId: "mtgl/_mesh", subject: "→ mtgl-v2", nodeId: "clawd", active: true }),
  dispatch({ agentId: "mtgl-v2", channelId: "mesh", initiatorId: "secretary-agent", initiatorKind: "a2a", clientId: "mtgl", projectId: "mtgl/_mesh", subject: "→ mtgl-v2", nodeId: "clawd" }),
  dispatch({}),
  dispatch({ subject: "MR #51" }),
]

describe("buildMapGraph", () => {
  const g = buildMapGraph(snapshot(traffic), traffic, { showIdle: false, orientation: "horizontal" })
  const node = (id: string) => g.nodes.find((n) => n.id === id)
  const edge = (id: string) => g.edges.find((e) => e.id === id)

  it("draws channels, agents and projects as distinct kinds", () => {
    expect(node("ch:voice")?.kind).toBe("channel")
    expect(node("ch:gitlab")?.kind).toBe("channel")
    expect(node("ag:secretary-agent")?.kind).toBe("agent")
    expect(node("pj:noqta/minbar")).toMatchObject({ kind: "project", label: "minbar", sub: "noqta" })
  })

  it("turns agent-started dispatches into delegation edges, not channel edges", () => {
    expect(edge("ag:secretary-agent->ag:devops-agent")).toMatchObject({ kind: "delegation", count: 1 })
    expect(edge("ag:secretary-agent->ag:mtgl-v2")).toMatchObject({ kind: "delegation", count: 2, active: true })
    expect(g.edges.some((e) => e.source === "ch:mesh")).toBe(false)
  })

  it("weights edges by count and marks active ones", () => {
    expect(edge("ch:gitlab->ag:coder-agent")).toMatchObject({ count: 2, active: false })
    expect(edge("ag:coder-agent->pj:noqta/minbar")?.count).toBe(2)
    expect(node("ag:mtgl-v2")?.active).toBe(1)
  })

  it("puts peer agents in a mesh cluster and keeps delegators local", () => {
    expect(node("ag:mtgl-v2")).toMatchObject({ mesh: true, sub: "clawd" })
    expect(node("ag:secretary-agent")?.mesh).toBe(false)
    expect(g.clusters).toHaveLength(1)
    const c = g.clusters[0]
    const m = node("ag:mtgl-v2")!
    expect(m.x).toBeGreaterThan(c.x)
    expect(m.y).toBeGreaterThan(c.y)
  })

  it("lays out channels, then delegating agents, then workers, then projects", () => {
    expect(node("ch:voice")!.x).toBeLessThan(node("ag:secretary-agent")!.x)
    expect(node("ag:secretary-agent")!.x).toBeLessThan(node("ag:devops-agent")!.x)
    expect(node("ag:coder-agent")!.x).toBe(node("ag:devops-agent")!.x)
    expect(node("ag:coder-agent")!.x).toBeLessThan(node("pj:noqta/minbar")!.x)
  })

  it("hides idle nodes unless asked", () => {
    expect(node("ag:idle-agent")).toBeUndefined()
    expect(node("ch:telegram")).toBeUndefined()
    const all = buildMapGraph(snapshot(traffic), traffic, { showIdle: true, orientation: "horizontal" })
    expect(all.nodes.find((n) => n.id === "ag:idle-agent")).toBeDefined()
    expect(all.nodes.find((n) => n.id === "ch:telegram")?.count).toBe(0)
  })

  it("stacks tiers top to bottom in the phone layout", () => {
    const v = buildMapGraph(snapshot(traffic), traffic, { showIdle: false, orientation: "vertical" })
    const y = (id: string) => v.nodes.find((n) => n.id === id)!.y
    expect(y("ch:gitlab")).toBeLessThan(y("ag:coder-agent"))
    expect(y("ag:coder-agent")).toBeLessThan(y("ag:mtgl-v2"))
    expect(y("ag:mtgl-v2")).toBeLessThan(y("pj:noqta/minbar"))
    const xs = v.nodes.map((n) => n.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(390)
  })
})

describe("itemsFor", () => {
  it("lists a node's latest dispatches, newest first", () => {
    const items = itemsFor({ nodeId: "ag:secretary-agent" }, traffic)
    expect(items.map((d) => d.agentId)).toEqual(["mtgl-v2", "mtgl-v2", "devops-agent", "secretary-agent"])
  })
  it("lists exactly an edge's dispatches", () => {
    const g = buildMapGraph(snapshot(traffic), traffic, { showIdle: false, orientation: "horizontal" })
    const e = g.edges.find((x) => x.id === "ch:gitlab->ag:coder-agent")!
    expect(itemsFor({ edge: e }, traffic)).toHaveLength(2)
  })
})

describe("projectLabel / linkFor", () => {
  it("collapses unmapped and client-only projects", () => {
    expect(projectLabel("unmapped/_cron").key).toBe("unmapped")
    expect(projectLabel("mtgl/_mesh")).toEqual({ key: "mtgl/_", label: "mtgl", sub: "client" })
  })
  it("links GitLab issues and MRs, GitHub pulls, nothing for chat", () => {
    const f = snapshot([]).forges
    expect(linkFor(dispatch({ subject: "Issue #152" }), f)).toBe("https://gitlab.example.com/noqta/minbar/-/issues/152")
    expect(linkFor(dispatch({ subject: "→ atlas", inputPreview: "[GitLab noqta/minbar MR !51 update]: x" }), f))
      .toBe("https://gitlab.example.com/noqta/minbar/-/merge_requests/51")
    expect(linkFor(dispatch({ channelId: "github", projectId: "o/r", subject: "o · r:pull:16" }), f)).toBe("https://github.com/o/r/pull/16")
    expect(linkFor(dispatch({ projectId: "mtgl/_mesh", subject: "→ mtgl-v2" }), f)).toBeNull()
    expect(linkFor(dispatch({ subject: "noqta/minbar · issue:152", inputPreview: "[GitLab noqta/minbar issue #152]: see MR !49" }), f))
      .toBe("https://gitlab.example.com/noqta/minbar/-/issues/152")
    expect(linkFor(dispatch({ subject: "→ atlas", inputPreview: "Please review MR !49" }), f)).toBeNull()
  })
})

describe("project attribution", () => {
  it("reads the forge path out of chat ids and relayed webhook text", () => {
    expect(projectFromChatId("chat:noqta/minbar:merge_request:51")).toBe("noqta/minbar")
    expect(projectFromChatId("anis-marrouchi/agentx:pull:16")).toBe("anis-marrouchi/agentx")
    expect(projectFromChatId("chat:21624309128@s.whatsapp.net")).toBeNull()
    expect(projectFromPreview("[GitLab mtgl/mtgl-system-v2 Issue #1113 update]: x")).toBe("mtgl/mtgl-system-v2")
    expect(inferProject({ context: { project: "ksi/ksi-v2" } }, null, "")).toBe("ksi/ksi-v2")
    expect(inferProject({ context: { chatId: "noqta/minbar:issue:152" } }, null, "")).toBe("noqta/minbar")
  })

  it("re-attributes unmapped peer rows when merging the fleet", () => {
    const peer = snapshot([dispatch({ clientId: "unmapped", projectId: "unmapped/_mesh", inputPreview: "[GitLab noqta/minbar MR !50 open]: y" })])
    const merged = mergeFleetSnapshots([{ nodeId: "mac", snap: snapshot([]) }, { nodeId: "clawd", snap: peer }])
    expect(merged.localNodeId).toBe("mac")
    expect(merged.forges?.gitlab).toBe("https://gitlab.example.com")
    expect(merged.dispatches[0]).toMatchObject({ projectId: "noqta/minbar", clientId: "noqta", nodeId: "clawd" })
  })
})
