import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { SessionStore } from "../src/agents/sessions"
import { rmSync, writeFileSync } from "fs"
import { resolve } from "path"

const TEST_DIR = resolve(__dirname, "../.test-sessions")

describe("SessionStore", () => {
  let store: SessionStore

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    store = new SessionStore(TEST_DIR)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it("creates a session on first access", () => {
    const session = store.getSession("atlas", "telegram", "group-1")
    expect(session.agentId).toBe("atlas")
    expect(session.channel).toBe("telegram")
    expect(session.messages).toHaveLength(0)
  })

  it("adds user and agent messages", () => {
    store.addUserMessage("atlas", "telegram", "g1", "Anis", "Hello")
    store.addAgentMessage("atlas", "telegram", "g1", "Hi there!")

    const session = store.getSession("atlas", "telegram", "g1")
    expect(session.messages).toHaveLength(2)
    expect(session.messages[0].role).toBe("user")
    expect(session.messages[1].role).toBe("agent")
  })

  it("builds history context", () => {
    store.addUserMessage("atlas", "telegram", "g1", "Anis", "What is 2+2?")
    store.addAgentMessage("atlas", "telegram", "g1", "4")
    store.addUserMessage("atlas", "telegram", "g1", "Anis", "And 3+3?")

    const context = store.buildHistoryContext("atlas", "telegram", "g1")
    expect(context).toContain("What is 2+2?")
    expect(context).toContain("4")
    expect(context).toContain("And 3+3?")
  })

  it("stores and retrieves Claude session IDs", () => {
    store.setClaudeSessionId("atlas", "telegram", "g1", "abc-123-def")
    const id = store.getClaudeSessionId("atlas", "telegram", "g1")
    expect(id).toBe("abc-123-def")
  })

  it("stores and retrieves Codex session IDs", () => {
    store.setCodexSessionId("atlas", "telegram", "g1", "thread-123")
    const id = store.getCodexSessionId("atlas", "telegram", "g1")
    expect(id).toBe("thread-123")
  })

  it("clearSession removes AgentX history and Claude resume metadata", () => {
    store.addUserMessage("lead", "api", "default", "Anis", "I want monthly subscription")
    store.addAgentMessage("lead", "api", "default", "Thanks Anis")
    store.setClaudeSessionId("lead", "api", "default", "claude-session")
    store.setCodexSessionId("lead", "api", "default", "codex-session")
    store.recordTurnUsage("lead", "api", "default", {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    })

    store.clearSession("lead", "api", "default")

    const session = store.getSession("lead", "api", "default")
    expect(session.messages).toHaveLength(0)
    expect(session.claudeSessionId).toBeUndefined()
    expect(session.codexSessionId).toBeUndefined()
    expect(session.turnCount).toBeUndefined()
    expect(store.buildHistoryContext("lead", "api", "default")).toBe("")
  })

  it("returns undefined for non-existent session ID", () => {
    const id = store.getClaudeSessionId("atlas", "telegram", "g1")
    expect(id).toBeUndefined()
  })

  it("persists sessions across instances", () => {
    store.addUserMessage("atlas", "telegram", "g1", "Anis", "test")
    store.addAgentMessage("atlas", "telegram", "g1", "reply")

    // Create new store instance pointing to same dir
    const store2 = new SessionStore(TEST_DIR)
    const session = store2.getSession("atlas", "telegram", "g1")
    expect(session.messages).toHaveLength(2)
  })

  it("trims messages beyond max", () => {
    // Add many messages
    for (let i = 0; i < 40; i++) {
      store.addUserMessage("atlas", "t", "g1", "u", `msg ${i}`)
    }

    const session = store.getSession("atlas", "t", "g1")
    expect(session.messages.length).toBeLessThanOrEqual(30)
  })

  it("returns empty context for new sessions", () => {
    const context = store.buildHistoryContext("atlas", "telegram", "g1")
    expect(context).toBe("")
  })
})

describe("SessionStore — day-rollover continuity", () => {
  let store: SessionStore

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    store = new SessionStore(TEST_DIR, { staleMinutes: 720 })
  })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  /** Write a session file for UTC yesterday, bypassing the (today-keyed) store. */
  function seedYesterday(updatedAt: string, extra: Record<string, unknown> = {}) {
    const prevDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const key = `atlas:telegram:g1:${prevDay}`
    const record = {
      id: key, agentId: "atlas", channel: "telegram", chatId: "g1", day: prevDay,
      messages: [{ role: "user", name: "Anis", content: "old", timestamp: updatedAt }],
      createdAt: updatedAt, updatedAt,
      claudeSessionId: "sess-yesterday", turnCount: 7, lastTurnContextTokens: 90_000,
      ...extra,
    }
    writeFileSync(resolve(TEST_DIR, ".agentx/sessions", `${key}.json`), JSON.stringify(record))
  }

  it("seeds today's record from yesterday's resumable session (no midnight amnesia)", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString()
    seedYesterday(twoHoursAgo)
    const s = store.getSession("atlas", "telegram", "g1")
    expect(s.claudeSessionId).toBe("sess-yesterday")
    expect(s.turnCount).toBe(7)
    expect(s.lastTurnContextTokens).toBe(90_000)
    expect(s.messages).toHaveLength(0) // history stays day-scoped
    expect(store.getClaudeSessionId("atlas", "telegram", "g1")).toBe("sess-yesterday")
    expect(store.isSessionStale("atlas", "telegram", "g1")).toBe(false)
  })

  it("carries yesterday's updatedAt so an idle session still goes stale", () => {
    const twentyHoursAgo = new Date(Date.now() - 20 * 3600_000).toISOString()
    seedYesterday(twentyHoursAgo)
    const s = store.getSession("atlas", "telegram", "g1")
    expect(s.claudeSessionId).toBe("sess-yesterday")
    // 20h idle > 12h staleMinutes → the rotation path in execute() clears it
    expect(store.isSessionStale("atlas", "telegram", "g1")).toBe(true)
  })

  it("creates a plain fresh session when yesterday has nothing", () => {
    const s = store.getSession("atlas", "telegram", "g1")
    expect(s.claudeSessionId).toBeUndefined()
    expect(s.turnCount).toBeUndefined()
  })
})

describe("SessionStore — tier-2 rotation metric (context vs cumulative)", () => {
  let store: SessionStore
  const bigCumulative = { inputTokens: 12_000, outputTokens: 900, cacheReadTokens: 3_200_000, cacheCreateTokens: 130_000 }

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    store = new SessionStore(TEST_DIR, { tierTwoThresholdTokens: 180_000 })
    store.setClaudeSessionId("atlas", "telegram", "g1", "sess-1")
  })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it("records both the cumulative turn total and the per-request context size", () => {
    store.recordTurnUsage("atlas", "telegram", "g1", bigCumulative, 120_000)
    const s = store.getSession("atlas", "telegram", "g1")
    expect(s.lastTurnInputTokens).toBe(3_342_000)
    expect(s.lastTurnContextTokens).toBe(120_000)
    expect(s.turnCount).toBe(1)
  })

  it("does NOT rotate on a tool-heavy turn whose real context is small (the amnesia bug)", () => {
    // 3.3M cumulative (cache reads across 20 calls) but only 120K real context
    store.recordTurnUsage("atlas", "telegram", "g1", bigCumulative, 120_000)
    expect(store.shouldRotateByTierTwo("atlas", "telegram", "g1")).toBe(false)
  })

  it("rotates when the real context crosses the threshold", () => {
    store.recordTurnUsage("atlas", "telegram", "g1", bigCumulative, 190_000)
    expect(store.shouldRotateByTierTwo("atlas", "telegram", "g1")).toBe(true)
    expect(store.getLastTurnContextTokens("atlas", "telegram", "g1")).toBe(190_000)
  })

  it("falls back to the cumulative total when no context reading exists (non-streaming path)", () => {
    store.recordTurnUsage("atlas", "telegram", "g1", { inputTokens: 190_500, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 })
    expect(store.shouldRotateByTierTwo("atlas", "telegram", "g1")).toBe(true)
    store.recordTurnUsage("atlas", "telegram", "g1", { inputTokens: 50_000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 })
    expect(store.shouldRotateByTierTwo("atlas", "telegram", "g1")).toBe(false)
  })

  it("a non-streaming turn clears the previous streaming turn's context reading", () => {
    store.recordTurnUsage("atlas", "telegram", "g1", bigCumulative, 120_000)
    store.recordTurnUsage("atlas", "telegram", "g1", { inputTokens: 30_000, outputTokens: 50, cacheReadTokens: 0, cacheCreateTokens: 0 })
    const s = store.getSession("atlas", "telegram", "g1")
    expect(s.lastTurnContextTokens).toBeUndefined()
    expect(s.lastTurnInputTokens).toBe(30_000)
  })

  it("rotation clears the context reading along with the counters", () => {
    store.recordTurnUsage("atlas", "telegram", "g1", bigCumulative, 190_000)
    store.clearClaudeSessionId("atlas", "telegram", "g1")
    const s = store.getSession("atlas", "telegram", "g1")
    expect(s.lastTurnContextTokens).toBeUndefined()
    expect(s.turnCount).toBeUndefined()
    expect(store.shouldRotateByTierTwo("atlas", "telegram", "g1")).toBe(false)
  })
})
