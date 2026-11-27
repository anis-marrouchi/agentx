// The React feed, #page=feed-preview (#2101 R2): its model on top of
// wall-feed-model.ts (filters, address, groups and counts, who runs what),
// the shared parts (state, row, card, failed line, section, empty), the
// frame its skeleton shares with the page, and the page drawn from a read.
import { createElement, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { fdGroupTitle, fdStates } from "../src/daemon/ui/pages/wall-feed-model"
import {
  FEED_PAGE, FEED_TABS, agentNames, feedFilters, feedHash, feedMatches, feedState, feedView, initials, liveRunOf, postHash, until, waitLine,
  type FeedLive, type FeedPost,
} from "../src/hub/feed/model"
import { FeedActionsContext, FeedEmpty, FeedRow, FeedSection, StateLabel, type FeedActions } from "../src/hub/feed/parts"
import { FeedPageSkeleton, FEED_COLUMN } from "../src/hub/feed/frame"
import FeedPage, { composeTarget } from "../src/hub/feed/FeedPage"
import { HUB_REACT_PAGES } from "../src/hub/pages"
import { LiveProvider } from "../src/hub/live-react"
import { LIVE_KEY, type LiveStream } from "../src/hub/live"
import { parseHash } from "../src/hub/router"
import { TooltipProvider } from "../src/hub/ui"

const now = Date.UTC(2026, 10, 20, 10, 0)
const min = 60_000
// Made-up agents, projects and tasks only.
const post = (id: string, state: string, extra: Partial<FeedPost> = {}): FeedPost => ({
  id, state, headline: "Task " + id, need: "Do " + id, owner: "coder", project: "atlas", lastMoveAt: now - 5 * min,
  runs: 1, runMs: 4 * min, lastFailure: null, lastRun: null, result: null, blocked: null, ownerCards: [], ...extra,
} as FeedPost)
const card = { id: "c1", title: "Merge the docs PR?", ask: "Merge #12 to main", recommend: "Yes", silence: "It waits", expiresAt: now + 4 * 3_600_000, raisedBy: "reviewer" } as FeedPost["ownerCards"] extends (infer C)[] | undefined ? C : never
const live: FeedLive = {
  nodes: [
    { url: "", name: "here", agents: [{ id: "coder", name: "Coder", runningTasks: [{ id: "t1", channel: "requests", chatId: "req-run" }] }] },
    { url: "http://peer.test", name: "peer", agents: [{ id: "writer", name: "Writer" }] },
  ],
}
const posts: FeedPost[] = [
  post("req-run", "in_progress"),
  post("req-fail", "needs_attention", { lastFailure: { taskId: "t9", error: "exit 1", at: now } as FeedPost["lastFailure"] }),
  post("req-you", "waiting_owner", { ownerCards: [card], owner: "reviewer" }),
  post("req-other", "waiting_other", { blocked: { who: "writer", why: "needs the copy", since: now - 60 * min }, project: "beacon" }),
  post("req-new", "in_progress", { runs: 0 }),
  post("req-done", "done", { lastMoveAt: now - 2 * 86_400_000 }),
  post("req-dup", "in_progress", { headline: "Task req-run", lastMoveAt: now - 30 * min }),
]

const actions = (over: Partial<FeedActions> = {}): FeedActions => ({
  nameOf: (id) => agentNames(live)[id] || id, owner: true,
  open: () => {}, copy: () => {}, stop: () => {}, retry: () => {}, call: () => {}, decide: () => {},
  busy: {}, copied: "", said: {}, ...over,
})
const wrap = (el: ReactElement, client = new QueryClient()) => createElement(QueryClientProvider, { client }, createElement(TooltipProvider, null, el))
const html = (el: ReactElement, a = actions()) => renderToStaticMarkup(wrap(createElement(FeedActionsContext.Provider, { value: a }, el)))

describe("the feed's page id", () => {
  it("is listed in pages.ts, owner only, beside the old feed", () => {
    expect(HUB_REACT_PAGES).toContainEqual({ page: FEED_PAGE, ownerOnly: true })
    expect(FEED_PAGE).toBe("feed-preview")
  })
  it("is a core route with the page's own skeleton as its fallback", async () => {
    const { hubRegistry } = await import("../src/hub/registry")
    await import("../src/hub/extensions/core")
    const r = hubRegistry.route(FEED_PAGE)
    expect(r?.title).toBe("Hub")
    expect(r?.fallback).toBe(FeedPageSkeleton)
  })
})

describe("filters and the address", () => {
  it("opens on Open; an empty status is All", () => {
    expect(feedFilters(parseHash("#page=feed-preview"))).toEqual({ status: "open", q: "", owner: "", project: "" })
    expect(feedFilters(parseHash("#page=feed-preview&status=all&q=docs&owner=coder")).status).toBe("all")
    expect(feedFilters(parseHash("#page=feed-preview&status=")).status).toBe("")
  })
  it("writes the filters on the review id, All as status=all", () => {
    expect(feedHash({})).toBe("#page=feed-preview&status=open")
    expect(feedHash({ status: "", q: "docs" })).toBe("#page=feed-preview&status=all&q=docs")
    expect(parseHash(feedHash({ status: "failed", owner: "coder" })).get("owner")).toBe("coder")
  })
  it("a post opens its Task page, on its node (#2101 T3)", () => {
    expect(postHash({ id: "req-1" })).toBe("#page=task&id=req-1")
    expect(postHash({ id: "req-1", node: { name: "mini", peer: "http://p" } })).toBe("#page=task&id=req-1&peer=http%3A%2F%2Fp")
  })
  it("search matches every word over title, words, owner, project and id", () => {
    const p = post("req-x", "in_progress", { headline: "Fix the login page", project: "atlas" })
    expect(feedMatches(p, "")).toBe(true)
    expect(feedMatches(p, "LOGIN atlas")).toBe(true)
    expect(feedMatches(p, "login beacon")).toBe(false)
    expect(feedMatches(p, "req-x")).toBe(true)
  })
})

describe("who runs what (the live snapshot)", () => {
  it("finds a post's run by request id or by its last run, with its node", () => {
    expect(liveRunOf(posts[0], live)).toEqual({ node: "", task: "t1", agent: "coder" })
    expect(liveRunOf(post("req-z", "in_progress", { lastRun: { taskId: "t1" } as FeedPost["lastRun"] }), live)?.task).toBe("t1")
    expect(liveRunOf(posts[1], live)).toBeNull()
    expect(liveRunOf(posts[0], null)).toBeNull()
  })
  it("gives the one state set, knowing what runs now", () => {
    expect(feedState(posts[0], live)).toBe("working")
    expect(feedState(posts[1], live)).toBe("failed")
    expect(feedState(posts[2], live)).toBe("needs")
    expect(feedState(posts[4], live)).toBe("notstarted")
  })
  it("names agents from the snapshot, else their id", () => {
    expect(agentNames(live)).toEqual({ coder: "Coder", writer: "Writer" })
    expect(agentNames(undefined)).toEqual({})
  })
})

describe("feedView: groups and counts from wall-feed-model.ts", () => {
  const f = (over = {}) => ({ status: "open", q: "", owner: "", project: "", ...over })
  it("folds copies, groups in the state order with Failed under Needs you", () => {
    const v = feedView(posts, f(), live)
    expect(v.groups.map((g) => [g.key, g.posts.map((p) => p.id)])).toEqual([
      ["needs", ["req-fail", "req-you"]], ["working", ["req-run"]], ["waiting", ["req-other"]], ["notstarted", ["req-new"]],
    ])
    expect(v.groups.map((g) => g.title)).toEqual(v.groups.map((g) => fdGroupTitle(g.key)))
    // The older copy of "Task req-run" folds into the newer one.
    expect(v.groups[1].posts[0].copies).toEqual(["req-dup"])
    expect(v.total).toBe(5)
  })
  it("counts every tab over the posts the other filters leave", () => {
    const all = feedView(posts, f(), live).counts
    expect(all).toMatchObject({ open: 5, in_progress: 1, waiting: 2, failed: 1, done: 1, "": 6 })
    const atlas = feedView(posts, f({ project: "beacon" }), live).counts
    expect(atlas).toMatchObject({ open: 1, waiting: 1, failed: 0, "": 1 })
    expect(Object.keys(all)).toEqual(FEED_TABS.map((t) => t[0]))
  })
  it("shows a tab's posts, All as all, and nothing when no post matches", () => {
    expect(feedView(posts, f({ status: "done" }), live).groups.map((g) => g.key)).toEqual(["done"])
    expect(feedView(posts, f({ status: "all" }), live).total).toBe(6)
    expect(feedView(posts, f({ q: "nothing-like-this" }), live)).toMatchObject({ total: 0, groups: [] })
  })
})

describe("small words", () => {
  it("initials: one for a one-word agent, two otherwise", () => {
    expect(initials("Coder")).toBe("C")
    expect(initials("release-manager")).toBe("RM")
    expect(initials("")).toBe("?")
  })
  it("until: minutes, hours, days, passed", () => {
    expect(until(now + 12 * min, now)).toBe("in 12 min")
    expect(until(now + 4 * 3_600_000, now)).toBe("in 4 h")
    expect(until(now + 3 * 86_400_000, now)).toBe("in 3 d")
    expect(until(now - 1, now)).toBe("passed")
  })
  it("waitLine: who it waits on, and the card's clock", () => {
    expect(waitLine(posts[3], now)).toBe("Waits on writer: needs the copy")
    expect(waitLine(posts[2], now)).toBe("Waits on you: Merge the docs PR?, card expires in 4 h")
    expect(waitLine(post("x", "in_progress"), now)).toBe("")
  })
  it("composeTarget: an @name picks the agent and its node", () => {
    expect(composeTarget("@Coder fix it", live)).toEqual({ id: "coder", name: "Coder", peer: null })
    expect(composeTarget("ask @writer.", live)).toEqual({ id: "writer", name: "Writer", peer: "http://peer.test" })
    expect(composeTarget("no one", live)).toBeNull()
    expect(composeTarget("@coder", undefined)).toBeNull()
  })
})

describe("the parts (shared with the List view)", () => {
  it("StateLabel: the icon and word of the one state set; only Working turns", () => {
    for (const [s, info] of Object.entries(fdStates())) expect(html(createElement(StateLabel, { state: s }))).toContain(">" + info.word + "<")
    expect(html(createElement(StateLabel, { state: "working" }))).toContain("animate-spin")
    expect(html(createElement(StateLabel, { state: "waiting" }))).not.toContain("animate-spin")
    expect(html(createElement(StateLabel, { state: "failed" }))).toContain("text-err-ink")
  })
  it("a working row: name, time in <time>, excerpt, copies, Stop always there", () => {
    const p = { ...posts[0], copies: ["req-dup"], result: { text: "**Opened** the PR" } } as FeedPost
    const out = html(createElement(FeedRow, { post: p, state: "working", running: true, now }))
    expect(out).toContain('data-slot="feed-row"')
    expect(out).toContain(">Coder<")
    expect(out).toMatch(/<time datetime="2026-11-20T09:55:00.000Z"[^>]*>5m<\/time>/i)
    expect(out).toContain("Opened the PR")
    expect(out).toContain("1 more copy of this task")
    expect(out).toContain('data-fk="stop"')
    expect(out).toContain('aria-label="Copy link"')
    expect(out).toContain('aria-label="More actions"')
    // The kit's DropdownMenu: a real menu button (arrow keys, Esc, focus back).
    expect(out).toMatch(/aria-haspopup="menu"[^>]*aria-label="More actions"|aria-label="More actions"[^>]*aria-haspopup="menu"/)
    // Not the old Hub's hooks: its script listens for these on the document.
    expect(out).not.toMatch(/data-(post|open|tab|agent)=/)
  })
  it("no Stop when nothing runs it", () => {
    expect(html(createElement(FeedRow, { post: posts[0], state: "working", running: false, now }))).not.toContain('data-fk="stop"')
  })
  it("a failed row: its error and run id, and Retry, in the one red", () => {
    const out = html(createElement(FeedRow, { post: posts[1], state: "failed", running: false, now }))
    expect(out).toContain('data-slot="feed-fail"')
    expect(out).toContain("Run failed: exit 1, run")
    expect(out).toContain(">t9<")
    expect(out).toContain('data-fk="retry"')
  })
  it("a card that waits on you: facts, Deny ghost and Approve; none for a guest", () => {
    const out = html(createElement(FeedRow, { post: posts[2], state: "needs", running: false, now }))
    expect(out).toContain('data-slot="feed-card"')
    expect(out).toContain("Merge #12 to main")
    expect(out).toContain(">Deny<")
    expect(out).toContain(">Approve<")
    expect(out).toContain("Expires in 4 h")
    const guest = html(createElement(FeedRow, { post: posts[2], state: "needs", running: false, now }), actions({ owner: false }))
    expect(guest).not.toContain(">Approve<")
  })
  it("says what an action did, and Link copied after a copy", () => {
    const out = html(createElement(FeedRow, { post: posts[0], state: "working", running: true, now }), actions({ said: { "req-run": "Stopped." }, copied: "req-run" }))
    expect(out).toContain("Stopped.")
    expect(out).toContain('aria-label="Link copied"')
  })
  it("a section folds from its header with a count, and offers Show all (N) past the cap", () => {
    const sec = (open: boolean, count: number) => html(createElement(FeedSection, {
      id: "working", title: "Working", count, open, onOpen: () => {}, all: false, onAll: () => {}, cap: 3, children: createElement("p", null, "rows"),
    }))
    expect(sec(true, 5)).toContain('aria-expanded="true"')
    expect(sec(true, 5)).toContain("Show all (5)")
    expect(sec(true, 3)).not.toContain("Show all")
    expect(sec(false, 5)).toContain('data-state="closed"')
    expect(sec(false, 5)).toMatch(/id="fd-rows-working" hidden=""/)
  })
  it("the empty state gives an action", () => {
    expect(html(createElement(FeedEmpty, { onClear: () => {} }))).toContain(">Clear filters<")
  })
})

describe("the page", () => {
  const stream = { acquire: () => () => {}, subscribe: () => () => {}, getStatus: () => "open" } as unknown as LiveStream
  const page = (hash: string, reply: unknown) => {
    const client = new QueryClient()
    if (reply) client.setQueryData(["feed-posts"], reply)
    client.setQueryData(LIVE_KEY, live)
    return renderToStaticMarkup(wrap(createElement(LiveProvider, { stream, children: createElement(FeedPage, { params: parseHash(hash) }) }), client))
  }
  it("draws the head, the composer, the tabs with counts and the groups", () => {
    const out = page("#page=feed-preview", { posts })
    expect(out).toContain('data-slot="feed"')
    expect(out).toContain(">Hub</h1>")
    expect(out).toContain('aria-label="Give an agent a task"')
    expect(out).toMatch(/role="tab" aria-selected="true"[^>]*>.*?Open<span[^>]*>5</)
    expect(out).toContain(">Needs you<")
    expect(out).toContain("Synced")
    expect(out).not.toContain(">Done</span><span")
  })
  it("a filter that leaves nothing shows the empty state, not the groups", () => {
    const out = page("#page=feed-preview&q=nothing-like-this", { posts })
    expect(out).toContain("No tasks match these filters")
    expect(out).not.toContain('data-slot="feed-section"')
  })
  it("before the first read: the frame and rows shaped like posts", () => {
    const out = page("#page=feed-preview", null)
    expect(out).toContain('aria-label="Loading tasks"')
    expect(out).toContain(">Hub</h1>")
  })
  it("a failed first read says so, with Retry (C15)", () => {
    // Read as it stands once the retries are spent (no new read on mount).
    const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } })
    client.getQueryCache().build(client, { queryKey: ["feed-posts"] }).setState({ status: "error", error: new Error("daemon down"), fetchStatus: "idle", dataUpdatedAt: 0 } as never)
    client.setQueryData(LIVE_KEY, live)
    const out = renderToStaticMarkup(wrap(createElement(LiveProvider, { stream, children: createElement(FeedPage, { params: parseHash("#page=feed-preview") }) }), client))
    expect(out).toContain("Could not load the feed")
    expect(out).toContain("daemon down")
    expect(out).toContain(">Retry<")
    expect(out).not.toContain('aria-label="Loading tasks"')
  })
  it("the route's skeleton sits in the same column as the page", () => {
    const sk = renderToStaticMarkup(createElement(FeedPageSkeleton))
    expect(sk).toContain(FEED_COLUMN)
    expect(page("#page=feed-preview", { posts })).toContain(FEED_COLUMN)
  })
})
