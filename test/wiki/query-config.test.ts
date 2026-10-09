import { describe, expect, it } from "vitest"
import { daemonConfigSchema, withSummaryJob } from "../../src/daemon/config"

// `wiki.query` and `wiki.summaries` settings (#855).

const node = { id: "node-1", name: "Node" }
const base = { node, agents: { "agent-a": { name: "A", workspace: "/w" } } }

describe("wiki query settings", () => {
  it("defaults: method auto, live read on but with no source, so nothing is read", () => {
    const q = daemonConfigSchema.parse(base).wiki.query
    expect(q.method).toBe("auto")
    expect(q.live).toEqual({ enabled: true, maxReads: 6, timeoutMs: 8000, sources: [] })
    expect(q.models).toEqual({ selector: "haiku", planner: "haiku", answer: "sonnet" })
  })

  it("accepts github, gitlab and agentx sources", () => {
    const q = daemonConfigSchema.parse({
      ...base,
      wiki: { query: { live: { sources: [
        { kind: "github", name: "gh", repos: ["example/app"], tokenEnv: "GITHUB_TOKEN" },
        { kind: "gitlab", name: "gl", host: "gitlab.example.com", repos: ["group/project"] },
        { kind: "agentx" },
      ] } } },
    }).wiki.query
    expect(q.live.sources[0]).toMatchObject({ kind: "github", host: "github.com" })
    expect(q.live.sources[2]).toEqual({ kind: "agentx", name: "agentx", peers: true })
  })

  it("rejects a host with a scheme, a source without repositories, and two sources with one name", () => {
    const bad = (sources: unknown[]) => daemonConfigSchema.safeParse({ ...base, wiki: { query: { live: { sources } } } }).success
    expect(bad([{ kind: "gitlab", name: "gl", host: "https://gitlab.example.com", repos: ["a/b"] }])).toBe(false)
    expect(bad([{ kind: "github", name: "gh", repos: [] }])).toBe(false)
    expect(bad([{ kind: "agentx", name: "x" }, { kind: "agentx", name: "x" }])).toBe(false)
  })
})

describe("the page-summary job", () => {
  it("is added only when wiki.summaries.schedule is set", () => {
    expect(withSummaryJob(daemonConfigSchema.parse(base), "agentx").crons["wiki-summarize"]).toBeUndefined()
    const on = daemonConfigSchema.parse({ ...base, wiki: { summaries: { schedule: "15 3 * * *" } } })
    expect(withSummaryJob(on, "agentx").crons["wiki-summarize"]).toMatchObject({
      schedule: "15 3 * * *", command: "agentx wiki summarize --all", agent: "agent-a",
    })
  })

  it("a cron the operator defined under the same id wins", () => {
    const own = daemonConfigSchema.parse({
      ...base,
      wiki: { summaries: { schedule: "15 3 * * *" } },
      crons: { "wiki-summarize": { schedule: "0 1 * * *", agent: "agent-a", command: "true" } },
    })
    expect(withSummaryJob(own, "agentx").crons["wiki-summarize"].schedule).toBe("0 1 * * *")
  })
})
