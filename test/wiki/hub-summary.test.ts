import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { WikiHub } from "../../src/wiki/hub"

// #603: GET /wiki/agents read every raw entry again for each agent, which
// took 25 to 75 s on a real fleet and hid every peer behind the mesh
// client's 5 s timeout. summary() now reads them once.

let dir: string
let hub: WikiHub

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wiki-summary-"))
  hub = new WikiHub(dir, () => {})
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function add(agentId: string, n: number) {
  for (let i = 0; i < n; i++) {
    hub.getSharedStore().addEntry({ id: `${agentId}-${i}`, date: "2026-10-01", agentId, source: "telegram", content: `entry ${i}` })
  }
}

function meta(owner: string, sources: string[]) {
  return { title: "One", tags: [], owner, access: "public", created: "2026-10-01", lastUpdated: "2026-10-01", sources } as any
}

describe("WikiHub.summary", () => {
  it("reads the raw entries once, however many agents there are", () => {
    add("alpha", 3)
    add("beta", 2)
    add("gamma", 1)
    const spy = vi.spyOn(hub.getSharedStore(), "listEntries")
    const s = hub.summary()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(Object.fromEntries(s.map((a) => [a.agentId, a.totalEntries]))).toEqual({ alpha: 3, beta: 2, gamma: 1 })
  })

  it("splits each agent's entries into cited, read and pending as before", () => {
    add("alpha", 3)
    add("beta", 1)
    hub.getAgentWiki("alpha").writeArticle("concept/one.md", meta("alpha", ["alpha-0"]), "body", "alpha")
    hub.markProcessed("alpha", ["alpha-0", "alpha-1"], ["alpha-0"])
    const byId = Object.fromEntries(hub.summary().map((a) => [a.agentId, a]))
    expect(byId.alpha).toMatchObject({ totalEntries: 3, cited: 1, readNotCited: 1, unabsorbed: 1, totalArticles: 1 })
    expect(byId.beta).toMatchObject({ totalEntries: 1, cited: 0, readNotCited: 0, unabsorbed: 1 })
  })

  it("lists an agent that has a wiki folder but no entries", () => {
    add("alpha", 1)
    hub.getAgentWiki("solo").writeArticle("concept/x.md", meta("solo", []), "body", "solo")
    const solo = hub.summary().find((a) => a.agentId === "solo")
    expect(solo).toMatchObject({ totalEntries: 0, totalArticles: 1, unabsorbed: 0 })
  })
})
