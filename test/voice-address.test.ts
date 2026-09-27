import { describe, it, expect } from "vitest"
import { addressedAgent } from "../src/voice/address"

const agents = [
  { id: "writer", name: "Main Writer", mentions: ["@writer"] },
  { id: "researcher-agent", name: "Researcher", mentions: ["@example_research_bot", "research"] },
  { id: "ops-agent", name: "Ops", mentions: [] },
  { id: "dev-session", name: "Dev Session", mentions: ["@dev-session"] },
  { id: "helper-agent", name: "Helper", mentions: ["@assistant", "assistant"] },
]

describe("addressedAgent", () => {
  it("routes a leading name to that agent", () => {
    expect(addressedAgent("Writer, what's the status?", agents, "researcher-agent")).toBe("writer")
    expect(addressedAgent("ops what is running", agents, "researcher-agent")).toBe("ops-agent")
  })

  it("matches id, name and mentions without @, ignoring case", () => {
    expect(addressedAgent("RESEARCHER-AGENT, hi", agents, "writer")).toBe("researcher-agent")
    expect(addressedAgent("main writer, hi", agents, "researcher-agent")).toBe("writer")
    expect(addressedAgent("Research: any news?", agents, "writer")).toBe("researcher-agent")
    expect(addressedAgent("Assistant, book it", agents, "writer")).toBe("helper-agent")
    expect(addressedAgent("@writer hello", agents, "ops-agent")).toBe("writer")
  })

  it("prefers a two-word name over its first word", () => {
    const withDev = [...agents, { id: "dev", name: "Dev" }]
    expect(addressedAgent("Dev Session, pull main", withDev, "writer")).toBe("dev-session")
    expect(addressedAgent("Dev, pull main", withDev, "writer")).toBe("dev")
  })

  it("keeps the target when no leading name matches", () => {
    expect(addressedAgent("what's the status", agents, "researcher-agent")).toBe("researcher-agent")
    expect(addressedAgent("please ask writer later", agents, "researcher-agent")).toBe("researcher-agent")
    expect(addressedAgent("", agents, "researcher-agent")).toBe("researcher-agent")
    expect(addressedAgent("  ,  ", agents, "researcher-agent")).toBe("researcher-agent")
  })

  it("keeps the target when more than one agent matches", () => {
    const twins = [{ id: "a", name: "Sam" }, { id: "b", name: "Sam" }]
    expect(addressedAgent("Sam, hi", twins, "a")).toBe("a")
    expect(addressedAgent("Sam, hi", twins, "c")).toBe("c")
  })

  it("returns the target unchanged when it is the one named", () => {
    expect(addressedAgent("Writer, again", agents, "writer")).toBe("writer")
  })
})
