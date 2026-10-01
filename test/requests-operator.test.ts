import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, statSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { isOperatorTurn, loadOperatorKey, operatorContext, operatorKeyMatches, operatorKeyPath } from "../src/requests/operator"

// A turn on this node's own surfaces counts as the owner's only when the
// daemon marked it: a mark a JSON body cannot carry, or the operator key
// the dashboard process shows on /task (#393).

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-operator-")) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("the operator mark", () => {
  it("is set by the daemon and cannot arrive in a request body", () => {
    const ctx = operatorContext({ channel: "dashboard", chatId: "assistant", sender: "operator" })
    expect(isOperatorTurn(ctx)).toBe(true)
    expect(isOperatorTurn(JSON.parse(JSON.stringify(ctx)))).toBe(false)
    expect(isOperatorTurn({ channel: "dashboard", operator: true })).toBe(false)
    expect(isOperatorTurn(undefined)).toBe(false)
  })
})

describe("the operator key", () => {
  it("is absent until the daemon creates it, then readable by this user only", () => {
    expect(loadOperatorKey(dir)).toBeNull()
    const key = loadOperatorKey(dir, { create: true })!
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(operatorKeyPath(dir)).mode & 0o777).toBe(0o600)
    expect(readFileSync(operatorKeyPath(dir), "utf-8").trim()).toBe(key)
    // The dashboard process reads the same key, and a second daemon start keeps it.
    expect(loadOperatorKey(dir)).toBe(key)
    expect(loadOperatorKey(dir, { create: true })).toBe(key)
  })

  it("matches only the exact key", () => {
    const key = loadOperatorKey(dir, { create: true })!
    expect(operatorKeyMatches(key, key)).toBe(true)
    expect(operatorKeyMatches(key, [key])).toBe(true)
    expect(operatorKeyMatches(key, `${key}0`)).toBe(false)
    expect(operatorKeyMatches(key, key.slice(1))).toBe(false)
    expect(operatorKeyMatches(key, undefined)).toBe(false)
    expect(operatorKeyMatches(null, key)).toBe(false)
    expect(operatorKeyMatches(key, "")).toBe(false)
  })
})
