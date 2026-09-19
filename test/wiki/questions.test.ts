import { mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { beforeEach, describe, expect, it } from "vitest"
import { QuestionStore, questionId } from "../../src/wiki/questions"

let dir: string
let store: QuestionStore
beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "wikiq-"))
  store = new QuestionStore(dir)
})

const fieldQ = (subject: string, field: string) => ({
  kind: "field" as const,
  agentId: "a",
  path: `people/${subject}.md`,
  subject,
  field,
  tier: "openings",
  question: `What is ${subject}'s ${field}?`,
})

describe("QuestionStore", () => {
  it("starts empty and does not create a file until something is asked", () => {
    expect(store.list()).toEqual([])
    expect(() => readFileSync(store.path)).toThrow()
  })

  it("adds questions and marks them open", () => {
    const r = store.add([fieldQ("alex", "language")])
    expect(r).toEqual({ added: 1, skipped: 0 })
    const [q] = store.list()
    expect(q.status).toBe("open")
    expect(q.asked).toBeTruthy()
    expect(q.id).toHaveLength(12)
  })

  it("is idempotent — asking the same thing twice adds nothing", () => {
    store.add([fieldQ("alex", "language")])
    expect(store.add([fieldQ("alex", "language")])).toEqual({ added: 0, skipped: 1 })
    expect(store.list()).toHaveLength(1)
  })

  it("never re-asks something already answered or dismissed", () => {
    // Re-asking what a person has dealt with is how a queue becomes
    // noise and then gets ignored.
    store.add([fieldQ("alex", "language")])
    const [q] = store.list()
    store.resolve(q.id, "dismissed")
    expect(store.add([fieldQ("alex", "language")])).toEqual({ added: 0, skipped: 1 })
    expect(store.list("open")).toEqual([])
    expect(store.list("dismissed")).toHaveLength(1)
  })

  it("distinguishes two fields on the same subject", () => {
    store.add([fieldQ("alex", "language"), fieldQ("alex", "ourOwner")])
    expect(store.list()).toHaveLength(2)
  })

  it("records an answer and returns the question so the caller can apply it", () => {
    store.add([fieldQ("alex", "language")])
    const [q] = store.list()
    const resolved = store.resolve(q.id, "answered", "French")!
    expect(resolved.field).toBe("language")
    expect(resolved.path).toBe("people/alex.md")
    expect(store.list("answered")[0].answer).toBe("French")
  })

  it("accepts an unambiguous id prefix, which is what a person will type", () => {
    store.add([fieldQ("alex", "language")])
    const [q] = store.list()
    expect(store.resolve(q.id.slice(0, 6), "answered", "French")?.id).toBe(q.id)
  })

  it("returns null for an unknown id rather than throwing", () => {
    expect(store.resolve("nope", "answered", "x")).toBeNull()
  })

  it("survives a corrupt queue file instead of breaking the absorb", () => {
    writeFileSync(store.path, "{ not json")
    expect(store.list()).toEqual([])
    expect(store.add([fieldQ("alex", "language")]).added).toBe(1)
  })

  it("filters by status", () => {
    store.add([fieldQ("alex", "language"), fieldQ("dana", "ourOwner")])
    store.resolve(store.list()[0].id, "answered", "French")
    expect(store.list("open")).toHaveLength(1)
    expect(store.list("answered")).toHaveLength(1)
  })

  it("keeps missing-article questions separate from field questions", () => {
    store.add([
      { kind: "article", agentId: "a", path: "", subject: "Acme Corp", question: "No article for Acme Corp" },
      fieldQ("alex", "language"),
    ])
    expect(store.list().map((q) => q.kind).sort()).toEqual(["article", "field"])
  })
})

describe("questionId", () => {
  it("is stable across runs and case-insensitive on the subject", () => {
    expect(questionId("field", "a", "Alex", "role")).toBe(questionId("field", "a", "alex", "role"))
  })

  it("separates kinds, agents and fields", () => {
    const base = questionId("field", "a", "alex", "role")
    expect(questionId("article", "a", "alex", "role")).not.toBe(base)
    expect(questionId("field", "b", "alex", "role")).not.toBe(base)
    expect(questionId("field", "a", "alex", "language")).not.toBe(base)
  })
})
