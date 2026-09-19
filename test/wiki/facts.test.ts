import { describe, expect, it, vi } from "vitest"
import {
  countryFromPhone,
  extractHints,
  installPrompts,
  isPersonName,
  mergeRecords,
  parseContactsTable,
  plausible,
  renderFactsBlock,
  resolveFacts,
} from "../../src/wiki/facts"
import type { FactRecord, FactSource, Unavailable } from "../../src/wiki/facts"

const fake = (
  name: string,
  records: FactRecord[],
  unavailable: Unavailable | null = null,
): FactSource => ({
  name,
  provides: ["test"],
  available: async () => unavailable,
  lookup: async () => records,
})

describe("isPersonName", () => {
  it("accepts a plain two-to-four word name", () => {
    expect(isPersonName("Saber Salhi")).toBe(true)
    expect(isPersonName("Anis Marrouchi")).toBe(true)
    expect(isPersonName("Jean-Luc De La Tour")).toBe(true)
  })

  it("rejects issue titles, which is what `context` holds for GitLab entries", () => {
    expect(isPersonName("GitLab noqta/minbar issue #14: Feature")).toBe(false)
    expect(isPersonName("Deploy v2 to staging")).toBe(false)
    expect(isPersonName("673-competition-dates")).toBe(false)
  })

  it("rejects the placeholder contexts the corpus is full of", () => {
    for (const s of ["me", "User", "system", "cron", "unknown", "N/A"]) {
      expect(isPersonName(s), s).toBe(false)
    }
  })

  it("rejects a single word — too weak a signal to spend a lookup on", () => {
    expect(isPersonName("Saber")).toBe(false)
  })

  it("rejects lowercase, which is how handles and slugs arrive", () => {
    expect(isPersonName("saber salhi")).toBe(false)
  })
})

describe("extractHints", () => {
  it("dedupes case-insensitively and keeps the first spelling", () => {
    const h = extractHints([
      { context: "Saber Salhi" }, { context: "saber salhi" }, { context: "Saber Salhi" },
    ])
    expect(h).toHaveLength(1)
    expect(h[0].name).toBe("Saber Salhi")
  })

  it("skips entries whose context is not a name", () => {
    expect(extractHints([{ context: "cron" }, { context: "" }, {}])).toEqual([])
  })

  it("caps the batch — each hint is N network calls", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ context: `Aaa Bbb${String.fromCharCode(97 + (i % 26))}${i}` }))
    expect(extractHints(many, { max: 10 }).length).toBeLessThanOrEqual(10)
  })
})

describe("parseContactsTable", () => {
  // Fixed-width output with an empty leading ALIAS column.
  const table = [
    "ALIAS  NAME              PHONE         JID",
    "       Sample Person     216000000000  216000000000@s.example.net",
    "vip    Other Person      33000000000   33000000000@s.example.net",
  ].join("\n")

  it("reads from the right, so an empty ALIAS does not shift the columns", () => {
    const r = parseContactsTable(table)
    expect(r).toHaveLength(2)
    expect(r[0].name).toBe("Sample Person")
    expect(r[0].fields.phone).toBe("+216000000000")
    expect(r[1].name).toBe("Other Person")
  })

  it("derives country from the dialling prefix", () => {
    const r = parseContactsTable(table)
    expect(r[0].fields.country).toBe("Tunisia")
    expect(r[1].fields.country).toBe("France")
  })

  it("ignores the header and blank lines", () => {
    expect(parseContactsTable("ALIAS  NAME  PHONE  JID\n\n   \n")).toEqual([])
  })

  it("skips rows with no identifier column", () => {
    expect(parseContactsTable("ALIAS  NAME\n       Someone")).toEqual([])
  })
})

describe("countryFromPhone", () => {
  it("prefers the longest matching prefix", () => {
    // "1" would otherwise swallow every +1xx number.
    expect(countryFromPhone("216000000")).toBe("Tunisia")
    expect(countryFromPhone("12025550000")).toBe("US/Canada")
  })

  it("returns undefined for an unknown prefix rather than guessing", () => {
    expect(countryFromPhone("99900000")).toBeUndefined()
  })
})

describe("plausible", () => {
  it("matches a stored short form against a fuller wiki name", () => {
    expect(plausible("Sample", "Sample Person")).toBe(true)
    expect(plausible("Sample Person", "Sample")).toBe(true)
  })

  it("rejects an unrelated person who happens to share a surname", () => {
    expect(plausible("Other Person", "Sample Person")).toBe(false)
  })

  it("ignores accents and case", () => {
    expect(plausible("José García", "jose garcia")).toBe(true)
  })
})

describe("resolveFacts", () => {
  const hints = [{ name: "Sample Person" }]

  it("merges records from every healthy source", async () => {
    const { records } = await resolveFacts(hints, {
      sources: [
        fake("a", [{ name: "Sample Person", source: "a", fields: { email: "s@example.com" } }]),
        fake("b", [{ name: "Sample Person", source: "b", fields: { role: "Engineer" } }]),
      ],
    })
    expect(records).toHaveLength(2)
  })

  it("a throwing source contributes nothing and blocks nothing", async () => {
    const boom: FactSource = {
      name: "boom", provides: [],
      available: async () => null,
      lookup: async () => { throw new Error("upstream is down") },
    }
    const { records, results } = await resolveFacts(hints, {
      sources: [boom, fake("ok", [{ name: "Sample Person", source: "ok", fields: { email: "s@example.com" } }])],
    })
    expect(records).toHaveLength(1)
    expect(results.find((r) => r.source === "boom")?.unavailable?.kind).toBe("failed")
  })

  it("never calls lookup on an unavailable source", async () => {
    const lookup = vi.fn(async () => [])
    await resolveFacts(hints, {
      sources: [{
        name: "off", provides: [],
        available: async () => ({ kind: "not-installed", hint: "install it" }),
        lookup,
      }],
    })
    expect(lookup).not.toHaveBeenCalled()
  })

  it("does nothing at all when the batch names nobody", async () => {
    const lookup = vi.fn(async () => [])
    const { records } = await resolveFacts([], {
      sources: [{ name: "s", provides: [], available: async () => null, lookup }],
    })
    expect(records).toEqual([])
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe("installPrompts", () => {
  it("surfaces a missing tool with its remedy", async () => {
    const src = fake("wacli", [], { kind: "not-installed", hint: "brew install wacli" })
    const { results } = await resolveFacts([{ name: "Sample Person" }], { sources: [src] })
    const prompts = installPrompts(results, [src])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ source: "wacli", kind: "not-installed", hint: "brew install wacli" })
  })

  it("stays quiet about a transient failure — that is noise, not a task", async () => {
    const src: FactSource = {
      name: "flaky", provides: [],
      available: async () => null,
      lookup: async () => { throw new Error("timeout") },
    }
    const { results } = await resolveFacts([{ name: "Sample Person" }], { sources: [src] })
    expect(installPrompts(results, [src])).toEqual([])
  })
})

describe("mergeRecords", () => {
  it("first source to state a field wins", () => {
    const m = mergeRecords([
      { name: "Sample Person", source: "wacli", fields: { phone: "+1" } },
      { name: "Sample Person", source: "gog", fields: { phone: "+2" } },
    ])
    expect(m).toHaveLength(1)
    expect(m[0].fields.phone).toEqual({ value: "+1", source: "wacli" })
  })

  it("keeps a conflicting value rather than dropping it silently", () => {
    const m = mergeRecords([
      { name: "Sample Person", source: "wacli", fields: { phone: "+1" } },
      { name: "Sample Person", source: "gog", fields: { phone: "+2" } },
    ])
    expect(m[0].fields["phone (gog)"]).toEqual({ value: "+2", source: "gog" })
  })

  it("does not record a conflict when the sources agree", () => {
    const m = mergeRecords([
      { name: "Sample Person", source: "wacli", fields: { phone: "+1" } },
      { name: "Sample Person", source: "gog", fields: { phone: "+1" } },
    ])
    expect(Object.keys(m[0].fields)).toEqual(["phone"])
  })

  it("groups by name case-insensitively", () => {
    const m = mergeRecords([
      { name: "Sample Person", source: "a", fields: { email: "s@example.com" } },
      { name: "sample person", source: "b", fields: { role: "Engineer" } },
    ])
    expect(m).toHaveLength(1)
    expect(Object.keys(m[0].fields).sort()).toEqual(["email", "role"])
  })

  it("drops empty values", () => {
    const m = mergeRecords([{ name: "Sample Person", source: "a", fields: { email: "  ", role: "Engineer" } }])
    expect(Object.keys(m[0].fields)).toEqual(["role"])
  })
})

describe("renderFactsBlock", () => {
  it("is empty when there is nothing to say, so the prompt gains no dead section", () => {
    expect(renderFactsBlock([])).toBe("")
    expect(renderFactsBlock([{ name: "Sample Person", fields: {} }])).toBe("")
  })

  it("instructs the writer to copy verbatim and attributes each value", () => {
    const md = renderFactsBlock(mergeRecords([
      { name: "Sample Person", source: "wacli", fields: { phone: "+216000000000" } },
    ]))
    expect(md).toContain("**Sample Person**")
    expect(md).toContain("`+216000000000`")
    expect(md).toContain("_(wacli)_")
    expect(md).toContain("verbatim")
    // Absorb's default disposition is to summarise; the block has to say
    // outright that a value is not a thing to summarise.
    expect(md).toMatch(/Do not paraphrase/i)
  })
})
