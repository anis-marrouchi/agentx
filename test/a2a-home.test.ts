import { describe, it, expect } from "vitest"
import { homeOfBody, homeRefsOf, homesOfRun, normalizeHome, sameHomeNote, SAME_HOME_MARKER } from "../src/a2a/home"
import { continueSession } from "../src/daemon/delegation-wiring"

describe("the home of a piece of work (#1100)", () => {
  it("compares links and refs in one form", () => {
    expect(normalizeHome(" https://git.example.com/team/app/-/issues/12/ ")).toBe("https://git.example.com/team/app/-/issues/12")
    expect(normalizeHome("https://git.example.com/team/app/-/issues/12#note_9")).toBe("https://git.example.com/team/app/-/issues/12")
    expect(normalizeHome("Team/App#12")).toBe("team/app#12")
    expect(normalizeHome("")).toBeUndefined()
    expect(normalizeHome(12)).toBeUndefined()
    expect(normalizeHome("x".repeat(301))).toBeUndefined()
  })

  it("finds issue and merge request links and project refs in a message, not bare numbers", () => {
    const text = "Pick up https://git.example.com/team/app/-/issues/12 and team/site!7, see #3 and https://github.com/o/r/pull/5."
    expect(homeRefsOf(text).sort()).toEqual([
      "https://git.example.com/team/app/-/issues/12",
      "https://github.com/o/r/pull/5",
      "team/site#7",
    ].sort())
    expect(homeRefsOf("fix #402 today")).toEqual([])
    expect(homeRefsOf(undefined)).toEqual([])
  })

  it("puts a named home first", () => {
    expect(homesOfRun({ message: "see team/app#3", home: "team/app#12" })).toEqual(["team/app#12", "team/app#3"])
    expect(homesOfRun({ message: "see team/app#12", home: "Team/App#12" })).toEqual(["team/app#12"])
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
    expect(sameHomeNote([other], ["team/app#12"], { channel: "a2a", chatId: "a2a:lead:writer:dlg-1" })).toBeNull()
    expect(sameHomeNote([other], [], { channel: "a2a", chatId: "x" })).toBeNull()
    expect(sameHomeNote([{ ...other, homes: undefined }], ["team/app#12"], { channel: "a2a", chatId: "x" })).toBeNull()
  })
})

describe("continuing a session in a new chat (#1100)", () => {
  function store(seed: Record<string, { claude?: string; codex?: string; open?: string }> = {}) {
    const k = (a: string, c: string, id: string) => `${a}|${c}|${id}`
    const s = new Map(Object.entries(seed))
    const get = (f: "claude" | "codex" | "open") => (a: string, c: string, id: string) => s.get(k(a, c, id))?.[f]
    const set = (f: "claude" | "codex" | "open") => (a: string, c: string, id: string, v: string) => { s.set(k(a, c, id), { ...(s.get(k(a, c, id)) ?? {}), [f]: v }) }
    return {
      s,
      api: {
        getClaudeSessionId: get("claude"), setClaudeSessionId: set("claude"),
        getCodexSessionId: get("codex"), setCodexSessionId: set("codex"),
        getOpenCodeSessionId: get("open"), setOpenCodeSessionId: set("open"),
      },
    }
  }

  it("copies the earlier chat's session ids to the new chat", () => {
    const st = store({ "writer|a2a|old": { claude: "sess-1", codex: "cx-1" } })
    expect(continueSession(st.api, "writer", { channel: "a2a", chatId: "old" }, { channel: "mcp", chatId: "new" })).toBe(true)
    expect(st.s.get("writer|mcp|new")).toEqual({ claude: "sess-1", codex: "cx-1" })
  })

  it("is false when there is nothing to continue, or it is the same chat", () => {
    const st = store()
    expect(continueSession(st.api, "writer", { channel: "a2a", chatId: "old" }, { channel: "a2a", chatId: "new" })).toBe(false)
    expect(continueSession(st.api, "writer", { channel: "a2a", chatId: "x" }, { channel: "a2a", chatId: "x" })).toBe(false)
  })
})
