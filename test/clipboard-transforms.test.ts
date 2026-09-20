import { describe, it, expect } from "vitest"
import {
  TRANSFORMS, applicable, previewFor, looksSecret,
} from "../src/clipboard/transforms"

// The deterministic half of smart paste.
//
// This is the half worth pinning. Which transform gets PICKED is a model's
// judgement and is measured by running it; what each transform DOES, and
// which ones are even offered, is code and must not drift.
//
// The offering rule matters as much as the transforms: a model handed an
// option that cannot work will pick it anyway, so `applicable` only
// returns transforms that change this particular text.

const by = (id: string) => TRANSFORMS.find((t) => t.id === id)!

describe("transforms", () => {
  it("strips tracking parameters and keeps the real ones", () => {
    expect(by("cleanUrl").apply("https://example.com/p?utm_source=x&id=42&utm_campaign=y"))
      .toBe("https://example.com/p?id=42")
  })

  it("leaves a clean url alone rather than reporting a no-op change", () => {
    // Returning the input unchanged would put a pointless option in front
    // of the model and invite it to "do something".
    expect(by("cleanUrl").apply("https://example.com/p?id=42")).toBeNull()
  })

  it("does not treat arbitrary text as a url", () => {
    expect(by("cleanUrl").apply("see https://example.com?utm_source=x for more")).toBeNull()
  })

  it("unwraps hard-wrapped prose but keeps paragraph breaks", () => {
    const wrapped = [
      "The quick brown fox jumps over the lazy dog and then",
      "continues running across the field toward the distant",
      "treeline where it stops.",
      "",
      "A second paragraph that was also wrapped by the exporter",
      "and continues onto another line here.",
    ].join("\n")
    const out = by("unwrap").apply(wrapped)!
    expect(out.split("\n\n")).toHaveLength(2)
    expect(out).toContain("and then continues running")
  })

  it("does not unwrap lines that are already whole sentences", () => {
    // A list of complete sentences is not wrapped prose, and joining it
    // would destroy the author's line breaks.
    const sentences = "First line here.\nSecond line here.\nThird line here."
    expect(by("unwrap").apply(sentences)).toBeNull()
  })

  it("makes a bullet list, and refuses when it is already one", () => {
    expect(by("bullets").apply("alpha\nbeta")).toBe("- alpha\n- beta")
    expect(by("bullets").apply("- alpha\n- beta")).toBeNull()
    expect(by("bullets").apply("1. alpha\n2. beta")).toBeNull()
  })

  it("pretty-prints only text that is really JSON", () => {
    expect(by("prettyJson").apply('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(by("prettyJson").apply("{not json}")).toBeNull()
    expect(by("prettyJson").apply("just a sentence")).toBeNull()
  })

  it("slugs a title but refuses multi-line or overlong text", () => {
    expect(by("slug").apply("Déploiement: Staging Notes!")).toBe("deploiement-staging-notes")
    expect(by("slug").apply("one\ntwo")).toBeNull()
    expect(by("slug").apply("x".repeat(120))).toBeNull()
  })
})

describe("applicable", () => {
  it("always offers asIs, and only offers what changes the text", () => {
    const offered = applicable("https://example.com/p?utm_source=x&id=42").map((o) => o.transform.id)
    expect(offered).toContain("asIs")
    expect(offered).toContain("cleanUrl")
    // Nothing that would hand back the input unchanged.
    expect(offered).not.toContain("prettyJson")
    expect(offered).not.toContain("bullets")
  })

  it("offers only the always-applicable wrappers for a plain word", () => {
    // quote and codeFence genuinely apply to anything, so they are
    // legitimately on offer; what must NOT appear are the shape-specific
    // transforms, which would be inapplicable options inviting a pick.
    const offered = applicable("hello").map((o) => o.transform.id)
    expect(offered).toContain("asIs")
    for (const id of ["cleanUrl", "prettyJson", "unwrap", "bullets", "collapseSpace"]) {
      expect(offered).not.toContain(id)
    }
  })
})

describe("previewFor", () => {
  it("passes short text through whole", () => {
    expect(previewFor("short")).toBe("short")
  })

  it("keeps head and tail and drops the middle", () => {
    // The seat needs the SHAPE of the clipboard, never all of its
    // contents — this is the buffer passwords live in.
    const long = "A".repeat(200) + "MIDDLE" + "B".repeat(200)
    const preview = previewFor(long, 100)
    expect(preview).toContain("more characters")
    expect(preview).not.toContain("MIDDLE")
    expect(preview.length).toBeLessThan(long.length)
  })
})

describe("looksSecret", () => {
  it("catches the token shapes that must never be reformatted", () => {
    // Checked in code, before any preview leaves the process — "do not
    // mangle my password" is not a judgement to delegate to a model.
    expect(looksSecret("sk-proj-AbC123dEfG456hIjK789lMnO012pQrS345tUvW")).toBe(true)
    expect(looksSecret("glpat-AbC123dEfG456hIjK789l")).toBe(true)
    expect(looksSecret("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc")).toBe(true)
  })

  it("does not flag ordinary text, prose or urls", () => {
    expect(looksSecret("review the deploy script")).toBe(false)
    expect(looksSecret("https://example.com/some/Path123")).toBe(false)
    expect(looksSecret("The quick brown fox jumps over the lazy dog.")).toBe(false)
  })
})
