import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { WikiHub } from "../../src/wiki/hub"
import { agenticQuery } from "../../src/wiki/query"
import { claudeModelCall, meteredModelCall } from "../../src/wiki/model-call"

let dir: string
let path: string | undefined

/** A `claude` on PATH that answers with `envelope` as its JSON output. */
function fakeClaude(envelope: string, code = 0): void {
  const bin = join(dir, "claude")
  writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${envelope}'\nexit ${code}\n`)
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

  it("counts a call that fails as unpriced, so its question's cost is not read as complete", async () => {
    const bin = join(dir, "claude")
    writeFileSync(bin, "#!/bin/sh\ncat >/dev/null\necho boom >&2\nexit 1\n")
    chmodSync(bin, 0o755)
    const spend = { calls: 0, usd: 0, unpriced: 0 }
    await expect(meteredModelCall(spend)("q", "haiku", 5000)).rejects.toThrow(/exited 1/)
    expect(spend).toEqual({ calls: 1, usd: 0, unpriced: 1 })
  })
})

describe("Claude model errors", () => {
  it("surfaces a short quota diagnostic from a failed CLI with empty stderr", async () => {
    fakeClaude(JSON.stringify({
      is_error: true,
      result: "\u001b[31mUsage limit reached.\u001b[0m\nTry again at 9pm. " + "x".repeat(250),
    }), 1)
    const detail = ("Usage limit reached. Try again at 9pm. " + "x".repeat(250)).slice(0, 200)
    await expect(claudeModelCall("q", "haiku", 5000)).rejects.toMatchObject({ message: `model error: ${detail}` })
  })

  it.each(["", "raw output", "null", '{"result":"raw model reply"}'])(
    "reports only the exit code for unusable error output (%s)",
    async (output) => {
      fakeClaude(output, 1)
      await expect(claudeModelCall("q", "haiku", 5000)).rejects.toThrow(/^claude exited 1$/)
    },
  )
})

describe("catalog synthesis", () => {
  it.each([
    { reply: { result: "The launch word is amber. [Launch Guide]" }, exit: 0,
      expected: { status: "ok", answer: "The launch word is amber. [Launch Guide]" } },
    { reply: { is_error: true, result: "Usage limit reached." }, exit: 1,
      expected: { status: "error", answer: "", error: "Synthesis: model error: Usage limit reached." } },
    { reply: { result: "  " }, exit: 0,
      expected: { status: "error", answer: "", error: "Synthesis: Wiki model returned an empty answer" } },
  ])("returns the expected status for synthesis reply $reply", async ({ reply, exit, expected }) => {
    const store = new WikiHub(join(dir, "wiki"), () => {}).getAgentWiki("test")
    store.writeArticle("projects/launch.md", {
      title: "Launch Guide", owner: "test", access: "public", tags: [], sources: [],
      created: "2026-01-01", lastUpdated: "2026-01-01",
    }, "The launch word is amber.", "test")
    store.rebuildIndex()

    const bin = join(dir, "claude")
    const selector = JSON.stringify({ result: JSON.stringify([{ title: "Launch Guide", path: "projects/launch.md" }]) })
    writeFileSync(bin, `#!/bin/sh
prompt=$(cat)
case "$prompt" in
  *"## Articles"*) printf '%s' '${JSON.stringify(reply)}'; exit ${exit} ;;
  *) printf '%s' '${selector}' ;;
esac
`)
    chmodSync(bin, 0o755)

    const result = await agenticQuery("What is the launch word?", store, "test", { log: () => {} })
    expect(result).toMatchObject({
      ...expected,
      walked: [{ title: "Launch Guide", path: "projects/launch.md" }],
    })
    if (result.status === "ok") expect(result.citations).toMatchObject([{ title: "Launch Guide", path: "projects/launch.md" }])
  })
})
