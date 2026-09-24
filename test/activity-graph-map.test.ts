import { describe, it, expect, beforeEach } from "vitest"
import { buildTransit, headline, lineOf, routeOf } from "../src/web/activity-graph/transit"
import { layoutNetwork, metroPath, spread } from "../src/web/activity-graph/transit-layout"
import type { FleetDispatch, FleetSnapshot } from "../src/web/activity-graph/api"
import { inferProject, mentionedMrs, primaryRef, projectFromChatId, projectFromPreview, refsOf } from "../src/daemon/activity-graph-attribution"
import { clearForgeCache, fetchForgeStatus, refsToLookUp, type ForgeItem } from "../src/daemon/activity-graph-forge"
import { mergeFleetSnapshots } from "../src/daemon/activity-graph-panel"

let seq = 0
function dispatch(p: Partial<FleetDispatch>): FleetDispatch {
  seq++
  return {
    id: `d${seq}`, agentId: "coder-agent", clientId: "noqta", projectId: "noqta/minbar",
    channelId: "gitlab", initiatorId: "saber", initiatorKind: "gitlab", subject: "Issue #152", intent: "mesh.gitlab",
    startedAt: 1_000 + seq, resolvedAt: 2_000 + seq, duration: 1_000, active: false, outcome: "completed",
    tokens: 0, inputPreview: "", system: false, nodeId: "mac", ...p,
  }
}

function mr(project: string, n: number, p: Partial<ForgeItem> = {}): [string, ForgeItem] {
  return [`${project}!${n}`, { kind: "mr", project, n, title: `MR ${n}`, state: "opened", draft: false, url: `https://gl/${project}/-/merge_requests/${n}`, pipeline: { status: "success", url: `https://gl/p/${n}` }, mergedAt: null, ...p }]
}

function snapshot(dispatches: FleetDispatch[], forge: Record<string, ForgeItem> = {}): FleetSnapshot {
  return {
    now: 10_000, windowH: 6, localNodeId: "mac",
    clients: [
      { id: "noqta", name: "noqta", color: "#111111", projects: ["noqta/minbar"] },
      { id: "ksi", name: "ksi", color: "#222222", projects: ["ksi/ksi-v2"] },
    ],
    agents: ["coder-agent", "secretary-agent", "devops-agent", "mtgl-v2", "idle-agent"].map((id) => ({ id, name: id, tier: "lead" as const, model: "", role: "" })),
    channels: [], initiators: [{ id: "voice", name: "Anis", avatar: "A", kind: "voice" }], dispatches,
    forges: { gitlab: "https://gl", github: "https://github.com" }, forge,
  }
}

// Voice → secretary hands MTGL V2 four MRs (three fail CI); GitLab → coder on Minbar.
const V2 = "mtgl/mtgl-system-v2"
const traffic = [
  dispatch({ agentId: "secretary-agent", channelId: "voice", initiatorId: "voice", initiatorKind: "voice", clientId: "unmapped", projectId: "unmapped/_voice", subject: "chat:voice:secretary-agent", startedAt: 100 }),
  dispatch({ agentId: "mtgl-v2", channelId: "a2a", initiatorId: "secretary-agent", initiatorKind: "a2a", clientId: "mtgl", projectId: V2, subject: "→ mtgl-v2", inputPreview: "Finish !445, !446, !447 and !448 today", nodeId: "clawd", startedAt: 200 }),
  dispatch({ agentId: "mtgl-v2", channelId: "a2a", initiatorId: "secretary-agent", initiatorKind: "a2a", clientId: "mtgl", projectId: V2, subject: "→ mtgl-v2", inputPreview: "Park !443 for now", nodeId: "clawd", startedAt: 300 }),
  dispatch({ agentId: "devops-agent", channelId: "a2a", initiatorId: "secretary-agent", initiatorKind: "a2a", clientId: "mtgl", projectId: V2, subject: "→ devops-agent", inputPreview: "Deploy !444", startedAt: 250 }),
  dispatch({ subject: "noqta/minbar · merge_request:54", inputPreview: "[GitLab noqta/minbar merge_request #54: x]", active: true }),
  dispatch({ subject: "MR #54" }),
]
const forge = Object.fromEntries([
  mr(V2, 445, { pipeline: { status: "pending", url: "" } }),
  mr(V2, 446, { pipeline: { status: "failed", url: "https://gl/p/446" } }),
  mr(V2, 447, { pipeline: { status: "failed", url: "https://gl/p/447" } }),
  mr(V2, 448, { pipeline: { status: "failed", url: "https://gl/p/448" } }),
  mr(V2, 443, { draft: true }),
  mr(V2, 444, { state: "merged", mergedAt: 900 }),
])

describe("buildTransit", () => {
  const t = buildTransit(snapshot(traffic, forge), traffic)
  const line = (id: string) => t.lines.find((l) => l.id === id)!
  const train = (tag: string) => t.trains.find((x) => x.tag === tag)!

  it("names lines after projects and gives them codes", () => {
    expect(lineOf(V2)).toMatchObject({ id: V2, name: "MTGL System V2", code: "V2" })
    expect(lineOf("noqta/minbar")).toMatchObject({ name: "Minbar", code: "MN" })
    expect(lineOf("mtgl/_mesh")).toMatchObject({ id: "mtgl/_", name: "MTGL" })
    expect(lineOf("unmapped/_cron").id).toBe("unmapped")
  })

  it("groups a hand-off naming several MRs into one train", () => {
    expect(train("!445–!448")).toMatchObject({ title: "MRs !445–!448", label: "4 MRs", agentId: "mtgl-v2", delegator: "secretary-agent" })
    expect(train("!445–!448").items.map((i) => i.status.label)).toEqual(["Build queued", "Build failed", "Build failed", "Build failed"])
  })

  it("groups webhook events for one MR into one train", () => {
    expect(t.trains.filter((x) => x.tag === "!54")).toHaveLength(1)
    expect(train("!54").dispatchIds).toHaveLength(2)
    expect(train("!54").state).toBe("running")
  })

  it("derives train state from pipelines, drafts and merges", () => {
    expect(train("!445–!448")).toMatchObject({ state: "delayed", reason: "3 pipelines failed" })
    expect(train("!445–!448").failedPipelines).toEqual(["https://gl/p/446", "https://gl/p/447", "https://gl/p/448"])
    expect(train("!443").state).toBe("held")
    expect(train("!444").state).toBe("delivered")
  })

  it("traces a hand-off back to what reached the delegator", () => {
    expect(train("!445–!448")).toMatchObject({ channel: "voice", startedBy: "Anis" })
    expect(routeOf(train("!445–!448"), line(V2), (id) => id)).toEqual(["Voice", "secretary-agent", "mtgl-v2", "V2"])
  })

  it("derives line status and reason from its trains", () => {
    expect(line(V2)).toMatchObject({ state: "delays", reason: "3 pipelines failed · 1 held" })
    expect(line("noqta/minbar")).toMatchObject({ state: "good", reason: "1 running" })
    expect(line("ksi/ksi-v2")).toMatchObject({ state: "quiet", reason: "" })
    expect(t.lines[0].id).toBe(V2)
    expect(headline(t.lines)).toBe("One line delayed")
  })

  it("marks a train delayed when its last run errored", () => {
    const ds = [dispatch({ outcome: "error", subject: "MR #60" })]
    expect(buildTransit(snapshot(ds), ds).trains[0]).toMatchObject({ state: "delayed", reason: "Last run errored" })
  })

  it("keeps chats and cron jobs as their own trains", () => {
    const ds = [
      dispatch({ channelId: "cron", initiatorKind: "cron", initiatorId: "__system", subject: "Reddit replies", projectId: "noqta/_cron" }),
      dispatch({ channelId: "cron", initiatorKind: "cron", initiatorId: "__system", subject: "Reddit replies", projectId: "noqta/_cron" }),
      dispatch({ channelId: "whatsapp", initiatorKind: "whatsapp", initiatorId: "u1", subject: "chat", inputPreview: "hello there", projectId: "unmapped/_whatsapp" }),
    ]
    const tt = buildTransit(snapshot(ds), ds)
    expect(tt.trains.map((x) => x.tag).sort()).toEqual(["WhatsApp", "cron"])
    expect(tt.trains.find((x) => x.tag === "cron")!.dispatchIds).toHaveLength(2)
  })
})

describe("layoutNetwork", () => {
  const t = buildTransit(snapshot(traffic, forge), traffic)
  const opts = { orientation: "horizontal" as const, showIdle: false, meshAgents: new Set(["mtgl-v2"]), agentName: (id: string) => id, allAgents: ["coder-agent", "idle-agent"] }
  const net = layoutNetwork(t, opts)
  const node = (id: string) => net.nodes.find((n) => n.id === id)!

  it("lays out channels, interchange, stations, trains and terminals left to right", () => {
    expect(node("ch:voice").x).toBeLessThan(node("st:secretary-agent").x)
    expect(node("st:secretary-agent").x).toBeLessThan(node("st:mtgl-v2").x)
    expect(node("st:mtgl-v2").x).toBeLessThan(node(`gr:mtgl-v2|${V2}`).x)
    expect(node(`gr:mtgl-v2|${V2}`).x).toBeLessThan(node(`tm:${V2}`).x)
    expect(node("st:secretary-agent")).toMatchObject({ interchange: true, sub: "Interchange · 1 line" })
  })

  it("draws the mesh as a remote district around peer stations", () => {
    const d = node("district:mesh"), m = node("st:mtgl-v2")
    expect(m.mesh).toBe(true)
    expect(m.x).toBeGreaterThan(d.x)
    expect(m.y + m.h).toBeLessThan(d.y + d.h)
    expect(node("st:coder-agent").y).toBeGreaterThan(d.y + d.h - 60)
  })

  it("feeds every channel in but fades idle ones", () => {
    expect(net.nodes.filter((n) => n.kind === "channel")).toHaveLength(9)
    expect(node("ch:voice").idle).toBe(false)
    expect(node("ch:telegram").idle).toBe(true)
    expect(net.edges.some((e) => e.id === "fd:voice|secretary-agent")).toBe(true)
  })

  it("hides idle stations unless asked", () => {
    expect(net.nodes.some((n) => n.id === "st:idle-agent")).toBe(false)
    expect(layoutNetwork(t, { ...opts, showIdle: true }).nodes.some((n) => n.id === "st:idle-agent")).toBe(true)
  })

  it("stacks one line top to bottom for the phone within 390 px", () => {
    const v = layoutNetwork(t, { ...opts, orientation: "vertical", lineId: V2 })
    const y = (id: string) => v.nodes.find((n) => n.id === id)!.y
    expect(y("ch:voice")).toBeLessThan(y("st:secretary-agent"))
    expect(y("st:secretary-agent")).toBeLessThan(y("st:mtgl-v2"))
    expect(y(`gr:mtgl-v2|${V2}`)).toBeLessThan(y(`tm:${V2}`))
    expect(v.nodes.some((n) => n.id === "st:coder-agent")).toBe(false)
    const xs = v.nodes.filter((n) => n.kind !== "district").flatMap((n) => [n.x, n.x + n.w])
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(390)
  })

  it("spreads crowded positions apart and draws 45° metro legs", () => {
    expect(spread([0, 0, 0], 10)).toEqual([-10, 0, 10])
    expect(metroPath(0, 0, 100, 0, "horizontal")).toBe("M 0 0 L 100 0")
    expect(metroPath(0, 0, 200, 50, "horizontal")).toBe("M 0 0 L 18 0 L 68 50 L 200 50")
  })
})

describe("forge refs and status", () => {
  beforeEach(() => clearForgeCache())

  it("finds the primary ref, else the MRs a hand-off names", () => {
    expect(primaryRef({ subject: "noqta/minbar · issue:152", inputPreview: "see !49" })).toEqual({ kind: "issue", n: 152 })
    expect(primaryRef({ subject: "→ atlas", inputPreview: "[GitLab noqta/minbar MR !51 update]: x" })).toEqual({ kind: "mr", n: 51 })
    expect(mentionedMrs("review !445, !446 and !445 (!447)")).toEqual([{ kind: "mr", n: 445 }, { kind: "mr", n: 446 }, { kind: "mr", n: 447 }])
    expect(refsOf({ subject: "→ mtgl-v2", inputPreview: "!445", projectId: "mtgl/_mesh" })).toEqual([])
  })

  it("looks up newest refs once each and caches them", async () => {
    const wants = refsToLookUp(traffic)
    expect(wants.map((w) => `${w.project}${w.ref.kind === "mr" ? "!" : "#"}${w.ref.n}`)).toContain(`${V2}!448`)
    expect(new Set(wants.map((w) => w.ref.n)).size).toBe(wants.length)
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return { ok: true, json: async () => ({ title: "t", state: "opened", draft: false, web_url: "u", head_pipeline: { status: "failed", web_url: "p" } }) }
    }) as unknown as typeof fetch
    const cfg = { gitlab: { host: "https://gl", token: "x" } }
    const out = await fetchForgeStatus(wants, cfg, fake, 0)
    expect(out[`${V2}!448`]).toMatchObject({ state: "opened", pipeline: { status: "failed", url: "p" } })
    expect(calls).toContain("https://gl/api/v4/projects/mtgl%2Fmtgl-system-v2/merge_requests/448")
    const n = calls.length
    await fetchForgeStatus(wants, cfg, fake, 30_000)
    expect(calls.length).toBe(n)
    await fetchForgeStatus(wants, cfg, fake, 61_000)
    expect(calls.length).toBe(2 * n)
  })

  it("survives an unreachable forge", async () => {
    const boom = (async () => { throw new Error("down") }) as unknown as typeof fetch
    expect(await fetchForgeStatus(refsToLookUp(traffic), { gitlab: { host: "https://gl", token: "x" } }, boom, 0)).toEqual({})
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
    expect(merged.forges?.gitlab).toBe("https://gl")
    expect(merged.dispatches[0]).toMatchObject({ projectId: "noqta/minbar", clientId: "noqta", nodeId: "clawd" })
  })
})

describe("map data scope", () => {
  it("always asks for the fleet-merged snapshot, like the rest of /activity", async () => {
    const { fetchSnapshot, fetchDispatchDetail } = await import("../src/web/activity-graph/api")
    const seen: string[] = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (u: string) => { seen.push(String(u)); return { ok: true, json: async () => ({}) } }) as any
    try {
      await fetchSnapshot(24)
      await fetchDispatchDetail("mac::e1|coder")
    } finally { globalThis.fetch = orig }
    expect(seen).toHaveLength(2)
    for (const u of seen) expect(u).toContain("peer=fleet")
  })
})
