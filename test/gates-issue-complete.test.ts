import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  missingParts,
  pickCurrentMilestone,
  titleNamesMonth,
  type MilestoneRow,
} from "../src/gates/issue-complete"
import { checkIssueCreate } from "../src/gates/issue-gate"
import type { GateEvent } from "../src/gates/events"
import { gateEventsSince } from "../src/gates/events"
import { GitLabAdapter } from "../src/channels/gitlab"
import { openDb, closeDb } from "../src/storage/sqlite"
import { registerAllBuiltins, runBuiltin, _resetBuiltinsForTesting } from "../src/actions/builtin"
import { setMessageRouter, resetMessageRouterForTesting } from "../src/channels/router-instance"

// #2085 G1: a new issue is complete when it is created (milestone,
// /estimate, checklist). Tests named after the design note (P*, C1).

const HOST = "https://gitlab.example.com"
const NOW = new Date("2026-11-23T12:00:00Z")
const COMPLETE = "What is wanted.\n\n- [ ] it works\n/estimate 1h"

const projectNov: MilestoneRow = { id: 11, title: "November 2026", start_date: "2026-11-01", due_date: "2026-11-30", project_id: 5 }
const groupNov: MilestoneRow = { id: 22, title: "2026-11", start_date: "2026-11-01", due_date: "2026-11-30", group_id: 3 }

function milestonesFetch(rows: MilestoneRow[] | { status: number }) {
  return vi.fn(async (_url: string) => {
    if (!Array.isArray(rows)) return { ok: false, status: rows.status, json: async () => ({}) } as any
    return { ok: true, status: 200, json: async () => rows } as any
  })
}

describe("missingParts", () => {
  it("names each missing part in order", () => {
    expect(missingParts("", false)).toEqual(["milestone", "/estimate", "checklist"])
    expect(missingParts(COMPLETE, true)).toEqual([])
  })
  it("takes a /milestone quick action as the milestone", () => {
    expect(missingParts(`/milestone %"November 2026"\n${COMPLETE}`, false)).toEqual([])
  })
  it("finds a checklist further down a multi-line body", () => {
    expect(missingParts("Intro 1) step (note)\n\nmore\n\n- [ ] later\n/estimate 30m", true)).toEqual([])
  })
  it("does not count a ticked box or a plain dash as a checklist", () => {
    expect(missingParts("- [x] done\n- item\n/estimate 1h", true)).toEqual(["checklist"])
  })
})

describe("the month's milestone", () => {
  it("P7: a project milestone wins over a group one for the same month", () => {
    expect(pickCurrentMilestone([groupNov, projectNov], NOW)?.id).toBe(11)
  })
  it("P6: a group milestone alone is taken", () => {
    expect(pickCurrentMilestone([groupNov], NOW)?.id).toBe(22)
  })
  it("P11: the title fallback needs both month and year", () => {
    expect(titleNamesMonth("November 2025", NOW)).toBe(false)
    expect(titleNamesMonth("Nov 2026", NOW)).toBe(true)
    expect(titleNamesMonth("2026-11 sprint", NOW)).toBe(true)
    expect(pickCurrentMilestone([{ id: 1, title: "November 2025" }, { id: 2, title: "November 2026" }], NOW)?.id).toBe(2)
  })
  it("a milestone whose dates do not hold today and whose title names another month is not taken", () => {
    expect(pickCurrentMilestone([{ id: 3, title: "October 2026", start_date: "2026-10-01", due_date: "2026-10-31" }], NOW)).toBeNull()
  })
})

describe("checkIssueCreate", () => {
  const base = { project: "acme/widgets", host: HOST, token: "t", now: NOW, agentId: "coder-agent" }

  it("C1: no milestone given → the month's is filled and logged fixed", async () => {
    const events: GateEvent[] = []
    const v = await checkIssueCreate({ ...base, mode: "enforce", description: COMPLETE, fetchFn: milestonesFetch([projectNov]), record: (e) => events.push(e) })
    expect(v).toEqual({ milestone: "11" })
    expect(events.map((e) => e.outcome)).toEqual(["fixed"])
    expect(events[0].reason).toContain("November 2026")
  })

  it("C1: an explicit milestone is logged allow and sent unchanged", async () => {
    const events: GateEvent[] = []
    const fetchFn = milestonesFetch([projectNov])
    const v = await checkIssueCreate({ ...base, mode: "enforce", description: COMPLETE, milestone: "42", fetchFn, record: (e) => events.push(e) })
    expect(v).toEqual({ milestone: "42" })
    expect(events.map((e) => e.outcome)).toEqual(["allow"])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("P2: enforce refuses a body with no estimate, naming it", async () => {
    const events: GateEvent[] = []
    const v = await checkIssueCreate({ ...base, mode: "enforce", description: "- [ ] x", milestone: "42", record: (e) => events.push(e) })
    expect(v.refuse).toMatch(/missing: \/estimate/)
    expect(events[0]).toMatchObject({ outcome: "refused", reason: "missing: /estimate" })
  })

  it("P3: shadow logs would-refuse and lets the create go on", async () => {
    const events: GateEvent[] = []
    const v = await checkIssueCreate({ ...base, mode: "shadow", description: "raw client text", fetchFn: milestonesFetch([projectNov]), record: (e) => events.push(e) })
    expect(v.refuse).toBeUndefined()
    expect(v.milestone).toBe("11")
    expect(events[0]).toMatchObject({ outcome: "would-refuse", reason: "missing: /estimate, checklist" })
  })

  it("P4: off runs no check and writes no row", async () => {
    const events: GateEvent[] = []
    const v = await checkIssueCreate({ ...base, mode: "off", description: "", record: (e) => events.push(e) })
    expect(v).toEqual({ milestone: undefined })
    expect(events).toEqual([])
  })

  it("P5: no month's milestone found: shadow creates without one, enforce refuses naming the project", async () => {
    const events: GateEvent[] = []
    const shadow = await checkIssueCreate({ ...base, mode: "shadow", description: COMPLETE, fetchFn: milestonesFetch([]), record: (e) => events.push(e) })
    expect(shadow).toEqual({ milestone: undefined })
    expect(events[0].reason).toBe("missing: milestone (no current milestone in acme/widgets)")
    const enforce = await checkIssueCreate({ ...base, mode: "enforce", description: COMPLETE, fetchFn: milestonesFetch({ status: 500 }), record: (e) => events.push(e) })
    expect(enforce.refuse).toMatch(/milestone lookup returned 500/)
  })

  it("milestone none is a logged override, allowed under enforce", async () => {
    const events: GateEvent[] = []
    const v = await checkIssueCreate({ ...base, mode: "enforce", description: COMPLETE, milestone: "none", record: (e) => events.push(e) })
    expect(v).toEqual({ milestone: undefined })
    expect(events[0]).toMatchObject({ outcome: "allow", reason: "override: milestone none" })
  })

  it("never puts the description into the log row", async () => {
    const events: GateEvent[] = []
    await checkIssueCreate({ ...base, mode: "shadow", description: "secret client words", milestone: "1", record: (e) => events.push(e) })
    expect(JSON.stringify(events)).not.toContain("secret client words")
  })
})

// End to end through the real adapter, a fake GitLab and a real gate log.
describe("GitLabAdapter.createIssue with the gate", () => {
  let dir: string
  let posts: URLSearchParams[]

  beforeEach(() => {
    closeDb()
    dir = mkdtempSync(join(tmpdir(), "gates-g1-"))
    openDb({ path: join(dir, "db.sqlite") })
    posts = []
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW)
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      if (url.includes("/milestones?")) return { ok: true, status: 200, json: async () => [projectNov] }
      if (url.includes("/issues?state=opened")) return { ok: true, status: 200, json: async () => [] }
      if (init?.method === "POST" && url.endsWith("/issues")) {
        posts.push(new URLSearchParams(String(init.body)))
        return { ok: true, status: 201, json: async () => ({ iid: 77, web_url: `${HOST}/acme/widgets/-/issues/77` }) }
      }
      return { ok: false, status: 404, text: async () => "", json: async () => ({}) }
    }))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    closeDb()
    rmSync(dir, { recursive: true, force: true })
    resetMessageRouterForTesting()
    _resetBuiltinsForTesting()
  })

  const adapter = (mode?: "off" | "shadow" | "enforce") =>
    new GitLabAdapter({ host: HOST, token: "g", webhookPort: 0, routes: [], gates: mode ? { issueComplete: { adapter: mode } } : undefined } as any, () => {})

  const rows = () => gateEventsSince(openDb()!, "issue-complete", 0)

  it("default shadow: an old-style call is created and logged would-refuse, with the month's milestone_id", async () => {
    const out = await adapter().createIssue({ project: "acme/widgets", title: "T", description: "raw" })
    expect(out?.iid).toBe(77)
    expect(posts[0].get("milestone_id")).toBe("11")
    expect(rows()[0]).toMatchObject({ outcome: "would-refuse", ruleId: "every-new-issue-is-complete-when-it-is-created" })
  })

  it("enforce refuses before any POST, with the reason", async () => {
    await expect(adapter("enforce").createIssue({ project: "acme/widgets", title: "T", description: "raw", milestone: "5" }))
      .rejects.toThrow(/missing: \/estimate, checklist/)
    expect(posts).toHaveLength(0)
    expect(rows()[0].outcome).toBe("refused")
  })

  it("P14 (with C1): channel.create_issue with no milestone sends the month's id and logs fixed; an explicit one is sent unchanged and logs allow", async () => {
    const gl = adapter("enforce")
    setMessageRouter({ getChannel: (n: string) => (n === "gitlab" ? gl : undefined) } as any)
    registerAllBuiltins()
    await runBuiltin("channel.create_issue", { channel: "gitlab", project: "acme/widgets", title: "Test case A", description: COMPLETE })
    expect(posts[0].get("milestone_id")).toBe("11")
    expect(rows()[0].outcome).toBe("fixed")

    await runBuiltin("channel.create_issue", { channel: "gitlab", project: "acme/widgets", title: "Test case B", description: COMPLETE, milestone: "9" })
    expect(posts[1].get("milestone_id")).toBe("9")
    expect(rows()[0].outcome).toBe("allow")
  })

  it("P12a: a peer forward carries the milestone; no lookup is made without a local token", async () => {
    const gl = new GitLabAdapter({ host: HOST, token: "", webhookPort: 0, routes: [], agentMappings: [{ agentId: "far", node: "peer-b", gitlabUsernames: [] }] } as any, () => {})
    const fwd = vi.fn(async () => ({ iid: 3, url: "u" }))
    gl.setCreateIssueForwarder(fwd)
    await gl.createIssue({ project: "acme/widgets", title: "T", description: COMPLETE, agentId: "far" })
    expect(fwd).toHaveBeenCalledWith("peer-b", "acme/widgets", "T", COMPLETE, [], [], "far", "current")
    expect((globalThis.fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("/milestones"))).toBe(false)
  })

  it("P12b: an agent with no local token and no forwarder falls through to the global token and still sends milestone_id", async () => {
    const gl = new GitLabAdapter({ host: HOST, token: "g", webhookPort: 0, routes: [], agentMappings: [{ agentId: "far", node: "peer-b", gitlabUsernames: [] }] } as any, () => {})
    await gl.createIssue({ project: "acme/widgets", title: "T", description: COMPLETE, agentId: "far" })
    expect(posts[0].get("milestone_id")).toBe("11")
  })
})
