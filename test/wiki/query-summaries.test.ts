import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { WikiStore } from "../../src/wiki/store"
import { agenticQuery, shortlistBySummary } from "../../src/wiki/query"
import { summarizeStore } from "../../src/wiki/summaries"
import type { LiveSource } from "../../src/wiki/live-read"

// `wiki query` with page summaries and a live read (#855): pick pages from
// their summary lines, name live reads, run them in code, answer from both.

const seatEnv = "AGENTX_DECISION_SEAT_WIKI_RERANK"

describe("wiki query: summaries + live read", () => {
  let dir: string
  let store: WikiStore
  const prevSeat = process.env[seatEnv]
  const write = (path: string, title: string, content: string) =>
    store.writeArticle(path, {
      title, type: "project", related: [], tags: [], owner: "ops", access: "public",
      created: "2026-10-01", lastUpdated: "2026-10-01", sources: [],
    }, content, "ops")

  const summaries: Record<string, string> = {
    "Login Fix": "Login fix for the phone app, tracked in example/app issue 12; waiting for review.",
    "Office Move": "The team moved to the third floor in September.",
  }
  const summarise = async (prompt: string) => {
    const ids = [...prompt.matchAll(/^### (p\d+): (.+?)(?: \[\w+\])?$/gm)]
    return JSON.stringify(Object.fromEntries(ids.map((m) => [m[1], summaries[m[2]] ?? m[2]])))
  }

  const sources: LiveSource[] = [{ kind: "github", name: "gh", host: "github.com", repos: ["example/app"] }]
  const issue = { title: "Login fails on the phone app", state: "closed", state_reason: "completed", closed_at: "2026-10-08T12:00:00Z" }
  let fetched: string[]
  const fakeFetch = (async (url: string, init: RequestInit) => {
    fetched.push(`${init.method} ${url}`)
    return url === "https://api.github.com/repos/example/app/issues/12"
      ? new Response(JSON.stringify(issue), { status: 200 })
      : new Response("{}", { status: 404 })
  }) as unknown as typeof fetch

  let prompts: Array<{ step: string; prompt: string; model: string }>
  const model = (replies: { pick?: string; plan?: string; answer?: string; catalog?: string }) =>
    async (prompt: string, m: string) => {
      const step = prompt.startsWith("You pick wiki pages") ? "pick"
        : prompt.startsWith("A question will be answered") ? "plan"
        : prompt.startsWith("You are picking candidate articles") ? "catalog"
        : "answer"
      prompts.push({ step, prompt, model: m })
      return (replies as any)[step] ?? ""
    }

  beforeEach(async () => {
    process.env[seatEnv] = "off"
    dir = mkdtempSync(resolve(tmpdir(), "wiki-query-summaries-"))
    store = new WikiStore(dir, () => {})
    write("projects/login-fix.md", "Login Fix", "The login fix is tracked in example/app#12. Status: waiting for review.")
    write("events/office-move.md", "Office Move", "We moved floors.")
    prompts = []
    fetched = []
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (prevSeat === undefined) delete process.env[seatEnv]
    else process.env[seatEnv] = prevSeat
  })

  it("picks pages from summaries, runs the named live read, and answers from both", async () => {
    await summarizeStore(store, { run: summarise })
    const r = await agenticQuery("Is the phone app issue fixed?", store, "ops", {
      runModel: model({
        pick: '["k1"]',
        plan: '[{"source": "gh", "kind": "issue", "repo": "example/app", "id": 12}, {"source": "gh", "kind": "issue", "repo": "evil/repo", "id": 1}]',
        answer: "Yes, the issue was closed on 2026-10-08 [live 1].",
      }),
      live: { enabled: true, sources, fetch: fakeFetch, env: {} },
      log: () => {},
    })
    expect(r.status).toBe("ok")
    expect(r.method).toBe("summaries")
    expect(r.citations.map((c) => c.path)).toEqual(["projects/login-fix.md"])
    // The selector saw the summary, not just the title.
    expect(prompts.find((p) => p.step === "pick")!.prompt).toContain("tracked in example/app issue 12")
    // Only the configured repository was read, with a GET.
    expect(fetched).toEqual(["GET https://api.github.com/repos/example/app/issues/12"])
    expect(r.live).toHaveLength(1)
    expect(r.live![0].text).toContain("closed (completed)")
    const answer = prompts.find((p) => p.step === "answer")!.prompt
    expect(answer).toContain("[live 1] gh: example/app#12")
    expect(answer).toContain("the live read wins")
    expect(r.answer).toContain("[live 1]")
    expect(prompts.map((p) => p.model)).toEqual(["haiku", "haiku", "sonnet"])
  })

  it("with the live read off, names no reads and fetches nothing", async () => {
    await summarizeStore(store, { run: summarise })
    const r = await agenticQuery("Is the phone app issue fixed?", store, "ops", {
      runModel: model({ pick: '["k1"]', answer: "Waiting for review [Login Fix]." }),
      live: { enabled: false, sources, fetch: fakeFetch },
      log: () => {},
    })
    expect(r.status).toBe("ok")
    expect(prompts.map((p) => p.step)).toEqual(["pick", "answer"])
    expect(fetched).toEqual([])
    expect(prompts[1].prompt).not.toContain("Live read")
  })

  it("when the selector picks no page, runs no live read", async () => {
    await summarizeStore(store, { run: summarise })
    const r = await agenticQuery("Is the phone app issue fixed?", store, "ops", {
      runModel: model({ pick: "[]" }),
      live: { enabled: true, sources, fetch: fakeFetch },
      log: () => {},
    })
    expect(r.status).toBe("no-candidates")
    expect(fetched).toEqual([])
  })

  it("auto falls back to the catalog method when the wiki has no summaries", async () => {
    store.rebuildIndex()
    const r = await agenticQuery("login fix status", store, "ops", {
      runModel: model({ catalog: '[{"title": "Login Fix", "path": "projects/login-fix.md"}]', answer: "Waiting for review." }),
      live: { enabled: true, sources, fetch: fakeFetch },
      log: () => {},
    })
    expect(r.method).toBe("catalog")
    expect(r.status).toBe("ok")
    expect(fetched).toEqual([])
  })

  it("method catalog ignores summaries the wiki has", async () => {
    await summarizeStore(store, { run: summarise })
    store.rebuildIndex()
    const r = await agenticQuery("login fix status", store, "ops", {
      method: "catalog",
      runModel: model({ catalog: '[{"title": "Login Fix", "path": "projects/login-fix.md"}]', answer: "ok" }),
      log: () => {},
    })
    expect(r.method).toBe("catalog")
  })
})

describe("shortlistBySummary", () => {
  const entries = [
    { title: "Office Move", tags: [], summary: "The team moved floors." },
    { title: "Release Notes", tags: [], summary: "What shipped in version 2.1 of the phone app." },
    { title: "Phone App", tags: ["mobile"], summary: "The phone app for field staff." },
  ]

  it("ranks by words shared over title, tags and summary, and leaves out pages that share none", () => {
    const out = shortlistBySummary("what shipped in the phone app version", entries, 12)
    expect(out.map((e) => e.title)).toEqual(["Release Notes", "Phone App"])
  })

  it("keeps at most n", () => {
    expect(shortlistBySummary("phone app", entries, 1)).toHaveLength(1)
  })
})
