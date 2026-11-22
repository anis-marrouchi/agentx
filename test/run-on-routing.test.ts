import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"

// Run an issue on another machine (#2104): one resolver picks the node
// (workflow home > the issue's runOn > agent mapping > none); a placed run
// carries its context and `placed`, is refused when a person's limits
// apply, and an offline node is told once on the issue.

const run = vi.hoisted(() => ({ calls: 0 }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, executeTask: () => { run.calls++; return Promise.resolve({ content: "ran here", duration: 1 }) } }
})

import { MessageRouter } from "../src/channels/router"
import type { IncomingMessage } from "../src/channels/types"
import { issueOfChat, offlineNoteText, pickPreferNode, workflowEntityRefs } from "../src/channels/run-on"
import { meshContextOf, meshForwardBlock, placedRefusalText } from "../src/agents/mesh-safety"
import { AgentRegistry } from "../src/agents/registry"
import { checkoutsOf } from "../src/agents/task-worktrees"
import { daemonConfigSchema } from "../src/daemon/config"
import { RequestStore, type RunOn } from "../src/requests/store"
import { getEventBus } from "../src/events/bus"

const ISSUE_CHAT = "acme/app:issue:7"
const runOn = (node: string): RunOn => ({ node, setBy: "owner", setAt: 1 })

describe("pickPreferNode: the order", () => {
  it("workflow home > runOn > mapping > none", () => {
    expect(pickPreferNode({ workflowHome: "box", runOn: runOn("clawd"), mapping: "nas" })).toEqual({ node: "box", source: "workflow" })
    expect(pickPreferNode({ workflowHome: "local", runOn: runOn("clawd"), mapping: "nas" })).toEqual({ source: "workflow" })
    expect(pickPreferNode({ workflowHome: null, runOn: runOn("clawd"), mapping: "nas" })).toMatchObject({ node: "clawd", source: "runOn" })
    expect(pickPreferNode({ workflowHome: null, runOn: null, mapping: "nas" })).toEqual({ node: "nas", source: "mapping" })
    expect(pickPreferNode({})).toEqual({ source: "none" })
  })

  it("reads the forge issue and the workflow entities of a chat", () => {
    expect(issueOfChat("github", ISSUE_CHAT)).toEqual({ provider: "github", project: "acme/app", number: 7 })
    expect(issueOfChat("gitlab", "g/sub/p:issue:3")).toEqual({ provider: "gitlab", project: "g/sub/p", number: 3 })
    expect(issueOfChat("github", "acme/app:pull:7")).toBeNull()
    expect(issueOfChat("telegram", "12345")).toBeNull()
    expect(workflowEntityRefs("gitlab", "g/p:issue:3")).toEqual([{ backend: "gitlab", id: "g/p#3" }, { backend: "gitlab", id: "gitlab:g/p:issue:3" }])
    expect(workflowEntityRefs("gitlab", "g/p:merge_request:4")[0]).toEqual({ backend: "gitlab", id: "g/p!4" })
  })
})

describe("the request record keeps runOn (no store of its own)", () => {
  let tmp: string
  let db: Database.Database
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "agentx-runon-")); db = new Database(join(tmp, "db.sqlite")) })
  afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }) })

  it("sets, reads by issue, and clears", () => {
    const store = new RequestStore(db)
    store.addPromise({ id: "r1", channel: "dashboard", chatId: "wall", agentId: "coder", text: "fix it", owedTo: "owner", home: { kind: "issue", link: "https://github.com/acme/app/issues/7" }, now: 10 })
    expect(store.runOnForIssue("github", "acme/app", 7)).toBeNull()
    expect(store.setRunOn("r1", runOn("clawd"), 20)).toBe(true)
    expect(store.get("r1")!.runOn).toEqual(runOn("clawd"))
    expect(store.runOnForIssue("github", "ACME/app", 7)).toEqual(runOn("clawd"))
    expect(store.runOnForIssue("github", "acme/app", 8)).toBeNull()
    expect(store.openOnIssue("github", "acme/app", 7)).toBe(true)
    // A closed request no longer places its issue.
    db.prepare("UPDATE requests SET state = 'done' WHERE id = 'r1'").run()
    expect(store.runOnForIssue("github", "acme/app", 7)).toBeNull()
    db.prepare("UPDATE requests SET state = 'in_progress' WHERE id = 'r1'").run()
    expect(store.setRunOn("r1", null, 30)).toBe(true)
    expect(store.runOnForIssue("github", "acme/app", 7)).toBeNull()
  })

  it("adds the column to a database from before", () => {
    new RequestStore(db)
    const cols = (db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain("run_on")
    new RequestStore(db) // idempotent
  })
})

describe("the shared mesh safety predicate", () => {
  it("refuses restricted autonomy and person limits, and strips local paths", () => {
    expect(meshForwardBlock("coder", "report", null)?.kind).toBe("autonomy")
    expect(meshForwardBlock("coder", "propose", null)?.kind).toBe("autonomy")
    expect(meshForwardBlock("coder", undefined, { personId: "sara", name: "Sara", tools: ["Bash"], skills: [] })).toMatchObject({ kind: "limits", name: "Sara" })
    expect(meshForwardBlock("coder", "act", null)).toBeNull()
    expect(meshContextOf({ channel: "github", chatId: "c", home: "h", runbookPath: "/here", runbookFiles: ["CLAUDE.md"] })).toEqual({ channel: "github", chatId: "c", home: "h" })
    expect(placedRefusalText("clawd")).toBe("This issue runs on clawd, which can't apply your limits. Ask the owner to bring it back to this Mac.")
  })
})

describe("MessageRouter: the resolver and a placed issue", () => {
  let router: MessageRouter
  let sendTask: ReturnType<typeof vi.fn>
  let healthy: boolean
  let recovered: (() => void) | undefined
  let place: { workflow: string | null; runOn: RunOn | null }
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
    place = { workflow: null, runOn: null }
    sendTask = vi.fn(async () => "done on clawd")
    router = new MessageRouter({ getAgent: () => ({ id: "coder", name: "Coder" }), refusalFor: () => null } as any, { channels: {}, people } as any)
    router.setMesh({
      directory: () => [{ peer: "clawd", peerUrl: "u", healthy, skills: [{ id: "coder" }], channels: [] }, { peer: "nas", peerUrl: "n", healthy: true, skills: [{ id: "coder" }], channels: [] }],
      findAgentPeer: () => ({ peer: "clawd", healthy }),
      sendTask,
      onPeerChange: (cb: any) => { recovered = () => cb({ peer: "clawd", healthy: true, skills: ["coder"], delta: "recovered" }) },
    } as any)
    router.setPlacement({ workflowHome: () => place.workflow, runOn: (p, project, n) => (p === "github" && project === "acme/app" && n === 7 ? place.runOn : null) })
  })

  it("resolves workflow home > runOn > mapping > none", () => {
    place = { workflow: "box", runOn: runOn("clawd") }
    expect(router.resolvePreferNode(msg({ preferNode: "nas" }), "coder")).toEqual({ node: "box", source: "workflow" })
    place = { workflow: null, runOn: runOn("clawd") }
    expect(router.resolvePreferNode(msg({ preferNode: "nas" }), "coder")).toMatchObject({ node: "clawd", source: "runOn" })
    place = { workflow: null, runOn: null }
    expect(router.resolvePreferNode(msg({ preferNode: "nas" }), "coder")).toEqual({ node: "nas", source: "mapping" })
    expect(router.resolvePreferNode(msg(), "coder")).toEqual({ source: "none" })
    // A pull request is not placed by its issue's choice.
    place = { workflow: null, runOn: runOn("clawd") }
    expect(router.resolvePreferNode(msg({ sender: { id: "acme/app:pull:7", name: "anis" } as any }), "coder")).toEqual({ source: "none" })
  })

  it("forwards a placed issue's run with its context, placed: true and no local paths", async () => {
    place.runOn = runOn("clawd")
    await (router as any).processResolvedMessage(adapter, msg({ preferNode: "nas" }), "coder", ISSUE_CHAT)
    expect(sendTask).toHaveBeenCalledTimes(1)
    const [peer, , agent, opts] = sendTask.mock.calls[0] as any[]
    expect(peer).toBe("clawd")
    expect(agent).toBe("coder")
    expect(opts.context).toMatchObject({ channel: "github", chatId: ISSUE_CHAT, placed: true })
    expect(opts.context.runbookPath).toBeUndefined()
    expect(opts.context.runbookFiles).toBeUndefined()
  })

  it("a mapping forward is not marked placed", async () => {
    await (router as any).processResolvedMessage(adapter, msg({ preferNode: "nas" }), "coder", ISSUE_CHAT)
    const opts = (sendTask.mock.calls[0] as any[])[3]
    expect(sendTask.mock.calls[0][0]).toBe("nas")
    expect(opts.context.placed).toBeUndefined()
  })

  it("refuses, and does not forward, a placed run for a person with limits", async () => {
    place.runOn = runOn("clawd")
    await (router as any).processResolvedMessage(adapter, msg({ sender: { id: ISSUE_CHAT, name: "sara-b", username: "sara-b" } as any }), "coder", ISSUE_CHAT)
    expect(sendTask).not.toHaveBeenCalled()
    expect(sent.map((s) => s.text)).toEqual([placedRefusalText("clawd")])
  })

  it("holds a placed run for an offline node and tells the issue once per outage", async () => {
    place.runOn = runOn("clawd")
    healthy = false
    const r = router as any
    await r.processResolvedMessage(adapter, msg(), "coder", ISSUE_CHAT)
    await r.processResolvedMessage(adapter, msg(), "coder", ISSUE_CHAT)
    expect(sendTask).not.toHaveBeenCalled()
    expect(router.getDeferredMeshCounts()).toEqual({ clawd: 2 })
    expect(sent).toEqual([{ chatId: ISSUE_CHAT, text: offlineNoteText("clawd") }])
    // Back: the held runs go, placed; a new outage is told again.
    healthy = true
    recovered!()
    await vi.waitFor(() => expect(sendTask).toHaveBeenCalledTimes(2))
    expect((sendTask.mock.calls[0] as any[])[3].context.placed).toBe(true)
    healthy = false
    await r.processResolvedMessage(adapter, msg(), "coder", ISSUE_CHAT)
    expect(sent.filter((s) => s.text === offlineNoteText("clawd"))).toHaveLength(2)
  })
})

describe("AgentRegistry: the mesh fallback and a placed task", () => {
  let dir: string
  let registry: AgentRegistry
  let sendTask: ReturnType<typeof vi.fn>
  const prevCwd = process.cwd()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-placed-"))
    process.chdir(dir)
    getEventBus().removeAllListeners()
    run.calls = 0
    registry = new AgentRegistry(daemonConfigSchema.parse({
      node: { id: "mac", name: "mac" }, jobState: { enabled: false },
      agents: { coder: { name: "Coder", tier: "claude-code", workspace: dir } },
    }), () => {})
    sendTask = vi.fn(async () => "ran on box")
    registry.setMeshFallback({ findPeerWithSkill: () => undefined, sendTask, directory: () => [{ peer: "box", healthy: true, skills: [{ id: "atlas" }] }] })
  })
  afterEach(() => { process.chdir(prevCwd); rmSync(dir, { recursive: true, force: true }) })

  it("the fallback now passes the task context, less local paths", async () => {
    const res = await registry.execute({ agentId: "atlas", message: "hi", context: { channel: "github", chatId: ISSUE_CHAT, home: "acme/app#7", runbookPath: "/here", runbookFiles: ["X.md"] } as any })
    expect(res.content).toBe("ran on box")
    const opts = (sendTask.mock.calls[0] as any[])[3]
    expect(opts.context).toMatchObject({ channel: "github", chatId: ISSUE_CHAT, home: "acme/app#7" })
    expect(opts.context.runbookPath).toBeUndefined()
    expect(opts.context.runbookFiles).toBeUndefined()
  })

  it("the fallback still refuses restricted autonomy", async () => {
    const res = await registry.execute({ agentId: "atlas", message: "hi", autonomy: "report", context: { channel: "cron", chatId: "x" } } as any)
    expect(res.error).toContain("cannot be enforced on a mesh peer")
    expect(sendTask).not.toHaveBeenCalled()
  })

  it("a placed task with no checkout of its repository is refused, not run in the workspace", async () => {
    const def = { ...(registry as any).agents.get("coder").def, worktrees: { enabled: true, maxAgeDays: 14 } }
    const task = { agentId: "coder", message: "hi", context: { channel: "github", chatId: ISSUE_CHAT, placed: true } }
    const out = await (registry as any).inTaskWorktree(def, task, {})
    expect(out.refused).toContain("no checkout")
    // Not placed: runs in the workspace as before.
    const plain = await (registry as any).inTaskWorktree(def, { ...task, context: { channel: "github", chatId: ISSUE_CHAT } }, {})
    expect(plain.refused).toBeUndefined()
    expect(plain.task.cwd).toBeUndefined()
  })

  it("a placed task is refused through execute too, and nothing runs", async () => {
    const res = await registry.execute({ agentId: "coder", message: "hi", context: { channel: "github", chatId: ISSUE_CHAT, placed: true } as any })
    expect(res.error).toContain("no checkout")
    expect(run.calls).toBe(0)
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
    state.client.getAgentCard = vi.fn(async () => ({ name: "clawd", skills: [{ id: "coder", name: "Coder" }], checkouts: ["acme/app", 3] }))
    await mesh.discoverAll()
    expect(mesh.directory()[0].checkouts).toEqual(["acme/app"])
  })
})
