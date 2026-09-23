import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "events"
import { handleOpenAICompat, messageText, titleFrom, type OpenAICompatDeps } from "../src/daemon/openai-compat"

class FakeRes extends EventEmitter {
  status = 0
  body = ""
  ended = false
  writeHead(status: number) { this.status = status; return this }
  write(chunk: string) { this.body += chunk; return true }
  end(chunk?: string) { if (chunk) this.body += chunk; this.ended = true; return this }
  chunks() {
    return this.body.split("\n\n").filter(l => l.startsWith("data: {")).map(l => JSON.parse(l.slice(6)))
  }
}

const req = (headers: Record<string, string> = {}) => ({ headers }) as any

function deps(overrides: Partial<OpenAICompatDeps> = {}): OpenAICompatDeps {
  return {
    execute: vi.fn(async () => ({ content: "ok" })),
    agentIds: ["coder-agent"],
    cancel: vi.fn(),
    log: () => {},
    ...overrides,
  }
}

describe("openai-compat", () => {
  it("reads text from string and array message content", () => {
    expect(messageText("hi")).toBe("hi")
    expect(messageText([{ type: "text", text: "a" }, { type: "image_url" }, { type: "text", text: "b" }])).toBe("a\nb")
    expect(messageText(null)).toBe("")
  })

  it("answers OpenCode title requests without running the agent", async () => {
    const d = deps()
    const res = new FakeRes()
    await handleOpenAICompat(req(), res as any, "/v1/chat/completions", {
      model: "coder-agent", stream: true,
      messages: [{ role: "system", content: "You are a title generator. You output ONLY a thread title." }, { role: "user", content: "\"fix the login redirect\"" }],
    }, d)
    expect(d.execute).not.toHaveBeenCalled()
    expect(res.chunks()[0].choices[0].delta.content).toBe("fix the login redirect")
    expect(titleFrom("x".repeat(80))).toHaveLength(50)
  })

  it("streams content, reasoning and tool activity, keyed by the OpenCode session", async () => {
    const d = deps({
      execute: vi.fn(async (_task, onDelta, _onThinking, onEvent) => {
        onEvent!({ type: "assistant", message: { content: [{ type: "thinking", thinking: "plan it" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } })
        onEvent!({ type: "user", message: { content: [{ type: "tool_result", content: "a.ts" }] } })
        onDelta!("Hello", "Hello")
        return { content: "Hello", usage: { inputTokens: 3, outputTokens: 1 } } as any
      }),
    })
    const res = new FakeRes()
    await handleOpenAICompat(req({ "x-opencode-session": "ses_1" }), res as any, "/v1/chat/completions", {
      model: "coder-agent", stream: true,
      messages: [{ role: "system", content: "You are an AI agent running in OpenCode" }, { role: "user", content: [{ type: "text", text: "list files" }] }],
    }, d)

    const task = (d.execute as any).mock.calls[0][0]
    expect(task.message).toBe("list files")
    expect(task.seedHistory).toEqual([])
    expect(task.context).toMatchObject({ channel: "opencode", chatId: "ses_1" })

    const deltas = res.chunks().filter(c => c.choices.length).map(c => c.choices[0].delta)
    const reasoning = deltas.map(x => x.reasoning_content).filter(Boolean).join("")
    expect(reasoning).toContain("plan it")
    expect(reasoning).toContain('→ Bash({"command":"ls"})')
    expect(reasoning).toContain("← a.ts")
    expect(deltas.map(x => x.content).filter(Boolean)).toEqual(["Hello"])
    expect(res.chunks().at(-1).usage.total_tokens).toBe(4)
    expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true)
    expect(d.cancel).not.toHaveBeenCalled()
  })

  it("hands the OpenCode transcript to the session as seed history", async () => {
    const d = deps()
    await handleOpenAICompat(req({ "x-opencode-session": "ses_3" }), new FakeRes() as any, "/v1/chat/completions", {
      model: "coder-agent", stream: false,
      messages: [
        { role: "system", content: "You are an AI agent running in OpenCode" },
        { role: "user", content: "refactor the parser" },
        { role: "assistant", content: [{ type: "text", text: "Done, split into two files." }] },
        { role: "user", content: "now add tests" },
      ],
    }, d)
    const task = (d.execute as any).mock.calls[0][0]
    expect(task.message).toBe("now add tests")
    expect(task.seedHistory.map((s: any) => [s.role, s.content])).toEqual([
      ["user", "refactor the parser"],
      ["agent", "Done, split into two files."],
    ])
  })

  it("reports agent errors as visible text so OpenCode does not retry the turn", async () => {
    const d = deps({ execute: vi.fn(async () => ({ content: "", error: "boom" })) })
    const res = new FakeRes()
    await handleOpenAICompat(req(), res as any, "/v1/chat/completions", {
      model: "coder-agent", stream: true, messages: [{ role: "user", content: "hi" }],
    }, d)
    expect(res.status).toBe(200)
    expect(res.chunks().at(-1).choices[0]).toMatchObject({ delta: { content: "[error] boom" }, finish_reason: "stop" })
  })

  it("cancels the agent turn when the client disconnects", async () => {
    let resolve!: (v: any) => void
    const d = deps({ execute: vi.fn(() => new Promise<any>(r => { resolve = r })) })
    const res = new FakeRes()
    const done = handleOpenAICompat(req({ "x-opencode-session": "ses_2" }), res as any, "/v1/chat/completions", {
      model: "coder-agent", stream: true, messages: [{ role: "user", content: "long task" }],
    }, d)
    await Promise.resolve()
    res.emit("close")
    expect(d.cancel).toHaveBeenCalledWith("coder-agent", "opencode", "ses_2", "client disconnected")
    resolve({ content: "", error: "task cancelled by operator" })
    await done
  })
})
