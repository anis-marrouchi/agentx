import { describe, expect, it } from "vitest"
import { startSizes, startSizeTable } from "../scripts/start-size-lib"

describe("start-size report (#2002)", () => {
  it("gives median, mean and p90 per agent, most starts first", () => {
    const rows = [
      ...[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((n) => ({ agent_id: "pm", start_tokens: n * 1000 })),
      { agent_id: "coo", start_tokens: 5000 },
    ]
    const [pm, coo] = startSizes(rows)
    expect(pm).toEqual({ agent: "pm", starts: 10, median: 50000, mean: 55000, p90: 90000 })
    expect(coo).toEqual({ agent: "coo", starts: 1, median: 5000, mean: 5000, p90: 5000 })
  })

  it("skips rows with no size", () => {
    expect(startSizes([{ agent_id: "a", start_tokens: null as never }])).toEqual([])
  })

  it("renders a table with one row per agent", () => {
    const md = startSizeTable(startSizes([{ agent_id: "a", start_tokens: 100 }]))
    expect(md.split("\n")).toHaveLength(3)
    expect(md).toContain("| a | 1 | 100 | 100 | 100 |")
  })
})
