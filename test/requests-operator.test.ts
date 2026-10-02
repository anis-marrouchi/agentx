import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, statSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { isOperatorTurn, isThisMachine, loadOperatorKey, operatorContext, operatorKeyMatches, operatorKeyPath, operatorVouch, ownerProven, peerVouches, OPERATOR_VOUCH_HEADER } from "../src/requests/operator"
import { OPERATOR_CHANNELS } from "../src/requests/tracker"

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

describe("a peer vouching for the owner (#407)", () => {
  const key = "k".repeat(64)

  it("vouches on a forward only for an owner surface whose caller showed this node's key", () => {
    expect(operatorVouch({ channel: "app" }, { "x-agentx-operator": key }, key, OPERATOR_CHANNELS)).toBe(true)
    expect(operatorVouch({ channel: "voice" }, { "x-agentx-operator": key }, key, OPERATOR_CHANNELS)).toBe(true)
    // An agent on this node naming the channel without the key.
    expect(operatorVouch({ channel: "app" }, {}, key, OPERATOR_CHANNELS)).toBe(false)
    expect(operatorVouch({ channel: "app" }, { "x-agentx-operator": "wrong" }, key, OPERATOR_CHANNELS)).toBe(false)
    // Not an owner surface at all.
    expect(operatorVouch({ channel: "telegram" }, { "x-agentx-operator": key }, key, OPERATOR_CHANNELS)).toBe(false)
    expect(operatorVouch(undefined, { "x-agentx-operator": key }, key, OPERATOR_CHANNELS)).toBe(false)
  })

  it("is believed only with one of this node's peer tokens", () => {
    const peers = ["agx_live_peer_a", "agx_live_peer_b"]
    const h = (bearer?: string, vouch?: string) => ({ ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(vouch ? { [OPERATOR_VOUCH_HEADER]: vouch } : {}) })
    expect(peerVouches(h("agx_live_peer_b", "1"), peers)).toBe(true)
    // The header alone, as a loopback caller could send it.
    expect(peerVouches(h(undefined, "1"), peers)).toBe(false)
    // A token this node does not list as a peer's (the dashboard token, say).
    expect(peerVouches(h("agx_live_dashboard", "1"), peers)).toBe(false)
    // A peer token without the vouch is an ordinary forward.
    expect(peerVouches(h("agx_live_peer_a"), peers)).toBe(false)
    expect(peerVouches(h("agx_live_peer_a", "yes"), peers)).toBe(false)
    expect(peerVouches(h("agx_live_peer_a", "1"), [])).toBe(false)
    expect(peerVouches(h("agx_live_peer_a", "1"), ["", undefined as any])).toBe(false)
  })
})

// The rule POST /task applies, with the caller's address: the mesh token
// is in every agent's environment, so a caller on this machine could
// send the vouch itself.
describe("who /task believes (#407)", () => {
  const key = "k".repeat(64)
  const node = { key, peerTokens: ["agx_live_peer_a"], operatorChannels: OPERATOR_CHANNELS, ownAddresses: ["100.64.0.2", "fe80::1%en0"] }
  const vouch = { authorization: "Bearer agx_live_peer_a", [OPERATOR_VOUCH_HEADER]: "1" }
  const app = { channel: "app" }

  it("believes a peer's vouch from another machine", () => {
    expect(ownerProven(app, { headers: vouch, remoteAddress: "100.64.0.7" }, node)).toBe(true)
    expect(ownerProven(app, { headers: vouch, remoteAddress: "::ffff:100.64.0.7" }, node)).toBe(true)
  })

  it("never believes a vouch from this machine, whichever address it dials", () => {
    for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.2", "100.64.0.2", "::ffff:100.64.0.2", "fe80::1", undefined, ""]) {
      expect(ownerProven(app, { headers: vouch, remoteAddress }, node)).toBe(false)
    }
  })

  it("still believes the operator key from this machine, and only on an owner surface", () => {
    expect(ownerProven(app, { headers: { "x-agentx-operator": key }, remoteAddress: "127.0.0.1" }, node)).toBe(true)
    expect(ownerProven({ channel: "telegram" }, { headers: { "x-agentx-operator": key }, remoteAddress: "127.0.0.1" }, node)).toBe(false)
    expect(ownerProven({ channel: "telegram" }, { headers: vouch, remoteAddress: "100.64.0.7" }, node)).toBe(false)
    expect(ownerProven(undefined, { headers: vouch, remoteAddress: "100.64.0.7" }, node)).toBe(false)
  })

  it("counts this machine's real addresses as local by default", () => {
    expect(isThisMachine("127.0.0.1")).toBe(true)
    expect(isThisMachine("203.0.113.9")).toBe(false)
  })
})
