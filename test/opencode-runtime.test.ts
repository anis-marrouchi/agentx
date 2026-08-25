import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { executeTask, type AgentTask } from "../src/agents/runtime"
import type { AgentDef } from "../src/daemon/config"

function agent(workspace: string): AgentDef {
  return {
    name: "OpenCode Test",
    workspace,
    tier: "opencode",
    model: "openai/gpt-test",
    mentions: [],
    intents: [],
    maxDelegationDepth: 5,
    contextReferences: false,
    maxConcurrent: 1,
    maxExecutionMinutes: 1,
    permissionMode: "bypassPermissions",
    queueMode: "collect",
    heartbeat: { enabled: false, intervalMinutes: 30, prompt: "", channel: "heartbeat" },
  } as AgentDef
}

describe("opencode runtime", () => {
  let tmp: string
  let oldPath: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agentx-opencode-runtime-"))
    oldPath = process.env.PATH
  })

  afterEach(() => {
    process.env.PATH = oldPath
    rmSync(tmp, { recursive: true, force: true })
  })

  it("streams JSON output and resumes the native OpenCode session", async () => {
    const argsFile = join(tmp, "args.json")
    writeFileSync(join(tmp, "opencode"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args, config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) }));
console.log(JSON.stringify({ type: "text", sessionID: "ses-next", part: { text: "hel" } }));
console.log(JSON.stringify({ type: "text", sessionID: "ses-next", part: { text: "lo" } }));
console.log(JSON.stringify({ type: "step_finish", sessionID: "ses-next", part: { tokens: { input: 12, output: 3, cache: { read: 4, write: 1 } } } }));
`)
    chmodSync(join(tmp, "opencode"), 0o755)
    process.env.PATH = `${tmp}:${oldPath || ""}`

    const task: AgentTask = { message: "hello", agentId: "opencode", systemPromptAppend: "system prompt" }
    const deltas: string[] = []
    const result = await executeTask(agent(tmp), task, {}, (delta) => deltas.push(delta), undefined, "ses-old")

    expect(result.error).toBeUndefined()
    expect(result.content).toBe("hello")
    expect(deltas).toEqual(["hel", "lo"])
    expect(result.opencodeSessionId).toBe("ses-next")
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3, cacheReadTokens: 4, cacheCreateTokens: 1 })

    const capture = JSON.parse(readFileSync(argsFile, "utf8"))
    const args = capture.args
    expect(args.slice(0, 3)).toEqual(["run", "--format", "json"])
    expect(args).toContain("--model")
    expect(args).toContain("openai/gpt-test")
    expect(args).toContain("--session")
    expect(args).toContain("ses-old")
    expect(args).toContain("--auto")
    expect(args.at(-1)).toContain("[System]\nsystem prompt")
    expect(capture.config.mcp.agentx.type).toBe("local")
    expect(capture.config.mcp.agentx.command).toContain("serve")
  })
})
