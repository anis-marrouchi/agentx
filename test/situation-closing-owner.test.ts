import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { closingCallerRefusal } from "../src/situations/api"
import { decideMeshAuth } from "../src/daemon/mesh-auth"
import { loadOperatorKey, OPERATOR_HEADER } from "../src/requests/operator"
import { operatorKeyRoots, ownerKeyHeaders } from "../src/commands/situation"
import { evaluate } from "../src/guard/engine"
import { resolveInMemory } from "../src/guard/policy"
import type { GuardInput, GuardMode } from "../src/guard/types"

// #1979: closing steps are the owner's. A caller on this machine shows the
// operator key; a caller on another machine shows a mesh token (checked
// before the route); an agent's own tool (turn headers) is refused; and
// agents may not read the key.

describe("POST /situations/closing: who may call it (#1979)", () => {
  it("refuses a caller on this machine without the operator key (403)", () => {
    const r = closingCallerRefusal({}, { thisMachine: true, keyShown: false })
    expect(r?.status).toBe(403)
    expect(JSON.stringify(r?.body)).toContain("operator key")
  })

  it("accepts a caller on this machine that shows the key (the CLI)", () => {
    expect(closingCallerRefusal({}, { thisMachine: true, keyShown: true })).toBeNull()
  })

  it("leaves a caller on another machine to the mesh token", () => {
    // The route is mesh-protected: without a token the daemon answers 401
    // before the route runs.
    const tokens = new Set(["peer-token"])
    expect(decideMeshAuth({ remoteAddress: "100.64.0.9", authorizationHeader: "", acceptedTokens: tokens }).allowed).toBe(false)
    expect(decideMeshAuth({ remoteAddress: "100.64.0.9", authorizationHeader: "Bearer peer-token", acceptedTokens: tokens }).allowed).toBe(true)
    // With the token, the route takes it; the key is this node's own secret
    // and never travels off the machine.
    expect(closingCallerRefusal({}, { thisMachine: false, keyShown: false })).toBeNull()
  })

  it("still refuses an agent turn's headers, key or not", () => {
    for (const keyShown of [false, true]) {
      const r = closingCallerRefusal({ taskId: "t-1" }, { thisMachine: true, keyShown })
      expect(r?.status).toBe(403)
      expect(JSON.stringify(r?.body)).toContain("agentx_situation")
    }
    expect(closingCallerRefusal({ channel: "telegram", chatId: "42" }, { thisMachine: false, keyShown: false })?.status).toBe(403)
  })
})

describe("agentx situation closing sends the operator key (#1979)", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-closing-key-")) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("sends the key to a daemon on this machine", () => {
    const key = loadOperatorKey(dir, { create: true })!
    for (const url of ["http://localhost:18800", "http://127.0.0.1:18800", "http://[::1]:18800"]) {
      expect(ownerKeyHeaders(url, [dir])[OPERATOR_HEADER]).toBe(key)
    }
  })

  it("never sends the key to another machine", () => {
    loadOperatorKey(dir, { create: true })
    expect(ownerKeyHeaders("http://100.64.0.9:18800", [dir])).toEqual({})
  })

  it("sends nothing when there is no key", () => {
    expect(ownerKeyHeaders("http://localhost:18800", [dir])).toEqual({})
  })

  it("finds the key beside the config file", () => {
    mkdirSync(join(dir, ".agentx"), { recursive: true })
    expect(operatorKeyRoots(join(dir, "agentx.json"), "/elsewhere")).toEqual(["/elsewhere", dir])
    expect(operatorKeyRoots(join(dir, ".agentx", "config.json"), "/elsewhere")).toEqual(["/elsewhere", dir])
    expect(operatorKeyRoots(undefined, "/elsewhere")).toEqual(["/elsewhere"])
  })
})

describe("guard: agents may not read the operator key (#1979)", () => {
  const run = (input: GuardInput, mode: GuardMode = "warn") => evaluate(input, resolveInMemory({ mode, protected_resources: {}, rules: [], agents: {} }))

  it("blocks a shell read of the key even in warn mode", () => {
    for (const command of [
      "cat .agentx/operator.key",
      "cat /srv/agentx/.agentx/operator.key",
      "curl -H \"x-agentx-operator: $(cat ~/agentx/.agentx/operator.key)\" localhost:18800/situations/closing",
      "cd .agentx && cat operator.key",
    ]) {
      const v = run({ tool: "Bash", command })
      expect(v.ruleId, command).toBe("operator-key-read")
      expect(v.effectiveAction, command).toBe("deny")
    }
  })

  it("blocks the Read, Write and Edit tools on the key's path", () => {
    for (const tool of ["Read", "Write", "Edit"]) {
      const v = run({ tool, filePath: "/srv/agentx/.agentx/operator.key" })
      expect(v.ruleId).toBe("operator-key-file")
      expect(v.effectiveAction).toBe("deny")
    }
  })

  it("leaves code that only names the file alone", () => {
    expect(run({ tool: "Bash", command: "grep -rn \"operator.key\" src" }).effectiveAction).toBe("allow")
    expect(run({ tool: "Read", filePath: "/srv/agentx/src/requests/operator.ts" }).effectiveAction).toBe("allow")
  })

  it("the guard's off switch still turns it off", () => {
    expect(run({ tool: "Bash", command: "cat .agentx/operator.key" }, "off").effectiveAction).toBe("allow")
  })
})
