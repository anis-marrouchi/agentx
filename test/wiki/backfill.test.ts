import { describe, expect, it } from "vitest"
import { backfillArticle, patchIdentityField, renderValue } from "../../src/wiki/backfill"
import type { MergedEntity } from "../../src/wiki/facts"

const entity = (fields: Record<string, { value: string; source: string }>): MergedEntity =>
  ({ name: "Alex Rivera", fields })

const resolved = entity({
  phone: { value: "+10000000000", source: "wacli" },
  whatsapp: { value: "10000000000@s.example.net", source: "wacli" },
  email: { value: "alex@example.com", source: "gitlab" },
  country: { value: "Tunisia", source: "wacli" },
})

const WITH_IDENTITY = `---
title: Alex Rivera
---

Alex Rivera is a contact.

## Identity
- **Role or job title:** unknown.
- **Organisation and position:** unknown.
- **Contact identifiers:** unknown. Posts in a group; no number is recorded.
- **Preferred language:** unknown.

## Why it matters

Something.
`

describe("renderValue", () => {
  it("joins every fact feeding one field, each attributed", () => {
    const v = renderValue(resolved, ["phone", "email"])!
    expect(v).toContain("+10000000000 (phone, via wacli)")
    expect(v).toContain("alex@example.com (email, via gitlab)")
  })

  it("returns null when no source answered — nothing to write", () => {
    expect(renderValue(entity({}), ["phone", "email"])).toBeNull()
  })

  it("skips blank values rather than emitting an empty attribution", () => {
    const v = renderValue(entity({ phone: { value: "  ", source: "wacli" } }), ["phone"])
    expect(v).toBeNull()
  })
})

describe("patchIdentityField", () => {
  it("replaces an existing unknown bullet in place", () => {
    const r = patchIdentityField(WITH_IDENTITY, "contactValue", "+10000000000 (phone, via wacli)")!
    expect(r.replaced).toBe(true)
    expect(r.content).toContain("- **Contact identifiers:** +10000000000 (phone, via wacli)")
    expect(r.content).not.toContain("no number is recorded")
    // Neighbouring bullets untouched.
    expect(r.content).toContain("- **Preferred language:** unknown.")
  })

  it("is idempotent — re-running writes nothing and so cuts no new version", () => {
    const once = patchIdentityField(WITH_IDENTITY, "contactValue", "+10000000000 (phone, via wacli)")!
    expect(patchIdentityField(once.content, "contactValue", "+10000000000 (phone, via wacli)")).toBeNull()
  })

  it("adds the bullet when the section exists but the field does not", () => {
    const stripped = WITH_IDENTITY.replace(/- \*\*Contact identifiers.*\n/, "")
    const r = patchIdentityField(stripped, "contactValue", "+10000000000 (phone, via wacli)")!
    expect(r.replaced).toBe(false)
    expect(r.content).toContain("- **Contact identifiers:** +10000000000")
    // Inserted inside Identity, not after the next heading.
    const idx = r.content.indexOf("Contact identifiers")
    expect(idx).toBeLessThan(r.content.indexOf("## Why it matters"))
  })

  it("creates an Identity section for an article written before the tier work", () => {
    const old = `---\ntitle: Alex Rivera\n---\n\nAlex Rivera is a contact.\n\n## History\n\nStuff.\n`
    const r = patchIdentityField(old, "contactValue", "+10000000000 (phone, via wacli)")!
    expect(r.content).toContain("## Identity")
    // After the opening definition, before the first existing section —
    // identity follows "what this is" rather than displacing it.
    expect(r.content.indexOf("Alex Rivera is a contact")).toBeLessThan(r.content.indexOf("## Identity"))
    expect(r.content.indexOf("## Identity")).toBeLessThan(r.content.indexOf("## History"))
  })

  it("matches a differently-worded heading, since a model wrote them", () => {
    const variant = WITH_IDENTITY.replace("**Contact identifiers:**", "**How to reach him:**")
    const r = patchIdentityField(variant, "contactValue", "+10000000000 (phone, via wacli)")!
    expect(r.replaced).toBe(true)
    expect(r.content).not.toContain("How to reach him")
  })

  it("does not let the role matcher claim the organisation bullet", () => {
    // "Organisation and position" contains "position"; a naive role
    // matcher would overwrite the organisation line with a job title.
    const r = patchIdentityField(WITH_IDENTITY, "role", "Engineer (role, via gitlab)")!
    expect(r.content).toContain("- **Role or job title:** Engineer (role, via gitlab)")
    expect(r.content).toContain("- **Organisation and position:** unknown.")
  })

  it("returns null for a field that is not backfillable", () => {
    expect(patchIdentityField(WITH_IDENTITY, "whyItMatters", "because")).toBeNull()
  })
})

describe("backfillArticle", () => {
  it("fills only the fields the grader reported missing", () => {
    const r = backfillArticle(WITH_IDENTITY, resolved, ["contactValue"])
    expect(r.edits.map((e) => e.field)).toEqual(["contactValue"])
    expect(r.content).toContain("+10000000000")
    // role was also "unknown" but was not in `missing`, so it stands.
    expect(r.content).toContain("- **Role or job title:** unknown.")
  })

  it("leaves a present field alone even when a source disagrees", () => {
    // The article may carry a better-sourced fact than the directory
    // does; the wiki corrects the systems, not the reverse.
    const withValue = WITH_IDENTITY.replace(
      "- **Contact identifiers:** unknown. Posts in a group; no number is recorded.",
      "- **Contact identifiers:** +10000000000 (confirmed in person)",
    )
    const r = backfillArticle(withValue, resolved, [])
    expect(r.edits).toEqual([])
    expect(r.content).toContain("+10000000000")
  })

  it("writes nothing when the sources answered nothing", () => {
    const r = backfillArticle(WITH_IDENTITY, entity({}), ["contactValue", "role"])
    expect(r.edits).toEqual([])
    expect(r.content).toBe(WITH_IDENTITY)
  })

  it("applies several fields in one pass without disturbing each other", () => {
    const full = entity({
      phone: { value: "+10000000000", source: "wacli" },
      organisation: { value: "Acme", source: "gitlab" },
      role: { value: "Engineer", source: "gitlab" },
    })
    const r = backfillArticle(WITH_IDENTITY, full, ["contactValue", "organisation", "role"])
    expect(r.edits.map((e) => e.field)).toEqual(["contactValue", "organisation", "role"])
    expect(r.content).toContain("- **Contact identifiers:** +10000000000 (phone, via wacli)")
    expect(r.content).toContain("- **Organisation and position:** Acme (organisation, via gitlab)")
    expect(r.content).toContain("- **Role or job title:** Engineer (role, via gitlab)")
  })

  it("is idempotent across a whole article", () => {
    const once = backfillArticle(WITH_IDENTITY, resolved, ["contactValue"])
    const twice = backfillArticle(once.content, resolved, ["contactValue"])
    expect(twice.edits).toEqual([])
    expect(twice.content).toBe(once.content)
  })
})

describe("IDENTITY_SLOTS — the human answer path", () => {
  it("can write a field no lookup can supply", async () => {
    // A person answering "what language does she prefer" has produced a
    // fact that belongs in the article as much as a number does. Without
    // a slot it would be recorded on the queue and never reach the wiki.
    const r = patchIdentityField(WITH_IDENTITY, "language", "French (answered by operator)")!
    expect(r.replaced).toBe(true)
    expect(r.content).toContain("- **Preferred language:** French (answered by operator)")
  })

  it("covers the fields the grader says need a person", async () => {
    const { IDENTITY_SLOTS, REQUIRED_FIELDS, FIELD_SOURCES } =
      await import("../../src/decisions/seats/article-fields")
    // Every person field with no fact source is one only a human can
    // answer, so each needs somewhere to put the answer.
    for (const f of REQUIRED_FIELDS.person) {
      if ((FIELD_SOURCES[f.key] ?? []).length > 0) continue
      if (f.key === "whatItIs" || f.key === "whyItMatters" || f.key === "relationships") continue
      expect(IDENTITY_SLOTS[f.key], f.key).toBeTruthy()
    }
  })

  it("is a superset of what a machine may write unasked", async () => {
    const { IDENTITY_SLOTS, BACKFILLABLE } = await import("../../src/decisions/seats/article-fields")
    for (const k of Object.keys(BACKFILLABLE)) expect(IDENTITY_SLOTS[k], k).toBeTruthy()
  })

  it("still refuses a field with no defined place", () => {
    // Guessing a location in the source of truth is worse than leaving
    // the answer where a person can see it.
    expect(patchIdentityField(WITH_IDENTITY, "whyItMatters", "because")).toBeNull()
  })
})
