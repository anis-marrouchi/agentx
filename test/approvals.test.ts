import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs"
import { createServer, type Server } from "http"
import { tmpdir } from "os"
import { join } from "path"
import {
  buildCard, createCard, decideCard, expireCards, readCard, resolveCard, resolveExpiry, cardsAwaitingAgentNotice, verdictMessage,
  saveCard, CARD_LIMITS, NO_UNDO_LINE, DEFAULT_CARD_SETTINGS, IF_SILENT_VALUES,
} from "../src/approvals/cards"
import { decide, listInbox, parseKey } from "../src/approvals/inbox"
import { runApprovalsSweep, digestDue, digestText, type ApprovalSettings } from "../src/approvals/sweep"
import { handleApprovalsApi, OPERATOR_ONLY } from "../src/approvals/daemon-api"
import { runApprovalTool } from "../src/approvals/tool"
import { handleApprovalsPanelApi } from "../src/daemon/approvals-panel"
import { renderApprovalsPage } from "../src/daemon/ui/pages/approvals"
import { readInboxState } from "../src/approvals/state"
import { MemoryStore } from "../src/agents/memory-store"
import { saveProposal, readProposal, type PromotionProposal } from "../src/wiki/proposals"
import { daemonConfigSchema } from "../src/daemon/config"
import { isMeshGatedPath, decideMeshAuth } from "../src/daemon/mesh-auth"

// The Approvals inbox. What must hold:
//   - one list over cards, schedule requests, held facts and wiki proposals,
//     most urgent first, bounded
//   - a verdict goes through each source's own approve/reject
//   - cards always expire, and the default applies on expiry
//   - the agent hears the result once; the operator gets at most one digest a day
//   - nothing an agent can reach decides: the daemon API refuses, the tool can't

const NOW = Date.parse("2026-09-26T08:00:00.000Z")
const HOUR = 3_600_000
const DAY = 24 * HOUR

let root: string
let configPath: string

const SETTINGS: ApprovalSettings = {
  defaultExpiryDays: 3,
  maxExpiryDays: 30,
  laterHours: 24,
  notifyAgent: true,
  digest: { enabled: true, time: "09:00", timezone: "UTC" },
}

function writeConfig(crons: Record<string, any> = {}) {
  writeFileSync(configPath, JSON.stringify({
    node: { id: "t", name: "T", bind: "127.0.0.1:0" },
    agents: {
      alpha: { name: "Alpha", workspace: "./agents/alpha", tier: "claude-code" },
      beta: { name: "Beta", workspace: "./agents/beta", tier: "claude-code" },
    },
    notifications: { destination: { channel: "telegram", chatId: "1000" } },
    crons,
  }, null, 2))
}

const PENDING_CRON = {
  enabled: false,
  schedule: "0 10 * * 1",
  timezone: "UTC",
  agent: "alpha",
  prompt: "Summarise the open invoices",
  timeout: 600,
  onError: ["log"],
  createdBy: "alpha",
  approval: { action: "create", requestedBy: "alpha", requestedAt: "2026-09-25T08:00:00.000Z" },
}

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

function proposal(id: string): PromotionProposal {
  return {
    id,
    createdAt: "2026-09-24T08:00:00.000Z",
    status: "pending",
    article: { path: "lessons/retry-on-timeout.md", title: "Retry on timeout", tags: [], content: "When a call times out, retry once.", promotedFrom: ["m1"] },
    evidence: { agents: ["beta"], occurrences: 2, sources: [] },
  }
}

function ctx() {
  return { root, configPath, reload: false, now: NOW }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "approvals-"))
  configPath = join(root, "agentx.json")
  writeConfig()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("decision cards", () => {
  it("requires the one-line brief and a valid default", () => {
    expect(buildCard(card({ title: "" }), { now: NOW })).toMatchObject({ ok: false })
    expect(buildCard(card({ recommend: " " }), { now: NOW })).toMatchObject({ ok: false })
    expect(buildCard(card({ if_silent: "forever" }), { now: NOW })).toMatchObject({ ok: false })
    expect(buildCard(card({ title: "x".repeat(CARD_LIMITS.title + 1) }), { now: NOW })).toMatchObject({ ok: false })
    expect(buildCard(card({ source: "javascript:alert(1)" }), { now: NOW })).toMatchObject({ ok: false })
  })

  it("always expires: default, relative, absolute, capped", () => {
    const s = DEFAULT_CARD_SETTINGS
    expect(resolveExpiry(undefined, NOW, s)).toEqual({ ok: true, at: new Date(NOW + 3 * DAY).toISOString() })
    expect(resolveExpiry("12h", NOW, s)).toEqual({ ok: true, at: new Date(NOW + 12 * HOUR).toISOString() })
    expect(resolveExpiry("2026-09-28T08:00:00Z", NOW, s)).toEqual({ ok: true, at: "2026-09-28T08:00:00.000Z" })
    expect(resolveExpiry("400d", NOW, s)).toEqual({ ok: true, at: new Date(NOW + 30 * DAY).toISOString() })
    expect(resolveExpiry("2020-01-01", NOW, s)).toMatchObject({ ok: false })
    expect(resolveExpiry("soon", NOW, s)).toMatchObject({ ok: false })
  })

  it("caps how many cards one agent may leave open", () => {
    for (let i = 0; i < CARD_LIMITS.pendingPerAgent; i++) expect(createCard(root, card(), { now: NOW }).ok).toBe(true)
    expect(createCard(root, card(), { now: NOW })).toMatchObject({ ok: false })
    expect(createCard(root, card({ raised_by: "beta" }), { now: NOW }).ok).toBe(true)
  })

  it("applies if_silent on expiry, once", () => {
    const r = createCard(root, card({ expires: "1h" }), { now: NOW })
    if (!r.ok) throw new Error(r.error)
    expect(expireCards(root, NOW + 30 * 60_000)).toHaveLength(0)
    const expired = expireCards(root, NOW + 2 * HOUR)
    expect(expired).toHaveLength(1)
    expect(expired[0]).toMatchObject({ status: "expired", outcome: "discard", decided_by: "expiry" })
    expect(expireCards(root, NOW + 3 * HOUR)).toHaveLength(0)
    expect(decideCard(root, r.card.id, "yes")).toMatchObject({ ok: false })
  })

  it("never approves itself: \"approve\" is read as \"keep\" (#741)", () => {
    expect(IF_SILENT_VALUES).not.toContain("approve")
    const built = buildCard(card({ if_silent: "approve" }), { now: NOW })
    expect(built).toMatchObject({ ok: true, card: { if_silent: "keep", if_silent_asked: "approve" } })
    // A card stored by an older version still expires as "keep".
    const r = createCard(root, card({ expires: "1h" }), { now: NOW })
    if (!r.ok) throw new Error(r.error)
    const file = join(root, ".agentx", "approvals", `${r.card.id}.json`)
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf-8")), if_silent: "approve" }))
    expect(expireCards(root, NOW + 2 * HOUR)[0]).toMatchObject({ status: "expired", outcome: "keep" })
    // The saved record keeps what was originally asked.
    expect(JSON.parse(readFileSync(file, "utf-8"))).toMatchObject({ if_silent: "keep", if_silent_asked: "approve" })
  })

  it("an agent not yet told about a card that expired as \"approve\" hears \"keep\" (#741)", () => {
    const r = createCard(root, card({ expires: "1h" }), { now: NOW })
    if (!r.ok) throw new Error(r.error)
    expireCards(root, NOW + 2 * HOUR)
    const file = join(root, ".agentx", "approvals", `${r.card.id}.json`)
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf-8")), if_silent: "approve", outcome: "approve" }))
    const stored = readCard(root, r.card.id)
    expect(stored).toMatchObject({ outcome: "keep", if_silent: "keep", if_silent_asked: "approve" })
    const [pending] = cardsAwaitingAgentNotice(root)
    expect(verdictMessage(pending)).toContain("default applied: keep")
    expect(verdictMessage(pending)).not.toContain("approve")
  })
})

describe("the inbox read model", () => {
  function seedAll() {
    writeConfig({ "weekly-invoices": PENDING_CRON, "active-job": { ...PENDING_CRON, enabled: true, approval: undefined } })
    const store = new MemoryStore(root)
    store.addMemory("beta", {
      agentId: "beta", category: "fact", content: "The client prefers invoices in the first week.",
      keywords: [], source: { channel: "email", chatId: "c1", sender: "someone", date: "2026-09-20" },
    })
    store.addMemory("beta", {
      agentId: "beta", category: "fact", content: "Operator note, trusted.",
      keywords: [], source: { channel: "cli", chatId: "c2", sender: "op", date: "2026-09-20" },
    })
    saveProposal(join(root, ".agentx", "wiki"), proposal("2026-09-24-retry-ab12"))
    const c = createCard(root, card({ expires: "6h" }), { now: NOW })
    if (!c.ok) throw new Error(c.error)
    return c.card
  }

  it("says when a wiki proposal is a lesson from a recurring failure", () => {
    const p = proposal("2026-09-24-deploy-cli-cd34")
    p.evidence = {
      agents: ["beta"], occurrences: 4,
      sources: [{
        stamp: "failure:0123456789@2", kind: "failure", agentId: "beta", type: "feedback", name: "failure-0123456789",
        description: "beta: Bash keeps failing", occurrences: 4, sessions: ["s1", "s2"], tasks: ["t1", "t2"],
        failure: { tool: "Bash", errorClass: "command not found", runs: 6 },
        updatedAt: "2026-09-24T08:00:00.000Z", excerpt: "",
      }],
    }
    saveProposal(join(root, ".agentx", "wiki"), p)
    const [item] = listInbox(ctx(), { kinds: ["wiki"] }).items
    expect(item.detail).toMatch(/^Recurring failure: beta's Bash fails with "command not found" in 4 sessions \(6 runs\)\. When a call/)
    expect(item.more).toBe("agentx wiki proposals show 2026-09-24-deploy-cli-cd34")
  })

  it("lists every source in one shape, most urgent first", () => {
    const c = seedAll()
    const { items, errors } = listInbox(ctx())
    expect(errors).toEqual([])
    expect(items.map((i) => i.kind).sort()).toEqual(["card", "memory", "schedule", "wiki"])
    expect(items[0].key).toBe(`card:${c.id}`)
    for (const i of items) {
      expect(i.title).toBeTruthy()
      expect(i.ask).toBeTruthy()
      expect(i.yes).toBeTruthy()
      expect(i.no).toBeTruthy()
      expect((i.detail ?? "").length).toBeLessThanOrEqual(280)
    }
    expect(items.find((i) => i.kind === "schedule")).toMatchObject({ key: "schedule:weekly-invoices", raised_by: "alpha" })
    expect(items.filter((i) => i.kind === "memory")).toHaveLength(1)
  })

  it("keys parse, and junk keys are refused", async () => {
    expect(parseKey("memory:beta/abc")).toEqual({ kind: "memory", ref: "beta/abc" })
    expect(parseKey("nope:x")).toBeNull()
    expect(await decide(ctx(), "nope:x", "yes")).toMatchObject({ ok: false })
    expect(await decide(ctx(), "card:does-not-exist", "yes")).toMatchObject({ ok: false })
    expect(await decide(ctx(), "card:../../etc", "later")).toMatchObject({ ok: false })
  })

  it("later hides an item until its time, without deciding it", async () => {
    const c = seedAll()
    const r = await decide(ctx(), `card:${c.id}`, "later", { laterHours: 5 })
    expect(r.ok).toBe(true)
    const now = listInbox(ctx())
    expect(now.items.some((i) => i.key === `card:${c.id}`)).toBe(false)
    expect(now.snoozed).toBe(1)
    expect(listInbox(ctx(), { includeSnoozed: true }).items.find((i) => i.key === `card:${c.id}`)?.snoozed_until).toBeTruthy()
    expect(listInbox({ ...ctx(), now: NOW + 6 * HOUR }).items.some((i) => i.key === `card:${c.id}`)).toBe(true)
    expect(readCard(root, c.id)?.status).toBe("pending")
  })

  it("yes and no go through each source's own approve/reject", async () => {
    const c = seedAll()
    const factKey = listInbox(ctx()).items.find((i) => i.kind === "memory")!.key

    expect(await decide(ctx(), "schedule:weekly-invoices", "yes")).toMatchObject({ ok: true })
    const job = JSON.parse(readFileSync(configPath, "utf-8")).crons["weekly-invoices"]
    expect(job.enabled).toBe(true)
    expect(job.approval).toBeUndefined()

    expect(await decide(ctx(), factKey, "yes")).toMatchObject({ ok: true })
    const fact = new MemoryStore(root).getAll("beta").find((f) => factKey.endsWith(f.id))!
    expect(fact.review).toBe("approved")

    expect(await decide(ctx(), "wiki:2026-09-24-retry-ab12", "no", { note: "too specific" })).toMatchObject({ ok: true })
    expect(readProposal(join(root, ".agentx", "wiki"), "2026-09-24-retry-ab12")).toMatchObject({ status: "rejected", reason: "too specific" })

    expect(await decide(ctx(), `card:${c.id}`, "no", { note: "wait a week" })).toMatchObject({ ok: true })
    expect(readCard(root, c.id)).toMatchObject({ status: "decided", verdict: "no", note: "wait a week" })

    expect(listInbox(ctx()).items).toEqual([])
    // Already decided: the source refuses a second answer.
    expect(await decide(ctx(), "schedule:weekly-invoices", "no")).toMatchObject({ ok: false })
  })

  it("rejecting a schedule request drops the never-run job", async () => {
    writeConfig({ "weekly-invoices": PENDING_CRON })
    expect(await decide(ctx(), "schedule:weekly-invoices", "no")).toMatchObject({ ok: true })
    expect(JSON.parse(readFileSync(configPath, "utf-8")).crons["weekly-invoices"]).toBeUndefined()
  })
})

describe("the daemon sweep", () => {
  it("expires cards and tells the raising agent exactly once", async () => {
    createCard(root, card({ expires: "1h" }), { now: NOW })
    const tellAgent = vi.fn(async () => {})
    const log = vi.fn()
    const later = { ...ctx(), now: NOW + 2 * HOUR }
    const r1 = await runApprovalsSweep({ ctx: later, settings: SETTINGS, tellAgent, hasAgent: () => true, log })
    expect(r1).toMatchObject({ expired: 1, notified: 1 })
    expect(tellAgent).toHaveBeenCalledTimes(1)
    expect(tellAgent.mock.calls[0][1]).toMatch(/default applied: discard/)
    const r2 = await runApprovalsSweep({ ctx: later, settings: SETTINGS, tellAgent, hasAgent: () => true, log })
    expect(r2).toMatchObject({ expired: 0, notified: 0 })
    expect(tellAgent).toHaveBeenCalledTimes(1)
  })

  it("delivers decisions made elsewhere (CLI, dashboard)", async () => {
    const c = createCard(root, card(), { now: NOW })
    if (!c.ok) throw new Error(c.error)
    decideCard(root, c.card.id, "yes", { note: "go ahead" })
    const tellAgent = vi.fn(async () => {})
    await runApprovalsSweep({ ctx: ctx(), settings: SETTINGS, tellAgent, log: () => {} })
    expect(tellAgent.mock.calls[0][0]).toBe("alpha")
    expect(tellAgent.mock.calls[0][1]).toMatch(/said YES[\s\S]*go ahead/)
    expect(cardsAwaitingAgentNotice(root)).toEqual([])
  })

  it("skips agents that aren't on this node, and respects notifyAgent off", async () => {
    const c = createCard(root, card(), { now: NOW })
    if (!c.ok) throw new Error(c.error)
    decideCard(root, c.card.id, "no")
    const tellAgent = vi.fn(async () => {})
    await runApprovalsSweep({ ctx: ctx(), settings: { ...SETTINGS, notifyAgent: false }, tellAgent, log: () => {} })
    expect(tellAgent).not.toHaveBeenCalled()
    expect(cardsAwaitingAgentNotice(root)).toEqual([])
  })

  it("sends at most one digest a day, and only when something waits", async () => {
    const sendDigest = vi.fn(async () => {})
    const at = (iso: string) => ({ ...ctx(), now: Date.parse(iso) })
    const deps = (iso: string) => ({ ctx: at(iso), settings: SETTINGS, sendDigest, fallbackDestination: { channel: "telegram", chatId: "1000" }, log: () => {} })

    expect((await runApprovalsSweep(deps("2026-09-26T10:00:00Z"))).digest).toBe("empty")
    createCard(root, card(), { now: NOW })
    createCard(root, card({ title: "Merge the release PR", expires: "5h" }), { now: NOW })
    expect((await runApprovalsSweep(deps("2026-09-26T08:30:00Z"))).digest).toBe("not-due")
    expect((await runApprovalsSweep(deps("2026-09-26T10:00:00Z"))).digest).toBe("sent")
    expect((await runApprovalsSweep(deps("2026-09-26T18:00:00Z"))).digest).toBe("not-due")
    expect(sendDigest).toHaveBeenCalledTimes(1)
    const [dest, text] = sendDigest.mock.calls[0] as unknown as [any, string]
    expect(dest).toEqual({ channel: "telegram", chatId: "1000" })
    expect(text).toMatch(/^2 decisions waiting/)
    expect(text).toMatch(/Most urgent: Merge the release PR/)
    expect((await runApprovalsSweep(deps("2026-09-27T09:00:00Z"))).digest).toBe("sent")
    expect(sendDigest).toHaveBeenCalledTimes(2)
  })

  it("digest: off, or nowhere to send", async () => {
    createCard(root, card(), { now: NOW })
    const at = { ...ctx(), now: Date.parse("2026-09-26T10:00:00Z") }
    expect((await runApprovalsSweep({ ctx: at, settings: { ...SETTINGS, digest: { ...SETTINGS.digest, enabled: false } }, sendDigest: async () => {}, log: () => {} })).digest).toBe("disabled")
    expect((await runApprovalsSweep({ ctx: at, settings: SETTINGS, sendDigest: async () => {}, log: () => {} })).digest).toBe("no-destination")
  })

  it("digest timing follows the configured timezone", () => {
    const d = { enabled: true, time: "09:00", timezone: "Asia/Tokyo" }
    expect(digestDue(d, undefined, Date.parse("2026-09-26T00:30:00Z")).due).toBe(true)
    expect(digestDue(d, "2026-09-26", Date.parse("2026-09-26T00:30:00Z")).due).toBe(false)
    expect(digestDue(d, undefined, Date.parse("2026-09-25T23:30:00Z")).due).toBe(false)
    expect(digestText([])).toMatch(/^0 decisions/)
  })
})

describe("agents can raise and read, never decide", () => {
  const deps = () => ({ ctx: ctx(), settings: DEFAULT_CARD_SETTINGS, hasAgent: (id: string) => id === "alpha" })

  it("POST /approvals raises a card for a known agent", () => {
    const r = handleApprovalsApi("POST", "/approvals", card(), new URLSearchParams(), deps())
    expect(r.status).toBe(201)
    expect(handleApprovalsApi("POST", "/approvals", card({ raised_by: "stranger" }), new URLSearchParams(), deps()).status).toBe(400)
    expect(handleApprovalsApi("POST", "/approvals", card({ ask: "" }), new URLSearchParams(), deps()).status).toBe(400)
  })

  it("every deciding request is refused", () => {
    const r = handleApprovalsApi("POST", "/approvals", card(), new URLSearchParams(), deps())
    const id = (r.body as any).card.id
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of [`/approvals/${id}`, `/approvals/${id}/decide`, "/approvals/decide"]) {
        const res = handleApprovalsApi(method, path, { verdict: "yes", action: "yes" }, new URLSearchParams(), deps())
        expect(res.status).toBe(403)
        expect((res.body as any).error).toBe(OPERATOR_ONLY)
      }
    }
    expect(readCard(root, id)?.status).toBe("pending")
  })

  it("GET lists in bounded form and reads one card", () => {
    const r = handleApprovalsApi("POST", "/approvals", card(), new URLSearchParams(), deps())
    const id = (r.body as any).card.id
    const list = handleApprovalsApi("GET", "/approvals", undefined, new URLSearchParams(), deps())
    expect(list.body).toMatchObject({ count: 1, truncated: false })
    expect(handleApprovalsApi("GET", `/approvals/${id}`, undefined, new URLSearchParams(), deps()).status).toBe(200)
    expect(handleApprovalsApi("GET", "/approvals/..%2F..%2Fagentx", undefined, new URLSearchParams(), deps()).status).toBe(404)
  })

  it("/approvals is mesh-gated: loopback or a mesh token, reads included", () => {
    expect(isMeshGatedPath("/approvals")).toBe(true)
    expect(isMeshGatedPath("/approvals/abc")).toBe(true)
    const off = decideMeshAuth({ remoteAddress: "10.0.0.9", authorizationHeader: "", acceptedTokens: new Set(["t0k"]) })
    expect(off.allowed).toBe(false)
  })

  it("the agentx_approval tool raises a card and has no way to approve", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body))
        const r = handleApprovalsApi("POST", "/approvals", body, new URLSearchParams(), deps())
        return new Response(JSON.stringify(r.body), { status: r.status })
      }
      const path = new URL(url).pathname
      const r = handleApprovalsApi("GET", path, undefined, new URLSearchParams(), deps())
      return new Response(JSON.stringify(r.body), { status: r.status })
    }) as unknown as typeof fetch
    const env = { AGENTX_AGENT_ID: "alpha", AGENTX_CHANNEL: "telegram", AGENTX_CHAT_ID: "2000" }
    const text = await runApprovalTool({ ...card(), raised_by: "beta" }, { daemonUrl: "http://127.0.0.1:1", fetch: fakeFetch, env })
    expect(text).toMatch(/Decision card .* is in the operator's Approvals inbox/)
    const sent = JSON.parse(String(calls[0].init!.body))
    // The runtime's identity wins over whatever the model claims.
    expect(sent.raised_by).toBe("alpha")
    expect(sent.reply).toEqual({ channel: "telegram", chatId: "2000" })
    // The call names the run it comes from, so the daemon can tell whose turn raised it.
    expect(new Headers(calls[0].init!.headers).get("x-agentx-channel")).toBe("telegram")
    expect(new Headers(calls[0].init!.headers).get("x-agentx-chat")).toBe("2000")
    const id = /card (\S+) is/.exec(text)![1]
    expect(await runApprovalTool({ action: "status", id }, { daemonUrl: "http://127.0.0.1:1", fetch: fakeFetch, env })).toMatch(/still waiting/)
    expect(await runApprovalTool({ action: "approve", id }, { daemonUrl: "http://127.0.0.1:1", fetch: fakeFetch, env })).toMatch(/unknown action/)
    expect(readCard(root, id)?.status).toBe("pending")
  })
})

describe("an agent closes its own card once the owner answered in chat (#909)", () => {
  // `proven`: the agent whose running turn the call proves (the daemon reads
  // it from X-AgentX-Task, or channel + chat). `tokenPeer`: the node whose
  // own mesh token the call carries.
  const deps = (o: { proven?: string | null; tokenPeer?: string; hasPeer?: (n: string) => boolean } = {}) => ({
    ctx: ctx(), settings: DEFAULT_CARD_SETTINGS, hasAgent: (id: string) => id === "alpha" || id === "beta", hasPeer: o.hasPeer,
    provenAgent: () => (o.proven === undefined ? "alpha" : o.proven),
    tokenPeerIs: (n: string) => !!o.tokenPeer && n === o.tokenPeer,
  })
  const raise = (extra: Record<string, unknown> = {}) => {
    const r = createCard(root, card(extra), { now: NOW })
    if (!r.ok) throw new Error(r.error)
    return r.card
  }
  const close = (id: string, body: Record<string, unknown>, d = deps()) =>
    handleApprovalsApi("POST", `/approvals/${id}/resolve`, body, new URLSearchParams(), d)

  it("closes the card: it leaves the inbox, nobody is asked again, the agent is not told", async () => {
    const c = raise()
    const r = close(c.id, { raised_by: "alpha", reason: "approved in chat, done" })
    expect(r.status).toBe(200)
    const stored = readCard(root, c.id)!
    expect(stored).toMatchObject({ status: "resolved", resolution: "approved in chat, done", decided_by: "alpha" })
    expect(stored.verdict).toBeUndefined()
    expect(listInbox(ctx()).items).toEqual([])
    // A late answer from a check-in or popup cannot land on it.
    expect(await decide(ctx(), `card:${c.id}`, "no")).toMatchObject({ ok: false })
    expect(readCard(root, c.id)?.status).toBe("resolved")
    const tellAgent = vi.fn(async () => {})
    await runApprovalsSweep({ ctx: ctx(), settings: SETTINGS, tellAgent, log: () => {} })
    expect(tellAgent).not.toHaveBeenCalled()
  })

  it("only the raising agent, with a reason, on a card still pending", () => {
    const c = raise()
    expect(close(c.id, { raised_by: "beta", reason: "done" }, deps({ proven: "beta" })).status).toBe(403)
    expect(close(c.id, { reason: "done" }, deps({ proven: "beta" })).status).toBe(403)
    expect(close(c.id, { raised_by: "alpha" }).status).toBe(400)
    expect(close("2026-09-26-nope-abcd", { raised_by: "alpha", reason: "done" }).status).toBe(404)
    decideCard(root, c.id, "yes")
    expect(close(c.id, { raised_by: "alpha", reason: "done" }).status).toBe(409)
    expect(readCard(root, c.id)?.status).toBe("decided")
  })

  it("never closes a card the daemon acts on itself", () => {
    const c = raise()
    saveCard(root, { ...c, origin: { kind: "workflow", runId: "r1", nodeId: "n1" } })
    const r = close(c.id, { raised_by: "alpha", reason: "done" })
    expect(r.status).toBe(409)
    expect((r.body as any).error).toMatch(/operator only/)
  })

  it("the agent is the one the calling turn proves, not the one the body names", () => {
    const c = raise()
    // A turn of beta names alpha: refused, the card stays pending.
    const r = close(c.id, { raised_by: "alpha", reason: "owner approved in chat, go ahead" }, deps({ proven: "beta" }))
    expect(r.status).toBe(403)
    expect(readCard(root, c.id)).toMatchObject({ status: "pending" })
    expect(readCard(root, c.id)?.agent_notified_at).toBeUndefined()
    // No running turn at all (a bare loopback call): refused.
    expect(close(c.id, { raised_by: "alpha", reason: "done" }, deps({ proven: null })).status).toBe(403)
    expect(close(c.id, { raised_by: "alpha", reason: "done" }, { ...deps(), provenAgent: undefined }).status).toBe(403)
    expect(readCard(root, c.id)?.status).toBe("pending")
    // alpha's own turn, without naming itself: closed in alpha's name.
    expect(close(c.id, { reason: "done" }).status).toBe(200)
    expect(readCard(root, c.id)).toMatchObject({ status: "resolved", decided_by: "alpha" })
  })

  it("a card forwarded from another node is closed only in that node's name", () => {
    const r = createCard(root, card({ raised_by: "remote-agent" }), { now: NOW, node: "far" })
    if (!r.ok) throw new Error(r.error)
    // A loopback caller (or a local agent) naming the peer: refused.
    expect(close(r.card.id, { raised_by: "remote-agent", reason: "done", node: "far" }, deps({ hasPeer: () => true })).status).toBe(403)
    expect(close(r.card.id, { raised_by: "remote-agent", reason: "done", node: "far" }, deps({ tokenPeer: "other" })).status).toBe(403)
    expect(readCard(root, r.card.id)?.status).toBe("pending")
    // The other peer's own token, in its own name: not its card.
    expect(close(r.card.id, { raised_by: "remote-agent", reason: "done", node: "other" }, deps({ tokenPeer: "other" })).status).toBe(403)
    // Without a node it is a local close, and no local agent raised it.
    expect(close(r.card.id, { raised_by: "remote-agent", reason: "done" }, deps({ proven: null })).status).toBe(403)
    expect(close(r.card.id, { reason: "done" }).status).toBe(403)
    expect(readCard(root, r.card.id)?.status).toBe("pending")
    expect(close(r.card.id, { raised_by: "remote-agent", reason: "done", node: "far" }, deps({ tokenPeer: "far" })).status).toBe(200)
    expect(resolveCard(root, r.card.id, { by: "remote-agent", node: "far", reason: "again" })).toMatchObject({ ok: false })
  })

  it("the tool closes the card and says how in its create reply", async () => {
    // The daemon proves the turn from the task header the tool sends.
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      const task = (init?.headers as Record<string, string> | undefined)?.["X-AgentX-Task"]
      const r = handleApprovalsApi(init?.method ?? "GET", path, init?.body ? JSON.parse(String(init.body)) : undefined, new URLSearchParams(),
        deps({ proven: task === "task-alpha" ? "alpha" : null }))
      return new Response(JSON.stringify(r.body), { status: r.status })
    }) as unknown as typeof fetch
    const env = { AGENTX_AGENT_ID: "alpha", AGENTX_TASK_ID: "task-alpha" }
    const opts = { daemonUrl: "http://127.0.0.1:1", fetch: fakeFetch, env }
    const text = await runApprovalTool(card(), opts)
    expect(text).toMatch(/action:"resolve"/)
    const id = /card (\S+) is/.exec(text)![1]
    expect(await runApprovalTool({ action: "resolve", id }, opts)).toMatch(/reason.* is required/)
    expect(await runApprovalTool({ action: "resolve", id, reason: "approved in chat, done" }, opts)).toMatch(/is closed/)
    expect(await runApprovalTool({ action: "status", id }, opts)).toMatch(/closed by alpha: approved in chat, done/)
    expect(await runApprovalTool({ action: "resolve", id, reason: "again" }, opts)).toMatch(/already resolved/)
    // Outside a running turn the tool's call proves nobody.
    const other = /card (\S+) is/.exec(await runApprovalTool(card({ title: "Another" }), opts))![1]
    expect(await runApprovalTool({ action: "resolve", id: other, reason: "done" }, { ...opts, env: { AGENTX_AGENT_ID: "alpha" } })).toMatch(/Error: only the agent/)
  })

  it("a no tells the agent not to undo work already done", () => {
    const c = raise()
    const r = decideCard(root, c.id, "no")
    if (!r.ok) throw new Error(r.error)
    expect(verdictMessage(r.card)).toContain(NO_UNDO_LINE)
    const y = decideCard(root, raise({ title: "Another" }).id, "yes")
    if (!y.ok) throw new Error(y.error)
    expect(verdictMessage(y.card)).not.toContain(NO_UNDO_LINE)
  })
})

describe("the dashboard (operator) API", () => {
  let server: Server
  let base: string

  beforeEach(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://localhost")
      const handled = await handleApprovalsPanelApi(req, res, url.pathname, url, { ctx: ctx() })
      if (!handled) { res.writeHead(404); res.end() }
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const addr = server.address() as any
    base = `http://127.0.0.1:${addr.port}`
  })
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())) })

  it("lists, and decides only with the dashboard's header", async () => {
    const c = createCard(root, card(), { now: NOW })
    if (!c.ok) throw new Error(c.error)
    const list = await (await fetch(`${base}/api/admin/approvals`)).json() as any
    expect(list.items).toHaveLength(1)
    expect(list.settings).toMatchObject({ laterHours: 24 })

    const body = JSON.stringify({ key: `card:${c.card.id}`, action: "yes" })
    const noHeader = await fetch(`${base}/api/admin/approvals/decide`, { method: "POST", body, headers: { "Content-Type": "application/json" } })
    expect(noHeader.status).toBe(400)
    expect(readCard(root, c.card.id)?.status).toBe("pending")

    const ok = await fetch(`${base}/api/admin/approvals/decide`, { method: "POST", body, headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board" } })
    expect(ok.status).toBe(200)
    expect(readCard(root, c.card.id)).toMatchObject({ status: "decided", verdict: "yes", decided_by: "operator (dashboard)" })

    const again = await fetch(`${base}/api/admin/approvals/decide`, { method: "POST", body, headers: { "X-Requested-With": "agentx-board" } })
    expect(again.status).toBe(409)
  })

  it("takes a card's pick and edited message, and refuses a yes without a pick (#743)", async () => {
    const c = createCard(root, card({ choices: ["Script", "Watchdog"], draft: "Build: {choice}" }), { now: NOW })
    if (!c.ok) throw new Error(c.error)
    const key = `card:${c.card.id}`
    const list = await (await fetch(`${base}/api/admin/approvals`)).json() as any
    expect(list.items[0]).toMatchObject({ choices: ["Script", "Watchdog"], draft: "Build: {choice}" })
    const post = (body: Record<string, unknown>) => fetch(`${base}/api/admin/approvals/decide`, {
      method: "POST", body: JSON.stringify({ key, action: "yes", ...body }), headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board" },
    })
    expect((await post({})).status).toBe(409)
    expect(readCard(root, c.card.id)?.status).toBe("pending")
    for (const choice of [3, 0, "Something else"]) {
      const bad = await post({ choice })
      expect(bad.status).toBeGreaterThanOrEqual(400)
      expect(await bad.text()).toMatch(/choice must be 1-2/)
      expect(readCard(root, c.card.id)?.status).toBe("pending")
    }
    expect((await post({ choice: 2, text: "Build: Watchdog, alert on the ops chat" })).status).toBe(200)
    expect(readCard(root, c.card.id)).toMatchObject({ verdict: "yes", choice: "Watchdog", text: "Build: Watchdog, alert on the ops chat" })
  })

  it("puts a card back in line for the Mac popup, when the popup is on", async () => {
    const c = createCard(root, card(), { now: NOW })
    if (!c.ok) throw new Error(c.error)
    const key = `card:${c.card.id}`
    const post = (headers: Record<string, string>) => fetch(`${base}/api/admin/approvals/popup`, {
      method: "POST", body: JSON.stringify({ key }), headers: { "Content-Type": "application/json", ...headers },
    })
    expect((await post({})).status).toBe(400)
    // Off by default: nothing would show, so say so instead of queueing.
    const off = await post({ "X-Requested-With": "agentx-board" })
    expect(off.status).toBe(409)
    expect(readInboxState(root).wanted ?? []).toEqual([])

    const cfg = JSON.parse(readFileSync(configPath, "utf-8"))
    writeFileSync(configPath, JSON.stringify({ ...cfg, approvals: { popup: { enabled: true } } }))
    const ok = await post({ "X-Requested-With": "agentx-board" })
    expect(ok.status).toBe(200)
    expect(readInboxState(root).wanted).toEqual([key])
    expect(readCard(root, c.card.id)?.status).toBe("pending")
  })

  it("the page offers Show on Mac for cards, and its script parses", () => {
    const html = renderApprovalsPage()
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((x) => x.includes("/api/admin/approvals")) ?? ""
    expect(script).toContain("i.kind === 'card' && state.popup")
    expect(script).toContain("/api/admin/approvals/popup")
    expect(() => new Function(script)).not.toThrow()
  })

  it("saves settings through the config schema", async () => {
    const post = (b: unknown) => fetch(`${base}/api/admin/approvals/settings`, {
      method: "POST", body: JSON.stringify(b), headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board" },
    })
    const ok = await post({ defaultExpiryDays: 5, digestTime: "07:30", destination: "telegram:42" })
    expect(ok.status).toBe(200)
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(cfg.approvals).toMatchObject({ defaultExpiryDays: 5, digest: { time: "07:30", destination: { channel: "telegram", chatId: "42" } } })
    expect((await post({ digestTime: "25:00" })).status).toBe(400)
    expect((await post({ defaultExpiryDays: 90 })).status).toBe(400) // above maxExpiryDays
    expect((await post({ destination: "" })).status).toBe(200)
    expect(JSON.parse(readFileSync(configPath, "utf-8")).approvals.digest.destination).toBeUndefined()
  })
})

describe("config", () => {
  it("has defaults and validates the digest time", () => {
    const base = { node: { id: "t", name: "T" } }
    const parsed = daemonConfigSchema.parse(base)
    expect(parsed.approvals).toMatchObject({ defaultExpiryDays: 3, maxExpiryDays: 30, laterHours: 24, notifyAgent: true, digest: { enabled: true, time: "09:00" } })
    expect(daemonConfigSchema.safeParse({ ...base, approvals: { digest: { time: "9am" } } }).success).toBe(false)
    expect(daemonConfigSchema.safeParse({ ...base, approvals: { digest: { timezone: "Mars/Olympus" } } }).success).toBe(false)
    expect(existsSync(join(root, ".agentx", "approvals"))).toBe(false)
  })
})

describe("the page", () => {
  it("renders, with an Approvals tab and client JS that parses", async () => {
    const { renderApprovalsPage } = await import("../src/daemon/ui/pages/approvals")
    const html = renderApprovalsPage({ localToken: "t" })
    expect(html).toMatch(/href="\/approvals" class="ax-topbar__tab is-active"/)
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    const page = scripts.find((s) => s.includes("/api/admin/approvals"))
    expect(page).toBeTruthy()
    expect(() => new Function(page!)).not.toThrow()
  })
})
