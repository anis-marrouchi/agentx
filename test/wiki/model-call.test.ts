import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { claudeModelCall, meteredModelCall } from "../../src/wiki/model-call"

let dir: string
let path: string | undefined

/** A `claude` on PATH that answers with `envelope` as its JSON output. */
function fakeClaude(envelope: string): void {
  const bin = join(dir, "claude")
  writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${envelope}'\n`)
  chmodSync(bin, 0o755)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "model-call-"))
  path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ""}`
})

afterEach(() => {
  process.env.PATH = path
  rmSync(dir, { recursive: true, force: true })
})

describe("metered model call", () => {
  it("adds up the cost each call reports and still returns only the text", async () => {
    fakeClaude('{"result":"hello","total_cost_usd":0.0125}')
    const spend = { calls: 0, usd: 0, unpriced: 0 }
    const call = meteredModelCall(spend)
    expect(await call("q", "haiku", 5000)).toBe("hello")
    expect(await call("q", "haiku", 5000)).toBe("hello")
    expect(spend).toEqual({ calls: 2, usd: 0.025, unpriced: 0 })
    expect(await claudeModelCall("q", "haiku", 5000)).toBe("hello")
  })

  it("counts a call that reports no cost as unpriced", async () => {
    fakeClaude('{"result":"hello"}')
    const spend = { calls: 0, usd: 0, unpriced: 0 }
    expect(await meteredModelCall(spend)("q", "haiku", 5000)).toBe("hello")
    expect(spend).toEqual({ calls: 1, usd: 0, unpriced: 1 })
  })
})
