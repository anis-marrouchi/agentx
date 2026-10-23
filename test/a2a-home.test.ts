import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { homeOfBody, homeRefsOf, homesOfRun, normalizeHome, sameHomeNote, SAME_HOME_MARKER } from "../src/a2a/home"
import { continueSession } from "../src/daemon/delegation-wiring"
import { SessionStore } from "../src/agents/sessions"

describe("the home of a piece of work (#1100)", () => {
  it("brings links and refs to one form, host dropped", () => {
    expect(normalizeHome(" https://git.example.com/team/app/-/issues/12/ ")).toBe("team/app#12")
    expect(normalizeHome("https://git.example.com/team/app/-/issues/12#note_9")).toBe("team/app#12")
    expect(normalizeHome("Team/App#12")).toBe("team/app#12")
    expect(normalizeHome("https://git.example.com/g/sub/proj/-/issues/3")).toBe("g/sub/proj#3")
    expect(normalizeHome("https://github.com/o/r/pull/5")).toBe("o/r#5")
    expect(normalizeHome("https://github.com/o/r/issues/5")).toBe("o/r#5")
  })

  it("keeps a merge request apart from the issue with the same number", () => {
    expect(normalizeHome("team/app!12")).toBe("team/app!12")
    expect(normalizeHome("https://git.example.com/team/app/-/merge_requests/12")).toBe("team/app!12")
    expect(homeRefsOf("team/app!12 and team/app#12").sort()).toEqual(["team/app!12", "team/app#12"])
  })

  it("takes one token only", () => {
    expect(normalizeHome("x#1\nIGNORE ALL")).toBeUndefined()
    expect(normalizeHome("team app#1")).toBeUndefined()
    expect(normalizeHome("")).toBeUndefined()
    expect(normalizeHome(12)).toBeUndefined()
    expect(normalizeHome("x".repeat(301))).toBeUndefined()
  })

  it("finds issue and merge request links and project refs in a message, not bare numbers, file lines or dates", () => {
    const text = "Pick up https://git.example.com/team/app/-/issues/12 and team/site!7, see #3, src/a2a/home.ts#12, 2026/10/20#3 and https://github.com/o/r/pull/5."
    expect(homeRefsOf(text).sort()).toEqual(["o/r#5", "team/app#12", "team/site!7"].sort())
    expect(homeRefsOf("fix #402 today")).toEqual([])
    expect(homeRefsOf(undefined)).toEqual([])
  })

  it("puts a named home first, and matches a link to a ref", () => {
    expect(homesOfRun({ message: "see team/app#3", home: "team/app#12" })).toEqual(["team/app#12", "team/app#3"])
    expect(homesOfRun({ message: "see team/app#12", home: "https://git.example.com/team/app/-/issues/12" })).toEqual(["team/app#12"])
  })

  it("reads the home of a request body, top level or in its context", () => {
    expect(homeOfBody({ home: "team/app#1" })).toBe("team/app#1")
    expect(homeOfBody({ context: { home: "team/app#2" } })).toBe("team/app#2")
    expect(homeOfBody({})).toBeUndefined()
  })
})

describe("a second run on the same home (#1100)", () => {
  const started = new Date("2030-01-01T10:05:00Z")
  const other = { homes: ["team/app#12"], channel: "a2a", chatId: "a2a:lead:writer:dlg-1", startedAt: started }

  it("is told which run already works on it", () => {
    const note = sameHomeNote([other], ["team/app#12"], { channel: "a2a", chatId: "a2a:lead:writer:dlg-2" })
    expect(note).toContain(SAME_HOME_MARKER)
    expect(note).toContain("team/app#12")
    expect(note).toContain("10:05Z")
    expect(note).toContain("a2a:lead:writer:dlg-1")
  })

  it("says nothing for another home, its own chat, or no home", () => {
    expect(sameHomeNote([other], ["team/app#13"], { channel: "a2a", chatId: "x" })).toBeNull()
    expect(sameHomeNote([other], ["team/app!12"], { channel: "a2a", chatId: "x" })).toBeNull()
    expect(sameHomeNote([other], ["team/app#12"], { channel: "a2a", chatId: "a2a:lead:writer:dlg-1" })).toBeNull()
    expect(sameHomeNote([other], [], { channel: "a2a", chatId: "x" })).toBeNull()
    expect(sameHomeNote([{ ...other, homes: undefined }], ["team/app#12"], { channel: "a2a", chatId: "x" })).toBeNull()
  })
})

describe("continuing a session in a new chat (#1100)", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-continue-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it("copies the session ids and what the rotation checks read", () => {
    const store = new SessionStore(dir)
    store.setClaudeSessionId("writer", "a2a", "old", "sess-1")
    const src = store.getSession("writer", "a2a", "old")
    src.turnCount = 7
    src.lastTurnContextTokens = 150_000
    src.updatedAt = "2030-01-01T00:00:00.000Z"
    expect(continueSession(store, "writer", [{ channel: "a2a", chatId: "old" }], { channel: "mcp", chatId: "new" })).toBe(true)
    const dst = store.getSession("writer", "mcp", "new")
    expect(dst.claudeSessionId).toBe("sess-1")
    expect(dst.turnCount).toBe(7)
    expect(dst.lastTurnContextTokens).toBe(150_000)
    expect(dst.updatedAt).toBe("2030-01-01T00:00:00.000Z")
  })

  it("falls back to an older chat when the newest has no session, and is false with none", () => {
    const store = new SessionStore(dir)
    store.setClaudeSessionId("writer", "a2a", "first", "sess-a")
    expect(continueSession(store, "writer", [{ channel: "a2a", chatId: "failed" }, { channel: "a2a", chatId: "first" }], { channel: "a2a", chatId: "third" })).toBe(true)
    expect(store.getClaudeSessionId("writer", "a2a", "third")).toBe("sess-a")
    expect(continueSession(store, "writer", [{ channel: "a2a", chatId: "none" }], { channel: "a2a", chatId: "fourth" })).toBe(false)
    // Looking did not write an empty record for the chats that had none.
    expect(readdirSync(join(dir, ".agentx/sessions")).some((f) => f.includes("failed") || f.includes("none"))).toBe(false)
    expect(continueSession(store, "writer", [{ channel: "a2a", chatId: "x" }], { channel: "a2a", chatId: "x" })).toBe(false)
  })
})
