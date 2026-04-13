import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { applyConfigMutation, setAtPath, getAtPath, unsetAtPath } from "../src/daemon/config-mutator"
import { readDotEnv, setDotEnv, appendDotEnv, getDotEnv, unsetDotEnv } from "../src/utils/dotenv-mutator"

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentx-mut-"))
  const minimalConfig = {
    node: { id: "t", name: "T", bind: "127.0.0.1:0" },
    agents: {
      demo: {
        name: "Demo",
        workspace: "./agents/demo",
        tier: "claude-code",
        mentions: ["@demo"],
      },
    },
    channels: { telegram: { enabled: true, accounts: { default: { token: "${TG}", agentBinding: "demo" } } } },
    crons: {},
  }
  writeFileSync(join(dir, "agentx.json"), JSON.stringify(minimalConfig, null, 2))
  return dir
}

describe("applyConfigMutation", () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = makeTempProject()
    configPath = join(dir, "agentx.json")
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("applies a mutation, validates, writes, attempts reload", async () => {
    const result = await applyConfigMutation((cfg) => {
      cfg.agents.demo.model = "claude-haiku-4-5"
    }, { configPath })
    expect(result.success).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))
    expect(onDisk.agents.demo.model).toBe("claude-haiku-4-5")
    // reload fails (no daemon), but that's not a hard error
    expect(result.reloaded).toBe(false)
    expect(result.reloadSkipped).toBeTruthy()
  })

  it("rejects a mutation that violates the Zod schema and does NOT write", async () => {
    const before = readFileSync(join(dir, "agentx.json"), "utf-8")
    const result = await applyConfigMutation((cfg) => {
      // Invalid tier
      cfg.agents.demo.tier = "not-a-real-tier"
    }, { configPath })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Validation failed/)
    // On-disk unchanged
    expect(readFileSync(join(dir, "agentx.json"), "utf-8")).toBe(before)
  })

  it("dryRun skips the write", async () => {
    const before = readFileSync(join(dir, "agentx.json"), "utf-8")
    const result = await applyConfigMutation(
      (cfg) => { cfg.agents.demo.model = "claude-haiku-4-5" },
      { dryRun: true, configPath },
    )
    expect(result.success).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(readFileSync(join(dir, "agentx.json"), "utf-8")).toBe(before)
  })

  it("preserves ${VAR} tokens across a round-trip", async () => {
    await applyConfigMutation((cfg) => {
      cfg.agents.demo.model = "claude-sonnet-4-6"
    }, { configPath })
    const onDisk = JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))
    expect(onDisk.channels.telegram.accounts.default.token).toBe("${TG}")
  })

  it("fires POST /reload when a daemon is reachable (mocked fetch)", async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    globalThis.fetch = fetchMock as any
    try {
      const result = await applyConfigMutation((cfg) => {
        cfg.agents.demo.model = "claude-opus-4-6"
      }, { configPath })
      expect(result.success).toBe(true)
      expect(result.reloaded).toBe(true)
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/reload$/),
        expect.objectContaining({ method: "POST" }),
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("dot-path helpers", () => {
  it("set/get/unset work on a nested object", () => {
    const obj: any = { a: { b: { c: 1 } } }
    expect(getAtPath(obj, "a.b.c")).toBe(1)
    setAtPath(obj, "a.b.d", 42)
    expect(obj.a.b.d).toBe(42)
    setAtPath(obj, "x.y.z", "hi")
    expect(obj.x.y.z).toBe("hi")
    unsetAtPath(obj, "a.b.c")
    expect(obj.a.b.c).toBeUndefined()
  })
})

describe("dotenv-mutator", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-env-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("round-trips comments and blank lines", () => {
    const p = join(dir, ".env")
    writeFileSync(p, `# Tokens\n\nFOO=bar\nBAZ=qux\n# trailing\n`)
    const lines = readDotEnv(p)
    expect(lines.map((l) => l.kind)).toEqual(["comment", "blank", "kv", "kv", "comment"])
  })

  it("setDotEnv updates in place and preserves order", () => {
    const p = join(dir, ".env")
    writeFileSync(p, `# header\nFOO=bar\nBAZ=qux\n`)
    setDotEnv("FOO", "baz", p)
    const content = readFileSync(p, "utf-8")
    expect(content).toContain("# header")
    expect(content).toMatch(/FOO=baz\n/)
    expect(content.indexOf("FOO=baz")).toBeLessThan(content.indexOf("BAZ=qux"))
  })

  it("setDotEnv appends when the key is absent", () => {
    const p = join(dir, ".env")
    writeFileSync(p, `FOO=bar\n`)
    setDotEnv("NEW", "hello world", p)
    const content = readFileSync(p, "utf-8")
    expect(content).toContain("FOO=bar")
    // value with space should be quoted
    expect(content).toMatch(/NEW="hello world"/)
  })

  it("appendDotEnv is a no-op if the key exists", () => {
    const p = join(dir, ".env")
    writeFileSync(p, `FOO=keep\n`)
    const added = appendDotEnv("FOO", "different", p)
    expect(added).toBe(false)
    expect(getDotEnv("FOO", p)).toBe("keep")
  })

  it("getDotEnv + unsetDotEnv", () => {
    const p = join(dir, ".env")
    writeFileSync(p, `FOO=bar\nBAZ=qux\n`)
    expect(getDotEnv("FOO", p)).toBe("bar")
    expect(unsetDotEnv("FOO", p)).toBe(true)
    expect(existsSync(p)).toBe(true)
    expect(getDotEnv("FOO", p)).toBeUndefined()
    expect(getDotEnv("BAZ", p)).toBe("qux")
  })
})
