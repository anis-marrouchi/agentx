import { describe, it, expect, beforeEach } from "vitest"
import { applyAttachSessions, resetLiveCaches, withLastGood } from "../src/daemon/board-dashboard"

// #193 — the Live page must not lose a node that is briefly slow, and must
// show which Claude Code session answers for which agent.

const URL = "http://127.0.0.1:18800"
const good = (agents = [{ id: "dev-session" }]) =>
  ({ id: "mac", name: "MacBook", url: URL, reachable: true, agents }) as any
const down = (error = "The operation was aborted.") =>
  ({ id: URL, name: URL, url: URL, reachable: false, error, agents: [] }) as any

beforeEach(() => resetLiveCaches())

describe("live snapshot: last good node", () => {
  it("shows the last good data, marked stale, when a node times out", () => {
    const t0 = 1_800_000_000_000
    withLastGood(URL, good(), t0)
    const shown = withLastGood(URL, down(), t0 + 10_000)
    expect(shown.stale).toBe(true)
    expect(shown.agents.map((a: any) => a.id)).toEqual(["dev-session"])
    expect(shown.error).toBe("The operation was aborted.")
    expect(shown.staleSince).toBe(new Date(t0).toISOString())
  })

  it("stops pretending after five minutes and when nothing was ever seen", () => {
    const t0 = 1_800_000_000_000
    expect(withLastGood(URL, down(), t0).stale).toBeUndefined()
    withLastGood(URL, good(), t0)
    expect(withLastGood(URL, down(), t0 + 6 * 60_000).stale).toBeUndefined()
  })

  it("a fresh good response replaces the stale copy", () => {
    const t0 = 1_800_000_000_000
    withLastGood(URL, good(), t0)
    withLastGood(URL, down(), t0 + 1_000)
    const back = withLastGood(URL, good([{ id: "coder-agent" }]), t0 + 2_000)
    expect(back.stale).toBeUndefined()
    expect(back.agents[0].id).toBe("coder-agent")
  })
})

describe("live snapshot: attached sessions", () => {
  it("marks the bound agent and lists every session, including saved ones waiting to return", () => {
    const node = good([{ id: "dev-session" }, { id: "coder-agent" }, { id: "cx-agent" }])
    applyAttachSessions(node, [
      { sessionId: "67d57923-aaaa", cwd: "/Users/x/Developer/mtgl-system-v2", agentIds: ["dev-session"], mode: "notify", lastSeenAt: 5, pending: 1 },
      { sessionId: "9a0ec9b7-bbbb", cwd: "/Users/x/Developer/devops-workspace", agentIds: [], mode: "notify", lastSeenAt: 4 },
    ], {
      "c0ffee00-cccc": { agentIds: ["coder-agent"], mode: "auto", cwd: "/Users/x/Developer/coder-workspace", savedAt: 3 },
    })

    expect(node.agents[0].attached).toEqual({ session: "67d57923", project: "mtgl-system-v2", mode: "notify", lastSeenAt: 5, waiting: undefined })
    expect(node.agents[1].attached).toMatchObject({ project: "coder-workspace", waiting: true })
    expect(node.agents[2].attached).toBeUndefined()
    expect(node.attachSessions).toHaveLength(3)
    expect(node.attachSessions[1]).toMatchObject({ project: "devops-workspace", agentIds: [] })
    // Only the project folder leaves the machine, never the full path.
    expect(JSON.stringify(node.attachSessions)).not.toContain("/Users/")
  })
})
