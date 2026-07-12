import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DemoProvider } from "../src/agent/providers/demo"

const SCRIPT = {
  steps: [
    { match: "checkout is broken", reply: "delegating to builder", delayMs: 1, chunkMs: 1 },
    { match: "Builder reports", reply: "resolved", delayMs: 1, chunkMs: 1 },
  ],
  fallback: { reply: "demo fallback", delayMs: 1, chunkMs: 1 },
}

let dir: string | undefined

function providerWithScript(script: object): DemoProvider {
  dir = mkdtempSync(join(tmpdir(), "agentx-demo-test-"))
  const path = join(dir, "script.json")
  writeFileSync(path, JSON.stringify(script))
  process.env.AGENTX_DEMO_SCRIPT = path
  return new DemoProvider()
}

afterEach(() => {
  delete process.env.AGENTX_DEMO_SCRIPT
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("DemoProvider", () => {
  it("answers with the matching step", async () => {
    const p = providerWithScript(SCRIPT)
    const r = await p.generateRaw(
      [{ role: "user", content: "checkout is broken on demo/shop" }], "", [],
    )
    expect(r.content).toEqual([{ type: "text", text: "delegating to builder" }])
    expect(r.stop_reason).toBe("end_turn")
  })

  it("prefers the step matching latest in history-prepended text", async () => {
    // The orchestrator prepends conversation history, so scene 1's trigger
    // phrase is still present when scene 2 arrives. Latest match must win.
    const p = providerWithScript(SCRIPT)
    const r = await p.generateRaw(
      [{
        role: "user",
        content: "Earlier: checkout is broken and CI red.\n\nBuilder reports: fixed, MR merged.",
      }], "", [],
    )
    expect(r.content).toEqual([{ type: "text", text: "resolved" }])
  })

  it("falls back when nothing matches", async () => {
    const p = providerWithScript(SCRIPT)
    const r = await p.generate([{ role: "user", content: "hello there" }])
    expect(r.content).toBe("demo fallback")
  })

  it("streams thinking then text and ends with raw_result", async () => {
    const p = providerWithScript({
      steps: [{ match: "ping", thinking: "hm", reply: "pong", delayMs: 1, chunkMs: 1 }],
    })
    const events: string[] = []
    let final = ""
    for await (const ev of p.generateRawStream!([{ role: "user", content: "ping" }], "", [])) {
      events.push(ev.type)
      if (ev.type === "raw_result") {
        final = (ev.result.content[0] as any).text
      }
    }
    expect(events[0]).toBe("thinking_delta")
    expect(events).toContain("text_delta")
    expect(events[events.length - 1]).toBe("raw_result")
    expect(final).toBe("pong")
  })

  it("survives a missing script file", async () => {
    process.env.AGENTX_DEMO_SCRIPT = "/nonexistent/script.json"
    const p = new DemoProvider()
    const r = await p.generate([{ role: "user", content: "anything" }])
    expect(r.content).toMatch(/unreadable|demo/i)
  })
})
