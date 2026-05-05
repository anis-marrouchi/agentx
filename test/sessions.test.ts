import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { SessionStore } from "../src/agents/sessions"
import { rmSync } from "fs"
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
