// --- Laying out a night of fleet activity ---------------------------------
//
// Two problems make a naive timeline useless here.
//
// The axis. Nine hours of wall clock hold maybe forty minutes of work in two
// or three bursts; drawn linearly, 90% of the width is empty and every burst
// is an unreadable smear. So the axis BREAKS: runs are clustered, each cluster
// gets its own scale weighted by how much happened in it, and the quiet gaps
// between clusters are labelled rather than drawn.
//
// Overlap. A lane is one agent, one client, one project — whatever the chosen
// perspective keys on — and those routinely run concurrently. Bars are packed
// into sub-tracks so a lane grows downward instead of drawing runs on top of
// each other. That packing is what makes duplicate dispatches visible at all.

export interface TimelineRun {
  id: string
  laneKey: string
  laneLabel: string
  laneSub?: string
  startedAt: number
  /** Missing or zero for runs that were canceled before doing anything. */
  durationMs?: number
  status: string
  label?: string
}

export interface TimelineMark {
  runId: string
  kind: "decision" | "warning" | "recommendation" | "later"
  text: string
}

export interface Band {
  from: number
  to: number
  /** Fraction of the drawable width this band gets, 0..1. */
  weight: number
  runs: number
}

export interface PlacedRun extends TimelineRun {
  band: number
  track: number
  /** Percentage offset and width WITHIN the band. */
  left: number
  width: number
  marks: TimelineMark[]
}

export interface Lane {
  key: string
  label: string
  sub?: string
  tracks: number
  runs: PlacedRun[]
}

export interface Timeline {
  bands: Band[]
  /** Silence between band i and i+1, in ms. gaps.length === bands.length - 1 */
  gaps: number[]
  lanes: Lane[]
  from: number
  to: number
}

/** Split runs into activity clusters. A gap only breaks the axis when it is
 *  both long in absolute terms and long relative to the work around it —
 *  otherwise a slow afternoon shatters into dozens of one-run bands. */
export function computeBands(runs: TimelineRun[], minGapMs = 20 * 60_000, maxBands = 6): { bands: Band[]; gaps: number[] } {
  const sorted = [...runs].sort((a, b) => a.startedAt - b.startedAt)
  if (!sorted.length) return { bands: [], gaps: [] }
  const clusters: Array<{ from: number; to: number; runs: number }> = []
  for (const r of sorted) {
    const end = r.startedAt + Math.max(r.durationMs || 0, 0)
    const last = clusters[clusters.length - 1]
    if (last && r.startedAt - last.to <= minGapMs) {
      last.to = Math.max(last.to, end)
      last.runs++
    } else {
      clusters.push({ from: r.startedAt, to: end, runs: 1 })
    }
  }
  // Too many clusters: repeatedly merge across the smallest gap.
  while (clusters.length > maxBands) {
    let at = 0, best = Infinity
    for (let i = 1; i < clusters.length; i++) {
      const gap = clusters[i].from - clusters[i - 1].to
      if (gap < best) { best = gap; at = i }
    }
    clusters[at - 1].to = clusters[at].to
    clusters[at - 1].runs += clusters[at].runs
    clusters.splice(at, 1)
  }
  // Width follows density, not duration: a burst of nine runs in four minutes
  // deserves more room than a single run spread over two hours.
  const total = clusters.reduce((s, c) => s + c.runs, 0) || 1
  const bands = clusters.map(c => ({ from: c.from, to: Math.max(c.to, c.from + 1), weight: c.runs / total, runs: c.runs }))
  const gaps = clusters.slice(1).map((c, i) => c.from - clusters[i].to)
  return { bands, gaps }
}

/** First-fit packing into sub-tracks. Concurrent runs in one lane stack.
 *  Exported because buildTimeline calls it and both travel to the browser. */
export function packTracks(runs: PlacedRun[]): number {
  const ends: number[] = []
  for (const r of runs.sort((a, b) => a.startedAt - b.startedAt)) {
    const end = r.startedAt + Math.max(r.durationMs || 0, 0)
    let t = ends.findIndex(e => e <= r.startedAt)
    if (t === -1) { t = ends.length; ends.push(end) } else { ends[t] = end }
    r.track = t
  }
  return Math.max(ends.length, 1)
}

export function buildTimeline(runs: TimelineRun[], marks: TimelineMark[] = [], minGapMs?: number): Timeline {
  const { bands, gaps } = computeBands(runs, minGapMs)
  if (!bands.length) return { bands: [], gaps: [], lanes: [], from: 0, to: 0 }
  const marksByRun = new Map<string, TimelineMark[]>()
  for (const m of marks) {
    const list = marksByRun.get(m.runId)
    if (list) list.push(m); else marksByRun.set(m.runId, [m])
  }
  const byLane = new Map<string, Lane>()
  for (const r of runs) {
    const band = bands.findIndex(b => r.startedAt >= b.from && r.startedAt <= b.to)
    if (band === -1) continue
    const b = bands[band]
    const span = b.to - b.from || 1
    const left = ((r.startedAt - b.from) / span) * 100
    // 1.2% floor, inlined rather than hoisted: this function is stringified and
    // shipped to the browser, where a module-scope constant would be unbound.
    const width = Math.min(Math.max(((r.durationMs || 0) / span) * 100, 1.2), 100 - left)
    const lane = byLane.get(r.laneKey) ?? { key: r.laneKey, label: r.laneLabel, sub: r.laneSub, tracks: 1, runs: [] }
    lane.runs.push({ ...r, band, track: 0, left, width, marks: marksByRun.get(r.id) ?? [] })
    byLane.set(r.laneKey, lane)
  }
  const lanes = [...byLane.values()]
  for (const lane of lanes) {
    // Pack per band so a lane idle in one burst does not inherit its tracks.
    lane.tracks = Math.max(...bands.map((_, i) => packTracks(lane.runs.filter(r => r.band === i))), 1)
  }
  lanes.sort((a, b) => b.runs.length - a.runs.length || a.label.localeCompare(b.label))
  return { bands, gaps, lanes, from: bands[0].from, to: bands[bands.length - 1].to }
}
