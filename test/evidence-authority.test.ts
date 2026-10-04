import { describe, it, expect } from "vitest"
import { canRead, evidenceId, gate, markConflicts, partitionsFor, partitionsOf, resolve, standing, usable, wikiSourceId, type Outcome } from "../src/evidence/authority"
import { toBackendRecord, type BackendHit } from "../src/evidence/backend"
import type { Evidence, Requester, Standing } from "../src/evidence/types"

// The contract cases for #604. Each table row is one rule a memory
// backend must not be able to change.

const NOW = Date.parse("2026-10-04T12:00:00Z")
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

function ev(over: Partial<Evidence> = {}): Evidence {
  const source = over.source ?? { id: "fact:f-vendor-billing", version: "1" }
  return {
    id: evidenceId(source), kind: "fact", source,
    claim: { subject: "Globex vendor account", attribute: "billing status", value: "past due" },
    content: "Globex vendor account is past due.",
    eventAt: day(10), ingestedAt: day(10),
    check: { at: day(10), by: "accountant", method: "vendor portal" },
    volatility: "billing",
    scope: { owner: "accountant", access: "public" },
    trust: "internal", state: "active",
    ...over,
  }
}

/** A newer record about the same claim with a different value. */
const paid = (over: Partial<Evidence> = {}) => ev({
  kind: "observation", source: { id: "task:t-812", version: "1" },
  claim: { subject: "Globex vendor account", attribute: "billing status", value: "paid" },
  content: "Globex vendor account is paid.", eventAt: day(0), ingestedAt: day(0),
  check: { at: day(0), by: "accountant", method: "vendor portal" },
  ...over,
})

const ADA = wikiSourceId("coder", "graph", "people/ada.md")
const DEPLOY_WINDOW = wikiSourceId("devops", "graph", "decisions/deploy-window.md")

const article = (over: Partial<Evidence> = {}) => ev({
  kind: "article", source: { id: DEPLOY_WINDOW, version: "a1" },
  claim: { subject: "production deploy", attribute: "window", value: "Tuesday morning" },
  content: "Production deploys happen on Tuesday morning.", volatility: "stable",
  check: undefined, approval: { by: "owner", at: day(60) },
  ...over,
})

describe("standing", () => {
  const cases: Array<[string, Evidence, Standing]> = [
    ["a check within its time to live", ev({ check: { at: day(1), by: "a", method: "portal" } }), "verified"],
    ["a check past its time to live", ev(), "stale"],
    ["a stable fact never expires", ev({ volatility: "stable" }), "verified"],
    ["no check", ev({ check: undefined }), "unverified"],
    ["an unreadable check date", ev({ check: { at: "last week", by: "a", method: "portal" } }), "unverified"],
    ["a check dated in the future", ev({ check: { at: day(-3), by: "a", method: "portal" } }), "unverified"],
    ["an old claim stored today is still stale", ev({ ingestedAt: day(0) }), "stale"],
    ["an old unchecked claim stored today is still unverified", ev({ check: undefined, ingestedAt: day(0) }), "unverified"],
    ["a reviewed article", article(), "approved"],
    ["an article nobody approved", article({ approval: undefined }), "unverified"],
    ["backend-written text, whatever it carries", ev({ kind: "derived", check: { at: day(0), by: "backend", method: "summary" } }), "unverified"],
  ]
  it.each(cases)("%s", (_name, e, want) => {
    expect(standing(e, NOW)).toBe(want)
  })
})

describe("resolve: which record is current", () => {
  const cases: Array<[string, Evidence, Evidence, Outcome]> = [
    ["a stale wiki fact against a newer verified result", ev(), paid(), "supersede"],
    ["a newer unchecked claim", ev(), paid({ check: undefined }), "conflict"],
    ["a claim stored later but checked earlier", ev({ check: { at: day(2), by: "a", method: "portal" } }),
      paid({ check: { at: day(5), by: "b", method: "portal" }, ingestedAt: day(0) }), "conflict"],
    ["a claim stored today with no check, against an old checked fact", ev(), paid({ check: undefined, ingestedAt: day(0) }), "conflict"],
    ["any dated check against a fact nobody checked", ev({ check: undefined }), paid({ check: { at: day(30), by: "b", method: "portal" } }), "supersede"],
    ["a newer check against a value a person confirmed", ev({ check: { at: day(10), by: "a", method: "owner said", confirmedBy: "owner" } }), paid(), "conflict"],
    ["a person's confirmation against a newer check", ev({ check: { at: day(0), by: "a", method: "portal" } }),
      paid({ check: { at: day(3), by: "owner", method: "owner said", confirmedBy: "owner" } }), "supersede"],
    ["the same value again", ev(), ev({ source: { id: "task:t-9", version: "1" }, check: { at: day(0), by: "a", method: "portal" } }), "same"],
    ["backend-written text against a fact", ev(), paid({ kind: "derived", derivedFrom: ["e-x"] }), "keep"],
    ["an external claim still held for review", ev(), paid({ trust: "external", review: "held" }), "keep"],
    ["an external claim with no review", ev(), paid({ trust: "external" }), "keep"],
    ["an external claim a person approved", ev(), paid({ trust: "external", review: "approved" }), "supersede"],
    ["a revoked record", ev(), paid({ state: "revoked" }), "keep"],
    ["a verified observation against an approved decision", article(),
      paid({ claim: { subject: "production deploy", attribute: "window", value: "any day" } }), "conflict"],
    ["a person's word in chat against an approved decision", article(),
      paid({ claim: { subject: "production deploy", attribute: "window", value: "any day" }, check: { at: day(0), by: "owner", method: "owner said", confirmedBy: "owner" } }), "conflict"],
    ["a reviewed new version of the same article", article(),
      article({ source: { id: DEPLOY_WINDOW, version: "b2" }, claim: { subject: "production deploy", attribute: "window", value: "any day" }, approval: { by: "owner", at: day(0) } }), "supersede"],
    ["an older reviewed version sent again", article({ source: { id: DEPLOY_WINDOW, version: "b2" }, approval: { by: "owner", at: day(0) } }),
      article({ claim: { subject: "production deploy", attribute: "window", value: "any day" } }), "keep"],
    ["a new version with an unreadable review date", article(),
      article({ source: { id: DEPLOY_WINDOW, version: "b2" }, approval: { by: "owner", at: "today" } }), "keep"],
    ["a new version of the article nobody approved", article(),
      article({ source: { id: DEPLOY_WINDOW, version: "b2" }, claim: { subject: "production deploy", attribute: "window", value: "any day" }, approval: undefined }), "conflict"],
    ["a different approved article saying otherwise", article(),
      article({ source: { id: wikiSourceId("devops", "graph", "decisions/other.md"), version: "c3" }, claim: { subject: "production deploy", attribute: "window", value: "any day" } }), "conflict"],
    ["a newer verified result against an article nobody reviewed", article({ approval: undefined }),
      paid({ claim: { subject: "production deploy", attribute: "window", value: "any day" } }), "supersede"],
    ["a newer unchecked claim against an article nobody reviewed", article({ approval: undefined }),
      paid({ claim: { subject: "production deploy", attribute: "window", value: "any day" }, check: undefined }), "conflict"],
    ["a reviewed version of an article nobody reviewed", article({ approval: undefined }),
      article({ source: { id: DEPLOY_WINDOW, version: "b2" }, claim: { subject: "production deploy", attribute: "window", value: "any day" } }), "supersede"],
    ["a fact proposal nobody decided", ev(), paid({ source: { id: "proposal:fp-1", version: "1" }, review: "held" }), "keep"],
  ]
  it.each(cases)("%s", (_name, current, incoming, want) => {
    expect(resolve(current, incoming, NOW).outcome).toBe(want)
  })

  it("gives a reason with every outcome", () => {
    for (const [, current, incoming] of cases) expect(resolve(current, incoming, NOW).reason).not.toBe("")
  })
})

describe("canRead: who may see a record", () => {
  const coder: Requester = { agentId: "coder", projects: ["globex"] }
  const cases: Array<[string, Evidence["scope"], Requester, boolean]> = [
    ["public", { owner: "accountant", access: "public" }, coder, true],
    ["private, the owner", { owner: "coder", access: "private" }, coder, true],
    ["private, someone else", { owner: "accountant", access: "private" }, coder, false],
    ["shared with the requester", { owner: "accountant", access: "shared", sharedWith: ["coder"] }, coder, true],
    ["shared with others", { owner: "accountant", access: "shared", sharedWith: ["sales"] }, coder, false],
    ["public inside the requester's project", { owner: "accountant", access: "public", project: "globex" }, coder, true],
    ["public inside another project", { owner: "accountant", access: "public", project: "initech" }, coder, false],
    ["the owner's own record in a project they are not on", { owner: "coder", access: "private", project: "initech" }, coder, false],
    ["a project record, requester with no projects", { owner: "accountant", access: "public", project: "globex" }, { agentId: "coder" }, false],
    ["public, requester with no agent id", { owner: "accountant", access: "public" }, { agentId: "" }, true],
    ["private with no owner, requester with no agent id", { owner: "", access: "private" }, { agentId: "" }, false],
    ["shared with an empty name, requester with no agent id", { owner: "accountant", access: "shared", sharedWith: [""] }, { agentId: "" }, false],
  ]
  it.each(cases)("%s", (_name, scope, who, want) => {
    expect(canRead(scope, who)).toBe(want)
  })

  it("indexes a record only where its readers search", () => {
    expect(partitionsOf({ owner: "a", access: "public" })).toEqual(["public"])
    expect(partitionsOf({ owner: "a", access: "private" })).toEqual(["agent:a"])
    expect(partitionsOf({ owner: "a", access: "shared", sharedWith: ["b", "a"] })).toEqual(["agent:a", "agent:b"])
    expect(partitionsFor({ agentId: "b" })).toEqual(["public", "agent:b"])
    expect(partitionsFor({ agentId: "" })).toEqual(["public"])
  })
})

describe("gate: what a backend's answer is worth", () => {
  const who: Requester = { agentId: "coder" }
  const fresh = ev({ check: { at: day(0), by: "a", method: "portal" } })
  const secret = ev({ source: { id: "memory:accountant/m-1", version: "1" }, scope: { owner: "accountant", access: "private" } })
  const old = ev({ source: { id: ADA, version: "v1" }, state: "superseded" })
  const gone = ev({ source: { id: "entry:e-77", version: "1" }, state: "deleted", content: "" })
  const revoked = ev({ source: { id: "entry:e-78", version: "1" }, state: "revoked" })
  const held = ev({ source: { id: "entry:e-79", version: "1" }, trust: "external", review: "held" })
  const mine = ev({ source: { id: "memory:coder/m-2", version: "1" }, scope: { owner: "coder", access: "private" } })
  const store = new Map([fresh, secret, old, gone, revoked, held, mine].map((e) => [e.id, e]))
  const lookup = (id: string) => store.get(id)
  const hit = (e: Evidence, over: Partial<BackendHit> = {}): BackendHit => ({ id: e.id, sourceVersion: e.source.version, score: 1, ...over })

  const dropped: Array<[string, BackendHit]> = [
    ["an id AgentX never issued", { id: "e-made-up", sourceVersion: "1", score: 1 }],
    ["a version that is not the current one", hit(fresh, { sourceVersion: "0" })],
    ["a record another agent owns, though the backend returned it", hit(secret)],
    ["a superseded version of an edited article", hit(old)],
    ["a deleted record", hit(gone)],
    ["a revoked record", hit(revoked)],
    ["a record held for review", hit(held)],
    ["backend text with no sources", { id: "h-1", sourceVersion: "1", score: 1, derived: { content: "All accounts are paid.", from: [] } }],
    ["backend text built on a source AgentX does not know", { id: "h-2", sourceVersion: "1", score: 1, derived: { content: "x", from: [fresh.id, "e-made-up"] } }],
    ["backend text built on a record the requester cannot read", { id: "h-3", sourceVersion: "1", score: 1, derived: { content: "x", from: [fresh.id, secret.id] } }],
    ["backend text built on a revoked record", { id: "h-4", sourceVersion: "1", score: 1, derived: { content: "x", from: [fresh.id, revoked.id] } }],
    ["backend text built on a deleted record", { id: "h-5", sourceVersion: "1", score: 1, derived: { content: "x", from: [gone.id] } }],
    ["backend text built on an edited record", { id: "h-6", sourceVersion: "1", score: 1, derived: { content: "x", from: [old.id] } }],
    ["backend text built across two partitions", { id: "h-8", sourceVersion: "1", score: 1, derived: { content: "x", from: [fresh.id, mine.id] } }],
    ["backend text under an id AgentX issued", hit(fresh, { derived: { content: "x", from: [fresh.id] } })],
  ]
  it.each(dropped)("drops %s", (_name, h) => {
    expect(gate(h, lookup, who, NOW)).toBeNull()
  })

  it("returns AgentX's record and standing, not the backend's", () => {
    const r = gate(hit(fresh), lookup, who, NOW)
    expect(r).toEqual({ evidence: fresh, standing: "verified" })
  })

  it("returns backend text as unverified, private to the requester, and no more trusted than its weakest source", () => {
    const external = ev({ source: { id: "entry:e-80", version: "1" }, trust: "external", review: "approved" })
    const r = gate(
      { id: "h-7", sourceVersion: "1", score: 1, derived: { content: "Globex is past due.", from: [fresh.id, external.id] } },
      (id) => (id === external.id ? external : lookup(id)), who, NOW,
    )
    expect(r?.standing).toBe("unverified")
    expect(r?.evidence).toMatchObject({
      id: "d-h-7", kind: "derived", trust: "external", derivedFrom: [fresh.id, external.id],
      scope: { owner: "coder", access: "private" }, volatility: "billing",
    })
    expect(r?.evidence.check).toBeUndefined()
    expect(r?.evidence.approval).toBeUndefined()
  })

  it("shows both sides of a disagreement with their provenance", () => {
    const a = { evidence: ev(), standing: standing(ev(), NOW) }
    const b = { evidence: paid({ check: undefined }), standing: "unverified" as const }
    const c = { evidence: article(), standing: "approved" as const }
    const out = markConflicts([a, b, c])
    expect(out[0].conflictsWith).toEqual([b.evidence.id])
    expect(out[1].conflictsWith).toEqual([a.evidence.id])
    expect(out[2].conflictsWith).toBeUndefined()
    expect(out[1].evidence.source.id).toBe("task:t-812")
  })
})

describe("ids and what a backend is given", () => {
  it("gives the same source version the same id, and an edit a new one", () => {
    const a = evidenceId({ id: ADA, version: "v1" })
    expect(evidenceId({ id: ADA, version: "v1" })).toBe(a)
    expect(evidenceId({ id: ADA, version: "v2" })).not.toBe(a)
  })

  it("tells one agent's article in one folder from the same path anywhere else", () => {
    const ids = [
      wikiSourceId("coder", "graph", "people/ada.md"), wikiSourceId("coder", "unified", "people/ada.md"),
      wikiSourceId("sales", "graph", "people/ada.md"),
    ].map((id) => evidenceId({ id, version: "v1" }))
    expect(new Set(ids).size).toBe(3)
  })

  it("hands a backend the id, source and text, and no check, trust or approval", () => {
    const e = article()
    expect(toBackendRecord(e)).toEqual({
      id: e.id, sourceId: e.source.id, sourceVersion: e.source.version,
      content: e.content, eventAt: e.eventAt, scope: e.scope,
    })
  })

  it("does not show a record that is not active or not reviewed", () => {
    expect(usable(ev())).toBe(true)
    expect(usable(ev({ state: "superseded" }))).toBe(false)
    expect(usable(ev({ review: "rejected" }))).toBe(false)
    expect(usable(ev({ trust: "external" }))).toBe(false)
    expect(usable(ev({ source: { id: "proposal:fp-1", version: "1" }, kind: "observation", review: "held" }))).toBe(false)
  })
})
