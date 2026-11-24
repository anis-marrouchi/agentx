import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { executeClaudeCodeStreaming } from "../src/agents/runtime"
import type { AgentDef } from "../src/daemon/config"

// #2101 R16 / #2170: on the spawn path, a reply written as two text
// messages around a tool call streams as two paragraphs, not glued words.
describe("Claude Code spawn path with partial messages", () => {
  let tmp: string
  let oldPath: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agentx-claude-partial-"))
    oldPath = process.env.PATH
  })
  afterEach(() => {
    process.env.PATH = oldPath
    rmSync(tmp, { recursive: true, force: true })
  })

  it("starts each new text block on a new paragraph and writes each word once", async () => {
    const se = (event: unknown) => ({ type: "stream_event", event, parent_tool_use_id: null })
    const lines = [
      { type: "system", subtype: "init", model: "claude-test", session_id: "s1" },
      se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "check." } }),
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Let me check." }] } },
      { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } },
      se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "It is " } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fine." } }),
      { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "It is fine." }] } },
      { type: "result", subtype: "success", result: "It is fine.", session_id: "s1", usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    writeFileSync(join(tmp, "claude"), `#!/usr/bin/env node
for (const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) process.stdout.write(l + "\\n");
`)
    chmodSync(join(tmp, "claude"), 0o755)
    process.env.PATH = `${tmp}:${oldPath || ""}`

    const agent = {
      name: "Claude Test", workspace: tmp, tier: "claude-code", mentions: [], intents: [],
      maxDelegationDepth: 5, contextReferences: false, maxConcurrent: 1, maxExecutionMinutes: 1,
      permissionMode: "default", queueMode: "collect",
      heartbeat: { enabled: false, intervalMinutes: 30, prompt: "", channel: "heartbeat" },
    } as AgentDef
    const deltas: string[] = []
    const res = await executeClaudeCodeStreaming(agent, { message: "hi", agentId: "claude" }, (d) => { deltas.push(d) })

    expect(res.error).toBeUndefined()
    expect(deltas.join("")).toBe("Let me check.\n\nIt is fine.")
    expect(res.content).toBe("Let me check.\n\nIt is fine.")
  })
})
