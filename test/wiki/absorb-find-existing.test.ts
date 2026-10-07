import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const hoisted = vi.hoisted(() => ({ askSeat: vi.fn(async () => null as unknown) }))
vi.mock("../../src/decisions/seat", () => ({ askSeat: hoisted.askSeat }))

import { WikiStore } from "../../src/wiki/store"
import { findArticles } from "../../src/wiki/query"
import { buildAbsorbPrompt, ABSORB_MATCH_CHARS } from "../../src/wiki/prompts"

// #801: absorb showed the model catalog titles only, so a re-review either
// became a second article (Sonnet) or a blind rewrite of the first (Opus).

const RE_REVIEW = "User: Re-review GitHub PR #198 (anis-marrouchi/agentx) at its new head 056ff66. Peer event feed blockers fixed?"

let dir: string
let store: WikiStore

function write(path: string, title: string, type: string, related: string[], body: string) {
  store.writeArticle(path, {
    title, type: type as never, related, tags: [], owner: "devops-agent", access: "public",
    created: "2026-09-27", lastUpdated: "2026-09-27", sources: ["devops-agent-mukbrpfj"],
  }, body, "devops-agent")
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "absorb-find-"))
  store = new WikiStore(dir, () => {})
  write("events/2026-09-27-agentx-pr-198-peer-event-feed-review-not-ready.md",
    "AgentX PR #198 Peer Event Feed Reviewed: NOT READY (2026-09-27)", "event",
    ["DevOps Agent"], "NOT READY at `1a01e02`; 16/16 tests. See [[DevOps Agent]].")
  write("people/devops-agent.md", "DevOps Agent", "person", [], "Reviews AgentX PRs.")
  write("events/2026-09-20-padel-booking.md", "Padel Court Booking (2026-09-20)", "event", [], "Booked court 3.")
  write("concepts/staging-deployment.md", "Staging Deployment", "concept", [], "How staging works.")
  hoisted.askSeat.mockReset()
  hoisted.askSeat.mockResolvedValue(null)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("findArticles", () => {
  it("finds the article an entry follows up on, and walks its wikilinks", async () => {
    const found = await findArticles([RE_REVIEW], store, "devops-agent")
    expect(found[0].path).toBe("events/2026-09-27-agentx-pr-198-peer-event-feed-review-not-ready.md")
    expect(found[0].hop).toBe(0)
    expect(found[0].content).toContain("1a01e02")
    expect(found.find((a) => a.path === "people/devops-agent.md")?.hop).toBe(1)
    expect(found.map((a) => a.path)).not.toContain("events/2026-09-20-padel-booking.md")
  })

  it("returns nothing for an entry no article matches", async () => {
    expect(await findArticles(["zzzz qqqq"], store, "devops-agent")).toEqual([])
  })

  it("uses the rerank seat's picks when it is active", async () => {
    hoisted.askSeat.mockImplementation(async (_seat: unknown, state: any) => {
      const pick = state.candidates.find((c: any) => c.title.startsWith("Staging"))
      const probabilities = Object.fromEntries(state.candidates.map((c: any) => [c.id, c === pick ? 0.9 : 0.01]))
      return { mode: "active", answers: { best: { probabilities, confidence: 0.9 }, answerable: { noul: 0.9 } } }
    })
    const found = await findArticles(["staging deployment and padel"], store, "devops-agent", { perQuery: 1 })
    expect(found.map((a) => a.path)).toEqual(["concepts/staging-deployment.md"])
  })

  it("dedupes across entries and respects maxArticles", async () => {
    const found = await findArticles([RE_REVIEW, RE_REVIEW, "padel court"], store, "devops-agent", { maxArticles: 2 })
    expect(found).toHaveLength(2)
    expect(new Set(found.map((a) => a.path)).size).toBe(2)
  })
})

describe("absorb prompt with matches", () => {
  const match = {
    path: "events/2026-09-27-agentx-pr-198.md",
    title: "AgentX PR #198 Reviewed",
    type: "event",
    sources: ["devops-agent-mukbrpfj"],
    content: "NOT READY at `1a01e02`.",
  }

  it("shows matched articles in full with their path", () => {
    const p = buildAbsorbPrompt("graph", "devops-agent", "", [], "ENTRY", 1, "", [match])
    expect(p).toContain("## Articles that may already cover these entries (full text)")
    expect(p).toContain("### AgentX PR #198 Reviewed — event (events/2026-09-27-agentx-pr-198.md)")
    expect(p).toContain("NOT READY at `1a01e02`.")
    expect(p).toMatch(/UPDATE at that article's EXISTING path/)
  })

  it("leaves out an article that does not fit whole, never a cut one", () => {
    const big = { ...match, path: "big.md", title: "Big", content: "x".repeat(ABSORB_MATCH_CHARS) }
    const p = buildAbsorbPrompt("graph", "devops-agent", "", [], "ENTRY", 1, "", [big, match])
    expect(p).not.toContain("### Big")
    expect(p).toContain("### AgentX PR #198 Reviewed")
  })

  it("adds no section when nothing matched", () => {
    const p = buildAbsorbPrompt("graph", "devops-agent", "", [], "ENTRY", 1, "", [])
    expect(p).not.toContain("may already cover these entries (full text)")
  })
})
