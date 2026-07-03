import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { resolve, join } from "path"
import { parseMention, matchAgents, matchFiles, mentionSuggestions, applyMention, advanceMention, type MentionCycle } from "../src/tui/mention-complete"

describe("parseMention", () => {
  it("captures a trailing @token at a word boundary", () => {
    expect(parseMention("hey @dev")).toEqual({ token: "dev", start: 4 })
    expect(parseMention("@co")).toEqual({ token: "co", start: 0 })
    expect(parseMention("bare @")).toEqual({ token: "", start: 5 })
    expect(parseMention("path @src/tu")).toEqual({ token: "src/tu", start: 5 })
  })

  it("does not fire mid-word or without a trailing mention", () => {
    expect(parseMention("email me@x.com")).toBeNull()
    expect(parseMention("no mention here")).toBeNull()
    expect(parseMention("@done ")).toBeNull() // trailing space ends the token
  })
})

describe("matchAgents", () => {
  const ids = ["coo-agent", "cx-agent", "devops-agent", "coder-agent"]
  it("matches by substring, case-insensitive, prefixed with @", () => {
    expect(matchAgents("co", ids)).toEqual(["@coo-agent", "@coder-agent"])
    expect(matchAgents("AGENT", ids)).toHaveLength(4)
    expect(matchAgents("", ids)).toHaveLength(4)
    expect(matchAgents("zzz", ids)).toEqual([])
  })
})

describe("matchFiles", () => {
  it("lists files/dirs by basename prefix, dirs get a trailing slash", () => {
    const dir = mkdtempSync(join(tmpdir(), "mention-"))
    writeFileSync(resolve(dir, "readme.md"), "x")
    writeFileSync(resolve(dir, "run.ts"), "x")
    mkdirSync(resolve(dir, "src"))
    writeFileSync(resolve(dir, "src", "index.ts"), "x")

    expect(matchFiles("r", dir).sort()).toEqual(["readme.md", "run.ts"])
    expect(matchFiles("s", dir)).toEqual(["src/"])
    expect(matchFiles("src/in", dir)).toEqual(["src/index.ts"])
    expect(matchFiles("nope", dir)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("mentionSuggestions + applyMention", () => {
  it("combines agent + file matches and caps them", () => {
    const dir = mkdtempSync(join(tmpdir(), "mention2-"))
    writeFileSync(resolve(dir, "coverage.txt"), "x")
    const s = mentionSuggestions("ping @co", ["coo-agent", "cx-agent"], dir)!
    expect(s.mention.token).toBe("co")
    expect(s.items).toContain("@coo-agent")
    expect(s.items).toContain("coverage.txt")
    rmSync(dir, { recursive: true, force: true })
  })

  it("returns null when nothing matches", () => {
    expect(mentionSuggestions("no mention", ["a"], "/nonexistent-xyz")).toBeNull()
  })

  it("applyMention replaces the token; agents get a space, dirs stay open", () => {
    expect(applyMention("hi @co", { token: "co", start: 3 }, "@coo-agent")).toBe("hi @coo-agent ")
    expect(applyMention("see @sr", { token: "sr", start: 4 }, "src/")).toBe("see src/")
  })
})

describe("advanceMention (Tab-cycling)", () => {
  const ids = ["coo-agent", "coder-agent", "cx-agent"]

  it("first Tab accepts the top match; subsequent Tabs cycle at the frozen @ position", () => {
    const ref: { current: MentionCycle | null } = { current: null }
    // "co" matches coo-agent + coder-agent
    let buf = advanceMention("hi @co", ref, ids, "/nonexistent-xyz")!
    expect(buf).toBe("hi @coo-agent ")
    expect(ref.current?.items).toEqual(["@coo-agent", "@coder-agent"])
    buf = advanceMention(buf, ref, ids, "/nonexistent-xyz")!
    expect(buf).toBe("hi @coder-agent ")
    // wraps back to the first
    buf = advanceMention(buf, ref, ids, "/nonexistent-xyz")!
    expect(buf).toBe("hi @coo-agent ")
  })

  it("returns null when there is no mention to complete", () => {
    const ref: { current: MentionCycle | null } = { current: null }
    expect(advanceMention("no mention", ref, ids, "/nonexistent-xyz")).toBeNull()
    expect(ref.current).toBeNull()
  })
})
