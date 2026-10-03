import { describe, it, expect, beforeEach } from "vitest"
import { agentLineOf, buildTransit, headline, lineOf, routeOf } from "../src/web/activity-graph/transit"
import { crossesBox, layoutNetwork, metroPath, metroPoints, spread } from "../src/web/activity-graph/transit-layout"
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
    expect(routeOf(train("!445–!448"), line(V2), (id) => id)).toEqual(["Unknown", "Voice", "secretary-agent", "mtgl-v2", "V2"])
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

describe("agent lines for work with no project", () => {
  const snap = (ds: FleetDispatch[]) => {
    const base = snapshot(ds)
    return { ...base, agents: base.agents.map((a) => a.id === "coder-agent" ? { ...a, name: "Coder", title: "Software Developer" } : a) }
  }

  it("runs a project-less chat on its agent's line, never on 'Unassigned'", () => {
    const voice = dispatch({ agentId: "secretary-agent", channelId: "voice", clientId: "unmapped", projectId: "unmapped/_voice", subject: "chat:voice:secretary-agent" })
    const t = buildTransit(snap([voice]), [voice])
    const busy = t.lines.filter((l) => l.trains.length)
    expect(busy.map((l) => [l.id, l.name])).toEqual([["agent:secretary-agent", "secretary-agent"]])
    expect(t.lines.some((l) => l.name === "Unassigned")).toBe(false)
  })

  it("names an agent line after the org-chart title, else the agent's name", () => {
    expect(agentLineOf({ id: "coder-agent", name: "Coder", title: "Software Developer" }, "coder-agent")).toMatchObject({ name: "Software Developer", code: "SD" })
    expect(agentLineOf({ id: "secretary-agent", name: "Secretary" }, "secretary-agent")).toMatchObject({ name: "Secretary", code: "SE" })
    expect(agentLineOf(undefined, "atlas")).toMatchObject({ id: "agent:atlas", name: "atlas" })
  })

  it("gives each agent its own line and hides quiet ones", () => {
    const ds = [
      dispatch({ agentId: "coder-agent", channelId: "cron", clientId: "unmapped", projectId: "unmapped/_cron", subject: "cron:maintainer" }),
      dispatch({ agentId: "secretary-agent", channelId: "voice", clientId: "unmapped", projectId: "unmapped/_voice", subject: "chat:voice:secretary-agent" }),
    ]
    const names = buildTransit(snap(ds), ds).lines.map((l) => l.name)
    expect(names).toContain("Software Developer")
    expect(names).toContain("secretary-agent")
    // Agents with no work in the window don't get a line.
    expect(names).not.toContain("idle-agent")
  })

  it("still folds a hand-off's originating chat into the route instead of its own line", () => {
    const t = buildTransit(snapshot(traffic, forge), traffic)
    expect(t.lines.find((l) => l.id === "agent:secretary-agent")).toBeUndefined()
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
    expect(net.nodes.filter((n) => n.kind === "channel")).toHaveLength(10)
    expect(node("ch:voice").idle).toBe(false)
    expect(node("ch:telegram").idle).toBe(true)
    expect(net.edges.some((e) => e.id === `fd:voice|secretary-agent|${V2}`)).toBe(true)
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

// #267 — every train starts at its true origin and shows every A2A hop.
describe("hop chains and true origin", () => {
  const WEB = "acme/web"
  const ask = (agentId: string, from: string, startedAt: number, p: Partial<FleetDispatch> = {}) => dispatch({
    agentId, channelId: "a2a", initiatorId: from, initiatorKind: "a2a", intent: "mesh.a2a", clientId: "acme", projectId: WEB,
    subject: `→ ${agentId}`, startedAt, resolvedAt: startedAt + 500, ...p,
  })
  const chat = (agentId: string, channelId: string, startedAt: number, p: Partial<FleetDispatch> = {}) => dispatch({
    agentId, channelId, initiatorId: "voice", initiatorKind: channelId as FleetDispatch["initiatorKind"], clientId: "unmapped",
    projectId: `unmapped/_${channelId}`, subject: `chat:${channelId}:${agentId}`, startedAt, resolvedAt: null, active: true, ...p,
  })
  const hookRun = (agentId: string, startedAt: number, p: Partial<FleetDispatch> = {}) => dispatch({
    agentId, clientId: "acme", projectId: WEB, subject: "MR #7", inputPreview: "[GitLab acme/web MR !7 open]: x", startedAt, ...p,
  })
  const trainOf = (ds: FleetDispatch[], agentId: string, snapDs = ds) =>
    buildTransit(snapshot(snapDs), ds).trains.find((t) => t.agentId === agentId)!

  it("starts a GitLab-triggered job at GitLab, not at an agent that asked about it later", () => {
    const ds = [
      chat("secretary-agent", "voice", 100),
      hookRun("devops-agent", 200),
      ask("devops-agent", "secretary-agent", 900, { inputPreview: "status of !7?" }),
    ]
    const t = trainOf(ds, "devops-agent")
    expect(t).toMatchObject({ tag: "!7", channel: "gitlab", route: ["devops-agent"], delegator: null })
    expect(routeOf(t, undefined, (id) => id)).toEqual(["Unknown", "GitLab", "devops-agent", WEB])
    // The later question is still on the train's timeline, after the webhook.
    expect(t.hops.filter((h) => h.to === "devops-agent").map((h) => h.from)).toEqual([null, "secretary-agent"])
  })

  it("routes GitLab → receiving agent on a peer → local agent, with no Secretary", () => {
    const root = { kind: "human" as const, channel: "gitlab", agentId: "coder-agent" }
    const ds = [
      chat("secretary-agent", "voice", 100),
      hookRun("coder-agent", 200, { nodeId: "peer-a", resolvedAt: 5_000 }),
      ask("devops-agent", "coder-agent", 300, { root, inputPreview: "deploy !7" }),
    ]
    const t = trainOf(ds, "devops-agent")
    expect(t.channel).toBe("gitlab")
    expect(t.route).toEqual(["coder-agent", "devops-agent"])
    expect(t.hops.map((h) => h.node)).toEqual(["peer-a", "mac"])
  })

  it("renders a 3-hop chain in order, across mesh peers", () => {
    const root = { kind: "human" as const, channel: "voice", agentId: "secretary-agent" }
    const ds = [
      chat("secretary-agent", "voice", 100),
      ask("idle-agent", "secretary-agent", 200, { root, nodeId: "peer-a", resolvedAt: null, active: true }),
      ask("devops-agent", "idle-agent", 300, { root, inputPreview: "ship !9" }),
    ]
    const t = trainOf(ds, "devops-agent")
    expect(t.channel).toBe("voice")
    expect(t.route).toEqual(["secretary-agent", "idle-agent", "devops-agent"])
    expect(t.hops.map((h) => `${h.from ?? "voice"}→${h.to}@${h.node}`)).toEqual([
      "voice→secretary-agent@mac", "secretary-agent→idle-agent@peer-a", "idle-agent→devops-agent@mac",
    ])
    expect(routeOf(t, undefined, (id) => id)).toEqual(["Unknown", "Voice", "secretary-agent", "idle-agent", "devops-agent", WEB])
  })

  it("falls back to the root marker when the run that started it is missing", () => {
    const root = { kind: "human" as const, channel: "telegram", sender: "Sam", agentId: "secretary-agent" }
    const ds = [ask("devops-agent", "idle-agent", 300, { root })]
    const t = trainOf(ds, "devops-agent")
    expect(t).toMatchObject({ channel: "telegram", startedBy: "Sam", originId: null })
    expect(t.route).toEqual(["secretary-agent", "idle-agent", "devops-agent"])
    expect(t.hops[0]).toMatchObject({ dispatchId: null, from: null, to: "secretary-agent" })
  })

  it("draws a callback as a return hop on the train it answers, not as a new origin", () => {
    const root = { kind: "human" as const, channel: "app", agentId: "secretary-agent" }
    const ds = [
      chat("secretary-agent", "app", 100, { active: false, resolvedAt: 150 }),
      ask("devops-agent", "secretary-agent", 140, { root, inputPreview: "check !7" }),
      chat("secretary-agent", "app", 900, { initiatorId: "devops-agent", initiatorKind: "a2a", callback: { from: "devops-agent", status: "done" } }),
    ]
    const tt = buildTransit(snapshot(ds), ds)
    const t = tt.trains.find((x) => x.agentId === "devops-agent")!
    expect(t.channel).toBe("app")
    expect(t.route).toEqual(["secretary-agent", "devops-agent"])
    expect(t.hops.map((h) => `${h.kind}:${h.from}→${h.to}`)).toEqual([
      "ask:null→secretary-agent", "ask:secretary-agent→devops-agent", "return:devops-agent→secretary-agent",
    ])
    expect(tt.trains.some((x) => x.channel === "mesh")).toBe(false)
    expect(tt.trains).toHaveLength(1)
  })

  it("never takes a run the sender started well after the hop as its parent", () => {
    const ds = [
      chat("secretary-agent", "voice", 100_000, { active: false, resolvedAt: 103_000 }),
      ask("devops-agent", "secretary-agent", 103_500),
      hookRun("secretary-agent", 127_000),
    ]
    const t = trainOf(ds, "devops-agent")
    expect(t.channel).toBe("voice")
    expect(t.route).toEqual(["secretary-agent", "devops-agent"])
  })

  it("keeps the full chain when a filter hides the runs that started it", () => {
    const root = { kind: "human" as const, channel: "voice", agentId: "secretary-agent" }
    const all = [
      chat("secretary-agent", "voice", 100, { active: false, resolvedAt: 250 }),
      ask("idle-agent", "secretary-agent", 200, { root, resolvedAt: 260 }),
      ask("devops-agent", "idle-agent", 240, { root, active: true, resolvedAt: null }),
    ]
    const t = trainOf(all.filter((d) => d.active), "devops-agent", all)
    expect(t.route).toEqual(["secretary-agent", "idle-agent", "devops-agent"])
  })

  describe("layout of long chains", () => {
    const root = { kind: "human" as const, channel: "voice", agentId: "secretary-agent" }
    const ds = [
      chat("secretary-agent", "voice", 100),
      ask("idle-agent", "secretary-agent", 200, { root, active: true, resolvedAt: null }),
      ask("coder-agent", "idle-agent", 300, { root, active: true, resolvedAt: null }),
      ask("devops-agent", "coder-agent", 400, { root }),
    ]
    const t = buildTransit(snapshot(ds), ds)
    const opts = { orientation: "horizontal" as const, showIdle: false, meshAgents: new Set<string>(), agentName: (id: string) => id, allAgents: [] }
    const train = t.trains.find((x) => x.agentId === "devops-agent")!

    it("collapses the middle hops of a 4-hop chain behind a +n expander", () => {
      expect(train.route).toHaveLength(4)
      const net = layoutNetwork(t, opts)
      const first = net.edges.find((e) => e.id === `ho:secretary-agent|coder-agent|${WEB}`)!
      expect(first).toMatchObject({ hidden: 1, trainIds: [train.id], hop: { from: "secretary-agent", to: "coder-agent" } })
      expect(net.nodes.some((n) => n.id === "st:idle-agent")).toBe(false)
    })

    it("draws every hop in order once expanded, horizontally and vertically", () => {
      for (const orientation of ["horizontal", "vertical"] as const) {
        const net = layoutNetwork(t, { ...opts, orientation, expanded: new Set([train.id]) })
        const pos = (id: string) => { const n = net.nodes.find((x) => x.id === `st:${id}`)!; return orientation === "horizontal" ? n.x : n.y }
        expect(pos("secretary-agent")).toBeLessThan(pos("idle-agent"))
        expect(pos("idle-agent")).toBeLessThan(pos("coder-agent"))
        expect(pos("coder-agent")).toBeLessThan(pos("devops-agent"))
        expect(net.edges.filter((e) => e.hop).map((e) => e.id)).toContain(`ho:idle-agent|coder-agent|${WEB}`)
        expect(net.edges.some((e) => e.hidden)).toBe(false)
      }
    })

    it("tags every hop and feeder with its line, so focus can dim the others", () => {
      const net = layoutNetwork(t, opts)
      for (const e of net.edges) expect(e.lineId).toBe(WEB)
    })
  })

  describe("feeders past an interchange (#559)", () => {
    const hOpts = { orientation: "horizontal" as const, showIdle: false, meshAgents: new Set<string>(), agentName: (id: string) => id, allAgents: [] }
    const github = (agentId: string, at: number) => dispatch({
      agentId, channelId: "github", initiatorId: "anis", initiatorKind: "github", clientId: "acme", projectId: "acme/api",
      subject: "acme/api · pull_request:557", inputPreview: "[GitHub acme/api pull_request #557: release]", startedAt: at, active: true, resolvedAt: null,
    })
    /** Stations other than its own end that a feeder's drawn path touches. */
    const touched = (ds: FleetDispatch[], feeder: string, orientation: "horizontal" | "vertical" = "horizontal") => {
      const net = layoutNetwork(buildTransit(snapshot(ds), ds), { ...hOpts, orientation })
      const e = net.edges.find((x) => x.id.startsWith(feeder))!
      const s = net.nodes.find((n) => n.id === e.source)!, t = net.nodes.find((n) => n.id === e.target)!
      const pts = orientation === "horizontal"
        ? metroPoints(s.x + s.w, s.y + s.h / 2, t.x, t.y + t.h / 2, orientation, e.offset, e.via)
        : metroPoints(s.x + s.w / 2, s.y + s.h, t.x + t.w / 2, t.y, orientation, e.offset, e.via)
      return { edge: e, hit: net.nodes.filter((n) => n.kind === "station" && n.id !== e.target && crossesBox(pts, n)).map((n) => n.id) }
    }
    // Voice → Secretary → DevOps is a real hand-off; GitHub → Coder is direct.
    const ds = [
      chat("secretary-agent", "voice", 100, { active: true, resolvedAt: null }),
      ask("devops-agent", "secretary-agent", 200, { active: true, resolvedAt: null }),
      github("coder-agent", 300),
    ]

    it("goes straight to the agent that got the work, clear of an interchange that took no part", () => {
      for (const orientation of ["horizontal", "vertical"] as const) {
        const { edge, hit } = touched(ds, "fd:github|", orientation)
        expect(edge.target).toBe("st:coder-agent")
        expect(hit).toEqual([])
      }
    })

    it("stays clear on a busy map, where a channel line is too steep for one 45° leg", () => {
      const busy = [...ds, ...["a1", "a2", "a3", "a4", "a5", "a6"].flatMap((a, i) => [github(a, 400 + i), chat(a, "telegram", 500 + i)])]
      for (const orientation of ["horizontal", "vertical"] as const) {
        const net = layoutNetwork(buildTransit(snapshot(busy), busy), { ...hOpts, orientation })
        const feeders = net.edges.filter((e) => e.id.startsWith("fd:"))
        expect(feeders.length).toBeGreaterThan(8)
        for (const e of feeders) expect(touched(busy, e.id, orientation).hit).toEqual([])
      }
    })

    it("stays clear on the phone when the agent is far to the side of its channel", () => {
      // Fixed random maps: up to 8 pieces of work over 12 agents, half handed on once or twice.
      let seed = 1
      const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return Math.floor((seed / 2 ** 32) * n) }
      const agents = Array.from({ length: 12 }, (_, i) => `a${i}`)
      for (let m = 0; m < 60; m++) {
        const map: FleetDispatch[] = []
        for (let i = 0, n = 1 + rnd(8); i < n; i++) {
          let from = agents[rnd(12)]
          map.push(chat(from, ["github", "gitlab", "telegram", "voice", "whatsapp"][rnd(5)], 100 + i * 10, { projectId: `acme/p${rnd(4)}` }))
          for (let k = 0, hops = rnd(2) ? 1 + rnd(2) : 0; k < hops; k++) {
            const to = agents.filter((a) => a !== from)[rnd(11)]
            map.push(ask(to, from, 101 + i * 10 + k, { active: true, resolvedAt: null }))
            from = to
          }
        }
        for (const orientation of ["horizontal", "vertical"] as const) {
          const net = layoutNetwork(buildTransit(snapshot(map), map), { ...hOpts, orientation })
          for (const e of net.edges.filter((x) => x.id.startsWith("fd:"))) expect(touched(map, e.id, orientation).hit, `map ${m}, ${orientation}, ${e.id}`).toEqual([])
        }
      }
    })

    it("still draws a real hand-off through the interchange", () => {
      const t = buildTransit(snapshot(ds), ds)
      expect(t.trains.find((x) => x.agentId === "coder-agent")!.route).toEqual(["coder-agent"])
      const net = layoutNetwork(t, hOpts)
      expect(net.edges.some((e) => e.id.startsWith("fd:voice|secretary-agent|"))).toBe(true)
      expect(net.edges.some((e) => e.id.startsWith("ho:secretary-agent|devops-agent|"))).toBe(true)
      expect(net.edges.some((e) => e.hop?.to === "coder-agent")).toBe(false)
    })

    it("tells a line through a box from one beside it", () => {
      const box = { x: 10, y: 10, w: 10, h: 10 }
      expect(crossesBox([[0, 0], [30, 30]], box)).toBe(true)
      expect(crossesBox([[0, 0], [30, 0], [30, 30]], box)).toBe(false)
      expect(crossesBox([[0, 0], [30, 0], [30, 30]], box, 12)).toBe(true)
      expect(metroPath(0, 0, 100, 0, "horizontal", 0, { m0: 40, m1: 60, c: 10 })).toBe("M 0 0 L 10 0 L 20 10 L 40 10 L 60 10 L 70 10 L 80 0 L 100 0")
    })
  })

  it("reads the root and callback markers off a stored event", async () => {
    const { lineageOf } = await import("../src/daemon/activity-graph-lineage")
    expect(lineageOf({ context: { channel: "a2a", initiator: { kind: "human", channel: "gitlab", sender: "sam", agentId: "coder-agent", chatId: "x" } } }))
      .toEqual({ root: { kind: "human", channel: "gitlab", sender: "sam", agentId: "coder-agent" } })
    expect(lineageOf({ context: { channel: "app", delegation: { taskId: "dlg-1", from: "devops-agent", status: "done" } } }))
      .toEqual({ callback: { from: "devops-agent", status: "done" } })
    expect(lineageOf({ context: { initiator: { kind: "robot", channel: "x" } } })).toEqual({})
    expect(lineageOf({ object_kind: "merge_request" })).toEqual({})
  })
})
