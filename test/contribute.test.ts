import { readFileSync, readdirSync } from "node:fs"
import { parse } from "yaml"
import { describe, expect, it } from "vitest"
import { CATEGORIES, MAX_URL_LENGTH, buildIssueUrl, isRecommended, notRecommendedMessage, searchIssues } from "../src/contrib/contribute"

const models = JSON.parse(readFileSync(new URL("../contrib/models.json", import.meta.url), "utf8"))
const formsDir = new URL("../.github/ISSUE_TEMPLATE/", import.meta.url)
const meta = { model: "claude-sonnet-5", version: "1.2.3" }

describe("issue forms", () => {
  it("every category matches its issue form: template, title prefix, field ids and required flags", () => {
    for (const [name, cat] of Object.entries(CATEGORIES)) {
      const form = parse(readFileSync(new URL(cat.template, formsDir), "utf8"))
      expect(form.title.startsWith(cat.titlePrefix), name).toBe(true)
      const fields = form.body
        .filter((b: any) => b.type !== "markdown")
        .map((b: any) => ({ id: b.id, required: Boolean(b.validations?.required) }))
      expect(fields, name).toEqual(cat.fields)
      expect(form.body.find((b: any) => b.id === cat.footerField)?.type, name).toBe("textarea")
    }
  })

  it("has the six categories, and blank issues stay disabled", () => {
    expect(Object.keys(CATEGORIES).sort()).toEqual(["bug", "docs", "enhancement", "feature", "idea", "integration"])
    const config = parse(readFileSync(new URL("config.yml", formsDir), "utf8"))
    expect(config.blank_issues_enabled).toBe(false)
    for (const f of readdirSync(formsDir).filter((f) => f !== "config.yml")) {
      expect(() => parse(readFileSync(new URL(f, formsDir), "utf8")), f).not.toThrow()
    }
  })
})

describe("isRecommended", () => {
  it("accepts ids, dated snapshots and aliases, case-insensitively", () => {
    expect(isRecommended("claude-sonnet-5", models)).toBe(true)
    expect(isRecommended("claude-sonnet-5-20261001", models)).toBe(true)
    expect(isRecommended("Opus", models)).toBe(true)
  })

  it("refuses unlisted models and prefixes that are not a dash-separated snapshot", () => {
    expect(isRecommended("gpt-3.5-turbo", models)).toBe(false)
    expect(isRecommended("claude-sonnet-50", models)).toBe(false)
    expect(isRecommended("", models)).toBe(false)
  })

  it("the refusal message is kind and points to the web form", () => {
    const msg = notRecommendedMessage("old-model", models)
    expect(msg).toContain("says nothing about you or your idea")
    expect(msg).toContain("https://github.com/anis-marrouchi/agentx/issues/new/choose")
  })
})

describe("buildIssueUrl", () => {
  const draft = { category: "feature", title: "Dashboard – export runs", fields: { problem: "No export.", proposal: "Add a button." } }

  it("builds a pre-filled form link with the title prefix and a provenance footer", () => {
    const url = new URL(buildIssueUrl(draft, meta))
    expect(url.pathname).toBe("/anis-marrouchi/agentx/issues/new")
    expect(url.searchParams.get("template")).toBe("feature_request.yml")
    expect(url.searchParams.get("title")).toBe("Feat: Dashboard – export runs")
    expect(url.searchParams.get("problem")).toBe("No export.")
    expect(url.searchParams.get("proposal")).toBe("Add a button.\n\n---\n_Prepared with `agentx contribute` · model: claude-sonnet-5 · AgentX 1.2.3 · category: feature_")
    expect(url.searchParams.has("alternatives")).toBe(false)
  })

  it("keeps a title that already has the prefix", () => {
    const url = new URL(buildIssueUrl({ ...draft, title: "Feat: Dashboard – export runs" }, meta))
    expect(url.searchParams.get("title")).toBe("Feat: Dashboard – export runs")
  })

  it("rejects unknown categories, unknown fields, missing required fields and empty titles", () => {
    expect(() => buildIssueUrl({ ...draft, category: "rant" }, meta)).toThrow(/Unknown category/)
    expect(() => buildIssueUrl({ ...draft, fields: { ...draft.fields, extra: "x" } }, meta)).toThrow(/Unknown field\(s\) for feature: extra/)
    expect(() => buildIssueUrl({ ...draft, fields: { problem: "x", proposal: "  " } }, meta)).toThrow(/Missing required field\(s\) for feature: proposal/)
    expect(() => buildIssueUrl({ ...draft, title: " " }, meta)).toThrow(/needs a title/)
  })

  it("refuses drafts too long for a link", () => {
    const long = { ...draft, fields: { problem: "x".repeat(MAX_URL_LENGTH), proposal: "y" } }
    expect(() => buildIssueUrl(long, meta)).toThrow(/too long/)
  })
})

describe("searchIssues", () => {
  it("scopes the query to open issues in the repo and sorts by votes", async () => {
    let asked = ""
    const fake = (async (url: string) => {
      asked = url
      return new Response(JSON.stringify({ items: [
        { number: 1, title: "a", html_url: "u1", reactions: { "+1": 2 } },
        { number: 2, title: "b", html_url: "u2", reactions: { "+1": 9 } },
      ] }))
    }) as unknown as typeof fetch
    const hits = await searchIssues("voice", fake)
    expect(decodeURIComponent(asked)).toContain("repo:anis-marrouchi/agentx is:issue is:open voice")
    expect(hits.map((h) => h.number)).toEqual([2, 1])
  })

  it("explains a failed search", async () => {
    const fake = (async () => new Response("", { status: 403 })) as unknown as typeof fetch
    await expect(searchIssues("x", fake)).rejects.toThrow(/HTTP 403/)
  })
})
