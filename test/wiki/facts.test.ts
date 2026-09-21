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
    expect(isPersonName("Alex Rivera")).toBe(true)
    expect(isPersonName("Dana Okonkwo")).toBe(true)
    expect(isPersonName("Jean-Luc De La Tour")).toBe(true)
  })

  it("rejects issue titles, which is what `context` holds for GitLab entries", () => {
    expect(isPersonName("GitLab acme/widgets issue #14: Feature")).toBe(false)
    expect(isPersonName("Deploy v2 to staging")).toBe(false)
    expect(isPersonName("673-competition-dates")).toBe(false)
  })

  it("rejects the placeholder contexts the corpus is full of", () => {
    for (const s of ["me", "User", "system", "cron", "unknown", "N/A"]) {
      expect(isPersonName(s), s).toBe(false)
    }
  })

  it("rejects a single word — too weak a signal to spend a lookup on", () => {
    expect(isPersonName("Alex")).toBe(false)
  })

  it("rejects lowercase, which is how handles and slugs arrive", () => {
    expect(isPersonName("alex rivera")).toBe(false)
  })
})

describe("extractHints", () => {
  it("dedupes case-insensitively and keeps the first spelling", () => {
    const h = extractHints([
      { context: "Alex Rivera" }, { context: "alex rivera" }, { context: "Alex Rivera" },
    ])
    expect(h).toHaveLength(1)
    expect(h[0].name).toBe("Alex Rivera")
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
    "       Sample Person     100000000000  100000000000@s.example.net",
    "vip    Other Person      33000000000   33000000000@s.example.net",
  ].join("\n")

  it("reads from the right, so an empty ALIAS does not shift the columns", () => {
    const r = parseContactsTable(table)
    expect(r).toHaveLength(2)
    expect(r[0].name).toBe("Sample Person")
    expect(r[0].fields.phone).toBe("+100000000000")
    expect(r[1].name).toBe("Other Person")
  })

  it("derives country from the dialling prefix", () => {
    const r = parseContactsTable(table)
    expect(r[0].fields.country).toBe("US/Canada")
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
      { name: "Sample Person", source: "wacli", fields: { phone: "+100000000000" } },
    ]))
    expect(md).toContain("**Sample Person**")
    expect(md).toContain("`+100000000000`")
    expect(md).toContain("_(wacli)_")
    expect(md).toContain("verbatim")
    // Absorb's default disposition is to summarise; the block has to say
    // outright that a value is not a thing to summarise.
    expect(md).toMatch(/Do not paraphrase/i)
  })
})

describe("extractHints — known people found in entry bodies", () => {
  // `context` names a person only on one-to-one channels. On a GitLab
  // entry it is the issue title; in a group chat it is the group. The
  // people who talk in groups were never looked up at all.
  const groupEntry = {
    context: "Team Group",
    content: "Alex Rivera: heads up, the deploy is tonight. Dana Okonkwo will cover.",
  }

  it("finds a known person named only in the body", () => {
    const h = extractHints([groupEntry], { known: ["Alex Rivera"] })
    expect(h.map((x) => x.name)).toContain("Alex Rivera")
    expect(h.find((x) => x.name === "Alex Rivera")?.origin).toBe("body")
  })

  it("ignores a name the wiki has no article for", () => {
    // Harvesting capitalised pairs out of free text would spend lookups
    // on noise and resolve strangers. Only the corpus's own people count.
    const h = extractHints([groupEntry], { known: ["Alex Rivera"] })
    expect(h.map((x) => x.name)).not.toContain("Dana Okonkwo")
  })

  it("does not invent a hint when the known person is absent from the batch", () => {
    const h = extractHints([{ context: "Team Group", content: "nothing relevant here" }], {
      known: ["Alex Rivera"],
    })
    expect(h).toEqual([])
  })

  it("matches case-insensitively", () => {
    const h = extractHints([{ context: "g", content: "spoke to alex rivera today" }], {
      known: ["Alex Rivera"],
    })
    expect(h.map((x) => x.name)).toEqual(["Alex Rivera"])
  })

  it("prefers the context hint and does not duplicate the person", () => {
    const h = extractHints([{ context: "Alex Rivera", content: "Alex Rivera said hello" }], {
      known: ["Alex Rivera"],
    })
    expect(h).toHaveLength(1)
    expect(h[0].origin).toBe("context")
  })

  it("ignores blank and one-character dictionary entries", () => {
    const h = extractHints([{ context: "g", content: "a b c" }], { known: ["", " ", "a"] })
    expect(h).toEqual([])
  })

  it("still respects the cap once bodies are scanned", () => {
    const known = Array.from({ length: 40 }, (_, i) => `Person Number${i}`)
    const content = known.join(", ")
    const h = extractHints([{ context: "g", content }], { known, max: 5 })
    expect(h).toHaveLength(5)
  })
})

describe("isPersonName — group names are not people", () => {
  it("rejects a group chat whose name is shaped like a person's", () => {
    // A group's `context` is its name, and plenty look exactly like a
    // two-word person name. Treating one as a person spends a lookup and
    // risks matching a real contact with a similar name.
    for (const s of ["Team Group", "Acme Family", "Dev Channel", "Support Room", "Sales Team"]) {
      expect(isPersonName(s), s).toBe(false)
    }
  })

  it("still accepts a person whose name merely sits near such words", () => {
    expect(isPersonName("Alex Rivera")).toBe(true)
    expect(isPersonName("Dana Okonkwo")).toBe(true)
  })
})

describe("memoizeAvailability", () => {
  it("probes once however many lookups follow", async () => {
    const { memoizeAvailability } = await import("../../src/wiki/facts")
    let probes = 0
    const src = memoizeAvailability({
      name: "slow", provides: [],
      available: async () => { probes++; return null },
      lookup: async () => [{ name: "Sample Person", source: "slow", fields: { email: "s@example.com" } }],
    })
    for (let i = 0; i < 5; i++) await resolveFacts([{ name: "Sample Person" }], { sources: [src] })
    expect(probes).toBe(1)
  })

  it("caches an unavailable verdict too, without calling lookup", async () => {
    const { memoizeAvailability } = await import("../../src/wiki/facts")
    let probes = 0
    const lookup = vi.fn(async () => [])
    const src = memoizeAvailability({
      name: "off", provides: [],
      available: async () => { probes++; return { kind: "not-installed" as const, hint: "install" } },
      lookup,
    })
    await resolveFacts([{ name: "Sample Person" }], { sources: [src] })
    await resolveFacts([{ name: "Sample Person" }], { sources: [src] })
    expect(probes).toBe(1)
    expect(lookup).not.toHaveBeenCalled()
  })

  it("shares one probe between concurrent callers instead of racing", async () => {
    const { memoizeAvailability } = await import("../../src/wiki/facts")
    let probes = 0
    const src = memoizeAvailability({
      name: "s", provides: [],
      available: async () => { probes++; await new Promise((r) => setTimeout(r, 5)); return null },
      lookup: async () => [],
    })
    await Promise.all([src.available(), src.available(), src.available()])
    expect(probes).toBe(1)
  })
})

describe("gitlab source availability", () => {
  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const saved: Record<string, string | undefined> = {}
    for (const k of Object.keys(env)) { saved[k] = process.env[k]; 
      if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]! }
    try { await fn() } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!
      }
    }
  }

  it("asks for a host rather than guessing one", async () => {
    const { createGitlabSource } = await import("../../src/wiki/facts")
    await withEnv({ GITLAB_URL: undefined, GITLAB_ADMIN_TOKEN: "t", GITLAB_TOKEN: undefined }, async () => {
      const why = await createGitlabSource().available()
      expect(why?.kind).toBe("not-configured")
      expect(why?.hint).toContain("GITLAB_URL")
    })
  })

  it("reports a rejected token instead of returning silence", async () => {
    // A present-but-bad token makes every lookup empty, which reads as
    // "nobody is in GitLab" and quietly hollows out the corpus.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 401 }) as never,
    )
    try {
      const { createGitlabSource } = await import("../../src/wiki/facts")
      const why = await createGitlabSource({ baseUrl: "https://git.example.com", token: "bad" }).available()
      expect(why?.kind).toBe("not-configured")
      expect(why?.hint).toMatch(/401|rejected/i)
    } finally { fetchSpy.mockRestore() }
  })

  it("is healthy when the probe authenticates", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), { status: 200 }) as never,
    )
    try {
      const { createGitlabSource } = await import("../../src/wiki/facts")
      expect(await createGitlabSource({ baseUrl: "https://git.example.com", token: "ok" }).available()).toBeNull()
    } finally { fetchSpy.mockRestore() }
  })

  it("reports an unreachable host as failed, not as a config error", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ENOTFOUND"))
    try {
      const { createGitlabSource } = await import("../../src/wiki/facts")
      const why = await createGitlabSource({ baseUrl: "https://git.example.com", token: "ok" }).available()
      expect(why?.kind).toBe("failed")
    } finally { fetchSpy.mockRestore() }
  })
})
