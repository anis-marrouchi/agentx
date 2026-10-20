import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createCard, listCards, resolveCard, DEFAULT_CARD_SETTINGS } from "../src/approvals/cards"
import { handleApprovalsApi } from "../src/approvals/daemon-api"

// One question, one card (#1100): an agent that raises a second pending
// card on the same source gets the first one's id back instead.

const NOW = Date.parse("2026-10-20T08:00:00.000Z")
let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agentx-card-dup-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function card(extra: Record<string, unknown> = {}) {
  return {
    title: "Merge the release notes fix",
    ask: "Merge the release notes fix today?",
    recommend: "Yes: the checks pass and the change is small",
    if_silent: "discard",
    raised_by: "alpha",
    source: "https://example.com/acme/app/pull/12",
    ...extra,
  }
}

describe("duplicate pending cards", () => {
  it("refuses a second pending card from the same agent on the same source, naming the first", () => {
    const first = createCard(root, card(), { now: NOW })
    expect(first.ok).toBe(true)
    const again = createCard(root, card({ title: "Merge PR 12", source: "https://EXAMPLE.com/acme/app/pull/12/" }), { now: NOW })
    expect(again.ok).toBe(false)
    if (again.ok || !first.ok) return
    expect(again.duplicateOf).toBe(first.card.id)
    expect(again.error).toContain(first.card.id)
    expect(listCards(root, "pending")).toHaveLength(1)
  })

  it("allows another source, another agent, another node, or no source", () => {
    expect(createCard(root, card(), { now: NOW }).ok).toBe(true)
    expect(createCard(root, card({ source: "https://example.com/acme/app/pull/13" }), { now: NOW }).ok).toBe(true)
    expect(createCard(root, card({ raised_by: "beta" }), { now: NOW }).ok).toBe(true)
    expect(createCard(root, card(), { now: NOW, node: "peer-b" }).ok).toBe(true)
    expect(createCard(root, card({ source: undefined }), { now: NOW }).ok).toBe(true)
    expect(createCard(root, card({ source: undefined }), { now: NOW }).ok).toBe(true)
  })

  it("leaves the daemon's own cards to their origin", () => {
    expect(createCard(root, card(), { now: NOW }).ok).toBe(true)
    const origin = { kind: "merge-policy" as const, repo: "acme/app", pr: 12, sha: "abc" }
    expect(createCard(root, card(), { now: NOW, origin }).ok).toBe(true)
  })

  it("allows a new card once the first is closed", () => {
    const first = createCard(root, card(), { now: NOW })
    if (!first.ok) throw new Error(first.error)
    expect(resolveCard(root, first.card.id, { by: "alpha", reason: "answered in chat", now: NOW }).ok).toBe(true)
    expect(createCard(root, card(), { now: NOW }).ok).toBe(true)
  })

  it("POST /approvals answers 409 with the waiting card's id", () => {
    const deps = { ctx: { root, now: NOW }, settings: DEFAULT_CARD_SETTINGS, hasAgent: (id: string) => id === "alpha" }
    const first = handleApprovalsApi("POST", "/approvals", card(), new URLSearchParams(), deps)
    expect(first.status).toBe(201)
    const again = handleApprovalsApi("POST", "/approvals", card(), new URLSearchParams(), deps)
    expect(again.status).toBe(409)
    expect((again.body as any).card_id).toBe((first.body as any).card.id)
  })
})
