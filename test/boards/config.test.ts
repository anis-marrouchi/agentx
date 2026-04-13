import { describe, it, expect } from "vitest"
import { deriveStage, transitionLabelDiff, DEFAULT_COLUMNS, boardSchema } from "../../src/boards/config"

describe("deriveStage", () => {
  it("returns triage when no labels match any column", () => {
    expect(deriveStage([], DEFAULT_COLUMNS)).toBe("triage")
    expect(deriveStage(undefined, DEFAULT_COLUMNS)).toBe("triage")
    expect(deriveStage(["bug", "priority:p1"], DEFAULT_COLUMNS)).toBe("triage")
  })

  it("maps a single matching label to its column id", () => {
    expect(deriveStage(["Doing"], DEFAULT_COLUMNS)).toBe("doing")
    expect(deriveStage(["Review"], DEFAULT_COLUMNS)).toBe("review")
    expect(deriveStage(["Done"], DEFAULT_COLUMNS)).toBe("done")
  })

  it("picks the later column when an item holds multiple stage labels", () => {
    // Items sometimes get left with stale labels — show them in the most-advanced column
    expect(deriveStage(["To Do", "Doing"], DEFAULT_COLUMNS)).toBe("doing")
    expect(deriveStage(["Doing", "Review"], DEFAULT_COLUMNS)).toBe("review")
    expect(deriveStage(["Doing", "Review", "Done"], DEFAULT_COLUMNS)).toBe("done")
  })

  it("honors custom column->label mappings", () => {
    const customColumns = [
      { id: "triage" as const, title: "Inbox", mapsToLabel: "Inbox" },
      { id: "todo"   as const, title: "Queued", mapsToLabel: "Queued" },
      { id: "doing"  as const, title: "Active", mapsToLabel: "Active" },
      { id: "onhold" as const, title: "Paused", mapsToLabel: "Paused" },
      { id: "review" as const, title: "QA",     mapsToLabel: "QA" },
      { id: "done"   as const, title: "Shipped", mapsToLabel: "Shipped" },
    ]
    expect(deriveStage(["Queued"], customColumns)).toBe("todo")
    expect(deriveStage(["Active"], customColumns)).toBe("doing")
    // Default-named labels should NOT match custom columns
    expect(deriveStage(["Doing"], customColumns)).toBe("triage")
  })
})

describe("transitionLabelDiff", () => {
  const cols = DEFAULT_COLUMNS
  const todo   = cols.find(c => c.id === "todo")!
  const doing  = cols.find(c => c.id === "doing")!
  const review = cols.find(c => c.id === "review")!

  it("adds to-label and removes from-label on a normal transition", () => {
    expect(transitionLabelDiff(todo, doing)).toEqual({ add: "Doing", remove: "To Do" })
    expect(transitionLabelDiff(doing, review)).toEqual({ add: "Review", remove: "Doing" })
  })

  it("omits remove when fromColumn is undefined (card entering the board)", () => {
    expect(transitionLabelDiff(undefined, doing)).toEqual({ add: "Doing", remove: undefined })
  })

  it("omits remove when from and to share the same mapsToLabel", () => {
    const synonym = { id: "review" as const, title: "Review", mapsToLabel: "Doing" }
    expect(transitionLabelDiff(doing, synonym)).toEqual({ add: "Doing", remove: undefined })
  })
})

describe("boardSchema validation", () => {
  it("accepts a minimal gitlab board and applies defaults", () => {
    const parsed = boardSchema.parse({
      id: "mtgl-main",
      name: "MTGL Engineering",
      source: { type: "gitlab", projects: ["mtgl/mtgl-system-v2"] },
    })
    expect(parsed.columns).toHaveLength(6)
    expect(parsed.columns[0].id).toBe("triage")
    expect(parsed.timeRangeDays).toBe(30)
    expect(parsed.reconciliation.staleDoingMinutes).toBe(45)
    expect(parsed.reconciliation.action).toBe("badge")
  })

  it("rejects boards with non-slug ids", () => {
    expect(() => boardSchema.parse({
      id: "MTGL Main",
      name: "bad",
      source: { type: "gitlab", projects: ["x/y"] },
    })).toThrow(/lowercase slug/i)
  })

  it("rejects gitlab sources with no projects", () => {
    expect(() => boardSchema.parse({
      id: "bad",
      name: "bad",
      source: { type: "gitlab", projects: [] },
    })).toThrow()
  })

  it("rejects column arrays that don't have exactly 6 entries", () => {
    expect(() => boardSchema.parse({
      id: "bad",
      name: "bad",
      source: { type: "gitlab", projects: ["x/y"] },
      columns: [
        { id: "triage", title: "Triage", mapsToLabel: "Triage" },
        { id: "done",   title: "Done",   mapsToLabel: "Done" },
      ],
    })).toThrow()
  })
})
