import { mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { beforeEach, describe, expect, it } from "vitest"
import {
  STARTER_ONTOLOGY,
  checkOntology,
  lensFor,
  loadOntology,
  ontologySchema,
  pillarOf,
  writeStarterOntology,
  type Ontology,
} from "../../src/wiki/ontology"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "wiki-ontology-"))
})

const write = (yaml: string) => writeFileSync(resolve(dir, "ontology.yaml"), yaml)
const clone = (): Ontology => JSON.parse(JSON.stringify(STARTER_ONTOLOGY))

describe("starter ontology", () => {
  it("parses and checks clean", () => {
    expect(ontologySchema.safeParse(STARTER_ONTOLOGY).success).toBe(true)
    expect(checkOntology(STARTER_ONTOLOGY)).toEqual([])
  })

  it("has the nine approved pillars, in sidebar order", () => {
    expect(STARTER_ONTOLOGY.pillars.map((p) => p.label)).toEqual([
      "Parties", "Places & Jurisdictions", "Assets", "Offerings & Projects", "Agreements",
      "Law & Obligations", "Events", "Decisions & Policies", "Procedures",
    ])
  })

  it("puts every type in one pillar except the fallback", () => {
    for (const t of STARTER_ONTOLOGY.types) {
      if (t.fallback) expect(pillarOf(STARTER_ONTOLOGY, t.id)).toBeUndefined()
      else expect(pillarOf(STARTER_ONTOLOGY, t.id)).toBeDefined()
    }
  })

  it("keeps roles off the types: client, employer and accountant are qualifiers", () => {
    const typeIds = STARTER_ONTOLOGY.types.flatMap((t) => [t.id, ...t.kinds])
    for (const role of ["client", "supplier", "employer", "accountant"]) expect(typeIds).not.toContain(role)
    expect(STARTER_ONTOLOGY.properties.find((p) => p.id === "role_at")?.required).toEqual(["role"])
  })

  it("gives every type a lens, falling back to the default one", () => {
    expect(lensFor(STARTER_ONTOLOGY, "device").map((p) => p.panel)).toEqual([
      "state_now", "events", "installed_apps", "discussed", "parties",
    ])
    expect(lensFor(STARTER_ONTOLOGY, "topic")).toBe(STARTER_ONTOLOGY.lenses.default)
  })

  it("keeps the sidebar to home, pins and pillars, with at most five pins", () => {
    expect(STARTER_ONTOLOGY.sidebar).toEqual({ pins_max: 5, show: ["home", "pins", "pillars"] })
  })
})

describe("checkOntology", () => {
  it("names a pillar type that does not exist", () => {
    const o = clone()
    o.pillars[0].types.push("robot")
    expect(checkOntology(o)).toContain(`pillar "parties" lists type "robot", which is not defined`)
  })

  it("names a type left out of every pillar", () => {
    const o = clone()
    o.types.push({ id: "vehicle", label: "Vehicle", schema_org: [], kinds: [] })
    expect(checkOntology(o)).toContain(`type "vehicle" is in no pillar (add it to one, or mark it fallback)`)
  })

  it("names a required qualifier the property does not have", () => {
    const o = clone()
    o.properties.find((p) => p.id === "owns")!.required = ["role"]
    expect(checkOntology(o)).toContain(`property "owns" names "role" as required or private, but it is not one of its qualifiers`)
  })

  it("names a lens panel reading a property that never links its type", () => {
    const o = clone()
    o.lenses.person.push({ panel: "installed", from: "installed_on" })
    expect(checkOntology(o)).toContain(`lens "person", panel "installed": property "installed_on" never links a person`)
  })

  it("names an unknown panel source and importance level", () => {
    const o = clone()
    o.lenses.device[0] = { panel: "state_now", from: "telemetry", importance: ["urgent"] }
    const problems = checkOntology(o)
    expect(problems.some((p) => p.includes(`"telemetry" is neither a property`))).toBe(true)
    expect(problems).toContain(`lens "device", panel "state_now": "urgent" is not an importance level`)
  })

  it("names a roll-up that raises to a level that does not exist", () => {
    const o = clone()
    o.rollup.raise_to = "high"
    expect(checkOntology(o)).toContain(`rollup.raise_to is "high", which is not an importance level`)
  })
})

describe("loadOntology", () => {
  it("uses the built-in ontology when there is no file", () => {
    const l = loadOntology(dir)
    expect(l.source).toBe("built-in")
    expect(l.problems).toEqual([])
    expect(l.ontology).toBe(STARTER_ONTOLOGY)
  })

  it("takes the sections the file has, the starter for the rest, and merges lenses per type", () => {
    write(`
sidebar:
  pins_max: 3
  show: [home, pillars]
lenses:
  person:
    - {panel: belongings, from: [owns, uses], show: 5}
    - {panel: history, from: events, importance: [major], fold: minor}
`)
    const l = loadOntology(dir)
    expect(l.problems).toEqual([])
    expect(l.source).toBe("file")
    expect(l.ontology.sidebar).toEqual({ pins_max: 3, show: ["home", "pillars"] })
    expect(lensFor(l.ontology, "person").map((p) => p.panel)).toEqual(["belongings", "history"])
    expect(lensFor(l.ontology, "device")).toEqual(STARTER_ONTOLOGY.lenses.device)
    expect(l.ontology.pillars).toEqual(STARTER_ONTOLOGY.pillars)
  })

  it("falls back to the built-in ontology, with reasons, when the file is wrong", () => {
    write(`sidebar: {pins_max: 9, show: [home]}\n`)
    const l = loadOntology(dir)
    expect(l.source).toBe("built-in")
    expect(l.ontology).toBe(STARTER_ONTOLOGY)
    expect(l.problems[0]).toMatch(/^sidebar\.pins_max:/)
  })

  it("reports a file that is not YAML", () => {
    write(`pillars: [unclosed\n`)
    const l = loadOntology(dir)
    expect(l.source).toBe("built-in")
    expect(l.problems[0]).toMatch(/not valid YAML/)
  })

  it("reports a file that checks against the schema but not against itself", () => {
    write(`rollup: {level: minor, min: 5, window_days: 30, raise_to: high}\n`)
    expect(loadOntology(dir).problems).toEqual([`rollup.raise_to is "high", which is not an importance level`])
  })
})

describe("writeStarterOntology", () => {
  it("writes a file that loads back to the starter, and never overwrites without force", () => {
    expect(writeStarterOntology(dir)).toBe(true)
    const l = loadOntology(dir)
    expect(l.source).toBe("file")
    expect(l.ontology).toEqual(STARTER_ONTOLOGY)

    write("lenses: {default: [{panel: facts, from: facts}]}\n")
    expect(writeStarterOntology(dir)).toBe(false)
    expect(readFileSync(resolve(dir, "ontology.yaml"), "utf-8")).toMatch(/^lenses:/)
    expect(writeStarterOntology(dir, true)).toBe(true)
    expect(readFileSync(resolve(dir, "ontology.yaml"), "utf-8")).toMatch(/^# Wiki ontology/)
  })
})
