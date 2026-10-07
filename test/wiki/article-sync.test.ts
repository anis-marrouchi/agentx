import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"

import { WikiHub } from "../../src/wiki/hub"
import { isSafeArticlePath, syncPeerArticles, type PeerFetch } from "../../src/wiki/article-sync"

let dir: string
let hub: WikiHub

const PEER = { url: "http://peer:19900", token: "t" }

/** A peer with one remote agent ("ops") and one agent this node also runs ("coder"). */
function fakePeer(over: { lastUpdated?: string; path?: string } = {}) {
  const path = over.path ?? "decisions/use-postgres.md"
  const calls: string[] = []
  const fetchJson: PeerFetch = vi.fn(async (_peer, url: string) => {
    calls.push(url)
    if (url === "/wiki/agents") {
      return { nodeId: "peer-node", agents: [
        { agentId: "ops", totalArticles: 1 },
        { agentId: "coder", totalArticles: 3 },
        { agentId: "quiet", totalArticles: 0 },
      ] }
    }
    if (url.startsWith("/wiki/articles?agent=ops")) {
      return { articles: [{
        path, title: "Use Postgres", type: "decision", related: ["Database"], tags: ["db"],
        owner: "ops", access: "private", aliases: [], backlinks: 0,
        sources: ["e1"], lastUpdated: over.lastUpdated ?? "2026-10-07", graphPath: ["work", "infra"],
      }] }
    }
    if (url.startsWith("/wiki/article?agent=ops")) {
      return { content: "We chose [[Database]] Postgres.", created: "2026-10-01" }
    }
    throw new Error(`unexpected ${url}`)
  })
  return { fetchJson, calls }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "article-sync-"))
  hub = new WikiHub(dir, () => {})
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("syncPeerArticles", () => {
  it("copies a remote agent's articles with their metadata and marks the agent read-only", async () => {
    const { fetchJson } = fakePeer()
    const result = await syncPeerArticles({ hub, peer: PEER, localAgents: new Set(["coder"]), fetchJson })

    expect(result.node).toBe("peer-node")
    expect(result.agents.find((a) => a.agentId === "ops")).toMatchObject({ copied: 1, unchanged: 0, rejected: 0 })
    const article = hub.getAgentWiki("ops").readArticle("decisions/use-postgres.md")
    expect(article?.content).toBe("We chose [[Database]] Postgres.")
    expect(article?.meta).toMatchObject({
      title: "Use Postgres", type: "decision", related: ["Database"], owner: "ops",
      access: "private", created: "2026-10-01", lastUpdated: "2026-10-07", sources: ["e1"], graphPath: ["work", "infra"],
    })
    expect(existsSync(resolve(hub.getAgentWiki("ops").baseDir, "_index.md"))).toBe(true)
    expect(hub.syncedFrom("ops")).toMatchObject({ node: "peer-node", peerUrl: PEER.url })
  })

  it("never copies an agent this node runs, nor marks it read-only", async () => {
    const { fetchJson, calls } = fakePeer()
    const result = await syncPeerArticles({ hub, peer: PEER, localAgents: new Set(["coder"]), fetchJson })

    expect(result.agents.find((a) => a.agentId === "coder")?.skipped).toBe("local")
    expect(calls.some((u) => u.includes("agent=coder"))).toBe(false)
    expect(hub.syncedFrom("coder")).toBeNull()
  })

  it("does not fetch an article again when last_updated matches", async () => {
    await syncPeerArticles({ hub, peer: PEER, localAgents: new Set(), fetchJson: fakePeer().fetchJson })
    const second = fakePeer()
    const result = await syncPeerArticles({ hub, peer: PEER, localAgents: new Set(), fetchJson: second.fetchJson })

    expect(result.agents.find((a) => a.agentId === "ops")).toMatchObject({ copied: 0, unchanged: 1 })
    expect(second.calls.some((u) => u.startsWith("/wiki/article?"))).toBe(false)
  })

  it("refuses an article path that leaves the agent's folder", async () => {
    const { fetchJson } = fakePeer({ path: "../coder/graph/evil.md" })
    const result = await syncPeerArticles({ hub, peer: PEER, localAgents: new Set(), fetchJson })

    expect(result.agents.find((a) => a.agentId === "ops")).toMatchObject({ copied: 0, rejected: 1 })
    expect(existsSync(resolve(dir, "agents", "coder", "graph", "evil.md"))).toBe(false)
  })

  it("writes nothing on a dry run", async () => {
    const { fetchJson } = fakePeer()
    const result = await syncPeerArticles({ hub, peer: PEER, localAgents: new Set(), fetchJson, dryRun: true })

    expect(result.agents.find((a) => a.agentId === "ops")?.copied).toBe(1)
    expect(existsSync(resolve(dir, "agents", "ops"))).toBe(false)
    expect(hub.syncedFrom("ops")).toBeNull()
  })
})

describe("isSafeArticlePath", () => {
  it("accepts ordinary article paths and refuses sidecars, raw entries and escapes", () => {
    const base = "/w/agents/ops/graph"
    expect(isSafeArticlePath(base, "people/ada.md")).toBe(true)
    for (const bad of ["../x.md", "a/../../x.md", "/etc/x.md", "_index.md", "raw/e.md", "a.txt", "a\\b.md", "a//b.md", 5]) {
      expect(isSafeArticlePath(base, bad)).toBe(false)
    }
  })
})
