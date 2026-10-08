// --- Load and check `ontology.yaml` (#811) ---
//
// The file is optional. Each section the owner writes is merged over the
// defaults: pillars, types and properties by `id` (a listed id replaces
// the fields it sets, a new id is added), `importance` and `sidebar`
// field by field, and `classify` as a whole list. Problems are reported,
// never thrown, so a typo in the file cannot take the wiki down.

import { existsSync, readFileSync, statSync, writeFileSync } from "fs"
import { resolve } from "path"
import yaml from "js-yaml"
import { DEFAULT_ONTOLOGY } from "./defaults"
import { IMPORTANCE_LEVELS, type LensPanel, type Ontology, type PanelSource } from "./types"

export const ONTOLOGY_FILE = "ontology.yaml"

export interface LoadedOntology {
  ontology: Ontology
  /** Problems found in the file. The defaults are used where they apply. */
  errors: string[]
  /** Path of the file read, or null when the defaults were used as they are. */
  file: string | null
}

const cache = new Map<string, { mtimeMs: number; loaded: LoadedOntology }>()

export function loadOntology(wikiDir: string): LoadedOntology {
  const file = resolve(wikiDir, ONTOLOGY_FILE)
  if (!existsSync(file)) return { ontology: DEFAULT_ONTOLOGY, errors: [], file: null }

  const mtimeMs = statSync(file).mtimeMs
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.loaded

  let raw: unknown
  const errors: string[] = []
  try {
    raw = yaml.load(readFileSync(file, "utf-8"))
  } catch (err) {
    errors.push(`${ONTOLOGY_FILE} is not valid YAML: ${(err as Error).message}`)
    raw = {}
  }
  const ontology = mergeOntology(DEFAULT_ONTOLOGY, isObject(raw) ? raw : {}, errors)
  errors.push(...checkOntology(ontology))
  const loaded = { ontology, errors, file }
  cache.set(file, { mtimeMs, loaded })
  return loaded
}

/** Write the defaults as a starting `ontology.yaml`. Refuses to overwrite. */
export function writeDefaultOntology(wikiDir: string): string {
  const file = resolve(wikiDir, ONTOLOGY_FILE)
  if (existsSync(file)) throw new Error(`${file} already exists`)
  const header = [
    "# Wiki ontology: pillars, types, typed relations, event importance and lenses.",
    "# Edit any section; what you leave out falls back to the built-in defaults.",
    "# Check it with: agentx wiki ontology check",
    "",
  ].join("\n")
  writeFileSync(file, header + yaml.dump(DEFAULT_ONTOLOGY, { lineWidth: 120, noRefs: true }))
  return file
}

export function mergeOntology(base: Ontology, over: Record<string, unknown>, errors: string[] = []): Ontology {
  const out: Ontology = structuredClone(base)
  if (typeof over.version === "number") out.version = over.version
  for (const key of ["pillars", "types", "properties"] as const) {
    const list = over[key]
    if (list === undefined) continue
    if (!Array.isArray(list)) { errors.push(`${key} must be a list`); continue }
    out[key] = mergeById(out[key] as Array<{ id: string }>, list, key, errors) as never
  }
  if (isObject(over.importance)) out.importance = { ...out.importance, ...over.importance } as Ontology["importance"]
  if (isObject(over.sidebar)) out.sidebar = { ...out.sidebar, ...over.sidebar } as Ontology["sidebar"]
  if (over.classify !== undefined) {
    if (Array.isArray(over.classify)) out.classify = over.classify as Ontology["classify"]
    else errors.push("classify must be a list")
  }
  if (typeof over.fallback_type === "string") out.fallback_type = over.fallback_type
  if (over.agent_names !== undefined) {
    if (Array.isArray(over.agent_names)) out.agent_names = over.agent_names.filter((n): n is string => typeof n === "string" && n.trim() !== "")
    else errors.push("agent_names must be a list")
  }
  return out
}

function mergeById(base: Array<{ id: string }>, list: unknown[], key: string, errors: string[]): Array<{ id: string }> {
  const out = base.map(x => ({ ...x }))
  for (const item of list) {
    if (!isObject(item) || typeof item.id !== "string") { errors.push(`every item in ${key} needs an id`); continue }
    const at = out.findIndex(x => x.id === item.id)
    if (at === -1) out.push(item as { id: string })
    else out[at] = { ...out[at], ...item }
  }
  return out
}

/** Problems that make part of the ontology unusable. */
export function checkOntology(o: Ontology): string[] {
  const errors: string[] = []
  const pillars = new Set(o.pillars.map(p => p.id))
  const types = new Set(o.types.map(t => t.id))
  const props = new Set(o.properties.map(p => p.id))
  for (const t of o.types) {
    if (!pillars.has(t.pillar)) errors.push(`type ${t.id}: unknown pillar "${t.pillar}"`)
    for (const p of t.lens ?? []) {
      for (const f of panelFrom(p)) if (!props.has(f)) errors.push(`type ${t.id}, panel ${p.panel}: unknown property "${f}"`)
      for (const ty of p.types ?? []) if (!types.has(ty)) errors.push(`type ${t.id}, panel ${p.panel}: unknown type "${ty}"`)
      for (const lv of p.importance ?? []) if (!IMPORTANCE_LEVELS.includes(lv)) errors.push(`type ${t.id}, panel ${p.panel}: unknown importance "${lv}"`)
    }
  }
  for (const r of o.classify) {
    if (!types.has(r.type)) errors.push(`classify: unknown type "${r.type}"`)
    if (r.title) {
      try { new RegExp(r.title, "i") } catch { errors.push(`classify: bad title pattern "${r.title}"`) }
    }
  }
  if (!types.has(o.fallback_type)) errors.push(`fallback_type: unknown type "${o.fallback_type}"`)
  if (!IMPORTANCE_LEVELS.includes(o.importance.default)) errors.push(`importance.default: unknown level "${o.importance.default}"`)
  if (o.sidebar.pins.length > o.sidebar.pins_max) {
    errors.push(`sidebar.pins: ${o.sidebar.pins.length} pins, only the first ${o.sidebar.pins_max} are shown`)
  }
  return errors
}

export function panelFrom(p: LensPanel): string[] {
  if (!p.from) return []
  return Array.isArray(p.from) ? p.from : [p.from]
}

export function panelSource(p: LensPanel): PanelSource {
  if (p.source) return p.source
  if (p.panel === "history" || p.panel === "discussed" || p.panel === "notes") return p.panel
  if (p.latest) return "readings"
  if (p.from) return "statements"
  return "linked"
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
