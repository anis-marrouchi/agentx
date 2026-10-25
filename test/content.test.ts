import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CALENDAR_TEMPLATE, parseCalendar, readCalendar, setCalendarStatus, upcoming } from "../src/content/calendar"
import { contentTextHash, createContentDraft, decideContentDraft, listContentDrafts, readContentDraft, type ContentDraft, type PublishContent } from "../src/content/drafts"
import { publishDraft } from "../src/content/publish"
import { pickSamples } from "../src/content/voice"
import { handleContentApi } from "../src/content/daemon-api"
import { runContentTool } from "../src/content/tool"
import { decide, listInbox } from "../src/approvals/inbox"
import { shippedTeam } from "../src/teams/catalog"

let root: string
let ws: string

function samples(): void {
  mkdirSync(join(ws, "voice"), { recursive: true })
  writeFileSync(join(ws, "voice", "2026-03-launch.md"), "We launched the new booking page today. Three things we learned about pricing pages.\n")
  writeFileSync(join(ws, "voice", "2026-05-hiring.md"), "We are hiring a designer. Here is what the first month looks like.\n")
}

function calendar(rows: string[]): void {
  writeFileSync(join(ws, "calendar.md"), CALENDAR_TEMPLATE + rows.join("\n") + "\n")
}

function draft(over: Record<string, unknown> = {}) {
  return createContentDraft(root, {
    agent: "content",
    workspace: ws,
    platform: "linkedin",
    text: "Three things our booking page taught us about pricing.",
    samples: ["2026-03-launch.md"],
    topic: "pricing pages",
    date: "2026-11-02",
    ...over,
  }, Date.UTC(2026, 9, 26, 8))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentx-content-"))
  ws = join(root, "agents", "content")
  mkdirSync(ws, { recursive: true })
  samples()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("voice samples", () => {
  it("picks the past posts closest to the topic first", () => {
    const picked = pickSamples(ws, "what we learned about pricing", 2)
    expect(picked.map((p) => p.file)).toEqual(["2026-03-launch.md", "2026-05-hiring.md"])
    expect(picked[0].score).toBeGreaterThan(picked[1].score)
  })

  it("a draft must name the samples it followed, and they must exist", () => {
    expect(draft({ samples: [] })).toMatchObject({ ok: false, error: expect.stringContaining("samples is empty") })
    expect(draft({ samples: ["made-up.md"] })).toMatchObject({ ok: false, error: "not in voice/: made-up.md" })
    const r = draft()
    expect(r.ok && r.draft.samples).toEqual(["2026-03-launch.md"])
  })

  it("refuses a post longer than the platform takes", () => {
    expect(draft({ platform: "x", text: "a".repeat(281) })).toMatchObject({ ok: false, error: expect.stringContaining("280") })
    expect(draft({ platform: "mastodon" })).toMatchObject({ ok: false, error: expect.stringContaining("platform") })
  })
})

describe("every draft waits for approval before it is published", () => {
  it("a new draft is pending, in the inbox, and nothing is published", async () => {
    const publish = vi.fn<PublishContent>(async () => ({ ok: true, posted: true }))
    const r = draft()
    expect(r.ok).toBe(true)
    const id = r.ok ? r.draft.id : ""
    expect(readContentDraft(root, id)?.status).toBe("pending")

    const { items } = listInbox({ root, publishContent: publish, requests: undefined }, { kinds: ["content"] })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ key: `content:${id}`, kind: "content", raised_by: "content" })
    expect(items[0].ask).toContain("Three things our booking page")
    expect(items[0].detail).toContain("2026-03-launch.md")
    expect(items[0].yes).toContain("ready to paste")
    expect(publish).not.toHaveBeenCalled()
  })

  it("no drops it and publishes nothing", async () => {
    const publish = vi.fn<PublishContent>(async () => ({ ok: true, posted: true }))
    const r = draft()
    const id = r.ok ? r.draft.id : ""
    const out = await decide({ root, publishContent: publish }, `content:${id}`, "no")
    expect(out).toMatchObject({ ok: true })
    expect(publish).not.toHaveBeenCalled()
    expect(readContentDraft(root, id)?.status).toBe("rejected")
  })

  it("yes publishes once, as edited, and a second yes does nothing", async () => {
    const publish = vi.fn<PublishContent>(async () => ({ ok: true, posted: true, url: "https://example.com/post/1" }))
    const r = draft()
    const id = r.ok ? r.draft.id : ""
    const out = await decide({ root, publishContent: publish }, `content:${id}`, "yes", { text: "Edited by the owner." })
    expect(out).toMatchObject({ ok: true, message: expect.stringContaining("posted on LinkedIn") })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0][0].text).toBe("Edited by the owner.")
    expect(readContentDraft(root, id)).toMatchObject({ status: "posted", url: "https://example.com/post/1" })

    expect(await decide({ root, publishContent: publish }, `content:${id}`, "yes")).toMatchObject({ ok: false })
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it("two yes at once publish once", async () => {
    let calls = 0
    const publish: PublishContent = async () => { calls++; return { ok: true, posted: true } }
    const r = draft()
    const id = r.ok ? r.draft.id : ""
    const both = await Promise.all([
      decideContentDraft(root, id, "yes", { publish }),
      decideContentDraft(root, id, "yes", { publish }),
    ])
    expect(both.filter((b) => b.ok)).toHaveLength(1)
    expect(calls).toBe(1)
  })

  it("yes is refused when the draft changed since it was shown", async () => {
    const publish = vi.fn<PublishContent>(async () => ({ ok: true, posted: true }))
    const r = draft()
    const id = r.ok ? r.draft.id : ""
    const [item] = listInbox({ root, publishContent: publish }, { kinds: ["content"] }).items
    expect(item.text_hash).toBe(contentTextHash("Three things our booking page taught us about pricing."))

    // The file is rewritten behind the owner's back after the page loaded.
    const file = join(root, ".agentx", "content", "drafts", `${id}.json`)
    writeFileSync(file, JSON.stringify({ ...readContentDraft(root, id), text: "Something else." }))
    const out = await decide({ root, publishContent: publish }, item.key, "yes", { seen: item.text_hash })
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("changed since it was shown") })
    expect(publish).not.toHaveBeenCalled()
    expect(readContentDraft(root, id)?.status).toBe("pending")

    const fresh = listInbox({ root, publishContent: publish }, { kinds: ["content"] }).items[0]
    expect(await decide({ root, publishContent: publish }, fresh.key, "yes", { seen: fresh.text_hash })).toMatchObject({ ok: true })
    expect(publish.mock.calls[0][0].text).toBe("Something else.")
  })

  it("a yes from the CLI reads the connector token from the .env next to agentx.json", async () => {
    const config = { agents: { content: { workspace: ws, integrations: [{ kind: "x", label: "me", enabled: true, credentials: { tokenEnv: "AGENTX_TEST_CONTENT_X" }, metadata: {} }] } } }
    writeFileSync(join(root, "agentx.json"), JSON.stringify(config))
    writeFileSync(join(root, ".env"), "AGENTX_TEST_CONTENT_X=from-dotenv\n")
    delete process.env.AGENTX_TEST_CONTENT_X
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { id: "7" } }), { status: 201 }))
    vi.stubGlobal("fetch", fetch)
    try {
      const r = draft({ platform: "x", text: "Short post." })
      const id = r.ok ? r.draft.id : ""
      expect(listInbox({ root }, { kinds: ["content"] }).items[0].yes).toBe("post it on X")
      const out = await decide({ root }, `content:${id}`, "yes")
      expect(out).toMatchObject({ ok: true, message: expect.stringContaining("posted on X") })
      const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer from-dotenv")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("agents cannot publish through the daemon", () => {
    const r = draft()
    const id = r.ok ? r.draft.id : ""
    const reply = handleContentApi("POST", `/content/drafts/${id}/publish`, {}, new URLSearchParams(), { root, workspaceOf: () => ws })
    expect(reply.status).toBe(403)
    expect(readContentDraft(root, id)?.status).toBe("pending")
  })
})

describe("publishing an approved draft", () => {
  const approved = (over: Partial<ContentDraft> = {}): ContentDraft => ({
    id: "mabc123-0011aabb", status: "pending", created_at: "2026-10-26T08:00:00.000Z", agent: "content",
    platform: "linkedin", text: "Ready to go.", samples: ["2026-03-launch.md"], date: "2026-11-02", workspace: ws, ...over,
  })

  it("without a connector, saves a ready-to-paste file holding only the post", async () => {
    const r = await publishDraft(approved(), { config: {} })
    expect(r).toMatchObject({ ok: true, posted: false })
    const file = (r as { file: string }).file
    expect(file).toBe(join(ws, "ready", "2026-11-02-linkedin-mabc123-0011aabb.txt"))
    expect(readFileSync(file, "utf-8")).toBe("Ready to go.\n")
  })

  it("with a LinkedIn connector, posts as the configured author", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 201, headers: { "x-restli-id": "urn:li:share:42" } }))
    const config = { agents: { content: { integrations: [{ kind: "linkedin", label: "me", enabled: true, credentials: { tokenEnv: "LI_TOKEN" }, metadata: { author: "urn:li:person:abc" } }] } } }
    const r = await publishDraft(approved(), { config, env: { LI_TOKEN: "t0ken" }, fetch: fetch as any })
    expect(r).toEqual({ ok: true, posted: true, url: "https://www.linkedin.com/feed/update/urn:li:share:42/" })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://api.linkedin.com/rest/posts")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t0ken")
    expect(JSON.parse(String(init.body))).toMatchObject({ author: "urn:li:person:abc", commentary: "Ready to go.", lifecycleState: "PUBLISHED" })
  })

  it("when X refuses the post, keeps it ready to paste and says why", async () => {
    const fetch = vi.fn(async () => new Response("forbidden", { status: 403 }))
    const config = { agents: { content: { integrations: [{ kind: "x", label: "me", enabled: true, credentials: { tokenEnv: "X_TOKEN" }, metadata: {} }] } } }
    const r = await publishDraft(approved({ platform: "x" }), { config, env: { X_TOKEN: "t" }, fetch: fetch as any })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain("X said 403")
    expect(existsSync((r as { file: string }).file)).toBe(true)
  })

  it("a connector whose token is not set falls back to the file", async () => {
    const fetch = vi.fn()
    const config = { agents: { content: { integrations: [{ kind: "x", label: "me", enabled: true, credentials: { tokenEnv: "X_TOKEN" }, metadata: {} }] } } }
    const r = await publishDraft(approved({ platform: "x" }), { config, env: {}, fetch: fetch as any })
    expect(r).toMatchObject({ ok: true, posted: false })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("the content calendar", () => {
  it("reads rows and keeps the status moving with the draft", async () => {
    calendar(["| 2026-11-02 | linkedin | pricing pages | planned |", "| 2026-11-04 | x | hiring | planned |"])
    expect(readCalendar(ws)).toHaveLength(2)

    const r = draft()
    const id = r.ok ? r.draft.id : ""
    expect(readCalendar(ws)?.[0].status).toBe("drafted")

    await decideContentDraft(root, id, "yes", { publish: async () => ({ ok: true, posted: true }) })
    expect(readCalendar(ws)?.[0].status).toBe("posted")
    expect(readCalendar(ws)?.[1].status).toBe("planned")

    const other = draft({ platform: "x", date: "2026-11-04", text: "Hiring." })
    await decideContentDraft(root, other.ok ? other.draft.id : "", "no", { publish: async () => ({ ok: true, posted: true }) })
    expect(readCalendar(ws)?.[1].status).toBe("skipped")
    expect(readFileSync(join(ws, "calendar.md"), "utf-8")).toContain("# Content calendar")
  })

  it("lists what is planned in the coming days", () => {
    const rows = parseCalendar("| Date | Platform | Topic | Status |\n|---|---|---|---|\n| 2026-11-02 | x | a | planned |\n| 2026-12-01 | x | b | planned |")
    expect(upcoming(rows, new Date("2026-10-30T00:00:00Z"), 7).map((e) => e.topic)).toEqual(["a"])
    expect(setCalendarStatus(ws, "2026-11-02", "x", "posted")).toBe(false)
  })
})

describe("the agentx_content tool", () => {
  it("raises a draft in the agent's name through the daemon", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      const reply = handleContentApi(init?.method ?? "GET", new URL(url).pathname, body, new URL(url).searchParams, { root, workspaceOf: (a) => (a === "content" ? ws : null) })
      return new Response(JSON.stringify(reply.body), { status: reply.status })
    })
    const text = await runContentTool(
      { action: "draft", platform: "linkedin", text: "A post.", samples: ["2026-05-hiring.md"], topic: "hiring" },
      { daemonUrl: "http://127.0.0.1:1", fetch: fetch as any, env: { AGENTX_AGENT_ID: "content" } },
    )
    expect(text).toContain("Nothing is published until they say yes")
    expect(listContentDrafts(root, "pending")).toHaveLength(1)

    const voice = await runContentTool({ action: "voice", topic: "hiring a designer" }, { daemonUrl: "http://127.0.0.1:1", fetch: fetch as any, env: { AGENTX_AGENT_ID: "content" } })
    expect(voice).toContain("2026-05-hiring.md")
  })
})

describe("the content team", () => {
  it("ships with the voice skill, the calendar template and both weekly schedules", () => {
    const t = shippedTeam("content")!
    expect(t).toBeTruthy()
    expect(Object.keys(t.agents.content.skills["content-voice"])).toEqual(["SKILL.md", "calendar-template.md"])
    expect(t.schedules["content-weekly-calendar"].schedule).toBe("0 10 * * 5")
    expect(t.schedules["content-weekly-drafts"].prompt).toContain("Publish nothing")
    expect(t.agents.content.systemPrompt).toContain("never publish")
  })
})
