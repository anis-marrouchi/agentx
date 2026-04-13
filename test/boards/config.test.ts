import { describe, it, expect } from "vitest"
import { deriveStage, transitionDiff, DEFAULT_COLUMNS, boardSchema } from "../../src/boards/config"

describe("deriveStage (GitLab-style default columns)", () => {
  it("sends opened items with no Status:: label to the open-backlog column", () => {
    expect(deriveStage({ state: "opened", labels: [] }, DEFAULT_COLUMNS)).toBe("open")
    expect(deriveStage({ state: "opened", labels: ["bug", "priority:p1"] }, DEFAULT_COLUMNS)).toBe("open")
  })

  it("drops items with an unclaimed Status:: scoped label (off-board workflow state)", () => {
    expect(deriveStage({ state: "opened", labels: ["Status::Done"] }, DEFAULT_COLUMNS)).toBeNull()
    expect(deriveStage({ state: "opened", labels: ["Status::Blocked", "bug"] }, DEFAULT_COLUMNS)).toBeNull()
  })

  it("routes scoped Status:: labels to the matching column", () => {
    expect(deriveStage({ state: "opened", labels: ["Status::To Do"] }, DEFAULT_COLUMNS)).toBe("todo")
    expect(deriveStage({ state: "opened", labels: ["Status::Doing"] }, DEFAULT_COLUMNS)).toBe("doing")
    expect(deriveStage({ state: "opened", labels: ["Status::Review"] }, DEFAULT_COLUMNS)).toBe("review")
    expect(deriveStage({ state: "opened", labels: ["Status::On Hold"] }, DEFAULT_COLUMNS)).toBe("onhold")
  })

  it("always sends closed items to the closed column, regardless of labels", () => {
    expect(deriveStage({ state: "closed", labels: ["Status::Doing"] }, DEFAULT_COLUMNS)).toBe("closed")
    expect(deriveStage({ state: "closed", labels: [] }, DEFAULT_COLUMNS)).toBe("closed")
  })

  it("honors custom column mixes (label kind)", () => {
    const cols = [
      { id: "backlog", title: "Backlog", kind: "open-backlog" as const, scopedPrefix: "Status" },
      { id: "active",  title: "Active",  kind: "label" as const, scopedPrefix: "Status", mapsToLabel: "Active" },
      { id: "done",    title: "Done",    kind: "label" as const, scopedPrefix: "Status", mapsToLabel: "Shipped" },
    ]
    expect(deriveStage({ state: "opened", labels: ["Active"] }, cols)).toBe("active")
    expect(deriveStage({ state: "opened", labels: ["Shipped"] }, cols)).toBe("done")
    expect(deriveStage({ state: "opened", labels: ["unrelated"] }, cols)).toBe("backlog")
  })
})

describe("transitionDiff", () => {
  const cols = DEFAULT_COLUMNS
  const open   = cols.find(c => c.id === "open")!
  const todo   = cols.find(c => c.id === "todo")!
  const doing  = cols.find(c => c.id === "doing")!
  const review = cols.find(c => c.id === "review")!
  const closed = cols.find(c => c.id === "closed")!

  it("adds target scoped label and removes source scoped label", () => {
    expect(transitionDiff(todo, doing)).toEqual({
      addLabels: ["Status::Doing"], removeLabels: ["Status::To Do"],
    })
    expect(transitionDiff(doing, review)).toEqual({
      addLabels: ["Status::Review"], removeLabels: ["Status::Doing"],
    })
  })

  it("adds scoped label only when source is the open backlog (no label to remove)", () => {
    expect(transitionDiff(open, doing)).toEqual({
      addLabels: ["Status::Doing"],
    })
  })

  it("strips source scoped label when moving back to the open backlog", () => {
    expect(transitionDiff(doing, open)).toEqual({
      removeLabels: ["Status::Doing"],
    })
  })

  it("closes the issue when moving into the closed column", () => {
    expect(transitionDiff(doing, closed)).toEqual({
      removeLabels: ["Status::Doing"],
      closeIssue: true,
    })
  })

  it("reopens the issue when moving out of the closed column", () => {
    expect(transitionDiff(closed, doing)).toEqual({
      addLabels: ["Status::Doing"],
      reopen: true,
    })
  })
})

describe("boardSchema validation", () => {
  it("accepts a minimal gitlab board and applies GitLab-style default columns", () => {
    const parsed = boardSchema.parse({
      id: "mtgl-main",
      name: "MTGL Engineering",
      source: { type: "gitlab", projects: ["mtgl/mtgl-system-v2"] },
    })
    expect(parsed.columns).toHaveLength(6)
    expect(parsed.columns[0].id).toBe("open")
    expect(parsed.columns[0].kind).toBe("open-backlog")
    expect(parsed.columns.at(-1)!.kind).toBe("closed")
    expect(parsed.timeRangeDays).toBe(30)
    expect(parsed.closedWindowDays).toBe(30)
  })

  it("rejects boards with non-slug ids", () => {
    expect(() => boardSchema.parse({
      id: "MTGL Main", name: "bad",
      source: { type: "gitlab", projects: ["x/y"] },
    })).toThrow(/lowercase slug/i)
  })

  it("rejects gitlab sources with no projects", () => {
    expect(() => boardSchema.parse({
      id: "bad", name: "bad",
      source: { type: "gitlab", projects: [] },
    })).toThrow()
  })

  it("accepts a single-column board (no length lock)", () => {
    const parsed = boardSchema.parse({
      id: "tiny", name: "tiny",
      source: { type: "gitlab", projects: ["x/y"] },
      columns: [{ id: "all", title: "All", kind: "open-backlog" }],
    })
    expect(parsed.columns).toHaveLength(1)
  })
})
