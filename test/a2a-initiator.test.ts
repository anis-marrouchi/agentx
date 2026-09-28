import { describe, it, expect } from "vitest"
import { classifyInitiator, isHumanFacingTurn, rootInitiatorOf } from "../src/a2a/initiator"

describe("classifyInitiator", () => {
  it("treats chat, phone, voice and review channels as a person", () => {
    for (const channel of ["telegram", "whatsapp", "slack", "discord", "gitlab", "github", "app", "voice", "dashboard"]) {
      expect(classifyInitiator({ channel, chatId: "c1", sender: "Sam" })).toBe("human")
    }
  })

  it("treats machine channels as an agent", () => {
    for (const channel of ["cron", "workflow", "a2a", "mcp", "mesh", "api", "events", "reminder"]) {
      expect(classifyInitiator({ channel, chatId: "c1", sender: "Sam" })).toBe("agent")
    }
  })

  it("treats a machine-shaped sender on a chat channel as an agent", () => {
    expect(classifyInitiator({ channel: "telegram", chatId: "c1", sender: "agent:helper" })).toBe("agent")
    expect(classifyInitiator({ channel: "telegram", chatId: "c1", sender: "cron:daily" })).toBe("agent")
  })

  it("keeps unknown channels on today's behaviour (agent)", () => {
    expect(classifyInitiator({ channel: "something-new", sender: "Sam" })).toBe("agent")
    expect(classifyInitiator(undefined)).toBe("agent")
  })

  it("lets a propagated root win over the hop's own channel", () => {
    const initiator = { kind: "human", channel: "telegram", chatId: "c1" }
    expect(classifyInitiator({ channel: "a2a", sender: "agent:front", initiator })).toBe("human")
    expect(classifyInitiator({ channel: "telegram", sender: "Sam", initiator: { kind: "agent", channel: "cron" } })).toBe("agent")
  })

  it("ignores a malformed root", () => {
    expect(classifyInitiator({ channel: "cron", initiator: { kind: "robot" } })).toBe("agent")
    expect(classifyInitiator({ channel: "telegram", sender: "Sam", initiator: "human" })).toBe("human")
  })
})

describe("rootInitiatorOf", () => {
  it("makes this turn the root when none travels with it", () => {
    expect(rootInitiatorOf({ channel: "telegram", chatId: "c1", sender: "Sam" }, "front")).toEqual({
      kind: "human", channel: "telegram", chatId: "c1", sender: "Sam", agentId: "front",
    })
  })

  it("passes an existing root on unchanged", () => {
    const initiator = { kind: "human", channel: "app", chatId: "p1", agentId: "front" }
    expect(rootInitiatorOf({ channel: "a2a", sender: "agent:front", initiator }, "middle")).toEqual(initiator)
  })
})

describe("isHumanFacingTurn", () => {
  it("is true only for the turn talking to the person", () => {
    expect(isHumanFacingTurn({ channel: "telegram", chatId: "c1", sender: "Sam" })).toBe(true)
    expect(isHumanFacingTurn({ channel: "app", chatId: "p1" })).toBe(true)
  })

  it("is false for a delegated hop, even when a person is at the root", () => {
    expect(isHumanFacingTurn({ channel: "a2a", sender: "agent:front", initiator: { kind: "human", channel: "telegram" } })).toBe(false)
    // Forwarded with the person's own chat context, as mesh routing does.
    expect(isHumanFacingTurn({ channel: "telegram", chatId: "c1", sender: "Sam", initiator: { kind: "human", channel: "telegram" } })).toBe(false)
  })

  it("is false for a callback turn and for machine turns", () => {
    expect(isHumanFacingTurn({ channel: "telegram", chatId: "c1", sender: "Sam", delegation: { taskId: "t" } })).toBe(false)
    expect(isHumanFacingTurn({ channel: "cron", chatId: "daily" })).toBe(false)
    expect(isHumanFacingTurn(undefined)).toBe(false)
  })
})
