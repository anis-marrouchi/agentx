import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"

// Run an issue on another machine (#2104, design v3): one order
// (workflow home > placement > mapping > none) read by the router and by
// registry.execute; a placed run is sent synchronously with its context
// and `placed`, refused when the peer cannot apply the run's limits; the
// placement lives per issue chat and survives request pruning.

const run = vi.hoisted(() => ({ calls: 0 }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, executeTask: () => { run.calls++; return Promise.resolve({ content: "ran here", duration: 1 }) } }
})

import { MessageRouter } from "../src/channels/router"
import type { IncomingMessage } from "../src/channels/types"
import { droppedNoteText, issueKeysOfHome, issueKeysOfTask, issueOfChat, offlineNoteText, pickPreferNode, resolveRunNode, workflowEntityRefs } from "../src/channels/run-on"
import { meshContextOf, meshForwardBlock, placedRefusalText } from "../src/agents/mesh-safety"
import { AgentRegistry } from "../src/agents/registry"
import { checkoutsOf } from "../src/agents/task-worktrees"
import { daemonConfigSchema } from "../src/daemon/config"
import { RequestStore, type Placement } from "../src/requests/store"
import { WebhookHandler, forgeIssueHomeOf } from "../src/daemon/webhooks"
import { getEventBus } from "../src/events/bus"

const ISSUE_CHAT = "acme/app:issue:7"
const at = (node: string): Placement => ({ node, setBy: "owner", setAt: 1 })

describe("the order", () => {
  it("workflow home > placement > mapping > none, and local beats the mapping", () => {
    expect(pickPreferNode({ workflowHome: "box", placement: at("clawd"), mapping: "nas" })).toEqual({ node: "box", source: "workflow" })
    expect(pickPreferNode({ workflowHome: "local", placement: at("clawd"), mapping: "nas" })).toEqual({ source: "workflow" })
    expect(pickPreferNode({ placement: at("clawd"), mapping: "nas" })).toEqual({ node: "clawd", source: "placement" })
    expect(pickPreferNode({ placement: at("local"), mapping: "nas" })).toEqual({ source: "placement" })
    expect(pickPreferNode({ mapping: "nas" })).toEqual({ node: "nas", source: "mapping" })
    expect(pickPreferNode({})).toEqual({ source: "none" })
  })

  it("reads the issue a task names: its chat, its home, or its request's home", () => {
    expect(issueOfChat("github", ISSUE_CHAT)).toEqual({ provider: "github", project: "acme/app", number: 7 })
    expect(issueOfChat("github", "acme/app:pull:7")).toBeNull()
    expect(issueKeysOfTask({ channel: "github", chatId: "Acme/App:issue:7" }, {})).toEqual([{ channel: "github", chatId: "acme/app:issue:7" }])
    expect(issueKeysOfHome("https://gitlab.example/g/sub/p/-/issues/3")).toEqual([{ channel: "github", chatId: "g/sub/p:issue:3" }, { channel: "gitlab", chatId: "g/sub/p:issue:3" }])
    expect(issueKeysOfHome("g/p!3")).toEqual([])
    expect(issueKeysOfTask({ channel: "cron", chatId: "cron:x", home: "acme/app#7" }, {})).toHaveLength(2)
    expect(issueKeysOfTask({ channel: "requests", chatId: "wp-1" }, { requestHome: (id) => (id === "wp-1" ? "https://github.com/acme/app/issues/7" : null) })[0]).toEqual({ channel: "github", chatId: ISSUE_CHAT })
    expect(issueKeysOfTask({ channel: "telegram", chatId: "1" }, {})).toEqual([])
    expect(workflowEntityRefs("gitlab", "g/p:issue:3")).toEqual([{ backend: "gitlab", id: "g/p#3" }, { backend: "gitlab", id: "gitlab:g/p:issue:3" }])
  })

  it("resolveRunNode finds the placement under the chat it is kept", () => {
    const rows: Record<string, Placement> = { [`gitlab ${"g/p:issue:3"}`]: at("clawd") }
    const placement = (c: string, id: string) => rows[`${c} ${id}`] ?? null
    expect(resolveRunNode({ context: { channel: "cron", home: "g/p#3" } }, { placement })).toEqual({ key: { channel: "gitlab", chatId: "g/p:issue:3" }, placement: at("clawd") })
    expect(resolveRunNode({ context: { channel: "cron", home: "g/p#4" } }, { placement })).toBeNull()
  })
})

describe("issue_placements: a place that lasts", () => {
  let tmp: string
  let db: Database.Database
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "agentx-place-")); db = new Database(join(tmp, "db.sqlite")) })
  afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }) })

  it("sets, reads without case, writes local, restores", () => {
    const store = new RequestStore(db)
    expect(store.placement("github", ISSUE_CHAT)).toBeNull()
    store.setPlacement("github", "Acme/App:issue:7", at("clawd"))
    expect(store.placement("github", ISSUE_CHAT)).toEqual(at("clawd"))
    expect(store.placement("gitlab", ISSUE_CHAT)).toBeNull()
    store.setPlacement("github", ISSUE_CHAT, { node: "local", setBy: "owner", setAt: 2 })
    expect(store.placement("github", ISSUE_CHAT)?.node).toBe("local")
    store.restorePlacement("github", ISSUE_CHAT, at("clawd"))
    expect(store.placement("github", ISSUE_CHAT)).toEqual(at("clawd"))
    store.restorePlacement("github", ISSUE_CHAT, null)
    expect(store.placement("github", ISSUE_CHAT)).toBeNull()
  })

  it("survives the requests on the issue being pruned", () => {
    const store = new RequestStore(db)
    store.addPromise({ id: "r1", channel: "dashboard", chatId: "wall", agentId: "coder", text: "fix", owedTo: "owner", home: { kind: "issue", link: "https://github.com/acme/app/issues/7" }, now: 10 })
    store.setPlacement("github", ISSUE_CHAT, at("clawd"))
    store.close("r1", "done", "fixed", 20)
    expect(store.pruneClosed(Date.now() + 1)).toBe(1)
    expect(store.get("r1")).toBeNull()
    expect(store.placement("github", ISSUE_CHAT)).toEqual(at("clawd"))
    expect((db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>).map((c) => c.name)).not.toContain("run_on")
  })
})

describe("the shared mesh safety predicate", () => {
  it("refuses restricted autonomy and person limits, and strips local paths", () => {
    expect(meshForwardBlock("coder", "report", null)?.kind).toBe("autonomy")
    expect(meshForwardBlock("coder", undefined, { personId: "sara", name: "Sara", tools: ["Bash"], skills: [] })).toMatchObject({ kind: "limits", name: "Sara" })
    expect(meshForwardBlock("coder", "act", null)).toBeNull()
    expect(meshContextOf({ channel: "github", chatId: "c", home: "h", runbookPath: "/here", runbookFiles: ["CLAUDE.md"] })).toEqual({ channel: "github", chatId: "c", home: "h" })
    expect(placedRefusalText("clawd")).toBe("This issue runs on clawd, which can't apply your limits. Ask the owner to bring it back to this Mac.")
  })
})

describe("MessageRouter with a placement", () => {
  let router: MessageRouter
  let sendTask: ReturnType<typeof vi.fn>
  let execute: ReturnType<typeof vi.fn>
  let healthy: boolean
  let localAgent: boolean
  let recovered: (() => void) | undefined
  let place: { workflow: string | null; placement: Placement | null }
  let sent: Array<{ chatId: string; text: string }>
  const adapter: any = { name: "github", send: vi.fn(async (m: any) => { sent.push({ chatId: m.chatId, text: m.text }); return "c1" }), react: vi.fn(), sendTyping: vi.fn() }
  const people = [{ id: "sara", name: "Sara", role: "member", identities: ["github:sara-b"], agents: [], deny: { tools: ["Bash"], skills: [] } }]

  const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
    id: `m-${Math.random()}`, channel: "github", accountId: "default",
    sender: { id: ISSUE_CHAT, name: "anis", username: "anis" } as any,
    text: "[GitHub Issue #7: x]\nanis commented:\nplease fix", timestamp: new Date(),
    runbookPath: "/only/here", runbookFiles: ["CLAUDE.md"], ...over,
  } as IncomingMessage)

  beforeEach(() => {
    sent = []
    healthy = true
    localAgent = false
    place = { workflow: null, placement: null }
    sendTask = vi.fn(async () => "done on clawd")
    execute = vi.fn(async () => ({ content: "answered", duration: 1 }))
    router = new MessageRouter({ getAgent: () => (localAgent ? { id: "coder", name: "Coder" } : undefined), refusalFor: () => null, execute } as any, { channels: { telegram: { accounts: [] } }, people } as any)
    router.setMesh({
      directory: () => [{ peer: "clawd", peerUrl: "u", healthy, skills: [{ id: "coder" }], channels: [] }, { peer: "nas", peerUrl: "n", healthy: true, skills: [{ id: "coder" }], channels: [] }],
      findAgentPeer: () => ({ peer: "clawd", healthy }),
      sendTask,
      onPeerChange: (cb: any) => { recovered = () => cb({ peer: "clawd", healthy: true, skills: ["coder"], delta: "recovered" }) },
    } as any)
    router.setPlacement({ workflowHome: () => place.workflow, placement: (c, id) => (c === "github" && id === ISSUE_CHAT ? place.placement : null) })
  })

  it("resolves workflow home > placement > mapping > none", () => {
    place = { workflow: "box", placement: at("clawd") }
    expect(router.resolvePreferNode(msg({ preferNode: "nas" }), "coder")).toEqual({ node: "box", source: "workflow" })
    place = { workflow: null, placement: at("clawd") }
    expect(router.resolvePreferNode(msg({ preferNode: "nas" }), "coder")).toEqual({ node: "clawd", source: "placement" })
    place = { workflow: null, placement: at("local") }
    expect(router.resolvePreferNode(msg({ preferNode: "nas" }), "coder")).toEqual({ source: "placement" })
    place = { workflow: null, placement: null }
    expect(router.resolvePreferNode(msg({ preferNode: "nas" }), "coder")).toEqual({ node: "nas", source: "mapping" })
    expect(router.resolvePreferNode(msg({ sender: { id: "acme/app:pull:7", name: "anis" } as any }), "coder")).toEqual({ source: "none" })
  })

  it("does not forward on the mapping when the issue is placed: the local registry takes it", async () => {
    localAgent = true
    place.placement = at("clawd")
    await (router as any).processResolvedMessage(adapter, msg({ preferNode: "nas" }), "coder", ISSUE_CHAT)
    expect(sendTask).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("local beats the mapping", async () => {
    localAgent = true
    place.placement = at("local")
    await (router as any).processResolvedMessage(adapter, msg({ preferNode: "nas" }), "coder", ISSUE_CHAT)
    expect(sendTask).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("with no local agent, sends the placed run to the node with placed: true and no local paths", async () => {
    place.placement = at("clawd")
    await (router as any).processResolvedMessage(adapter, msg({ preferNode: "nas" }), "coder", ISSUE_CHAT)
    const [peer, , , opts] = sendTask.mock.calls[0] as any[]
    expect(peer).toBe("clawd")
    expect(opts.context).toMatchObject({ channel: "github", chatId: ISSUE_CHAT, placed: true })
    expect(opts.context.runbookPath).toBeUndefined()
  })

  it("refuses, not forwards, a placed run for a person with limits (no local agent)", async () => {
    place.placement = at("clawd")
    await (router as any).processResolvedMessage(adapter, msg({ sender: { id: ISSUE_CHAT, name: "sara-b", username: "sara-b" } as any }), "coder", ISSUE_CHAT)
    expect(sendTask).not.toHaveBeenCalled()
    expect(sent.map((s) => s.text)).toEqual([placedRefusalText("clawd")])
  })

  it("holds a placed run for an offline node and tells the issue once per outage", async () => {
    localAgent = true
    place.placement = at("clawd")
    healthy = false
    const r = router as any
    await r.processResolvedMessage(adapter, msg(), "coder", ISSUE_CHAT)
    await r.processResolvedMessage(adapter, msg(), "coder", ISSUE_CHAT)
    expect(execute).not.toHaveBeenCalled()
    expect(router.getDeferredMeshCounts()).toEqual({ clawd: 2 })
    expect(sent).toEqual([{ chatId: ISSUE_CHAT, text: offlineNoteText("clawd") }])
    // Back: the held messages go through the local registry, which sends them on.
    healthy = true
    recovered!()
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    healthy = false
    await r.processResolvedMessage(adapter, msg(), "coder", ISSUE_CHAT)
    expect(sent.filter((s) => s.text === offlineNoteText("clawd"))).toHaveLength(2)
  })

  it("C1: dropped held messages are told on the issue, with the count and why", async () => {
    localAgent = true
    place.placement = at("clawd")
    healthy = false
    const r = router as any
    for (let i = 0; i < 3; i++) await r.processResolvedMessage(adapter, msg(), "coder", ISSUE_CHAT)
    for (const d of r.deferredByPeer.get("clawd")) d.deferredAt = Date.now() - 31 * 60_000
    healthy = true
    await r.replayDeferred("clawd")
    expect(sent.map((s) => s.text)).toContain(droppedNoteText("clawd", 3, "ttl"))
    expect(execute).not.toHaveBeenCalled()
    // A full queue: told once per outage.
    sent = []
    healthy = false
    for (let i = 0; i < 53; i++) await r.processResolvedMessage(adapter, msg(), "coder", ISSUE_CHAT)
    expect(sent.filter((s) => s.text === droppedNoteText("clawd", 1, "full"))).toHaveLength(1)
  })
})

describe("AgentRegistry: placement at the start of execute", () => {
  let dir: string
  let registry: AgentRegistry
  let sendTask: ReturnType<typeof vi.fn>
  let placements: Record<string, Placement>
  let peers: Array<{ peer: string; healthy: boolean; skills: Array<{ id: string }> }>
  const prevCwd = process.cwd()
  const people = [{ id: "sara", name: "Sara", role: "member", identities: ["github:sara-b"], agents: [], deny: { tools: ["Bash"], skills: [] } }]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-placed-"))
    process.chdir(dir)
    getEventBus().removeAllListeners()
    run.calls = 0
    registry = new AgentRegistry(daemonConfigSchema.parse({
      node: { id: "mac", name: "mac" }, jobState: { enabled: false }, people,
      agents: { coder: { name: "Coder", tier: "claude-code", workspace: dir, maxExecutionMinutes: 45 } },
    }), () => {})
    sendTask = vi.fn(async () => "ran on clawd")
    peers = [{ peer: "clawd", healthy: true, skills: [{ id: "coder" }] }, { peer: "box", healthy: true, skills: [{ id: "atlas" }] }]
    registry.setMeshFallback({ findPeerWithSkill: () => undefined, sendTask, directory: () => peers })
    placements = { [`github ${ISSUE_CHAT}`]: at("clawd") }
    registry.setPlacements({
      placement: (c, id) => placements[`${c} ${id}`] ?? null,
      requestHome: (id) => (id === "wp-1" ? "https://github.com/acme/app/issues/7" : null),
    })
  })
  afterEach(() => { process.chdir(prevCwd); rmSync(dir, { recursive: true, force: true }) })

  it("a channel message on a placed issue is sent, with context, placed and the agent's time limit", async () => {
    const res = await registry.execute({ agentId: "coder", message: "fix", context: { channel: "github", chatId: ISSUE_CHAT, runbookPath: "/here", runbookFiles: ["X"] } as any })
    expect(res.content).toBe("ran on clawd")
    expect(res.viaMesh).toBe("clawd")
    expect(run.calls).toBe(0)
    const [peer, text, agent, opts] = sendTask.mock.calls[0] as any[]
    expect([peer, text, agent]).toEqual(["clawd", "fix", "coder"])
    expect(opts.timeoutMs).toBe(45 * 60_000)
    expect(opts.context).toMatchObject({ channel: "github", chatId: ISSUE_CHAT, placed: true })
    expect(opts.context.runbookPath).toBeUndefined()
    expect(opts.context.runbookFiles).toBeUndefined()
  })

  it("a Hub turn (a pick-up of a post homed on the issue) is sent, in the issue's chat", async () => {
    const res = await registry.execute({ agentId: "coder", message: "the owner says", context: { channel: "requests", chatId: "wp-1", sender: "operator" } as any })
    expect(res.content).toBe("ran on clawd")
    const opts = (sendTask.mock.calls[0] as any[])[3]
    expect(opts.context).toMatchObject({ channel: "github", chatId: ISSUE_CHAT, placed: true, placedFrom: { channel: "requests", chatId: "wp-1" } })
  })

  it("a cron with a home is sent, under its own timeout", async () => {
    const res = await registry.execute({ agentId: "coder", message: "nightly", timeoutMinutes: 10, context: { channel: "cron", chatId: "cron:n", home: "acme/app#7" } as any })
    expect(res.content).toBe("ran on clawd")
    expect((sendTask.mock.calls[0] as any[])[3].timeoutMs).toBe(10 * 60_000)
  })

  it("a task from a peer is never sent on, and local runs here", async () => {
    await registry.execute({ agentId: "coder", message: "x", context: { channel: "github", chatId: ISSUE_CHAT, placed: true, fromPeer: true } as any })
    placements[`github ${ISSUE_CHAT}`] = at("local")
    await registry.execute({ agentId: "coder", message: "y", context: { channel: "cron", chatId: "c", home: "acme/app#7" } as any })
    expect(sendTask).not.toHaveBeenCalled()
  })

  it("refuses, not sends, restricted autonomy and a person's limits", async () => {
    const auto = await registry.execute({ agentId: "coder", message: "x", autonomy: "report", context: { channel: "cron", chatId: "c", home: "acme/app#7" } } as any)
    expect(auto.content).toBe(placedRefusalText("clawd"))
    const limited = await registry.execute({ agentId: "coder", message: "x", context: { channel: "github", chatId: ISSUE_CHAT, sender: "sara-b", senderUsername: "sara-b" } as any })
    expect(limited.content).toBe(placedRefusalText("clawd"))
    expect(sendTask).not.toHaveBeenCalled()
    expect(run.calls).toBe(0)
  })

  it("an offline node fails the run with the reason", async () => {
    peers[0].healthy = false
    const res = await registry.execute({ agentId: "coder", message: "x", context: { channel: "cron", chatId: "c", home: "acme/app#7" } as any })
    expect(res.error).toBe(offlineNoteText("clawd"))
    expect(sendTask).not.toHaveBeenCalled()
  })

  it("the mesh fallback passes the task context, less local paths", async () => {
    const res = await registry.execute({ agentId: "atlas", message: "hi", context: { channel: "github", chatId: "o/r:issue:1", home: "o/r#1", runbookPath: "/here", runbookFiles: ["X.md"] } as any })
    expect(res.content).toBe("ran on clawd")
    const opts = (sendTask.mock.calls[0] as any[])[3]
    expect(opts.context).toMatchObject({ channel: "github", chatId: "o/r:issue:1", home: "o/r#1" })
    expect(opts.context.runbookPath).toBeUndefined()
  })

  it("C3: a placed task here with no checkout of its repository is refused, not run in the workspace", async () => {
    const res = await registry.execute({ agentId: "coder", message: "hi", context: { channel: "github", chatId: "other/repo:issue:3", placed: true, fromPeer: true } as any })
    expect(res.error).toContain("no checkout")
    expect(run.calls).toBe(0)
  })
})

describe("a mapped webhook loses to the placement", () => {
  it("reads the issue of forge payloads", () => {
    expect(forgeIssueHomeOf("github", { repository: { full_name: "acme/app" }, issue: { number: 7 } })).toBe("acme/app#7")
    expect(forgeIssueHomeOf("github", { repository: { full_name: "acme/app" }, issue: { number: 7, pull_request: {} } })).toBeUndefined()
    expect(forgeIssueHomeOf("gitlab", { object_kind: "issue", project: { path_with_namespace: "g/p" }, object_attributes: { iid: 3 } })).toBe("g/p#3")
    expect(forgeIssueHomeOf("gitlab", { object_kind: "note", project: { path_with_namespace: "g/p" }, object_attributes: { noteable_type: "Issue" }, issue: { iid: 4 } })).toBe("g/p#4")
    expect(forgeIssueHomeOf("stripe", {})).toBeUndefined()
  })

  it("does not forward on webhookEntries[].node; the registry runs it (and sends it to the placed node)", async () => {
    const execute = vi.fn(async () => ({ content: "ok", duration: 1 }))
    const sendTask = vi.fn(async () => "on nas")
    let placed = true
    const registry: any = { execute, placementOf: () => (placed ? { node: "clawd", key: { channel: "github", chatId: ISSUE_CHAT } } : null), getAgent: () => ({}) }
    const handler = new WebhookHandler(registry, {}, () => {}, { sendTask } as any, [{ id: "w", enabled: true, source: "github", agentId: "coder", node: "nas" }] as any)
    const h = handler as any
    h.readBody = async () => ({ raw: Buffer.from("{}"), parsed: { action: "opened", repository: { full_name: "acme/app" }, issue: { number: 7, title: "t" } } })
    h.validateSignature = () => null
    h.fireHookSafe = async () => {}
    const res: any = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() }
    const call = () => h.handle({ headers: { "x-github-event": "issues" }, url: "/webhook/coder/github", method: "POST" }, res, "/webhook/coder/github")
    await call()
    expect(sendTask).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect((execute.mock.calls[0] as any[])[0].context).toMatchObject({ channel: "webhook:github", home: "acme/app#7" })
    placed = false
    await call()
    expect(sendTask).toHaveBeenCalledTimes(1)
  })

  it("C4: a run placed on a peer answers 202 before the registry sends it", async () => {
    let finish!: (v: unknown) => void
    const execute = vi.fn(() => new Promise((r) => { finish = r }))
    const registry: any = { execute, placementOf: () => ({ node: "clawd", key: { channel: "github", chatId: ISSUE_CHAT } }), getAgent: () => ({}) }
    const handler = new WebhookHandler(registry, {}, () => {}, undefined as any, [] as any)
    const h = handler as any
    h.readBody = async () => ({ raw: Buffer.from("{}"), parsed: { action: "created", repository: { full_name: "acme/app" }, issue: { number: 7, title: "t" }, comment: { body: "hi" } } })
    h.validateSignature = () => null
    h.fireHookSafe = async () => {}
    const res: any = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() }
    await h.handle({ headers: { "x-github-event": "issue_comment" }, url: "/webhook/coder/github", method: "POST" }, res, "/webhook/coder/github")
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.anything())
    expect(execute).toHaveBeenCalledTimes(1)
    finish({ content: "ok", duration: 1 })
  })

  it("C4: a run placed local still answers with the run's result", async () => {
    const execute = vi.fn(async () => ({ content: "ok", duration: 1 }))
    const registry: any = { execute, placementOf: () => ({ node: "local", key: { channel: "github", chatId: ISSUE_CHAT } }), getAgent: () => ({}) }
    const handler = new WebhookHandler(registry, {}, () => {}, undefined as any, [] as any)
    const h = handler as any
    h.readBody = async () => ({ raw: Buffer.from("{}"), parsed: { action: "opened", repository: { full_name: "acme/app" }, issue: { number: 7, title: "t" } } })
    h.validateSignature = () => null
    h.fireHookSafe = async () => {}
    const res: any = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() }
    await h.handle({ headers: { "x-github-event": "issues" }, url: "/webhook/coder/github", method: "POST" }, res, "/webhook/coder/github")
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything())
  })
})

describe("checkouts advertised", () => {
  it("lists each origin repository once", () => {
    const remotes: Record<string, string> = { "/a": "git@github.com:Acme/App.git", "/b": "https://github.com/acme/app", "/c": "https://gitlab.example/g/sub/p.git", "/d": "" }
    expect(checkoutsOf(["/a", "/b", "/c", "/d", "/a"], (d) => remotes[d] || undefined)).toEqual(["Acme/App", "g/sub/p"])
  })

  it("reads a real checkout's origin", () => {
    const base = mkdtempSync(join(tmpdir(), "agentx-co-"))
    try {
      execFileSync("git", ["init", "-q", base])
      execFileSync("git", ["-C", base, "remote", "add", "origin", "git@github.com:acme/app.git"])
      expect(checkoutsOf([base, join(base, "missing")])).toEqual(["acme/app"])
    } finally { rmSync(base, { recursive: true, force: true }) }
  })

  it("the mesh directory carries a peer's checkouts from its agent card", async () => {
    const { A2AMesh } = await import("../src/a2a/mesh")
    const mesh = new A2AMesh({ mesh: { peers: [{ name: "clawd", url: "http://100.64.0.2:18800" }], healthCheck: { timeout: 5, interval: 60 } } } as any, () => {})
    const state = (mesh as any).peers.get("clawd")
    state.client.getAgentCard = vi.fn(async () => ({ name: "clawd", skills: [{ id: "coder", name: "Coder" }], checkouts: ["acme/app", 3], placement: 1 }))
    await mesh.discoverAll()
    expect(mesh.directory()[0].checkouts).toEqual(["acme/app"])
    // C2: the card says the peer runs placed issues; an older one does not.
    expect(mesh.directory()[0].placement).toBe(1)
    state.client.getAgentCard = vi.fn(async () => ({ name: "clawd", skills: [] }))
    await mesh.discoverAll()
    expect(mesh.directory()[0].placement).toBeUndefined()
  })
})
