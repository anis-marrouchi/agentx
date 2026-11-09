import { DIRECTIONS, NUMBER_NAME_MAX, NUMBER_UNIT_MAX, RHYTHMS, parseNumberId, parseTags, type Direction, type Rhythm } from "./model"
import { parseSource } from "./sources"
import type { NumberInput, NumberOrigin } from "./store"

// --- A number as given by agentx.json, an agent or the CLI (#1826) ---

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** Check what was given for a number. Fields left out stay as they are on
 *  an existing number (undefined in the result). `fromConfig` allows a
 *  command source and request headers. */
export function parseNumberInput(raw: Record<string, unknown>, origin: NumberOrigin, opts: { idFallback?: string } = {}): NumberInput | { error: string } {
  const id = parseNumberId(raw.id ?? opts.idFallback)
  if (typeof id !== "string") return id
  const name = str(raw.name).replace(/\s+/g, " ")
  if (name.length > NUMBER_NAME_MAX) return { error: `name is longer than ${NUMBER_NAME_MAX} characters` }
  const input: NumberInput = { id, name, origin }

  const owner = raw.owner ?? raw.ownerAgent
  if (owner !== undefined) input.ownerAgent = str(owner) || null
  if (raw.unit !== undefined) {
    const unit = str(raw.unit)
    if (unit.length > NUMBER_UNIT_MAX) return { error: `unit is longer than ${NUMBER_UNIT_MAX} characters` }
    input.unit = unit || null
  }
  if (raw.rhythm !== undefined) {
    const rhythm = str(raw.rhythm).toLowerCase()
    if (!(RHYTHMS as readonly string[]).includes(rhythm)) return { error: `rhythm must be ${RHYTHMS.join(", ")}` }
    input.rhythm = rhythm as Rhythm
  }
  const direction = raw.direction === undefined ? undefined : str(raw.direction).toLowerCase()
  if (direction !== undefined && !(DIRECTIONS as readonly string[]).includes(direction)) return { error: "direction must be up (higher is better) or down (lower is better)" }
  if (raw.target === null || raw.target === "") {
    input.target = null
  } else if (raw.target !== undefined) {
    const value = Number(raw.target)
    if (!Number.isFinite(value)) return { error: "target must be a number" }
    input.target = { value, direction: (direction ?? "up") as Direction }
  } else if (direction !== undefined) {
    return { error: "direction needs a target" }
  }
  if (raw.tags !== undefined) {
    const tags = parseTags(raw.tags)
    if (!Array.isArray(tags)) return tags
    input.tags = tags
  }
  if (raw.source !== undefined) {
    const source = parseSource(raw.source, origin === "config")
    if ("error" in source) return source
    input.source = source
  }
  return input
}
