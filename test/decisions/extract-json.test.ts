import { describe, it, expect } from "vitest"
import { extractJson } from "../../src/utils/extract-json"

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it("parses through a code fence", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it("finds an object buried in prose", () => {
    expect(extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 })
  })

  it("handles nested objects", () => {
    expect(extractJson('noise {"a":{"b":[1,2]}} more')).toEqual({ a: { b: [1, 2] } })
  })

  it("finds a top-level array", () => {
    expect(extractJson('here: [{"a":1}]')).toEqual([{ a: 1 }])
  })

  it("is not fooled by braces inside strings — the bug in the copies it replaces", () => {
    expect(extractJson('prose {"glob": "src/**/{a,b}", "n": 2} tail')).toEqual({
      glob: "src/**/{a,b}",
      n: 2,
    })
  })

  it("handles escaped quotes inside strings", () => {
    expect(extractJson('x {"q": "she said \\"hi}\\"", "n": 1} y')).toEqual({
      q: 'she said "hi}"',
      n: 1,
    })
  })

  it("returns null rather than throwing on junk", () => {
    for (const junk of ["", "no json here", "{unclosed", "{\"a\": }"]) {
      expect(extractJson(junk)).toBeNull()
    }
  })
})
