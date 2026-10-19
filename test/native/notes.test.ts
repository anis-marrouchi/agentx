import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { macosNotes, NOTES_SCRIPT } from "../../src/native/macos/notes"
import { handleNoteRequest, noteCaller, type NoteDeps } from "../../src/native/notes-api"
import { runNoteTool } from "../../src/native/note-tool"
import { daemonConfigSchema } from "../../src/daemon/config"
import { isMeshGatedPath } from "../../src/daemon/mesh-auth"

// #1062 step 9: an agent's idea goes to the owner's notes app, off by
// default, a few a day per agent, forwarded from a node without one.

const NOW = Date.parse("2030-03-01T08:00:00.000Z")
const ON = { enabled: true, folder: "AgentX", perAgentPerDay: 2 }
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agentx-notes-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function deps(over: Partial<NoteDeps> = {}) {
  const added: { folder: string; title: string; body: string }[] = []
  const d: NoteDeps = {
    root, settings: ON, agentId: "scout", node: "", now: NOW,
    notes: { add: async (n) => { added.push(n); return { id: `note-${added.length}` } } },
    ...over,
  }
  return { d, added }
}

describe("POST /native/notes (#1062)", () => {
  it("adds a signed note to the folder", async () => {
    const { d, added } = deps()
    const r = await handleNoteRequest({ title: "Idea:  weekly\ndigest", body: "Most replies come on Thursday." }, d)
    expect(r).toEqual({ status: 201, body: { ok: true, id: "note-1", folder: "AgentX" } })
    expect(added[0]).toEqual({ folder: "AgentX", title: "Idea: weekly digest", body: `Most replies come on Thursday.\n\n— scout, ${new Date(NOW).toISOString()}` })
  })

  it("is off unless native.notes.enabled", async () => {
    const { d, added } = deps({ settings: { ...ON, enabled: false } })
    expect((await handleNoteRequest({ title: "t", body: "b" }, d)).status).toBe(409)
    expect(added).toEqual([])
  })

  it("refuses a call that is not an agent's turn, and bad input", async () => {
    expect((await handleNoteRequest({ title: "t", body: "b" }, deps({ agentId: null }).d)).status).toBe(403)
    expect((await handleNoteRequest({ title: "", body: "b" }, deps().d)).status).toBe(400)
    expect((await handleNoteRequest({ title: "x".repeat(121), body: "b" }, deps().d)).status).toBe(400)
    expect((await handleNoteRequest({ title: "t", body: "x".repeat(4001) }, deps().d)).status).toBe(400)
  })

  it("stops an agent at perAgentPerDay, per agent, and starts again the next day", async () => {
    const { d } = deps()
    for (let i = 0; i < 2; i++) expect((await handleNoteRequest({ title: "t", body: "b" }, d)).status).toBe(201)
    expect((await handleNoteRequest({ title: "t", body: "b" }, d)).status).toBe(429)
    expect((await handleNoteRequest({ title: "t", body: "b" }, { ...d, agentId: "other" })).status).toBe(201)
    expect((await handleNoteRequest({ title: "t", body: "b" }, { ...d, now: NOW + 24 * 3_600_000 })).status).toBe(201)
  })

  it("does not count a note that failed", async () => {
    const { d } = deps({ notes: { add: async () => { throw new Error("not allowed") } } })
    for (let i = 0; i < 3; i++) expect((await handleNoteRequest({ title: "t", body: "b" }, d)).status).toBe(502)
  })

  it("forwards from a node without a notes app, and refuses with nowhere to send it", async () => {
    const forward = vi.fn(async () => ({ status: 201, body: { ok: true, id: "remote", folder: "AgentX" } }))
    const r = await handleNoteRequest({ title: "t", body: "b" }, deps({ notes: undefined, forward }).d)
    expect(r.status).toBe(201)
    expect(forward).toHaveBeenCalledWith({ title: "t", body: "b", agentId: "scout", node: "" })
    expect((await handleNoteRequest({ title: "t", body: "b" }, deps({ notes: undefined }).d)).status).toBe(501)
  })

  it("signs a forwarded note with the node it came from", async () => {
    const { d, added } = deps({ node: "linux-box" })
    await handleNoteRequest({ title: "t", body: "b" }, d)
    expect(added[0].body).toMatch(/— scout on linux-box, 2030-/)
  })

  it("is mesh-gated, and off by default in config", () => {
    expect(isMeshGatedPath("/native/notes")).toBe(true)
    const cfg = daemonConfigSchema.parse({ node: { id: "n", name: "n" } })
    expect(cfg.native.notes).toEqual({ enabled: false, folder: "AgentX", perAgentPerDay: 10 })
  })
})

describe("who a note is from", () => {
  const base = { selfNode: "mac", isLocalAgent: (id: string) => id === "scout", proven: () => "scout" as string | null }

  it("is the proven turn for a local call, whatever the body claims", () => {
    expect(noteCaller({ ...base, node: "", tokenPeer: null, claimed: "boss" })).toEqual({ agentId: "scout", node: "" })
  })

  it("does not believe a node with this machine's own mesh token (no peer token)", () => {
    // A local agent holding MESH_TOKEN, naming a peer and any agent.
    expect(noteCaller({ ...base, node: "linux-box", tokenPeer: null, claimed: "anyone", proven: () => null })).toEqual({ agentId: null, node: "" })
  })

  it("does not believe a node other than the token's own peer", () => {
    expect(noteCaller({ ...base, node: "linux-box", tokenPeer: "other-box", claimed: "anyone", proven: () => null })).toEqual({ agentId: null, node: "" })
  })

  it("believes the peer whose token it is, for its own agents only", () => {
    expect(noteCaller({ ...base, node: "linux-box", tokenPeer: "linux-box", claimed: "coder" })).toEqual({ agentId: "coder", node: "linux-box" })
    expect(noteCaller({ ...base, node: "linux-box", tokenPeer: "linux-box", claimed: "scout" })).toEqual({ error: expect.stringMatching(/agent on this node/) })
  })
})

describe("the daily limit under load", () => {
  it("lets only the allowed number through when notes arrive at once", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { d } = deps({ settings: { ...ON, perAgentPerDay: 1 }, notes: { add: async () => { await gate; return { id: "n" } } } })
    const both = Promise.all([handleNoteRequest({ title: "a", body: "b" }, d), handleNoteRequest({ title: "a", body: "b" }, d)])
    release()
    expect((await both).map((r) => r.status).sort()).toEqual([201, 429])
  })
})

describe("Apple Notes through JXA", () => {
  it("passes folder, title and body as argv, never inside the script", async () => {
    const output = vi.fn(async () => "x-coredata://ABC/ICNote/p1\n")
    const body = 'He said "</div><script>alert(1)</script>"\nline 2'
    expect(await macosNotes(output).add({ folder: "AgentX", title: "T's", body })).toEqual({ id: "x-coredata://ABC/ICNote/p1" })
    expect(output).toHaveBeenCalledWith("/usr/bin/osascript", ["-l", "JavaScript", "-e", NOTES_SCRIPT, "AgentX", "T's", body])
    expect(NOTES_SCRIPT).not.toMatch(/alert|T's/)
    expect(NOTES_SCRIPT).toContain("&lt;")
  })

  it("fails when Notes gives no id", async () => {
    await expect(macosNotes(async () => "  ").add({ folder: "f", title: "t", body: "b" })).rejects.toThrow(/id/)
  })
})

describe("agentx_note", () => {
  it("posts the idea with the turn's headers and says where it went", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: "n1", folder: "AgentX" }), { status: 201 }))
    const text = await runNoteTool({ title: "Idea", body: "Text" }, { daemonUrl: "http://d/", fetch: fetchFn as any, env: { AGENTX_AGENT_ID: "scout", AGENTX_TASK_ID: "t-1" } })
    expect(text).toMatch(/folder "AgentX"/)
    const [url, init] = fetchFn.mock.calls[0] as any
    expect(url).toBe("http://d/native/notes")
    expect(init.headers["X-AgentX-Task"]).toBe("t-1")
    expect(JSON.parse(init.body)).toEqual({ title: "Idea", body: "Text", agentId: "scout" })
  })

  it("returns the daemon's refusal", async () => {
    const fetchFn = async () => new Response(JSON.stringify({ error: "notes are off on this node" }), { status: 409 })
    expect(await runNoteTool({ title: "Idea", body: "Text" }, { daemonUrl: "http://d", fetch: fetchFn as any, env: {} })).toBe("Error: notes are off on this node")
  })
})
