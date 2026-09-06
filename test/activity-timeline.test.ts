import { describe, expect, it } from "vitest"
import { buildTimeline, computeBands, type TimelineRun } from "../src/daemon/activity-timeline"
import { ACTIVITY_SCRIPT, renderActivityPage } from "../src/daemon/ui/pages/activity"
import { injectFns } from "../src/daemon/ui/inject"
import { packTracks } from "../src/daemon/activity-timeline"

const T = Date.UTC(2026, 8, 5, 23, 0)
const MIN = 60_000
const run = (id: string, lane: string, atMin: number, durSec = 60, status = "ok"): TimelineRun =>
  ({ id, laneKey: lane, laneLabel: lane, startedAt: T + atMin * MIN, durationMs: durSec * 1000, status })

describe("activity timeline", () => {
  it("breaks the axis on real silence and labels it instead of drawing it", () => {
    // The real shape of that night: a burst before midnight, three hours of
    // nothing, then a CI storm.
    const runs = [
      run("a", "atlas", 38), run("b", "atlas", 45), run("c", "atlas", 48),
      run("d", "atlas", 320), run("e", "atlas", 322), run("f", "atlas", 323),
    ]
    const { bands, gaps } = computeBands(runs)
    expect(bands).toHaveLength(2)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toBeGreaterThan(4 * 60 * MIN)
    // Both bursts hold three runs, so neither is squeezed by the other.
    expect(bands[0].weight).toBeCloseTo(0.5)
    expect(bands[1].weight).toBeCloseTo(0.5)
  })

  it("gives a dense burst more width than a long thin one", () => {
    const runs = [
      run("x", "a", 0, 3600),                                   // one hour-long run
      ...Array.from({ length: 9 }, (_, i) => run("y" + i, "a", 300 + i)), // nine in nine minutes
    ]
    const { bands } = computeBands(runs)
    expect(bands).toHaveLength(2)
    expect(bands[1].weight).toBeGreaterThan(bands[0].weight)
  })

  it("stacks concurrent runs so a duplicate dispatch is visible", () => {
    // The real defect: hasanah-coding ran twice on #96 at once.
    const t = buildTimeline([
      run("first", "hasanah-coding", 0, 600),
      run("second", "hasanah-coding", 5, 120),
      run("later", "hasanah-coding", 20, 60),
    ])
    const lane = t.lanes[0]
    expect(lane.tracks).toBe(2)
    expect(lane.runs.find(r => r.id === "first")!.track).toBe(0)
    expect(lane.runs.find(r => r.id === "second")!.track).toBe(1)
    // The third starts after both finish, so it reuses the first track.
    expect(lane.runs.find(r => r.id === "later")!.track).toBe(0)
  })

  it("keeps a zero-duration cancel visible instead of drawing nothing", () => {
    const t = buildTimeline([{ id: "c", laneKey: "a", laneLabel: "a", startedAt: T, durationMs: 0, status: "canceled" }])
    expect(t.lanes[0].runs[0].width).toBeGreaterThan(0)
  })

  it("hangs review findings on the run that produced them", () => {
    const t = buildTimeline(
      [run("r1", "atlas", 0), run("r2", "atlas", 30)],
      [{ runId: "r2", kind: "warning", text: "PAT in plaintext" }],
    )
    const runs = t.lanes[0].runs
    expect(runs.find(r => r.id === "r1")!.marks).toEqual([])
    expect(runs.find(r => r.id === "r2")!.marks[0]).toMatchObject({ kind: "warning" })
  })

  it("never draws more bands than it can label", () => {
    const runs = Array.from({ length: 30 }, (_, i) => run("r" + i, "a", i * 120))
    const { bands, gaps } = computeBands(runs, 20 * MIN, 6)
    expect(bands.length).toBeLessThanOrEqual(6)
    expect(gaps).toHaveLength(bands.length - 1)
  })

  it("returns an empty timeline rather than throwing when nothing ran", () => {
    expect(buildTimeline([])).toMatchObject({ bands: [], lanes: [], gaps: [] })
  })

  it("ships a page whose perspective switch re-lanes without refetching", () => {
    const html = renderActivityPage()
    for (const p of ["Agent", "Client", "Project", "Channel", "Node"]) expect(html).toContain(p)
    // buildTimeline calls computeBands, so both have to travel to the browser.
    expect(html).toContain("function buildTimeline")
    expect(html).toContain("function computeBands")
    // Changing lanes must not hit the network — only render() runs.
    expect(ACTIVITY_SCRIPT).toContain("persp=b.dataset.value;paint('persp',persp);selected=null;render();")
    expect(() => new Function(ACTIVITY_SCRIPT)).not.toThrow()
  })

  it("travels to the browser with every helper it calls", () => {
    // new Function() has no lexical access to this module, so any dependency
    // left out of the injection is an immediate ReferenceError here — which
    // is exactly how it fails in the browser, minified or not.
    const src = injectFns({ computeBands, packTracks, buildTimeline })
    const out = new Function(src + `return buildTimeline([
      {id:"a",laneKey:"x",laneLabel:"x",startedAt:1000,durationMs:500,status:"ok"},
      {id:"b",laneKey:"x",laneLabel:"x",startedAt:1200,durationMs:500,status:"ok"}
    ]).lanes[0].tracks`)()
    expect(out).toBe(2)
  })
})
