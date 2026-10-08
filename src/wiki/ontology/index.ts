import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { resolve } from "path"
import { parse, stringify } from "yaml"
import { ontologySchema, PANEL_SOURCES, type Ontology } from "./types"
import { STARTER_ONTOLOGY } from "./starter"

export * from "./types"
export { STARTER_ONTOLOGY } from "./starter"

export const ONTOLOGY_FILE = "ontology.yaml"

export interface LoadedOntology {
  ontology: Ontology
  /** `file` when ontology.yaml was read and is valid; `built-in` otherwise. */
  source: "file" | "built-in"
  path: string
  /** Why the file was not used. Empty when it was, or when there is none. */
  problems: string[]
}

/**
 * The ontology the wiki runs on. A section the file leaves out comes from
 * the built-in starter, and `lenses` merge type by type, so a file holding
 * only `lenses: {person: [...]}` is enough to reorder the person page. A file that does not parse or does not check is not
 * used: the wiki keeps the built-in one and reports why, rather than
 * running on half a model.
 */
export function loadOntology(wikiDir: string): LoadedOntology {
  const path = resolve(wikiDir, ONTOLOGY_FILE)
  const builtIn = (problems: string[]): LoadedOntology => ({ ontology: STARTER_ONTOLOGY, source: "built-in", path, problems })
  if (!existsSync(path)) return builtIn([])

  let raw: unknown
  try {
    raw = parse(readFileSync(path, "utf-8"))
  } catch (e) {
    return builtIn([`${ONTOLOGY_FILE} is not valid YAML: ${(e as Error).message.split("\n")[0]}`])
  }
  if (raw == null) return builtIn([])
  if (typeof raw !== "object" || Array.isArray(raw)) return builtIn([`${ONTOLOGY_FILE} must be a map of sections (pillars, types, lenses, ...)`])

  const file = raw as Record<string, unknown>
  const merged = { ...STARTER_ONTOLOGY, ...file }
  if (file.lenses && typeof file.lenses === "object" && !Array.isArray(file.lenses)) {
    merged.lenses = { ...STARTER_ONTOLOGY.lenses, ...(file.lenses as Ontology["lenses"]) }
  }
  const parsed = ontologySchema.safeParse(merged)
  if (!parsed.success) {
    return builtIn(parsed.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`))
  }
  const problems = checkOntology(parsed.data)
  if (problems.length) return builtIn(problems)
  return { ontology: parsed.data, source: "file", path, problems: [] }
}

/** Cross-references the schema alone cannot see. Empty when consistent. */
export function checkOntology(o: Ontology): string[] {
  const problems: string[] = []
  const dupes = (what: string, ids: string[]) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) problems.push(`${what} "${id}" is defined twice`)
      seen.add(id)
    }
  }
  dupes("pillar", o.pillars.map((p) => p.id))
  dupes("type", o.types.map((t) => t.id))
  dupes("property", o.properties.map((p) => p.id))
  dupes("importance level", o.importance.map((l) => l.id))

  const types = new Map(o.types.map((t) => [t.id, t]))
  const props = new Map(o.properties.map((p) => [p.id, p]))
  const levels = new Set(o.importance.map((l) => l.id))

  const placed = new Map<string, string>()
  for (const p of o.pillars) {
    for (const t of p.types) {
      if (!types.has(t)) problems.push(`pillar "${p.id}" lists type "${t}", which is not defined`)
      else if (placed.has(t)) problems.push(`type "${t}" is in two pillars ("${placed.get(t)}" and "${p.id}")`)
      else placed.set(t, p.id)
    }
  }
  for (const t of o.types) {
    if (!t.fallback && !placed.has(t.id)) problems.push(`type "${t.id}" is in no pillar (add it to one, or mark it fallback)`)
  }

  for (const p of o.properties) {
    for (const t of [...p.from, ...p.to]) {
      if (t !== "*" && !types.has(t)) problems.push(`property "${p.id}" refers to type "${t}", which is not defined`)
    }
    for (const q of [...p.required, ...p.private]) {
      if (!p.qualifiers.includes(q)) problems.push(`property "${p.id}" names "${q}" as required or private, but it is not one of its qualifiers`)
    }
  }

  for (const [what, level] of [["rollup.level", o.rollup.level], ["rollup.raise_to", o.rollup.raise_to], ["major.level", o.major.level]] as const) {
    if (!levels.has(level)) problems.push(`${what} is "${level}", which is not an importance level`)
  }

  const sources = new Set<string>(PANEL_SOURCES)
  for (const [key, panels] of Object.entries(o.lenses)) {
    if (key !== "default" && !types.has(key)) { problems.push(`lens "${key}" is not a type (or "default")`); continue }
    dupes(`panel in lens "${key}"`, panels.map((p) => p.panel))
    for (const panel of panels) {
      const at = `lens "${key}", panel "${panel.panel}"`
      const from = panel.from === undefined ? [] : Array.isArray(panel.from) ? panel.from : [panel.from]
      for (const f of from) {
        if (sources.has(f)) continue
        const prop = props.get(f)
        if (!prop) { problems.push(`${at}: "${f}" is neither a property nor one of ${PANEL_SOURCES.join(", ")}`); continue }
        const touches = (side: string[]) => side.includes("*") || side.includes(key)
        if (key !== "default" && !touches(prop.from) && !touches(prop.to)) {
          problems.push(`${at}: property "${f}" never links a ${key}`)
        }
      }
      for (const l of [...(panel.importance ?? []), ...(panel.fold ? [panel.fold] : [])]) {
        if (!levels.has(l)) problems.push(`${at}: "${l}" is not an importance level`)
      }
      if (panel.group_by && panel.group_by !== "kind") {
        const qualified = from.some((f) => props.get(f)?.qualifiers.includes(panel.group_by!))
        if (!qualified) problems.push(`${at}: group_by "${panel.group_by}" is not a qualifier of its properties (or "kind")`)
      }
    }
  }
  if (!o.lenses.default) {
    for (const t of o.types) {
      if (!o.lenses[t.id]) problems.push(`type "${t.id}" has no lens, and there is no "default" lens`)
    }
  }
  return problems
}

/** The panels a page of this type opens with (zoom level Z2). */
export function lensFor(o: Ontology, typeId: string) {
  return o.lenses[typeId] ?? o.lenses.default ?? []
}

/** The pillar a type sits in; undefined for a fallback type. */
export function pillarOf(o: Ontology, typeId: string) {
  return o.pillars.find((p) => p.types.includes(typeId))
}

const HEADER = `# Wiki ontology: what the wiki's pages are, how they link, and how they are viewed.
# Any section you delete falls back to the built-in default.
# Check your changes with: agentx wiki ontology check
`

/** The starter as YAML, for \`agentx wiki ontology init\`. */
export function ontologyYaml(o: Ontology = STARTER_ONTOLOGY): string {
  return HEADER + stringify(o, { lineWidth: 0 })
}

/** Writes the starter. Returns false, writing nothing, when a file exists. */
export function writeStarterOntology(wikiDir: string, force = false): boolean {
  const path = resolve(wikiDir, ONTOLOGY_FILE)
  if (existsSync(path) && !force) return false
  mkdirSync(wikiDir, { recursive: true })
  writeFileSync(path, ontologyYaml())
  return true
}
