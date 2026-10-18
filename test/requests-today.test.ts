import { describe, it, expect } from "vitest"
import { firstWords, startOfDay, todayRows } from "../src/requests/today"
import type { RequestRecord } from "../src/requests/store"

const at = Date.UTC(2026, 9, 18, 13, 25) // 14:25 in Tunis
const req = (id: string, extra: Partial<RequestRecord> & { links?: Array<{ kind: string; ref: string }> } = {}) =>
  ({ id, state: "in_progress", agentId: "secretary-agent", text: "build the chasing plan tonight please", createdAt: at, home: null, evidence: null, ...extra }) as any

describe("since this morning (#394)", () => {
  it("starts at 00:00 Tunis time", () => {
    expect(startOfDay(at)).toBe(Date.UTC(2026, 9, 17, 23, 0))
    expect(startOfDay(Date.UTC(2026, 9, 17, 23, 30))).toBe(Date.UTC(2026, 9, 17, 23, 0))
    expect(startOfDay(Date.UTC(2026, 9, 17, 22, 59))).toBe(Date.UTC(2026, 9, 16, 23, 0))
  })

  it("puts requests with no home first and says where the others landed", () => {
    const rows = todayRows([
      req("a", { links: [{ kind: "run", ref: "t1" }, { kind: "issue", ref: "https://x/i/1" }] }),
      req("b", { links: [{ kind: "run", ref: "t2" }, { kind: "delegation", ref: "d1" }] }),
      req("c", { state: "done", evidence: "https://x/pull/2" }),
      req("d", { home: { kind: "idea", link: "ideas/x.md" }, links: [{ kind: "idea", ref: "ideas/x.md" }] }),
      req("e", { state: "declined" }),
      req("f"),
      req("g"),
    ], { hasPlan: (id) => id === "g" })
    expect(rows.map((r) => [r.id, r.noHome])).toEqual([
      ["b", true], ["f", true], ["a", false], ["c", false], ["d", false], ["e", false], ["g", false],
    ])
    expect(rows.find((r) => r.id === "a")!.landed).toEqual([{ kind: "issue", ref: "https://x/i/1" }])
    expect(rows.find((r) => r.id === "d")!.landed).toEqual([{ kind: "idea", ref: "ideas/x.md" }])
    expect(rows.find((r) => r.id === "g")!.landed).toEqual([{ kind: "plan", ref: "g" }])
    expect(rows[0]).toMatchObject({ time: "14:25", owner: "secretary-agent", state: "in_progress" })
  })

  it("keeps the first words on one line", () => {
    expect(firstWords("one  two\nthree", 2)).toBe("one two …")
    expect(firstWords("short ask")).toBe("short ask")
  })
})
