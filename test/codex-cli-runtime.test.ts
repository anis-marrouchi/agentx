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
console.log(JSON.stringify({ type: "turn_complete", thread_id: "codex-thread-1", usage: { input_tokens: 11, output_tokens: 2 } }));
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
    expect(args).toContain("--ignore-user-config")
    expect(args).not.toContain("--ephemeral")
    expect(args).toContain("--json")
    expect(args).toContain("--skip-git-repo-check")
    expect(args).toContain("mcp_servers.agentx.command=" + JSON.stringify(process.execPath))
    expect(args).not.toContain("--ask-for-approval")
    expect(args).toContain("--output-last-message")
    expect(args).toContain("--model")
    expect(args).toContain("gpt-5.1")
    expect(args.at(-1)).toContain("[System]\nsystem prompt")
    expect(r.codexSessionId).toBe("codex-thread-1")
    expect(r.usage?.inputTokens).toBe(11)
  })

  it("resumes an existing codex thread without ephemeral fresh-session flags", async () => {
    writeFileSync(join(tmp, "codex-args.json"), "[]")
    writeFileSync(join(tmp, "codex"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(tmp, "codex-args.json"))}, JSON.stringify(args));
const outIdx = args.indexOf("--output-last-message");
console.log(JSON.stringify({ type: "turn_complete", thread_id: "codex-thread-2" }));
if (outIdx >= 0) fs.writeFileSync(args[outIdx + 1], "resumed");
process.exit(0);
`)
    chmodSync(join(tmp, "codex"), 0o755)
    process.env.PATH = `${tmp}:${oldPath || ""}`

    const r = await executeTask(
      baseAgent(tmp, { model: "gpt-5.1" }),
      baseTask(),
      {},
      undefined,
      undefined,
      "codex-thread-1",
    )

    expect(r.error).toBeUndefined()
    expect(r.content).toBe("resumed")
    expect(r.codexSessionId).toBe("codex-thread-2")
    const args = JSON.parse(readFileSync(join(tmp, "codex-args.json"), "utf8"))
    expect(args.slice(0, 2)).toEqual(["exec", "resume"])
    expect(args).toContain("codex-thread-1")
    expect(args).toContain("--json")
    expect(args).not.toContain("--ephemeral")
    expect(args).not.toContain("--sandbox")
    expect(args).not.toContain("--color")
  })

  it("streams codex JSON events and returns the final message", async () => {
    writeFileSync(join(tmp, "codex"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--output-last-message");
console.log(JSON.stringify({ type: "agent_message_delta", delta: "hel" }));
console.log(JSON.stringify({ type: "agent_message_delta", delta: "lo" }));
console.log(JSON.stringify({ type: "turn_complete", model: "gpt-5.2", thread_id: "codex-thread-stream", usage: { input_tokens: 31, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }));
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
    expect(events.map((e) => e.type)).toEqual(["agent_message_delta", "agent_message_delta", "turn_complete"])
    expect(r.billedModel).toBe("gpt-5.2")
    expect(r.codexSessionId).toBe("codex-thread-stream")
    expect(r.usage).toEqual({ inputTokens: 31, outputTokens: 7, cacheReadTokens: 3, cacheCreateTokens: 2 })
  })
})
