import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import path from "path"
import { parseYamlWorkflow } from "../src/workflows/yaml"
import { workflowSchema, lintWorkflow } from "../src/workflows/types"
import { evaluateBranch } from "../src/workflows/engine"
// @ts-expect-error — plain .mjs script, no type declarations
import { planSweep, ciState, formatSteps, applyEdits } from "../scripts/owner-sweep.mjs"

const now = new Date("2026-09-25T12:00:00Z")
const minsAgo = (m: number) => new Date(now.getTime() - m * 60000).toISOString()
const check = (conclusion: string | null, status = "COMPLETED") => ({ __typename: "CheckRun", name: "test", status, conclusion, detailsUrl: "https://ci/1" })

// A PR that is fully set up: assigned, reviewed, linked, recently active.
function pr(over: Record<string, unknown> = {}) {
  return {
    number: 52, title: "clicky", url: "https://gh/pull/52", body: "", isDraft: true,
    headRefName: "51-clicky", headRefOid: "aaaaaaa1", assignees: [{ login: "anis-marrouchi" }],
    reviewRequests: [{ login: "anis-marrouchi" }], latestReviews: [], closingIssuesReferences: [{ number: 51 }],
    statusCheckRollup: [check("SUCCESS")], updatedAt: minsAgo(5), ...over,
  }
}
const steps = (r: { steps: Array<{ owner: string; step: string }> }) => r.steps.map((s) => `${s.owner} ${s.step}`)

describe("owner sweep (#53)", () => {
  it("re-dispatches a draft PR with red CI to its author — the dropped #52 case", () => {
    const r = planSweep({ issues: [], prs: [pr({ statusCheckRollup: [check("FAILURE")], updatedAt: minsAgo(90) })] }, {}, now)
    expect(steps(r)).toEqual(["coder-agent fix-ci", "secretary-agent nudge"])
    expect(r.steps[0].why).toContain("attempt 1/2")
    expect(r.steps[0].why).toContain("https://ci/1")
  })

  it("does not re-dispatch the same red commit on the next sweep", () => {
    const snap = { issues: [], prs: [pr({ statusCheckRollup: [check("FAILURE")] })] }
    const first = planSweep(snap, {}, now)
    const second = planSweep(snap, first.state, new Date(now.getTime() + 15 * 60000))
    expect(second.steps).toEqual([])
  })

  it("escalates to the coordinator after two red commits", () => {
    let state = {}
    for (const sha of ["s1", "s2"]) {
      const r = planSweep({ issues: [], prs: [pr({ headRefOid: sha, statusCheckRollup: [check("FAILURE")] })] }, state, now)
      expect(steps(r)).toEqual(["coder-agent fix-ci"])
      state = r.state
    }
    const r = planSweep({ issues: [], prs: [pr({ headRefOid: "s3", statusCheckRollup: [check("FAILURE")] })] }, state, now)
    expect(steps(r)).toEqual(["secretary-agent escalate-ci"])
  })

  it("routes to the agent named in the PR body marker", () => {
    const r = planSweep({ issues: [], prs: [pr({ body: "x\n<!-- agentx:pm-agent -->" })] }, {}, now)
    expect(steps(r)).toEqual(["pm-agent mark-ready"])
  })

  it("hands a ready green PR to the coordinator and does not call it stale", () => {
    const r = planSweep({ issues: [], prs: [pr({ isDraft: false, updatedAt: minsAgo(300) })] }, {}, now)
    expect(steps(r)).toEqual(["secretary-agent review-and-merge"])
  })

  it("gives a new PR an assignee, a reviewer and an issue link", () => {
    const fresh = pr({ assignees: [], reviewRequests: [], closingIssuesReferences: [], statusCheckRollup: [check(null, "IN_PROGRESS")] })
    expect(steps(planSweep({ issues: [], prs: [fresh] }, {}, now))).toEqual([
      "secretary-agent assign-owner", "secretary-agent request-review", "secretary-agent link-issue",
    ])
  })

  it("gives every unassigned issue an owner, and reminds after remindHours", () => {
    const issue = { number: 53, title: "owners", url: "https://gh/issues/53", assignees: [], labels: [], updatedAt: minsAgo(10) }
    const first = planSweep({ issues: [issue], prs: [] }, {}, now)
    expect(steps(first)).toEqual(["secretary-agent assign-owner"])
    expect(planSweep({ issues: [issue], prs: [] }, first.state, new Date(now.getTime() + 3600000)).steps).toEqual([])
    const later = planSweep({ issues: [issue], prs: [] }, first.state, new Date(now.getTime() + 25 * 3600000))
    expect(steps(later)).toEqual(["secretary-agent assign-owner"])
  })

  it("nudges a Doing issue that has gone quiet", () => {
    const issue = { number: 7, title: "t", url: "u", assignees: [{ login: "a" }], labels: [{ name: "Doing" }], updatedAt: minsAgo(45) }
    expect(steps(planSweep({ issues: [issue], prs: [] }, {}, now))).toEqual(["secretary-agent nudge"])
  })

  it("forgets closed items", () => {
    const r = planSweep({ issues: [], prs: [pr({ statusCheckRollup: [check("FAILURE")] })] }, {}, now)
    const after = planSweep({ issues: [], prs: [] }, r.state, now)
    expect(after.state).toEqual({ seen: {}, ciFixes: {} })
  })

  it("reads check runs and status contexts", () => {
    expect(ciState([]).state).toBe("none")
    expect(ciState([check(null, "QUEUED")]).state).toBe("pending")
    expect(ciState([{ __typename: "StatusContext", context: "ci/x", state: "ERROR", targetUrl: "t" }]).failing).toEqual([{ name: "ci/x", url: "t" }])
  })

  it("prints a verdict line the workflow branches on", () => {
    expect(formatSteps([])).toBe("RESULT steps=0")
  })
})

describe("owner sweep: applying ownership (#53 decisions)", () => {
  const opts = { assignee: "anis-marrouchi", owner: "coder-agent", reviewer: "devops-agent" }
  const issue = (over: Record<string, unknown> = {}) =>
    ({ number: 53, title: "owners", url: "u", body: "", assignees: [], labels: [], updatedAt: minsAgo(10), ...over })

  it("assigns the login and labels the default owner on a new issue, with no agent step", () => {
    const r = planSweep({ issues: [issue()], prs: [] }, {}, now, opts)
    expect(r.apply).toEqual([{ kind: "issue", number: 53, assignee: "anis-marrouchi", labels: ["agent:coder-agent"] }])
    expect(r.steps).toEqual([])
  })

  it("an issue marker picks the owner; only what is missing is applied", () => {
    const r = planSweep({ issues: [issue({ body: "x <!-- agentx:pm-agent -->", assignees: [{ login: "anis-marrouchi" }] })], prs: [] }, {}, now, opts)
    expect(r.apply).toEqual([{ kind: "issue", number: 53, labels: ["agent:pm-agent"] }])
    const owned = issue({ assignees: [{ login: "a" }], labels: [{ name: "agent:coder-agent" }] })
    expect(planSweep({ issues: [owned], prs: [] }, {}, now, opts).apply).toEqual([])
  })

  it("a new PR is owned by its author agent and reviewed by devops-agent", () => {
    const fresh = pr({ body: "<!-- agentx:coder-agent -->", assignees: [], reviewRequests: [], labels: [], statusCheckRollup: [check(null, "IN_PROGRESS")] })
    const r = planSweep({ issues: [], prs: [fresh] }, {}, now, opts)
    expect(r.apply).toEqual([
      { kind: "pr", number: 52, assignee: "anis-marrouchi", labels: ["agent:coder-agent"] },
      { kind: "pr", number: 52, labels: ["review:devops-agent"] },
    ])
    expect(steps(r)).toEqual(["devops-agent review"])
  })

  it("a PR already labelled for review is not reviewed again", () => {
    const labelled = pr({ reviewRequests: [], labels: [{ name: "agent:coder-agent" }, { name: "review:devops-agent" }] })
    const r = planSweep({ issues: [], prs: [labelled] }, {}, now, opts)
    expect(r.apply).toEqual([])
    expect(steps(r)).toEqual(["coder-agent mark-ready"])
  })

  it("applies each edit with gh, creating labels first, and reports failures per item", async () => {
    const calls: string[][] = []
    const run = async (args: string[]) => {
      calls.push(args)
      if (args[0] === "issue" && args[2] === "9") throw Object.assign(new Error("gone"), { code: 1 })
      return ""
    }
    const out = await applyEdits("o/r", [
      { kind: "issue", number: 53, assignee: "anis-marrouchi", labels: ["agent:coder-agent"] },
      { kind: "issue", number: 9, labels: ["agent:coder-agent"] },
      { kind: "pr", number: 52, labels: ["review:devops-agent"] },
    ], run)
    expect(calls.slice(0, 2).map((c) => c.slice(0, 3))).toEqual([["label", "create", "agent:coder-agent"], ["label", "create", "review:devops-agent"]])
    expect(calls).toContainEqual(["issue", "edit", "53", "-R", "o/r", "--add-assignee", "anis-marrouchi", "--add-label", "agent:coder-agent"])
    expect(calls).toContainEqual(["pr", "edit", "52", "-R", "o/r", "--add-label", "review:devops-agent"])
    expect(out.map((e: { result: string }) => e.result)).toEqual([
      "assigned anis-marrouchi, labelled agent:coder-agent",
      "failed to apply (1): labelled agent:coder-agent",
      "labelled review:devops-agent",
    ])
  })

  it("lists what was applied without counting it as work for the agent", () => {
    const text = formatSteps([], [{ kind: "issue", number: 53, labels: [], result: "assigned x" }])
    expect(text).toBe("RESULT steps=0 applied=1\n  applied issue #53: assigned x")
  })
})

describe("examples/workflows/github-owner-sweep", () => {
  const text = readFileSync(path.resolve(process.cwd(), "examples/workflows/github-owner-sweep.yaml"), "utf-8")
  const parsed = workflowSchema.safeParse(parseYamlWorkflow(text, { filePath: "github-owner-sweep.yaml" }))

  it("validates and lints clean", () => {
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(lintWorkflow(parsed.data)).toEqual([])
  })

  it("wakes the agent only when the sweep found steps", () => {
    if (!parsed.success) throw new Error("invalid workflow")
    const route = parsed.data.nodes.find((n) => n.id === "route")!
    const port = (output: string) => evaluateBranch(route, { sweep: { output } })
    expect(port("RESULT steps=0")).toBe("done")
    expect(port("RESULT steps=0 applied=2\n  applied issue #1: assigned x")).toBe("done")
    expect(port("RESULT error=collection (1)")).toBe("failed")
    expect(port("")).toBe("failed")
    expect(port("node: some crash")).toBe("failed")
    expect(port(formatSteps([{ owner: "coder-agent", step: "fix-ci", kind: "pr", number: 1, title: "t", url: "u", why: "w" }]))).toBe("act")
  })
})
