import { describe, it, expect } from "vitest"
import { addressedAgent, meshAddressables, resolveAddress, type AddressDirectory } from "../src/voice/address"

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

// --- Across the mesh (#266) ---

const directory: AddressDirectory = [
  {
    peer: "server",
    healthy: true,
    skills: [
      { id: "planner-agent", name: "Planner", tags: ["claude-code", "@planner", "plans"], color: "#2563EB" },
      { id: "sam-a", name: "Sam", tags: ["claude-code"] },
      { id: "writer", name: "Remote Writer", tags: ["claude-code"] },
    ],
  },
  { peer: "studio", healthy: true, skills: [{ id: "sam-b", name: "Sam", tags: ["orchestrator"] }, { id: "twin", name: "Twin", tags: [] }] },
  { peer: "lab", healthy: true, skills: [{ id: "twin", name: "Twin", tags: [] }] },
  { peer: "offline", healthy: false, skills: [{ id: "archivist", name: "Archivist", tags: [] }] },
]
const isLocal = (id: string) => agents.some((a) => a.id === id)
const remote = meshAddressables(directory, isLocal)
const resolve = (text: string, target = "writer") =>
  resolveAddress({ text, target, local: agents, remote, localNode: "laptop" })

describe("meshAddressables", () => {
  it("lists healthy peers' agents with their node, leaving out local ids", () => {
    const ids = remote.map((a) => `${a.node}/${a.id}`)
    expect(ids).toEqual(["server/planner-agent", "server/sam-a", "studio/sam-b", "studio/twin", "lab/twin"])
  })

  it("reads mentions from the card's tags after the tier", () => {
    expect(remote[0].mentions).toEqual(["@planner", "plans"])
  })
})

describe("resolveAddress", () => {
  it("routes a local agent's name to it, with this node", () => {
    const r = resolve("Ops, what is running", "writer")
    expect(r).toMatchObject({ agentId: "ops-agent", name: "Ops", node: "laptop", remote: false, addressed: true })
    expect(r.color).toMatch(/^#[0-9A-F]{6}$/i)
  })

  it("routes a remote agent's name, id or mention to its plain id and node", () => {
    for (const text of ["Planner, what's the status", "planner-agent status", "@planner status?", "Plans: next week"]) {
      expect(resolve(text), text).toMatchObject({ agentId: "planner-agent", name: "Planner", node: "server", color: "#2563EB", remote: true, addressed: true })
    }
    expect(resolve("Planner, hi").palette.colors).toHaveLength(5)
  })

  it("derives a remote colour from the id when the peer sent none", () => {
    const local = resolveAddress({ text: "sam-a hi", target: "writer", local: [], remote, localNode: "laptop" })
    const again = resolveAddress({ text: "hi", target: "sam-a", local: [], remote: [{ id: "sam-a" }], localNode: "laptop" })
    expect(local.agentId).toBe("sam-a")
    expect(local.color).toBe(again.color)
    expect(local.color).toMatch(/^#[0-9A-F]{6}$/i)
  })

  it("keeps the target when the same name is on two peers", () => {
    expect(resolve("Sam, hi")).toMatchObject({ agentId: "writer", addressed: false, node: "laptop" })
    expect(resolve("Twin, hi")).toMatchObject({ agentId: "writer", addressed: false })
  })

  it("keeps the target when a local and a remote agent share a name", () => {
    const withLocalPlanner = [...agents, { id: "planner", name: "Planner" }]
    const r = resolveAddress({ text: "Planner, hi", target: "writer", local: withLocalPlanner, remote, localNode: "laptop" })
    expect(r).toMatchObject({ agentId: "writer", addressed: false })
  })

  it("keeps the target for an unknown name or an agent on an unhealthy peer", () => {
    expect(resolve("Nobody, hi")).toMatchObject({ agentId: "writer", name: "Main Writer", addressed: false })
    expect(resolve("Archivist, hi")).toMatchObject({ agentId: "writer", addressed: false })
  })

  it("prefers the local agent when a peer has the same id", () => {
    expect(resolve("Remote Writer, hi", "ops-agent")).toMatchObject({ agentId: "ops-agent", addressed: false })
    expect(resolve("Writer, hi", "ops-agent")).toMatchObject({ agentId: "writer", node: "laptop" })
  })

  it("describes a remote target when nobody is named", () => {
    expect(resolve("what's next", "planner-agent")).toMatchObject({ agentId: "planner-agent", name: "Planner", node: "server", addressed: false })
  })

  it("uses a local agent's configured look", () => {
    const r = resolveAddress({
      text: "Ops, hi", target: "writer", local: agents, remote, localNode: "laptop",
      localLook: (id) => (id === "ops-agent" ? { color: "#112233", palette: "forest" } : undefined),
    })
    expect(r).toMatchObject({ color: "#112233", palette: { id: "forest" } })
  })

  // #553
  it("a local agent with no colour of its own gets the default palette", () => {
    const hashed = (defaultPalette?: string) => resolveAddress({
      text: "", target: "ops-agent", local: [{ id: "ops-agent" }], remote: [], localNode: "n",
      localLook: () => ({ color: "#7C3AED", colorSet: false }), defaultPalette,
    })
    expect(hashed()).toMatchObject({ color: "#7C3AED", palette: { id: "lagoon" } })
    expect(hashed("forest").palette.id).toBe("forest")
  })

  it("ignores a malformed colour from a peer", () => {
    const r = resolveAddress({ text: "Odd, hi", target: "writer", local: [], remote: [{ id: "odd", name: "Odd", node: "server", color: "red;x" }], localNode: "laptop" })
    expect(r.color).toMatch(/^#[0-9A-F]{6}$/i)
  })
})
