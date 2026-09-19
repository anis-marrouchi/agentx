import { describe, expect, it } from "vitest"
import {
  ARTICLE_FIELDS_SEAT,
  REQUIRED_FIELDS,
  articleFieldsState,
  fieldQuestions,
  fieldsFor,
  reportFields,
} from "../../src/decisions/seats/article-fields"
import { validateQuestions } from "../../src/decisions/questions"

const noulAnswers = (v: Record<string, number>) =>
  Object.fromEntries(Object.entries(v).map(([k, noul]) => [k, { noul }]))

describe("required fields per type", () => {
  it("asks every field as a noul, in one question set", () => {
    for (const type of Object.keys(REQUIRED_FIELDS)) {
      const qs = fieldQuestions(type)
      expect(() => validateQuestions(qs)).not.toThrow()
      expect(Object.keys(qs)).toEqual(fieldsFor(type).map((f) => f.key))
      for (const q of Object.values(qs)) expect(q.type).toBe("noul")
    }
  })

  it("falls back to the common fields for an unknown type", () => {
    expect(fieldsFor("wombat").map((f) => f.key)).toEqual(fieldsFor(undefined).map((f) => f.key))
    expect(fieldsFor("wombat").length).toBeGreaterThan(0)
  })

  it("asks a person for a contact VALUE, not a channel", () => {
    // The observed defect: "WhatsApp, in Arabic" satisfies "has a contact
    // channel" and fails the article's purpose. The wording has to make
    // the number itself the thing being asked about.
    const q = REQUIRED_FIELDS.person.find((f) => f.key === "contactValue")!
    expect(q.tier).toBe("pillar")
    expect(q.question).toMatch(/rather than only naming a channel/)
  })

  it("keys are unique within a type", () => {
    for (const [type, fields] of Object.entries(REQUIRED_FIELDS)) {
      const keys = fields.map((f) => f.key)
      expect(new Set(keys).size, type).toBe(keys.length)
    }
  })
})

describe("reportFields", () => {
  const person = "person"

  it("splits present, missing and unclear on the review band", () => {
    const r = reportFields(person, noulAnswers({
      whatItIs: 0.95, whyItMatters: 0.8, relationships: 0.5,
      role: 0.9, organisation: 0.02, contactValue: 0.05,
      language: 0.85, ourOwner: 0.45,
    }))
    expect(r.present).toContain("role")
    expect(r.missing).toEqual(expect.arrayContaining(["organisation", "contactValue"]))
    expect(r.unclear).toEqual(expect.arrayContaining(["relationships", "ourOwner"]))
    // Every field lands in exactly one bucket.
    expect(r.present.length + r.missing.length + r.unclear.length).toBe(fieldsFor(person).length)
  })

  it("flags missing CRITICAL fields separately and marks the article unfit", () => {
    const r = reportFields(person, noulAnswers({
      whatItIs: 0.95, whyItMatters: 0.9, relationships: 0.9,
      role: 0.9, organisation: 0.9, contactValue: 0.05, language: 0.9, ourOwner: 0.9,
    }))
    expect(r.missingCritical).toEqual(["contactValue"])
    expect(r.fit).toBe(false)
    // High coverage is not fitness — 7 of 8 present, still unusable.
    expect(r.coverage).toBeGreaterThan(0.8)
  })

  it("is fit when only non-critical fields are missing", () => {
    const r = reportFields(person, noulAnswers({
      whatItIs: 0.95, whyItMatters: 0.05, relationships: 0.05,
      role: 0.9, organisation: 0.9, contactValue: 0.9, language: 0.05, ourOwner: 0.05,
    }))
    expect(r.missingCritical).toEqual([])
    expect(r.fit).toBe(true)
  })

  it("treats an unclear critical field as not-missing — it escalates, it does not accuse", () => {
    const r = reportFields(person, noulAnswers({ contactValue: 0.5 }))
    expect(r.unclear).toContain("contactValue")
    expect(r.missingCritical).not.toContain("contactValue")
  })

  it("counts an absent answer as unclear rather than missing", () => {
    // A backend that dropped a question must not be read as evidence the
    // field is absent from the article.
    const r = reportFields(person, {})
    expect(r.missing).toEqual([])
    expect(r.unclear.length).toBe(fieldsFor(person).length)
    expect(r.coverage).toBe(0)
  })

  it("honours custom thresholds", () => {
    const a = noulAnswers({ role: 0.6 })
    expect(reportFields(person, a).unclear).toContain("role")
    expect(reportFields(person, a, { high: 0.5 }).present).toContain("role")
  })
})

describe("articleFieldsState", () => {
  it("truncates a long body and says so", () => {
    const s = articleFieldsState({ title: "t", type: "person", body: "x".repeat(50_000) }, 100)
    expect(String(s.body)).toHaveLength(100 + "\n…[truncated]".length)
    expect(String(s.body)).toContain("truncated")
  })

  it("passes a short body through untouched", () => {
    const s = articleFieldsState({ title: "t", type: "person", body: "  hello  " })
    expect(s.body).toBe("hello")
    expect(s.type).toBe("person")
  })
})

it("seat name is stable", () => {
  expect(ARTICLE_FIELDS_SEAT).toBe("article-fields")
})

describe("fieldChecklistMarkdown — one definition, two renderings", () => {
  it("covers every typed article kind", async () => {
    const { fieldChecklistMarkdown } = await import("../../src/decisions/seats/article-fields")
    const md = fieldChecklistMarkdown()
    for (const type of Object.keys(REQUIRED_FIELDS)) expect(md).toContain(`**${type}**`)
  })

  it("emits every non-common field the grader checks", async () => {
    const { fieldChecklistMarkdown, REQUIRED_FIELDS: R } = await import("../../src/decisions/seats/article-fields")
    const md = fieldChecklistMarkdown()
    const common = new Set(fieldsFor(undefined).map((f) => f.key))
    for (const [type, fields] of Object.entries(R)) {
      for (const f of fields) {
        if (common.has(f.key)) continue
        expect(md, `${type}.${f.key}`).toContain(f.label)
      }
    }
  })

  it("orders the checklist foundation-first", async () => {
    const { fieldChecklistMarkdown } = await import("../../src/decisions/seats/article-fields")
    const line = fieldChecklistMarkdown().split("\n").find((l) => l.startsWith("- **project**"))!
    // oneLine is foundation, status is walls — the prompt should read in
    // the order the article gets built, not record order.
    expect(line.indexOf("one line")).toBeLessThan(line.indexOf("current status"))
  })

  it("rejects a label that carries its own emphasis", async () => {
    // Nested ** produced `**contact identifiers **verbatim** …**`, which
    // renders as broken markdown in the prompt.
    const { REQUIRED_FIELDS: R } = await import("../../src/decisions/seats/article-fields")
    for (const fields of Object.values(R)) {
      for (const f of fields) expect(f.label, f.key).not.toContain("**")
    }
  })

  it("reaches the absorb prompt the writer actually sees", async () => {
    const { buildAbsorbPrompt } = await import("../../src/wiki/prompts")
    const p = buildAbsorbPrompt("graph" as never, "a", "w", [] as never, [] as never)
    expect(p).toContain("contact identifiers VERBATIM")
    expect(p).toContain("hostname, IP, URL or path")
  })
})

describe("tiers — not all facts are load-bearing", () => {
  it("every field declares a tier from the ladder", async () => {
    const { TIERS } = await import("../../src/decisions/seats/article-fields")
    for (const [type, fields] of Object.entries(REQUIRED_FIELDS)) {
      for (const f of fields) expect(TIERS, `${type}.${f.key}`).toContain(f.tier)
    }
  })

  it("every type rests on at least one foundation field", async () => {
    for (const [type, fields] of Object.entries(REQUIRED_FIELDS)) {
      expect(fields.some((f) => f.tier === "foundation"), type).toBe(true)
    }
  })

  it("critical means foundation or pillar, and nothing else", async () => {
    const { isCritical } = await import("../../src/decisions/seats/article-fields")
    for (const fields of Object.values(REQUIRED_FIELDS)) {
      for (const f of fields) {
        expect(isCritical(f), f.key).toBe(f.tier === "foundation" || f.tier === "pillar")
      }
    }
  })

  it("reports the worst tier with a gap, not just a count", async () => {
    const { reportFields: rf } = await import("../../src/decisions/seats/article-fields")
    // Furniture-level gap only.
    const mild = rf("person", noulAnswers({
      whatItIs: 0.95, whyItMatters: 0.02, relationships: 0.9,
      role: 0.9, organisation: 0.9, contactValue: 0.9, language: 0.9, ourOwner: 0.9,
    }))
    expect(mild.worstTier).toBe("walls")
    expect(mild.fit).toBe(true)

    // Same count of gaps, but one is structural.
    const severe = rf("person", noulAnswers({
      whatItIs: 0.02, whyItMatters: 0.9, relationships: 0.9,
      role: 0.9, organisation: 0.9, contactValue: 0.9, language: 0.9, ourOwner: 0.9,
    }))
    expect(severe.worstTier).toBe("foundation")
    expect(severe.fit).toBe(false)
  })

  it("worstTier is null for a complete article", async () => {
    const { reportFields: rf } = await import("../../src/decisions/seats/article-fields")
    const all = Object.fromEntries(fieldsFor("person").map((f) => [f.key, 0.95]))
    const r = rf("person", noulAnswers(all))
    expect(r.worstTier).toBeNull()
    expect(r.coverage).toBe(1)
  })
})

describe("nextActions — the post-absorb work list", () => {
  const partial = () => {
    const { } = {}
    return noulAnswers({
      whatItIs: 0.95, whyItMatters: 0.02, relationships: 0.9,
      role: 0.02, organisation: 0.9, contactValue: 0.02, language: 0.02, ourOwner: 0.9,
    })
  }

  it("ranks by tier, then puts lookups before questions", async () => {
    const { reportFields: rf, nextActions } = await import("../../src/decisions/seats/article-fields")
    const acts = nextActions(rf("person", partial()))
    expect(acts.map((a) => a.field)).toEqual(["contactValue", "role", "whyItMatters", "language"])
    // contactValue and role are both pillar; contactValue is resolvable
    // by lookup so it is drained before anyone is interrupted.
    expect(acts[0].needsHuman).toBe(false)
    expect(acts[0].sources).toContain("wacli")
    expect(acts[1].needsHuman).toBe(false)
  })

  it("marks a field no system holds as needing a person", async () => {
    const { reportFields: rf, nextActions } = await import("../../src/decisions/seats/article-fields")
    const acts = nextActions(rf("person", partial()))
    const language = acts.find((a) => a.field === "language")!
    expect(language.needsHuman).toBe(true)
    expect(language.sources).toEqual([])
  })

  it("maxTier stops the list before the furniture", async () => {
    const { reportFields: rf, nextActions } = await import("../../src/decisions/seats/article-fields")
    const acts = nextActions(rf("person", partial()), { maxTier: "pillar" })
    expect(acts.map((a) => a.field)).toEqual(["contactValue", "role"])
  })

  it("includes unclear fields only when asked, and flags them", async () => {
    const { reportFields: rf, nextActions } = await import("../../src/decisions/seats/article-fields")
    const r = rf("person", noulAnswers({
      whatItIs: 0.95, whyItMatters: 0.9, relationships: 0.9,
      role: 0.9, organisation: 0.9, contactValue: 0.5, language: 0.9, ourOwner: 0.9,
    }))
    expect(nextActions(r)).toEqual([])
    const withUnclear = nextActions(r, { includeUnclear: true })
    expect(withUnclear.map((a) => a.field)).toEqual(["contactValue"])
    expect(withUnclear[0].uncertain).toBe(true)
  })

  it("returns nothing for a complete article", async () => {
    const { reportFields: rf, nextActions } = await import("../../src/decisions/seats/article-fields")
    const all = Object.fromEntries(fieldsFor("project").map((f) => [f.key, 0.95]))
    expect(nextActions(rf("project", noulAnswers(all)))).toEqual([])
  })
})
