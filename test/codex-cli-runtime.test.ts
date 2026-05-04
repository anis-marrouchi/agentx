import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { executeTask, type AgentTask } from "../src/agents/runtime"
import type { AgentDef } from "../src/daemon/config"

function baseAgent(workspace: string, overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "Codex Test",
    workspace,
    tier: "codex-cli",
    mentions: [],
    intents: [],
    maxDelegationDepth: 5,
    contextReferences: false,
    maxConcurrent: 1,
    maxExecutionMinutes: 1,
    permissionMode: "default",
    queueMode: "collect",
    heartbeat: { enabled: false, intervalMinutes: 30, prompt: "", channel: "heartbeat" },
    ...overrides,
  } as AgentDef
}

function baseTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    message: "hello",
    agentId: "codex",
    ...overrides,
  }
}

describe("codex-cli runtime", () => {
  let tmp: string
  let oldPath: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agentx-codex-runtime-"))
    oldPath = process.env.PATH
  })

  afterEach(() => {
    process.env.PATH = oldPath
    rmSync(tmp, { recursive: true, force: true })
  })

  it("executes codex-cli tier via codex exec and reads the final message file", async () => {
    writeFileSync(join(tmp, "codex-args.json"), "[]")
    writeFileSync(join(tmp, "codex"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(tmp, "codex-args.json"))}, JSON.stringify(args));
const outIdx = args.indexOf("--output-last-message");
if (outIdx >= 0) fs.writeFileSync(args[outIdx + 1], "codex final");
process.exit(0);
`)
    chmodSync(join(tmp, "codex"), 0o755)
    process.env.PATH = `${tmp}:${oldPath || ""}`

    const r = await executeTask(
      baseAgent(tmp, { model: "gpt-5.1", systemPrompt: "system" }),
      baseTask({ systemPromptAppend: "system prompt" }),
      {},
    )

    expect(r.error).toBeUndefined()
    expect(r.content).toBe("codex final")
    const args = JSON.parse(readFileSync(join(tmp, "codex-args.json"), "utf8"))
    expect(args.slice(0, 1)).toEqual(["exec"])
    expect(args).toContain("--skip-git-repo-check")
    expect(args).toContain("--output-last-message")
    expect(args).toContain("--model")
    expect(args).toContain("gpt-5.1")
    expect(args.at(-1)).toContain("[System]\nsystem prompt")
  })

  it("streams codex JSON events and returns the final message", async () => {
    writeFileSync(join(tmp, "codex"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--output-last-message");
console.log(JSON.stringify({ type: "agent_message_delta", delta: "hel" }));
console.log(JSON.stringify({ type: "agent_message_delta", delta: "lo" }));
if (outIdx >= 0) fs.writeFileSync(args[outIdx + 1], "hello");
process.exit(0);
`)
    chmodSync(join(tmp, "codex"), 0o755)
    process.env.PATH = `${tmp}:${oldPath || ""}`

    const deltas: string[] = []
    const events: any[] = []
    const r = await executeTask(
      baseAgent(tmp),
      baseTask(),
      {},
      (delta) => deltas.push(delta),
      undefined,
      undefined,
      (event) => events.push(event),
    )

    expect(r.error).toBeUndefined()
    expect(r.content).toBe("hello")
    expect(deltas.join("")).toBe("hello")
    expect(events.map((e) => e.type)).toEqual(["agent_message_delta", "agent_message_delta"])
  })
})
