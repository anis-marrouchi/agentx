import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import { inboundTaskRaw, recordMeshDispatch } from "../src/intent/sources/mesh"
import { buildFleetSnapshot } from "../src/daemon/activity-graph-panel"
import { starterOf, type StarterInput } from "../src/daemon/activity-graph-starter"
import { daemonConfigSchema } from "../src/daemon/config"
import { operatorContext } from "../src/requests/operator"
import { personOfTurn, type Person } from "../src/people/people"
import { buildTransit, routeOf } from "../src/web/activity-graph/transit"
import { layoutNetwork } from "../src/web/activity-graph/transit-layout"
import type { FleetDispatch, FleetSnapshot } from "../src/web/activity-graph/api"

// #432: the Activity map's first column is who or what started the work:
// a person, AgentX itself or an external system. The channel comes second.

const people: Person[] = [
  { id: "sara", name: "Sara", role: "member", identities: ["gitlab:sara.b", "telegram:4711"] },
  { id: "omar", name: "Omar", role: "owner", identities: ["github:omar-dev"] },
]
const LABEL: Record<string, string> = { api: "Web API", github: "GitHub", gitlab: "GitLab" }
const of = (p: Partial<StarterInput>) => starterOf({ source: "mesh", channel: "mesh", raw: {}, people, channelLabel: (c) => LABEL[c] ?? c, ...p })
const task = (context: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({ agentId: "alpha", context, message: "x", ...extra })

describe("who started a run", () => {
  it("is the listed person behind a login or platform id, whatever the channel", () => {
    expect(of({ channel: "gitlab", raw: task({ channel: "gitlab", sender: "Sara B", senderUsername: "sara.b", senderId: "shop/web:issue:5" }) }))
      .toEqual({ kind: "person", id: "person:sara", name: "Sara" })
    expect(of({ source: "telegram", channel: "telegram", raw: { text: "hi", sender: { id: 4711, username: "sb", name: "S" } } }).id).toBe("person:sara")
    expect(of({ source: "github", channel: "github", raw: { sender: { login: "omar-dev" }, issue: { title: "t" } } }).id).toBe("person:omar")
    expect(of({ source: "workflow", channel: "gitlab", raw: { event: { payload: { issueEvent: { user: { username: "sara.b", name: "Sara B" } } } } } }).id).toBe("person:sara")
  })

  it("reads unknown for a sender that matches nobody, and never guesses from a display name", () => {
    expect(of({ channel: "gitlab", raw: task({ channel: "gitlab", sender: "Sara", senderUsername: "someone.else" }) }))
      .toEqual({ kind: "person", id: "unknown", name: "Unknown" })
    expect(of({ source: "telegram", channel: "telegram", raw: { sender: { id: 99, name: "Sara" } } }).id).toBe("unknown")
  })

  it("names the owner on this machine's own surfaces only when the daemon recorded the proof", () => {
    const ctx = { channel: "app", chatId: "app:c1", sender: "operator" }
    expect(of({ channel: "app", raw: task(ctx, { person: "omar" }) })).toEqual({ kind: "person", id: "person:omar", name: "Omar" })
    // Recorded as nobody, or stored before the person was recorded: a bare
    // channel name proves nothing (#393).
    expect(of({ channel: "app", raw: task(ctx, { person: null }) }).id).toBe("unknown")
    expect(of({ channel: "app", raw: task(ctx) }).id).toBe("unknown")
    expect(of({ channel: "voice", people: [], raw: task({ channel: "voice", sender: "Voice" }, { person: "owner" }) }).name).toBe("Owner")
    // The desktop assistant is recorded under its own channel: the same rule.
    const desktop = { channel: "desktop", sender: "Desktop", chatId: "desktop:alpha" }
    expect(of({ channel: "desktop", raw: task(desktop, { person: "omar" }) }).id).toBe("person:omar")
    expect(of({ channel: "desktop", raw: task(desktop, { person: null }) }).id).toBe("unknown")
  })

  it("names a person listed after the event arrived", () => {
    const raw = task({ channel: "gitlab", sender: "Sara B", senderUsername: "sara.b" }, { person: null })
    expect(of({ channel: "gitlab", raw, people: [] }).id).toBe("unknown")
    expect(of({ channel: "gitlab", raw }).id).toBe("person:sara")
  })

  it("is AgentX for a schedule, a workflow step and an agent acting on its own", () => {
    const agentx = { kind: "agentx", id: "agentx", name: "AgentX" }
    expect(of({ source: "cron", channel: "cron", raw: { jobId: "daily-brief", agentId: "alpha" } })).toEqual(agentx)
    expect(of({ source: "workflow", channel: "workflow", raw: { workflowId: "digest" } })).toEqual(agentx)
    expect(of({ channel: "a2a", raw: task({ channel: "a2a", sender: "agent:atlas" }, { senderAgentId: "atlas" }) })).toEqual(agentx)
    expect(of({ channel: "mesh", raw: task(undefined) })).toEqual(agentx)
    expect(of({ channel: "api", raw: task({ channel: "api" }, { senderAgentId: "atlas" }) })).toEqual(agentx)
    // An agent's own comment, posted with a person's account.
    expect(of({ channel: "github", raw: task({ channel: "github", sender: "agent:atlas", senderUsername: "omar-dev" }, { person: null }) })).toEqual(agentx)
  })

  it("is the external system for a service that is not a person", () => {
    expect(of({ channel: "api", raw: task({ channel: "api", chatId: "x" }) })).toEqual({ kind: "external", id: "ext:api", name: "Web API" })
    expect(of({ channel: "github", raw: task({ channel: "github", sender: "dependabot[bot]", senderUsername: "dependabot[bot]" }) }))
      .toEqual({ kind: "external", id: "ext:github", name: "GitHub" })
    expect(of({ source: "gitlab", channel: "gitlab", raw: { object_kind: "pipeline" } })).toEqual({ kind: "external", id: "ext:gitlab", name: "GitLab" })
    expect(of({ channel: "hn-watch", raw: task({ channel: "hn-watch" }) })).toEqual({ kind: "external", id: "ext:hn-watch", name: "hn-watch" })
  })

  it("follows the root a delegated hop carries", () => {
    const hop = (initiator: Record<string, unknown>) => of({ channel: "a2a", raw: task({ channel: "a2a", sender: "agent:atlas", initiator }, { senderAgentId: "atlas" }) })
    expect(hop({ kind: "human", channel: "gitlab", sender: "Sara B", person: "sara" }).id).toBe("person:sara")
    expect(hop({ kind: "human", channel: "voice", sender: "Voice" }).id).toBe("unknown")
    expect(hop({ kind: "agent", channel: "workflow", sender: "workflow" }).id).toBe("agentx")
    expect(hop({ kind: "agent", channel: "api" }).id).toBe("agentx")
  })
})

describe("the snapshot carries the initiator", () => {
  let tmp: string
  let ledger: IntentLedger
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "agentx-starter-"))
    ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
  })
  afterEach(() => {
    ledger.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  /** What recordInboundDispatch stores: the person resolved at arrival. */
  function receive(agent: string, context: Record<string, unknown>, senderAgentId?: string) {
    const person = personOfTurn(people, context)?.id ?? null
    recordMeshDispatch(ledger, { agentId: agent, senderAgentId, context: context as any },
      inboundTaskRaw(agent, senderAgentId, context, "x", person), { agentId: agent, outcome: "dispatched", reason: null })
  }

  it("for a marked phone turn, an unmarked one, and a forge event", () => {
    receive("alpha", operatorContext({ channel: "app", chatId: "app:c1", sender: "operator" }))
    receive("alpha", { channel: "app", chatId: "app:c2", sender: "operator" })
    receive("alpha", { channel: "gitlab", chatId: "shop/web:issue:5", sender: "Sara B", senderUsername: "sara.b" })
    const config = daemonConfigSchema.parse({ node: { id: "a", name: "a" }, people })
    const starters = buildFleetSnapshot(ledger.db, config, 6).dispatches.map((d) => d.starter?.id)
    expect(starters).toEqual(["person:omar", "unknown", "person:sara"])
  })
})

let seq = 0
function dispatch(p: Partial<FleetDispatch>): FleetDispatch {
  seq++
  return {
    id: `s${seq}`, agentId: "builder", clientId: "shop", projectId: "shop/web",
    channelId: "gitlab", initiatorId: "sara.b", initiatorKind: "gitlab", subject: `Issue #${seq}`, intent: "mesh.gitlab",
    startedAt: 1_000 + seq, resolvedAt: 2_000 + seq, duration: 1_000, active: false, outcome: "completed",
    tokens: 0, inputPreview: "", system: false, nodeId: "mac", ...p,
  }
}
function snapshot(dispatches: FleetDispatch[]): FleetSnapshot {
  return {
    now: 10_000, windowH: 6, localNodeId: "mac",
    clients: [{ id: "shop", name: "shop", color: "#111111", projects: ["shop/web"] }],
    agents: ["cx", "builder", "scout"].map((id) => ({ id, name: id, tier: "lead" as const, model: "", role: "" })),
    channels: [], initiators: [], dispatches,
  }
}

describe("the map puts the initiator before the channel", () => {
  const sara = { kind: "person" as const, id: "person:sara", name: "Sara" }
  const agentx = { kind: "agentx" as const, id: "agentx", name: "AgentX" }
  const ds = [
    dispatch({ agentId: "cx", subject: "shop/web · issue:7", inputPreview: "[GitLab shop/web issue #7: x]", starter: sara, startedAt: 100 }),
    dispatch({ agentId: "builder", channelId: "a2a", initiatorId: "cx", initiatorKind: "a2a", subject: "→ builder", inputPreview: "Fix the login page", starter: sara, root: { kind: "human", channel: "gitlab", sender: "Sara B", agentId: "cx" }, startedAt: 200 }),
    dispatch({ agentId: "scout", clientId: "unmapped", projectId: "unmapped/_cron", channelId: "cron", initiatorId: "cron:brief", initiatorKind: "cron", subject: "cron:brief", starter: agentx, startedAt: 300 }),
  ]
  const transit = buildTransit(snapshot(ds), ds)
  const opts = { orientation: "horizontal" as const, showIdle: false, meshAgents: new Set<string>(), agentName: (id: string) => id, allAgents: ["cx", "builder", "scout"] }
  const train = (tag: string) => transit.trains.find((t) => t.tag === tag)!

  it("reads a train's route as initiator › channel › agents › line", () => {
    expect(train("#7").starter).toEqual(sara)
    // The hand-off keeps the person who started the chain.
    const handed = transit.trains.find((t) => t.agentId === "builder")!
    expect(routeOf(handed, transit.lines.find((l) => l.id === "shop/web"), (id) => id)).toEqual(["Sara", "GitLab", "cx", "builder", "WB"])
    expect(train("cron").starter).toEqual(agentx)
  })

  it("draws initiators left of the channels and links each to the channel it came through", () => {
    const net = layoutNetwork(transit, opts)
    const node = (id: string) => net.nodes.find((n) => n.id === id)!
    expect(net.nodes.filter((n) => n.kind === "starter").map((n) => [n.label, n.sub])).toEqual(expect.arrayContaining([["Sara", "Person"], ["AgentX", "AgentX"]]))
    expect(node("in:person:sara").x + node("in:person:sara").w).toBeLessThan(node("ch:gitlab").x)
    const pairs = net.edges.filter((e) => e.kind === "feeder").map((e) => `${e.source}>${e.target}`)
    expect(pairs).toEqual(expect.arrayContaining(["in:person:sara>ch:gitlab", "ch:gitlab>st:cx", "in:agentx>ch:cron", "ch:cron>st:scout"]))
    expect(net.edges.find((e) => e.source === "in:person:sara")).toMatchObject({ starter: "person:sara", lineId: "shop/web" })
  })

  it("keeps the phone layout: the initiator sits above the channel", () => {
    const net = layoutNetwork(transit, { ...opts, orientation: "vertical", lineId: "shop/web" })
    const node = (id: string) => net.nodes.find((n) => n.id === id)!
    expect(net.nodes.filter((n) => n.kind === "starter").map((n) => n.label)).toEqual(["Sara"])
    expect(node("in:person:sara").y + node("in:person:sara").h).toBeLessThan(node("ch:gitlab").y)
  })

  it("does not guess a person for rows from a peer that sends no initiator", () => {
    const old = [
      dispatch({ agentId: "cx", subject: "shop/web · issue:9", inputPreview: "[GitLab shop/web issue #9: x]" }),
      dispatch({ agentId: "scout", channelId: "cron", initiatorId: "cron:brief", initiatorKind: "cron", subject: "cron:brief" }),
    ]
    const t = buildTransit(snapshot(old), old)
    expect(t.trains.find((x) => x.tag === "#9")!.starter.id).toBe("unknown")
    expect(t.trains.find((x) => x.tag === "cron")!.starter.id).toBe("agentx")
  })
})
