import { beforeEach, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { RequestStore } from "../src/requests/store"
import { pickupText } from "../src/requests/sweep"
import { handleWallAction, isWallActionPath, redactTalk, type Reply, type WallActionDeps } from "../src/daemon/wall-actions"
import { wallThread } from "../src/daemon/wall-api"

// The Wall's writes (#1316): a comment reaches the post's agent, a call
// asks it to ring the owner, a Space starts talk mode about the post.

const T0 = 1_700_000_000_000
let store: RequestStore
let calls: Array<{ method: string; path: string; body?: unknown }>
let deps: WallActionDeps

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "agentx-wall-actions-"))
  const configPath = join(dir, "agentx.json")
  writeFileSync(configPath, JSON.stringify({ agents: { coder: { name: "Coder" } }, requests: { enabled: true } }))
  const db = new Database(":memory:")
  store = new RequestStore(db)
  store.addCandidate({ id: "r1", runId: "t1", channel: "telegram", chatId: "chat-A", sender: "anis", agentId: "coder", text: "Fix the login page", now: T0 })
  store.progress("r1", T0 + 1000)
  calls = []
  deps = {
    inbox: { root: dir, configPath, requests: store },
    daemon: async (method, path, body): Promise<Reply> => {
      calls.push({ method, path, body })
      return { status: 201, body: path === "/talk" ? { active: true, kind: "talk", transcript: [{ name: "Coder", text: "token=supersecretvalue123" }] } : { ok: true } }
    },
    now: () => T0 + 5000,
  }
})

const post = (path: string, body: Record<string, unknown>) => handleWallAction("POST", `/api/admin/wall${path}`, body, deps)

describe("routes", () => {
  it("claims only its own paths", () => {
    expect(isWallActionPath("/api/admin/wall/comment")).toBe(true)
    expect(isWallActionPath("/api/admin/wall/post")).toBe(true)
    expect(isWallActionPath("/api/admin/wall/space/stop")).toBe(true)
    expect(isWallActionPath("/api/admin/wall/thread")).toBe(false)
    expect(isWallActionPath("/api/admin/wall")).toBe(false)
  })
})

describe("comment", () => {
  it("hands the post back to its agent and keeps the words in the thread", async () => {
    const r = await post("/comment", { id: "r1", text: "  Use the staging token  " })
    expect(r).toMatchObject({ status: 200, body: { ok: true, agentId: "coder" } })
    const thread = wallThread(store.get("r1")!, { store, db: (store as any).db, now: T0 + 6000, staleAfterHours: 24 } as any)
    expect(thread.find((e) => e.kind === "comment")).toMatchObject({ who: "owner", text: "Use the staging token" })
  })

  it("refuses an empty, unknown or closed post", async () => {
    expect((await post("/comment", { id: "r1", text: " " }))!.status).toBe(400)
    expect((await post("/comment", { id: "nope", text: "hi" }))!.status).toBe(404)
    store.close("r1", "done", "shipped", T0 + 2000)
    expect((await post("/comment", { id: "r1", text: "hi" }))!.status).toBe(409)
  })
})

describe("post (#1355)", () => {
  it("opens a post owed to the owner, marked for the agent to pick up", async () => {
    const r = await post("/post", { agent: "coder", text: "  Check the deploy log  " })
    expect(r).toMatchObject({ status: 200, body: { ok: true, agentId: "coder", id: expect.stringMatching(/^wp-/) } })
    const rec = store.get((r!.body as any).id)!
    expect(rec).toMatchObject({ state: "in_progress", channel: "wall", chatId: "owner", agentId: "coder", text: "Check the deploy log", owedTo: "owner" })
    const [picked] = store.takePickups()
    expect(picked.id).toBe(rec.id)
    expect(pickupText(picked)).toMatch(/gave you this task on the Wall/)
    expect(pickupText(picked)).toMatch(/answer to this turn/)
  })

  it("refuses an empty post, an agent not on this computer, and requests turned off", async () => {
    expect((await post("/post", { agent: "coder", text: " " }))!.status).toBe(400)
    expect((await post("/post", { agent: "../x", text: "hi" }))!.status).toBe(400)
    expect((await post("/post", { agent: "ghost", text: "hi" }))!.status).toBe(404)
    writeFileSync(deps.inbox.configPath!, JSON.stringify({ agents: { coder: { name: "Coder" } }, requests: { enabled: false } }))
    expect((await post("/post", { agent: "coder", text: "hi" }))!.status).toBe(409)
    expect(store.takePickups().filter((x) => x.channel === "wall")).toEqual([])
  })
})

describe("call", () => {
  it("asks the daemon to have the post's agent call the owner", async () => {
    const r = await post("/call", { id: "r1" })
    expect(r!.status).toBe(201)
    expect(calls).toEqual([{ method: "POST", path: "/calls/owner", body: { agentId: "coder", reason: expect.stringMatching(/^Wall post r1: /) } }])
  })
})

describe("space", () => {
  it("starts talk mode about the post, with what agents say redacted", async () => {
    const r = await post("/space", { id: "r1", agent: "coder", with: "pm", topic: "The login page" })
    expect(calls[0]).toMatchObject({ path: "/talk", body: { agents: ["coder", "pm"], topic: "The login page" } })
    expect((calls[0].body as any).context).toContain("Wall post r1")
    expect(JSON.stringify(r!.body)).not.toContain("supersecretvalue123")
  })

  it("needs two different agents and a topic", async () => {
    expect((await post("/space", { agent: "coder", with: "coder", topic: "x" }))!.status).toBe(400)
    expect((await post("/space", { agent: "coder", with: "pm" }))!.status).toBe(400)
    expect((await post("/space", { agent: "bad id!", with: "pm", topic: "x" }))!.status).toBe(400)
    expect(calls).toEqual([])
  })

  it("says the owner's words into it and stops it", async () => {
    await post("/space/say", { text: "Keep it short" })
    await post("/space/stop", {})
    expect(calls.map((c) => c.path)).toEqual(["/voice/door", "/talk/stop"])
  })

  it("redactTalk leaves a non-object alone", () => {
    expect(redactTalk(null)).toBe(null)
  })
})
