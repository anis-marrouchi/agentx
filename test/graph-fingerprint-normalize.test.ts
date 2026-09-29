import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { GraphStore, normalizeForFingerprint } from "../src/graph/store"

// 89% of classifications missed the fingerprint cache: the key was the
// exact text plus the sender, and two requests of the same kind never
// share those. The key now folds identifiers, numbers, links and
// mentions away and drops the sender.

let tmp: string
let store: GraphStore
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-fp-"))
  store = new GraphStore({ baseDir: tmp, log: () => undefined })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe("normalizeForFingerprint", () => {
  it("folds links, references, hashes and numbers", () => {
    expect(normalizeForFingerprint("Please review MR !957 at https://git.example/x/-/merge_requests/957 (sha a1b2c3d4e)"))
      .toBe("please review mr num at url sha id")
  })
  it("is case and punctuation insensitive", () => {
    expect(normalizeForFingerprint("Deploy   v2 to STAGING, please!")).toBe(normalizeForFingerprint("deploy v2 to staging please"))
  })
})

describe("GraphStore.fingerprint", () => {
  it("matches the same request about different items from different people", () => {
    const a = store.fingerprint({ text: "@coder please review MR #12 https://git.example/a/-/merge_requests/12", channel: "gitlab", sender: "alice" })
    const b = store.fingerprint({ text: "@coder Please review MR #340 https://git.example/b/-/merge_requests/340", channel: "gitlab", sender: "bob" })
    expect(a).toBe(b)
  })
  it("still separates channels and different wording", () => {
    const base = { text: "deploy to staging", sender: "alice" }
    expect(store.fingerprint({ ...base, channel: "gitlab" })).not.toBe(store.fingerprint({ ...base, channel: "telegram" }))
    expect(store.fingerprint({ text: "deploy to staging", channel: "gitlab" })).not.toBe(store.fingerprint({ text: "roll back staging", channel: "gitlab" }))
  })
})
