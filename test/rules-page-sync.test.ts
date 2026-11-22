import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { WikiHub } from "../src/wiki/hub"
import type { PeerFetch } from "../src/wiki/article-sync"
import { RulesPageSync, contentMd5, type RulesSyncConfig } from "../src/agents/rules-page-sync"
import { approveDecision, decisionHash } from "../src/wiki/decision-approvals"

const PAGE = "decisions/rules-registry.md"
const META = {
  title: "Rules Registry", type: "decision" as const, tags: ["rules"], owner: "pm-agent",
  access: "public" as const, created: "2026-11-15", lastUpdated: "2026-11-21", sources: [],
}
const BODY = "| ID | Rule | Scope |\n|---|---|---|\n| R4 | No due time without a check time | fleet |\n"

let dirs: string[] = []
function newHub(): WikiHub {
  const d = mkdtempSync(join(tmpdir(), "rules-sync-"))
  dirs.push(d)
  return new WikiHub(d, () => {})
}

beforeEach(() => { dirs = [] })
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** What GET /wiki/article answers on the node `hub` belongs to. */
function routeAnswer(hub: WikiHub, nodeId: string, runsAgent: boolean) {
  const a = hub.getAgentWiki("pm-agent").readArticle(PAGE)
  if (!a) return null
  return {
    nodeId, agentId: "pm-agent", runsAgent, path: a.path, title: a.meta.title, type: a.meta.type,
    access: a.meta.access, tags: a.meta.tags, owner: a.meta.owner, created: a.meta.created,
    lastUpdated: a.meta.lastUpdated, sources: a.meta.sources, content: a.content,
  }
}

function cfg(over: Partial<RulesSyncConfig> = {}): RulesSyncConfig {
  return { enabled: true, registryAgent: "pm-agent", registryPage: PAGE, syncMinutes: 10, maxStaleHours: 24, ...over }
}

interface Setup {
  hub?: WikiHub
  local?: boolean
  config?: Partial<RulesSyncConfig>
  directory?: Array<{ peer: string; healthy: boolean; skills: Array<{ id: string }> }>
  fetchJson?: PeerFetch
  approvalsRequired?: boolean
  now?: () => number
}

function setup(s: Setup = {}) {
  const hub = s.hub ?? newHub()
  const logs: string[] = []
  const sync = new RulesPageSync({
    hub,
    config: () => cfg(s.config),
    isLocalAgent: (id) => !!s.local && id === "pm-agent",
    peers: () => [
      { name: "mac", url: "http://mac:18800", token: "t1" },
      { name: "other", url: "http://other:18800", token: "t2" },
    ],
    directory: () => s.directory ?? [{ peer: "mac", healthy: true, skills: [{ id: "pm-agent" }, { id: "coo" }] }],
    fetchJson: s.fetchJson,
    approvalsRequired: () => !!s.approvalsRequired,
    now: s.now,
    log: (m) => logs.push(m),
  })
  return { hub, sync, logs }
}

/** A Mac whose pm-agent wiki holds the page, as the registry node. */
function macWithPage(content = BODY): WikiHub {
  const mac = newHub()
  mac.getAgentWiki("pm-agent").writeArticle(PAGE, { ...META }, content, "pm-agent")
  return mac
}

describe("RulesPageSync — registry agent on this node (Mac)", () => {
  it("never fetches and reports the local page's md5", async () => {
    const fetchJson = vi.fn()
    const { sync, hub } = setup({ hub: macWithPage(), local: true, fetchJson })
    const st = await sync.tick()
    expect(fetchJson).not.toHaveBeenCalled()
    expect(st.source).toBe("local")
    expect(st.md5).toBe(contentMd5(hub.getAgentWiki("pm-agent").readArticle(PAGE)!.content))
    expect(st.error).toBeUndefined()
  })

  it("does nothing while rules are off", async () => {
    const fetchJson = vi.fn()
    const { sync } = setup({ config: { enabled: false }, fetchJson })
    const st = await sync.tick()
    expect(fetchJson).not.toHaveBeenCalled()
    expect(st).toEqual({ enabled: false })
  })
})

describe("RulesPageSync — registry agent on a peer (clawd)", () => {
  it("fetches only from the peer whose agents include the registry agent, and logs the node", async () => {
    const mac = macWithPage()
    const urls: string[] = []
    const fetchJson: PeerFetch = vi.fn(async (peer, path) => { urls.push(peer.url + path); return routeAnswer(mac, "mac-node", true) })
    const { sync, hub, logs } = setup({
      fetchJson,
      directory: [
        { peer: "other", healthy: true, skills: [{ id: "coder" }] },
        { peer: "mac", healthy: true, skills: [{ id: "pm-agent" }] },
      ],
    })
    const st = await sync.tick()
    expect(urls).toEqual([`http://mac:18800/wiki/article?agent=pm-agent&path=${encodeURIComponent(PAGE)}`])
    expect((fetchJson as any).mock.calls[0][0].token).toBe("t1")
    expect(hub.getAgentWiki("pm-agent").readArticle(PAGE)?.content).toBe(BODY.trim())
    expect(st).toMatchObject({ source: "peer", node: "mac-node", peer: "mac" })
    expect(logs.some((l) => l.includes("synced from node mac-node (peer mac)") && l.includes(st.md5!))).toBe(true)
  })

  it("/health md5 is the same on the Mac and on clawd after a sync (content only, not meta)", async () => {
    // Trailing blank lines and odd spacing: the stored file differs from
    // the copy's file byte for byte, the content hash must not.
    const mac = macWithPage(`\n${BODY}\n\n`)
    const macSync = setup({ hub: mac, local: true }).sync
    const fetchJson: PeerFetch = vi.fn(async () => routeAnswer(mac, "mac-node", true))
    const clawd = setup({ fetchJson }).sync
    const macSt = await macSync.tick()
    const clawdSt = await clawd.tick()
    expect(clawdSt.md5).toBeDefined()
    expect(clawdSt.md5).toBe(macSt.md5)
    expect(clawd.status().md5).toBe(macSync.status().md5)
  })

  it("does not rewrite the page when the content is unchanged", async () => {
    const mac = macWithPage()
    const fetchJson: PeerFetch = vi.fn(async () => routeAnswer(mac, "mac-node", true))
    const { sync, hub, logs } = setup({ fetchJson })
    await sync.tick()
    const store = hub.getAgentWiki("pm-agent")
    const spy = vi.spyOn(store, "writeArticle")
    await sync.tick()
    expect(spy).not.toHaveBeenCalled()
    expect(logs.filter((l) => l.includes("synced from")).length).toBe(1)
  })

  it("writes again when the Mac's page changes", async () => {
    const mac = macWithPage()
    const fetchJson: PeerFetch = vi.fn(async () => routeAnswer(mac, "mac-node", true))
    const { sync, hub } = setup({ fetchJson })
    await sync.tick()
    mac.getAgentWiki("pm-agent").writeArticle(PAGE, { ...META, lastUpdated: "2026-11-22" }, BODY + "| R5 | Standing orders | fleet |\n", "pm-agent")
    await sync.tick()
    expect(hub.getAgentWiki("pm-agent").readArticle(PAGE)?.content).toContain("R5")
  })

  it("refuses an answer from a node that does not run the registry agent", async () => {
    const mac = macWithPage()
    const fetchJson: PeerFetch = vi.fn(async () => routeAnswer(mac, "mac-node", false))
    const { sync, hub, logs } = setup({ fetchJson })
    const st = await sync.tick()
    expect(hub.getAgentWiki("pm-agent").readArticle(PAGE)).toBeNull()
    expect(st.warning).toMatch(/does not run pm-agent/)
    // No copy at all: the missing page is the error that gets logged.
    expect(logs.some((l) => l.startsWith("[rules] ERROR registry page missing"))).toBe(true)
  })

  it("refuses an answer without runsAgent (an older peer)", async () => {
    const mac = macWithPage()
    const fetchJson: PeerFetch = vi.fn(async () => { const { runsAgent: _r, ...rest } = routeAnswer(mac, "mac-node", true)!; return rest })
    const { sync, hub } = setup({ fetchJson })
    await sync.tick()
    expect(hub.getAgentWiki("pm-agent").readArticle(PAGE)).toBeNull()
  })

  it("fetches nothing when two peers list the registry agent", async () => {
    const fetchJson = vi.fn()
    const { sync } = setup({
      fetchJson,
      directory: [
        { peer: "mac", healthy: true, skills: [{ id: "pm-agent" }] },
        { peer: "other", healthy: true, skills: [{ id: "pm-agent" }] },
      ],
    })
    const st = await sync.tick()
    expect(fetchJson).not.toHaveBeenCalled()
    expect(st.warning).toMatch(/mac, other/)
  })

  it("fetches nothing when no peer runs the registry agent", async () => {
    const fetchJson = vi.fn()
    const { sync } = setup({ fetchJson, directory: [{ peer: "other", healthy: true, skills: [{ id: "coder" }] }] })
    const st = await sync.tick()
    expect(fetchJson).not.toHaveBeenCalled()
    expect(st.warning).toMatch(/no mesh peer runs pm-agent/)
  })

  it("keeps the last good copy while the peer is down, and turns the warning into an error past maxStaleHours", async () => {
    const mac = macWithPage()
    let now = Date.parse("2026-11-22T00:00:00Z")
    let down = false
    const fetchJson: PeerFetch = vi.fn(async () => { if (down) throw new Error("connect ECONNREFUSED"); return routeAnswer(mac, "mac-node", true) })
    const { sync, hub, logs } = setup({ fetchJson, now: () => now })
    await sync.tick()
    down = true
    now += 2 * 3600_000
    const warn = await sync.tick()
    expect(hub.getAgentWiki("pm-agent").readArticle(PAGE)?.content).toBe(BODY.trim())
    expect(warn.error).toBeUndefined()
    expect(warn.warning).toMatch(/ECONNREFUSED/)
    expect(warn.md5).toBe(contentMd5(BODY.trim()))
    now += 23 * 3600_000
    const err = await sync.tick()
    expect(err.error).toMatch(/25h old/)
    expect(logs.some((l) => l.startsWith("[rules] ERROR") && l.includes("25h old"))).toBe(true)
  })
})

describe("RulesPageSync — missing page is an error, logged once per state change", () => {
  it("logs ERROR once while missing, once when back, and again when gone", async () => {
    const hub = newHub()
    const { sync, logs } = setup({ hub, local: true })
    await sync.tick()
    await sync.tick()
    const errors = () => logs.filter((l) => l.startsWith("[rules] ERROR registry page missing: pm-agent/decisions/rules-registry.md"))
    expect(errors().length).toBe(1)
    expect(sync.status().error).toMatch(/missing/)

    hub.getAgentWiki("pm-agent").writeArticle(PAGE, { ...META }, BODY, "pm-agent")
    await sync.tick()
    expect(logs.filter((l) => l.includes("registry page ok")).length).toBe(1)
    expect(sync.status().error).toBeUndefined()

    rmSync(join(hub.getAgentWiki("pm-agent").baseDir, PAGE))
    await sync.tick()
    expect(errors().length).toBe(2)
  })

  it("counts a page the approval filter drops as missing for runs", async () => {
    const { sync } = setup({ hub: macWithPage(), local: true, approvalsRequired: true })
    const st = await sync.tick()
    expect(st.error).toMatch(/not approved/)
  })

  it("approvals on (clawd): says approvals are not synced and how to approve here; approved here, runs get the rules", async () => {
    const mac = macWithPage()
    const fetchJson: PeerFetch = async () => routeAnswer(mac, "mac-node", true)
    const { sync, hub, logs } = setup({ fetchJson, approvalsRequired: true })
    const st = await sync.tick()
    expect(st.error).toMatch(/not approved on this node/)
    expect(st.error).toMatch(/Approvals are not synced/)
    expect(st.error).toContain(`agentx wiki decisions approve pm-agent ${PAGE}`)
    expect(logs.filter((l) => l.includes("[rules] ERROR"))).toHaveLength(1)

    const store = hub.getAgentWiki("pm-agent")
    approveDecision(store.baseDir, store.readArticle(PAGE)!)
    const after = await sync.tick()
    expect(after.error).toBeUndefined()
    expect(after.md5).toBe(contentMd5(mac.getAgentWiki("pm-agent").readArticle(PAGE)!.content))
  })

  it("copies a title with a colon, quotes and a newline so it reads back the same on clawd", async () => {
    const title = 'Rules Registry: "fleet"\nv2'
    const mac = newHub()
    mac.getAgentWiki("pm-agent").writeArticle(PAGE, { ...META, title }, BODY, "pm-agent")
    const fetchJson: PeerFetch = async () => routeAnswer(mac, "mac-node", true)
    const { sync, hub } = setup({ fetchJson })
    const st = await sync.tick()
    expect(st.error).toBeUndefined()
    const copy = hub.getAgentWiki("pm-agent").readArticle(PAGE)!
    expect(copy.meta.title).toBe(title)
    // Same title and body: an approval hash made on either node matches.
    expect(decisionHash(copy)).toBe(decisionHash(mac.getAgentWiki("pm-agent").readArticle(PAGE)!))
  })
})
