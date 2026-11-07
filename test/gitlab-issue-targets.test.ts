import { describe, it, expect } from "vitest"
import { computeIssueTargets, describeIssueChange, type IssueTargetEvent } from "../src/channels/gitlab-issue-targets"

// noqta/noqta#532: only a real start (open, new agent assignee, new mention)
// wakes an agent; milestone/label/time/estimate edits wake nobody.

const agents = new Map([["coder_bot", "coder"], ["devops_bot", "devops"], ["qa_bot", "qa"]])
const hakim = { name: "Hakim", username: "noqta_pm_bot" }

function ev(action: string, extra: Partial<IssueTargetEvent> = {}): IssueTargetEvent {
  return {
    user: hakim,
    object_attributes: { action, description: "Spec. cc @qa_bot" },
    assignees: [{ username: "coder_bot" }],
    ...extra,
  }
}

describe("computeIssueTargets (#532)", () => {
  it.each([
    ["time log", { total_time_spent: { previous: 0, current: 120 }, time_change: { previous: 0, current: 120 } }],
    ["milestone", { milestone_id: { previous: null, current: 4 } }],
    ["labels", { labels: { previous: [{ title: "To Do" }], current: [{ title: "Doing" }] } }],
    ["estimate", { time_estimate: { previous: 0, current: 3600 } }],
  ])("%s only on an agent-assigned issue → no dispatch, default route included", (_name, changes) => {
    const e = ev("update", { changes: { ...changes, updated_at: { previous: "a", current: "b" } } })
    expect(computeIssueTargets(e, agents, "atlas")).toEqual([])
  })

  it("close or reopen without a new assignee or mention → no dispatch", () => {
    expect(computeIssueTargets(ev("close"), agents, "atlas")).toEqual([])
    expect(computeIssueTargets(ev("reopen"), agents, "atlas")).toEqual([])
  })

  it("a newly assigned agent starts; agents already assigned do not", () => {
    const e = ev("update", {
      assignees: [{ username: "coder_bot" }, { username: "devops_bot" }],
      changes: { assignees: { previous: [{ username: "coder_bot" }], current: [{ username: "coder_bot" }, { username: "devops_bot" }] } },
    })
    expect(computeIssueTargets(e, agents, "atlas")).toEqual([{ agentId: "devops", trigger: "assignee-added" }])
  })

  it("an issue created with an agent assignee starts that agent (and description mentions)", () => {
    expect(computeIssueTargets(ev("open"), agents, "atlas")).toEqual([
      { agentId: "qa", trigger: "mention" },
    ])
    const noMention = ev("open", { object_attributes: { action: "open", description: "Spec" } })
    expect(computeIssueTargets(noMention, agents, "atlas")).toEqual([{ agentId: "coder", trigger: "assignee-current" }])
  })

  it("a description edit that adds an agent mention starts it; a kept mention starts none", () => {
    const added = ev("update", { changes: { description: { previous: "Spec. cc @qa_bot", current: "Spec. cc @qa_bot @devops_bot" } } })
    expect(computeIssueTargets(added, agents, "atlas")).toEqual([{ agentId: "devops", trigger: "mention" }])
    const kept = ev("update", { changes: { description: { previous: "cc @qa_bot", current: "cc @qa_bot, typo fixed" } } })
    expect(computeIssueTargets(kept, agents, "atlas")).toEqual([])
  })

  it("default route fires on open when nobody else is found, not on update", () => {
    const plain = { object_attributes: { action: "open", description: "x" }, assignees: [] }
    expect(computeIssueTargets(ev("open", plain), agents, "atlas")).toEqual([{ agentId: "atlas", trigger: "default-route" }])
    expect(computeIssueTargets(ev("update", { ...plain, object_attributes: { action: "update", description: "x" }, changes: { title: { previous: "a", current: "b" } } }), agents, "atlas")).toEqual([])
  })
})

describe("describeIssueChange (#532)", () => {
  it("names the changed fields and who changed them", () => {
    const e = ev("update", { changes: { milestone_id: {}, labels: {}, total_time_spent: {}, time_change: {}, updated_at: {} } })
    expect(describeIssueChange(e)).toBe("Change: milestone, labels, time spent updated by Hakim (@noqta_pm_bot)")
  })

  it("names open and assignment", () => {
    expect(describeIssueChange(ev("open"))).toBe("Change: opened by Hakim (@noqta_pm_bot)")
    expect(describeIssueChange(ev("update", { changes: { assignees: {} } }))).toBe("Change: assignees updated by Hakim (@noqta_pm_bot)")
  })
})
