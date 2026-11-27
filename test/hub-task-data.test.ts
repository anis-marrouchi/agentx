import { describe, expect, it } from "vitest"
import {
  allAgents, closeCall, closeConfirmText, foldEvents, hm, isOpen, liveRunOf, mentionedAgents, mentionText, nodeAgents, oldRunHref,
  planCount, proofOf, shortAgo, stateWord, stepState, taskAddress, taskFacts, taskFlags, taskLinks, taskPageHref, taskRead,
  taskStages, taskThreadPath, waitReason, waitsOn, type TaskEvent, type TaskPlanStep, type TaskPost,
} from "../src/hub/task/task-data"

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0)
const post = (over: Partial<TaskPost> = {}): TaskPost => ({
  id: "req-1", state: "in_progress", headline: "Relaunch the demo shop", owner: "coder", createdAt: NOW - 2 * 3600_000, ...over,
})
const step = (over: Partial<TaskPlanStep> = {}): TaskPlanStep => ({
  idx: 0, name: "Build", agentId: "coder", state: "pending", doneWhen: "PR open", evidence: null, note: null, updatedAt: NOW, ...over,
})

describe("task address", () => {
  it("reads id, task, peer and run, and builds the page's address", () => {
    const a = taskAddress(new URLSearchParams("page=task-preview&id=req-1&peer=http%3A%2F%2Fpeer&run=t9"))
    expect(a).toEqual({ id: "req-1", task: null, peer: "http://peer", run: "t9" })
    expect(taskPageHref("req-1")).toBe("#page=task-preview&id=req-1")
    expect(taskPageHref("req 1", { peer: "http://p" })).toBe("#page=task-preview&id=req+1&peer=http%3A%2F%2Fp")
  })
  it("reads the request by id first, then by run, else nothing", () => {
    expect(taskThreadPath({ id: "a/b", task: "t" })).toBe("/api/admin/wall/thread?id=a%2Fb")
    expect(taskThreadPath({ id: null, task: "t1" })).toBe("/api/admin/wall/thread?task=t1")
    expect(taskThreadPath({ id: null, task: null })).toBeNull()
  })
})

describe("taskRead", () => {
  it("is null without a request", () => {
    expect(taskRead(null, null)).toBeNull()
    expect(taskRead({ post: null }, null)).toBeNull()
  })
  it("names the node and fills missing lists", () => {
    const r = taskRead({ node: "mini", post: post() }, "http://peer")!
    expect(r.post.node).toEqual({ name: "mini", peer: "http://peer" })
    expect(r.events).toEqual([])
    expect(r.plan).toEqual([])
  })
})

describe("where it stands", () => {
  it("stands at Asked while open and never run", () => {
    const s = taskStages(post(), [], NOW)
    expect(s.map((x) => [x.name, x.mark])).toEqual([["Asked", "now"], ["Working", "todo"], ["Done", "todo"]])
    expect(s[0].detail).toBe("2h ago")
    expect(s[1].detail).toBe("not picked up yet")
  })
  it("works once it ran, with the estimate on Done", () => {
    const s = taskStages(post({ runs: 2, runMs: 30 * 60_000, estimateMinutes: 80 }), [], NOW)
    expect(s.map((x) => x.mark)).toEqual(["done", "now", "todo"])
    expect(s[1].detail).toBe("2 runs, 30 min")
    expect(s[2].detail).toBe("estimate 1 h 20 min")
  })
  it("adds Waits only while it waits, naming who", () => {
    const blocked = post({ runs: 1, blocked: { who: "@reviewer", why: "needs a review", since: NOW - 3 * 60_000 } })
    const s = taskStages(blocked, [], NOW)
    expect(s.map((x) => x.name)).toEqual(["Asked", "Working", "Waits", "Done"])
    expect(s[2]).toEqual({ name: "Waits", detail: "on @reviewer for 3m", mark: "wait" })
    expect(waitReason(blocked)).toBe("Waits on @reviewer: needs a review")
    expect(waitsOn(post({ state: "waiting_owner" }), [])).toBe("you")
    expect(waitsOn(post({ state: "waiting_other" }), [step({ state: "active", agentId: "qa" })])).toBe("@qa")
    expect(waitsOn(post({ state: "waiting_other" }), [])).toBe("another agent")
  })
  it("ends Done, or with the closed state's word", () => {
    const done = taskStages(post({ state: "done", runs: 1, closedAt: NOW - 60_000 }), [], NOW)
    expect(done[done.length - 1]).toEqual({ name: "Done", detail: "1m ago", mark: "done" })
    const dropped = taskStages(post({ state: "dropped" }), [], NOW)
    expect(dropped[dropped.length - 1].name).toBe("Dropped")
    expect(dropped[dropped.length - 1].mark).toBe("end")
    expect(waitReason(post({ state: "done", blocked: { who: "x", why: "y", since: 0 } }))).toBe("")
  })
  it("says why it waits: the owner's card first, then a forge that closed it", () => {
    const card = { id: "c1", title: "Pick a name", ask: "", recommend: "", silence: "", expiresAt: 0, raisedBy: "coder", createdAt: NOW, source: null, choices: [], draft: null }
    expect(waitReason(post({ ownerCards: [card] }))).toBe("Waits on you: Pick a name")
    expect(waitReason(post({ state: "waiting_owner" }))).toBe("Waits on you")
    expect(waitReason(post({ forgeState: { provider: "gitlab", state: "closed", mismatch: "forge-closed" } }))).toBe("GitLab says closed. Do not pick it up.")
    expect(waitReason(post())).toBe("")
    expect([isOpen("needs_attention"), isOpen("done"), isOpen("dropped")]).toEqual([true, false, false])
  })
  it("says states and times in words", () => {
    expect(stateWord("waiting_owner")).toBe("Waiting on you")
    expect(stateWord("on_hold")).toBe("On hold")
    expect(hm(45)).toBe("45 min")
    expect(hm(120)).toBe("2 h")
    expect(shortAgo(NOW - 30_000, NOW)).toBe("now")
    expect(shortAgo(NOW - 3 * 86400_000, NOW)).toBe("3d")
  })
})

describe("the plan", () => {
  it("maps step states to the one state set and counts skipped as done", () => {
    expect(stepState("active")).toEqual({ icon: "loader-circle", word: "Working", tone: "work" })
    expect(stepState("whatever").word).toBe("Not started")
    expect(planCount([step({ state: "done" }), step({ state: "skipped" }), step()])).toEqual({ done: 2, total: 3 })
  })
  it("opens a web proof and shows any other as text", () => {
    expect(proofOf("https://x/pr/1")).toEqual({ href: "https://x/pr/1", text: "Proof" })
    expect(proofOf("commit abc")).toEqual({ href: null, text: "commit abc" })
    expect(proofOf(null)).toBeNull()
  })
})

describe("facts, flags and links", () => {
  it("lists only the facts there are, always the times and the id", () => {
    const f = taskFacts(post({ askedBy: "Dana", group: { channel: "telegram", chatId: "42" }, project: "shop", estimateMinutes: 60, runMs: 600_000 }))
    expect(f.map((x) => x.label)).toEqual(["Asked by", "Chat", "Project", "Opened", "Time", "Request"])
    expect(f.find((x) => x.label === "Time")!.value).toBe("10 min of runs against 1 h")
    expect(f.find((x) => x.label === "Opened")!.at).toBe(NOW - 2 * 3600_000)
    expect(taskFacts(post()).find((x) => x.label === "Time")!.value).toBe("No runs yet")
  })
  it("words the loop check", () => {
    const f = taskFacts(post({ loop: { check: "PR merged", verifyState: "failed", verifyDetail: "still open" } }))
    expect(f.find((x) => x.label === "Closes when")!.value).toBe("PR merged (check not met: still open)")
  })
  it("flags time and a forge that disagrees", () => {
    expect(taskFlags(post({ timeFlag: "over the estimate" }))).toEqual(["Time: over the estimate"])
    expect(taskFlags(post({ forgeState: { provider: "github", state: "closed", mismatch: "forge-closed", closedBy: "dana" } }))[0])
      .toBe("GitHub says closed by dana, but this request is still open. Do not pick it up.")
    expect(taskFlags(post({ state: "done", forgeState: { provider: "gitlab", state: "opened", mismatch: "forge-open" } }))[0])
      .toBe("GitLab says open, but this request is done. Close it there or reopen it here.")
  })
  it("links home, proof and up to three web comments", () => {
    const l = taskLinks(post({
      home: { kind: "issue", link: "https://github.com/o/r/issues/1" }, evidence: "tests pass",
      comments: [1, 2, 3, 4].map((i) => ({ url: "https://c/" + i, at: NOW, agentId: "coder" })),
    }))
    expect(l.map((x) => [x.kind, x.label, x.href])).toEqual([
      ["home", "github.com/o/r/issues/1", "https://github.com/o/r/issues/1"],
      ["proof", "Proof: tests pass", null],
      ["comment", "Comment by coder", "https://c/1"], ["comment", "Comment by coder", "https://c/2"], ["comment", "Comment by coder", "https://c/3"],
    ])
    expect(oldRunHref("t1", "coder", "http://n")).toBe("#page=task&task=t1&agent=coder&node=http%3A%2F%2Fn")
  })
})

describe("the thread", () => {
  it("folds repeats in a row into one line with a count", () => {
    const e = (text: string, at: number): TaskEvent => ({ at, kind: "run", who: "coder", text, status: "ok" })
    const f = foldEvents([e("ran", 1), e("ran", 2), e("other", 3), e("ran", 4)])
    expect(f.map((x) => [x.event.text, x.count])).toEqual([["ran", 2], ["other", 1], ["ran", 1]])
  })
})

describe("actions", () => {
  it("says what Hand off, Done and Drop do", () => {
    expect(closeConfirmText("handoff", "Ship", "QA", false)).toBe("Hand “Ship” to QA. It cannot be taken back.")
    expect(closeConfirmText("done", "Ship", "", true)).toBe("Close “Ship” as done. Your words above go with it. It cannot be taken back.")
    expect(closeConfirmText("drop", "Ship", "", false)).toBe("Drop “Ship”. It cannot be taken back.")
  })
  it("makes the old page's calls", () => {
    expect(closeCall("handoff", "r", "qa", "n")).toEqual({ path: "/api/admin/wall/request/handoff", body: { id: "r", agentId: "qa", note: "n" } })
    expect(closeCall("done", "r", "", "pr")).toEqual({ path: "/api/admin/wall/request/close", body: { id: "r", action: "done", evidence: "pr" } })
    expect(closeCall("drop", "r", "", "why")).toEqual({ path: "/api/admin/wall/request/close", body: { id: "r", action: "drop", reason: "why" } })
  })

  const live = {
    nodes: [
      { name: "here", url: "http://here", agents: [{ id: "coder", name: "Coder" }, { id: "qa", name: "Night Shift", runningTasks: [{ id: "t7" }] }] },
      { name: "far", url: "http://far", agents: [{ id: "coder" }, { id: "scout", name: "Scout" }] },
    ],
  }
  it("finds the agents of the node that keeps it, and every agent once", () => {
    expect(nodeAgents(live, { name: "here" }).map((a) => a.id)).toEqual(["coder", "qa"])
    expect(nodeAgents(live, { name: "far", peer: "http://far" }).map((a) => a.id)).toEqual(["coder", "scout"])
    expect(allAgents(live).map((a) => [a.id, a.peer])).toEqual([["coder", null], ["qa", null], ["scout", "http://far"]])
    expect(liveRunOf(live, "qa")).toEqual({ taskId: "t7", nodeUrl: "http://here" })
    expect(liveRunOf(live, "coder")).toBeNull()
  })
  it("finds @mentions by id or name, in order, at word boundaries, not the owner", () => {
    const agents = allAgents(live)
    expect(mentionedAgents("@scout and @night shift please, @coder", agents, "coder").map((a) => a.id)).toEqual(["scout", "qa"])
    expect(mentionedAgents("mail a@scout or @scouting", agents, "coder")).toEqual([])
    expect(mentionText("Hub", post(), "look")).toBe("The owner mentioned you in a comment on Hub post req-1 by @coder: \"Relaunch the demo shop\".\n\nTheir comment:\nlook")
  })
})
