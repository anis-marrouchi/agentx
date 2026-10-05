import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createCard, decideCard, readCard, verdictMessage, DEFAULT_CARD_SETTINGS } from "../src/approvals/cards"
import { handleApprovalsApi } from "../src/approvals/daemon-api"
import { listInbox } from "../src/approvals/inbox"
import { runApprovalsSweep, FORWARDED_RESULT_RETRY_MS, type ApprovalSettings } from "../src/approvals/sweep"
import { readApprovalSettings, updateApprovalSettings } from "../src/approvals/settings"
import {
  deliverResult, forwardCard, normalizeNodeName, readForwardedCard, receiveResult, resolvePeerForNode,
} from "../src/approvals/forward"
import { daemonConfigSchema } from "../src/daemon/config"

// Decision cards across the mesh (#668). What must hold:
//   - a node with `approvals.forwardTo` hands its agents' cards to that peer,
//     in its own name, and only for agents it has
//   - the operator's node keeps a card from a known peer with `node` set,
//     and refuses one from a name that is no peer
//   - the result goes back to that node, and the card is marked told only
//     once the node took it; a node that is down is retried, for a day
//   - the raising node believes a result only with a mesh token, only for
//     its own agent, and only when it forwards cards at all

const NOW = Date.parse("2026-10-05T08:00:00.000Z")
const HOUR = 3_600_000

const SETTINGS: ApprovalSettings = {
  defaultExpiryDays: 3, maxExpiryDays: 30, laterHours: 24, notifyAgent: true,
  digest: { enabled: false, time: "09:00", timezone: "UTC" },
}

const MAC = { name: "hq-mac", url: "http://10.0.0.2:18800", token: "mac-token" }
const LINUX = { name: "linux-box", url: "http://10.0.0.3:18800", token: "linux-token" }

let root: string
let configPath: string

function card(extra: Record<string, unknown> = {}) {
  return {
    title: "Publish the launch post",
    ask: "Publish the draft on Monday?",
    recommend: "Yes: reviewed, and the date is agreed",
    if_silent: "discard",
    raised_by: "alpha",
    ...extra,
  }
}

function writeConfig(extra: Record<string, unknown> = {}) {
  writeFileSync(configPath, JSON.stringify({
    node: { id: "t", name: "T", bind: "127.0.0.1:0" },
    agents: { alpha: { name: "Alpha", workspace: "./agents/alpha", tier: "claude-code" } },
    ...extra,
  }, null, 2))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "approvals-fwd-"))
  configPath = join(root, "agentx.json")
  writeConfig()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("the operator's node keeps cards from its peers", () => {
  const deps = () => ({
    ctx: { root, now: NOW }, settings: DEFAULT_CARD_SETTINGS,
    hasAgent: (id: string) => id === "alpha",
    hasPeer: (node: string) => node === "linux-box",
  })

  it("accepts a card raised by an agent on a known peer and remembers the node", () => {
    const r = handleApprovalsApi("POST", "/approvals", card({ raised_by: "remote-coder", node: "linux-box" }), new URLSearchParams(), deps())
    expect(r.status).toBe(201)
    const c = (r.body as any).card
    expect(c).toMatchObject({ raised_by: "remote-coder", node: "linux-box", status: "pending" })
    expect(readCard(root, c.id)?.node).toBe("linux-box")
    // The inbox and the result message say where it came from.
    expect(listInbox({ root, configPath, now: NOW }).items[0]).toMatchObject({ raised_by: "remote-coder", node: "linux-box" })
    expect(verdictMessage({ ...c, status: "decided", verdict: "yes" })).toContain("forwarded from linux-box")
  })

  it("refuses a node that is no peer, and still refuses an unknown agent without one", () => {
    const stranger = handleApprovalsApi("POST", "/approvals", card({ raised_by: "remote-coder", node: "somewhere" }), new URLSearchParams(), deps())
    expect(stranger.status).toBe(400)
    expect((stranger.body as any).error).toMatch(/unknown node "somewhere"/)
    const noNode = handleApprovalsApi("POST", "/approvals", card({ raised_by: "remote-coder" }), new URLSearchParams(), deps())
    expect(noNode.status).toBe(400)
    expect((noNode.body as any).error).toMatch(/unknown agent "remote-coder"/)
    // Without a peer check at all, nothing changes from before.
    const { hasPeer: _, ...noPeers } = deps()
    expect(handleApprovalsApi("POST", "/approvals", card({ raised_by: "remote-coder", node: "linux-box" }), new URLSearchParams(), noPeers).status).toBe(400)
  })

  it("never marks a local agent's card as remote, whatever the body says", () => {
    const r = handleApprovalsApi("POST", "/approvals", card({ node: "linux-box" }), new URLSearchParams(), deps())
    expect(r.status).toBe(201)
    expect((r.body as any).card.node).toBeUndefined()
  })
})

describe("the operator's sweep sends the result back", () => {
  const remote = () => {
    const r = createCard(root, card({ raised_by: "remote-coder" }), { now: NOW, node: "linux-box" })
    if (!r.ok) throw new Error(r.error)
    decideCard(root, r.card.id, "yes", { now: NOW + HOUR, note: "go" })
    return r.card.id
  }

  it("hands the card to the peer instead of a local turn, then marks it told", async () => {
    const id = remote()
    const tellAgent = vi.fn(async () => {})
    const tellPeer = vi.fn(async () => {})
    const onCardResult = vi.fn()
    const r = await runApprovalsSweep({ ctx: { root, now: NOW + 2 * HOUR }, settings: SETTINGS, tellAgent, tellPeer, onCardResult, hasAgent: () => false, log: () => {} })
    expect(r.notified).toBe(1)
    expect(tellAgent).not.toHaveBeenCalled()
    expect(tellPeer).toHaveBeenCalledTimes(1)
    expect(tellPeer.mock.calls[0][0]).toBe("linux-box")
    expect((tellPeer.mock.calls[0][1] as any).id).toBe(id)
    expect(onCardResult).toHaveBeenCalledTimes(1)
    expect(readCard(root, id)?.agent_notified_at).toBeDefined()
    // Once is enough.
    await runApprovalsSweep({ ctx: { root, now: NOW + 3 * HOUR }, settings: SETTINGS, tellAgent, tellPeer, hasAgent: () => false, log: () => {} })
    expect(tellPeer).toHaveBeenCalledTimes(1)
  })

  it("retries while the peer is down, and gives up after a day", async () => {
    const id = remote()
    const tellPeer = vi.fn(async () => { throw new Error("connect ECONNREFUSED") })
    const onCardResult = vi.fn()
    const log = vi.fn()
    await runApprovalsSweep({ ctx: { root, now: NOW + 2 * HOUR }, settings: SETTINGS, tellPeer, onCardResult, log })
    expect(readCard(root, id)?.agent_notified_at).toBeUndefined()
    expect(onCardResult).not.toHaveBeenCalled()
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/couldn't send .* to linux-box .*will retry/)
    await runApprovalsSweep({ ctx: { root, now: NOW + 3 * HOUR }, settings: SETTINGS, tellPeer, onCardResult, log })
    expect(tellPeer).toHaveBeenCalledTimes(2)
    // Decided at NOW + 1h; a day later the sweep stops trying.
    await runApprovalsSweep({ ctx: { root, now: NOW + HOUR + FORWARDED_RESULT_RETRY_MS + 1 }, settings: SETTINGS, tellPeer, onCardResult, log })
    expect(readCard(root, id)?.agent_notified_at).toBeDefined()
    expect(onCardResult).toHaveBeenCalledTimes(1)
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/giving up/)
  })

  it("marks it told without a handoff when agents are not notified, or nothing can send", async () => {
    const id = remote()
    const tellPeer = vi.fn(async () => {})
    await runApprovalsSweep({ ctx: { root, now: NOW + 2 * HOUR }, settings: { ...SETTINGS, notifyAgent: false }, tellPeer, log: () => {} })
    expect(tellPeer).not.toHaveBeenCalled()
    expect(readCard(root, id)?.agent_notified_at).toBeDefined()
    const other = remote()
    await runApprovalsSweep({ ctx: { root, now: NOW + 2 * HOUR }, settings: SETTINGS, log: () => {} })
    expect(readCard(root, other)?.agent_notified_at).toBeDefined()
  })
})

describe("the raising node's side (forward.ts)", () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const answer = (status: number, body: unknown) => (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  beforeEach(() => { calls.length = 0 })

  it("forwards a card in its own name with the peer's token", async () => {
    const reply = await forwardCard(card(), { self: "Linux Box", peer: MAC, fetch: answer(201, { card: { id: "x" } }) })
    expect(reply).toEqual({ status: 201, body: { card: { id: "x" } } })
    expect(calls[0].url).toBe("http://10.0.0.2:18800/approvals")
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer mac-token")
    const sent = JSON.parse(String(calls[0].init.body))
    expect(sent).toMatchObject({ ...card(), node: "Linux Box" })
  })

  it("falls back to MESH_TOKEN when the peer entry has no token, and reports a peer it cannot reach", async () => {
    await forwardCard(card(), { self: "L", peer: { name: "hq-mac", url: "http://10.0.0.2:18800/" }, env: { MESH_TOKEN: "shared" }, fetch: answer(201, {}) })
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer shared")
    expect(calls[0].url).toBe("http://10.0.0.2:18800/approvals")
    const down = (async () => { throw new Error("connect ECONNREFUSED") }) as unknown as typeof fetch
    const reply = await forwardCard(card(), { self: "L", peer: MAC, fetch: down })
    expect(reply.status).toBe(502)
    expect((reply.body as any).error).toMatch(/couldn't reach hq-mac/)
  })

  it("reads a forwarded card on the peer, and hands a result over or throws", async () => {
    const read = await readForwardedCard("2026-10-05-x-ab12", { self: "L", peer: MAC, fetch: answer(200, { card: { id: "2026-10-05-x-ab12" } }) })
    expect(read.status).toBe(200)
    expect(calls[0].url).toBe("http://10.0.0.2:18800/approvals/2026-10-05-x-ab12")
    expect(calls[0].init.method).toBe("GET")
    const c = { id: "2026-10-05-x-ab12", status: "decided" } as any
    await deliverResult(c, { self: "M", peer: LINUX, fetch: answer(202, { ok: true }) })
    expect(calls[1].url).toBe("http://10.0.0.3:18800/approvals/result")
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ card: c })
    await expect(deliverResult(c, { self: "M", peer: LINUX, fetch: answer(400, { error: "unknown agent" }) })).rejects.toThrow(/unknown agent/)
  })

  it("believes a result only with a mesh token, for its own agent, from the node it is", () => {
    const base = { self: "Linux Box", forwardTo: "hq-mac", hasAgent: (id: string) => id === "alpha", authorized: true }
    const good = { card: { id: "2026-10-05-x-ab12", raised_by: "alpha", node: "linux-box", status: "decided", verdict: "yes" } }
    expect(receiveResult(good, base)).toMatchObject({ ok: true, card: { id: "2026-10-05-x-ab12" } })
    expect(receiveResult(good, { ...base, authorized: false })).toMatchObject({ ok: false, status: 401 })
    expect(receiveResult(good, { ...base, forwardTo: undefined })).toMatchObject({ ok: false, status: 409 })
    expect(receiveResult({ card: { ...good.card, raised_by: "beta" } }, base)).toMatchObject({ ok: false, status: 400 })
    expect(receiveResult({ card: { ...good.card, node: "other" } }, base)).toMatchObject({ ok: false, status: 400 })
    expect(receiveResult({ card: { ...good.card, status: "pending" } }, base)).toMatchObject({ ok: false, status: 400 })
    expect(receiveResult({ card: { ...good.card, id: "../etc" } }, base)).toMatchObject({ ok: false, status: 400 })
    expect(receiveResult({}, base)).toMatchObject({ ok: false, status: 400 })
  })

  it("finds the peer a node name means, however it was spelled on the other side", () => {
    expect(normalizeNodeName("HQ Mac")).toBe("hqmac")
    const peers = [MAC, LINUX]
    expect(resolvePeerForNode("hq-mac", peers)).toBe(MAC)
    expect(resolvePeerForNode("HQ Mac", peers)).toBe(MAC)
    expect(resolvePeerForNode("Studio", peers)).toBeUndefined()
    // The node calls itself "Studio" on its agent card; we listed it as linux-box.
    expect(resolvePeerForNode("Studio", peers, [{ peer: "linux-box", node: "Studio" }])).toBe(LINUX)
    expect(resolvePeerForNode("", peers)).toBeUndefined()
  })
})

describe("both nodes together", () => {
  it("a card raised on the Linux node is decided on the Mac and the result comes back", async () => {
    const macRoot = mkdtempSync(join(tmpdir(), "approvals-mac-"))
    try {
      // The Mac's daemon: keeps cards from its peer linux-box.
      const macDeps = () => ({
        ctx: { root: macRoot, now: NOW }, settings: DEFAULT_CARD_SETTINGS,
        hasAgent: (id: string) => id === "assistant", hasPeer: (n: string) => n === "linux-box",
      })
      const macFetch = (async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer mac-token")
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        const r = handleApprovalsApi(init.method ?? "GET", path, body, new URLSearchParams(), macDeps())
        return new Response(JSON.stringify(r.body), { status: r.status })
      }) as unknown as typeof fetch
      const linux = { self: "linux-box", peer: MAC, fetch: macFetch }

      // Linux: the agent raises a card; its daemon forwards it.
      const raised = await forwardCard(card({ raised_by: "coder" }), linux)
      expect(raised.status).toBe(201)
      const id = (raised.body as any).card.id
      expect(readCard(macRoot, id)).toMatchObject({ raised_by: "coder", node: "linux-box" })
      expect(readCard(root, id)).toBeNull()
      // Linux: the agent checks its status, answered from the Mac.
      expect((await readForwardedCard(id, linux)).body).toMatchObject({ card: { status: "pending" } })

      // Mac: the operator answers; the sweep posts the card back to Linux,
      // whose daemon accepts it for its own agent.
      decideCard(macRoot, id, "yes", { now: NOW + HOUR })
      const delivered: any[] = []
      const linuxFetch = (async (url: string, init: RequestInit) => {
        expect(url).toBe("http://10.0.0.3:18800/approvals/result")
        const token = new Headers(init.headers).get("authorization") === "Bearer linux-token"
        const r = receiveResult(JSON.parse(String(init.body)), { self: "Linux Box", forwardTo: "hq-mac", hasAgent: (a) => a === "coder", authorized: token })
        if (r.ok) delivered.push(r.card)
        return new Response(JSON.stringify(r.ok ? { ok: true } : { error: r.error }), { status: r.ok ? 202 : r.status })
      }) as unknown as typeof fetch
      const sweep = await runApprovalsSweep({
        ctx: { root: macRoot, now: NOW + 2 * HOUR }, settings: SETTINGS, hasAgent: (a) => a === "assistant", log: () => {},
        tellPeer: async (node, c) => {
          const peer = resolvePeerForNode(node, [LINUX])
          if (!peer) throw new Error(`no peer ${node}`)
          await deliverResult(c, { self: "hq-mac", peer, fetch: linuxFetch })
        },
      })
      expect(sweep.notified).toBe(1)
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toMatchObject({ id, status: "decided", verdict: "yes", raised_by: "coder" })
      expect(verdictMessage(delivered[0])).toMatch(/The operator said YES/)
    } finally {
      rmSync(macRoot, { recursive: true, force: true })
    }
  })
})

describe("the setting", () => {
  it("parses, and must name something", () => {
    const base = { node: { id: "t", name: "T" } }
    expect(daemonConfigSchema.parse({ ...base, approvals: { forwardTo: "hq-mac" } }).approvals.forwardTo).toBe("hq-mac")
    expect(daemonConfigSchema.parse(base).approvals.forwardTo).toBeUndefined()
    expect(daemonConfigSchema.safeParse({ ...base, approvals: { forwardTo: "" } }).success).toBe(false)
  })

  it("is set only to a paired peer, and cleared with null", async () => {
    const none = await updateApprovalSettings({ forwardTo: "hq-mac" }, { configPath, reload: false })
    expect(none.success).toBe(false)
    expect(none.error).toMatch(/not in mesh.peers/)
    writeConfig({ mesh: { enabled: true, peers: [{ name: "hq-mac", url: "http://10.0.0.2:18800", token: "t" }] } })
    const set = await updateApprovalSettings({ forwardTo: "hq-mac" }, { configPath, reload: false })
    expect(set.success).toBe(true)
    expect(readApprovalSettings(configPath).forwardTo).toBe("hq-mac")
    const typo = await updateApprovalSettings({ forwardTo: "hq-mak" }, { configPath, reload: false })
    expect(typo.success).toBe(false)
    expect(typo.error).toMatch(/known: hq-mac/)
    const cleared = await updateApprovalSettings({ forwardTo: null }, { configPath, reload: false })
    expect(cleared.success).toBe(true)
    expect(readApprovalSettings(configPath).forwardTo).toBeUndefined()
  })
})
