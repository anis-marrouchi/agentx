// --- Funnels: numbers in order, with the conversion at each step (#1826 N4) ---
//
// A funnel is set up in agentx.json, beside the numbers it uses:
//
//   "numbers": { "funnels": { "client-journey": {
//     "name": "Client journey",
//     "steps": ["site-visits", "trial-signups", { "name": "Paid", "tag": "step:paid" }]
//   } } }
//
// A step is a number's id, or { name?, number } for the same with a name of
// its own, or { name, tag } for every number that carries that tag: its
// value is the sum of their newest readings. So one funnel can be cut by
// channel or product: picking tags keeps only the numbers with every tag
// picked, and grouping by a tag kind (`channel`) draws the funnel once per
// channel.
//
// Conversion at a step is its value over the step before it. The biggest
// drop is the step with the lowest conversion. A step with no reading (a
// failed read, or no number left after the tags) has no conversion, and
// neither has the step after it: it is never counted as 0.
//
// These run in the browser too (injectFns, wall-numbers): each function is
// self-contained, and calls only the others of this file.

export const FUNNEL_STEPS_MIN = 2
export const FUNNEL_STEPS_MAX = 12

/** A step as set up: a number id, or an object naming a number or a tag. */
export type FunnelStepSpec = string | { name?: string; number?: string; tag?: string }
export interface FunnelSpec { name: string; steps: FunnelStepSpec[] }

/** What a step needs of a number: id, name, unit, tags, newest reading. */
export interface FunnelNumber {
  id: string
  name: string
  unit?: string | null
  tags: string[]
  latest: { value: number | null; periodStart: number; periodEnd: number } | null
}

export interface FunnelStep {
  name: string
  /** Sum of the newest readings of its numbers; null: no reading. */
  value: number | null
  unit: string | null
  /** The numbers counted, by id. */
  numbers: string[]
  /** Numbers it would count that have no reading. */
  missing: string[]
  /** The newest windows its readings cover, as [start, end]. */
  windows: Array<[number, number]>
  /** Value over the step before; null on the first step, or when either has no value or the one before is 0. */
  conversion: number | null
  /** This step has the lowest conversion of the funnel. */
  biggestDrop: boolean
}

export interface FunnelResult {
  name: string
  steps: FunnelStep[]
  /** Last step over first, when both have a value and the first is not 0. */
  overall: number | null
  /** Index of the biggest drop, or -1. */
  dropAt: number
  /** The steps' readings cover different windows. */
  mixedWindows: boolean
}

/** The steps of a spec in one shape: name, and a number id or a tag. */
export function funnelSteps(spec: FunnelSpec): Array<{ name: string; number?: string; tag?: string }> {
  return (spec.steps || []).map((s) => {
    if (typeof s === "string") return { name: "", number: s }
    return s.tag ? { name: s.name || "", tag: s.tag.toLowerCase() } : { name: s.name || "", number: s.number || "" }
  })
}

/** The funnel over `numbers`, keeping only those with every tag of `tags`. */
export function computeFunnel(spec: FunnelSpec, numbers: FunnelNumber[], tags: string[]): FunnelResult {
  const want = (tags || []).map((t) => t.toLowerCase())
  const keep = numbers.filter((n) => want.every((t) => (n.tags || []).indexOf(t) >= 0))
  const steps: FunnelStep[] = funnelSteps(spec).map((s) => {
    const all = s.tag ? numbers.filter((n) => (n.tags || []).indexOf(s.tag as string) >= 0) : numbers.filter((n) => n.id === s.number)
    const mine = s.tag ? keep.filter((n) => (n.tags || []).indexOf(s.tag as string) >= 0) : keep.filter((n) => n.id === s.number)
    const read = mine.filter((n) => n.latest && n.latest.value !== null && n.latest.value !== undefined)
    const windows: Array<[number, number]> = []
    for (const n of read) {
      const w: [number, number] = [n.latest!.periodStart, n.latest!.periodEnd]
      if (!windows.some((x) => x[0] === w[0] && x[1] === w[1])) windows.push(w)
    }
    const first = all[0]
    const name = s.name || (s.tag ? s.tag : first ? first.name : s.number || "")
    const units = read.map((n) => n.unit || "").filter((u, i, a) => a.indexOf(u) === i)
    return {
      name,
      value: read.length ? read.reduce((sum, n) => sum + (n.latest!.value as number), 0) : null,
      unit: units.length === 1 ? units[0] || null : null,
      numbers: read.map((n) => n.id),
      missing: mine.filter((n) => read.indexOf(n) < 0).map((n) => n.id),
      windows,
      conversion: null,
      biggestDrop: false,
    }
  })
  let dropAt = -1
  for (let i = 1; i < steps.length; i++) {
    const a = steps[i - 1].value, b = steps[i].value
    steps[i].conversion = a !== null && b !== null && a > 0 ? b / a : null
    const c = steps[i].conversion
    if (c !== null && c < 1 && (dropAt < 0 || c < (steps[dropAt].conversion as number))) dropAt = i
  }
  if (dropAt >= 0) steps[dropAt].biggestDrop = true
  const firstV = steps.length ? steps[0].value : null, lastV = steps.length ? steps[steps.length - 1].value : null
  const keys: Record<string, true> = {}
  for (const s of steps) for (const w of s.windows) keys[w[0] + ":" + w[1]] = true
  return {
    name: spec.name,
    steps,
    overall: steps.length > 1 && firstV !== null && lastV !== null && firstV > 0 ? lastV / firstV : null,
    dropAt,
    mixedWindows: Object.keys(keys).length > 1,
  }
}

/** The values of tag kind `kind` (`channel` → `video`, `newsletter`) on
 *  the numbers a funnel's steps use, sorted. */
export function funnelGroupValues(spec: FunnelSpec, numbers: FunnelNumber[], kind: string): string[] {
  const seen: Record<string, true> = {}
  const steps = funnelSteps(spec)
  for (const n of numbers) {
    const used = steps.some((s) => (s.tag ? (n.tags || []).indexOf(s.tag) >= 0 : n.id === s.number))
    if (!used) continue
    for (const t of n.tags || []) if (t.indexOf(kind + ":") === 0) seen[t.slice(kind.length + 1)] = true
  }
  return Object.keys(seen).sort()
}

/** "62%", or "62.5%" under 10 points from a round number; "—" for none. */
export function formatShare(share: number | null): string {
  if (share === null || !isFinite(share)) return "—"
  const p = share * 100
  return (p >= 10 ? Math.round(p) : Math.round(p * 10) / 10) + "%"
}

/** A funnel spec from config or another machine's reply, or an error. */
export function parseFunnel(raw: unknown): FunnelSpec | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "a funnel needs name and steps" }
  const r = raw as Record<string, unknown>
  const name = typeof r.name === "string" ? r.name.trim() : ""
  if (!name || name.length > 120) return { error: "name is needed: what the funnel follows, in a few plain words (at most 120 characters)" }
  if (!Array.isArray(r.steps) || r.steps.length < FUNNEL_STEPS_MIN || r.steps.length > FUNNEL_STEPS_MAX) return { error: `steps must list ${FUNNEL_STEPS_MIN} to ${FUNNEL_STEPS_MAX} steps, first to last` }
  const steps: FunnelStepSpec[] = []
  for (const s of r.steps) {
    if (typeof s === "string" && s.trim()) { steps.push(s.trim()); continue }
    if (s && typeof s === "object") {
      const o = s as Record<string, unknown>
      const sName = typeof o.name === "string" ? o.name.trim().slice(0, 120) : ""
      const number = typeof o.number === "string" ? o.number.trim() : ""
      const tag = typeof o.tag === "string" ? o.tag.trim().toLowerCase() : ""
      if (number && !tag) { steps.push(sName ? { name: sName, number } : { number }); continue }
      if (tag && !number && /^[^\s,]+$/.test(tag)) { steps.push(sName ? { name: sName, tag } : { tag }); continue }
    }
    return { error: "each step is a number's id, {\"number\": \"<id>\"} or {\"name\": \"…\", \"tag\": \"<tag>\"}" }
  }
  return { name, steps }
}
