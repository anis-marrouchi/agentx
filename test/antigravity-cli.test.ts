import { describe, expect, it } from "vitest"
import { AgyStream, buildAgyArgs } from "../src/agents/antigravity-cli"
import { getConventions, skillHome } from "../src/agents/conventions"
import { DEFAULT_ADMISSION_SETTINGS } from "../src/admission/queue"

// The events of a real `agy -p … --output-format stream-json` run (agy
// 1.5.19, 28 Nov 2026), with the tool list cut short.
const RUN = [
  `{"event":"init","conversation_id":"ad7c9688","init":{"model":"gemini-3.8-flash-low","cwd":"/tmp/w","tools":["read_file"],"permission_mode":"always-proceed"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"ad7c9688","step_index":0,"state":"DONE","step_type":"user_input"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"ad7c9688","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":3.2,"usage":{"input_tokens":12076,"output_tokens":30,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":12106}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"ad7c9688","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"/tmp/w/note.txt"}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"ad7c9688","step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"/tmp/w/note.txt"},"output":"1 lines, 25 bytes"}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"ad7c9688","step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"plum"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"ad7c9688","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":3.5,"usage":{"input_tokens":2168,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":10029,"total_tokens":2169}}}`,
  `{"event":"result","result":{"conversation_id":"ad7c9688","status":"SUCCESS","response":"plum\\n","duration_seconds":6.9,"num_turns":1,"usage":{"input_tokens":14244,"output_tokens":31,"thinking_tokens":0,"cache_read_tokens":10029,"total_tokens":14275}}}`,
]

describe("antigravity-cli: spawn arguments", () => {
  it("runs print mode with the stream-json output", () => {
    expect(buildAgyArgs({ prompt: "hello" })).toEqual(["-p", "hello", "--output-format", "stream-json"])
  })

  it("adds the model and the permission bypass only when set", () => {
    expect(buildAgyArgs({ prompt: "p", model: "gemini-4-neon-high", bypass: true })).toEqual([
      "-p", "p", "--output-format", "stream-json", "--model", "gemini-4-neon-high", "--dangerously-skip-permissions",
    ])
  })

  it("resumes a conversation by its id", () => {
    const args = buildAgyArgs({ prompt: "p", resumeSessionId: "ad7c9688" })
    expect(args.slice(args.indexOf("--conversation"), args.indexOf("--conversation") + 2)).toEqual(["--conversation", "ad7c9688"])
  })

  it("keeps a prompt that starts with a dash as the value of -p", () => {
    expect(buildAgyArgs({ prompt: "--help" }).slice(0, 2)).toEqual(["-p", "--help"])
  })
})

describe("antigravity-cli: stream parse", () => {
  it("reads the text, the conversation id, the model and the tokens of a real run", () => {
    const s = new AgyStream()
    const deltas = RUN.map((l) => s.push(l)?.delta).filter(Boolean)
    expect(deltas).toEqual(["plum", "\n"])
    expect(s.text).toBe("plum\n")
    expect(s.response).toBe("plum\n")
    expect(s.sessionId).toBe("ad7c9688")
    expect(s.model).toBe("gemini-3.8-flash-low")
    expect(s.error).toBeUndefined()
    // The two steps summed: the same numbers as the run's own total.
    expect(s.usage).toEqual({ inputTokens: 14244, outputTokens: 31, cacheReadTokens: 10029, cacheCreateTokens: 0 })
  })

  it("counts only this run's steps on a resumed conversation", () => {
    const s = new AgyStream()
    s.push(RUN[6])
    // A resumed conversation's result can carry more than this turn used.
    s.push(`{"event":"result","result":{"conversation_id":"ad7c9688","status":"SUCCESS","response":"x","num_turns":2,"usage":{"input_tokens":26629,"output_tokens":425,"cache_read_tokens":10029}}}`)
    expect(s.usage).toEqual({ inputTokens: 2168, outputTokens: 1, cacheReadTokens: 10029, cacheCreateTokens: 0 })
  })

  it("falls back to the result's tokens when no step carried any", () => {
    const s = new AgyStream()
    s.push(RUN[7])
    expect(s.usage?.inputTokens).toBe(14244)
  })

  it("keeps the cause of a failed run and drops the model list after it", () => {
    const s = new AgyStream()
    s.push(`{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection: model nope is not recognized\\nAvailable models:\\n  Gemini 4 Neon (High)"}}`)
    expect(s.error).toBe("invalid model selection: model nope is not recognized")
    expect(s.sessionId).toBeUndefined()
  })

  it("ignores blank lines and lines that are not JSON", () => {
    const s = new AgyStream()
    expect(s.push("")).toBeNull()
    expect(s.push("Fetching available models...")).toBeNull()
    expect(s.text).toBe("")
  })
})

describe("antigravity-cli: tier", () => {
  it("goes through the run queue, as every tier that starts a local process", () => {
    expect(DEFAULT_ADMISSION_SETTINGS.tiers).toContain("antigravity-cli")
  })

  it("reads skills from .agents/skills and instructions from AGENTS.md", () => {
    expect(skillHome("antigravity-cli", "/w")).toBe("/w/.agents/skills")
    expect(getConventions("antigravity-cli")?.instructionsFile).toBe("AGENTS.md")
    expect(getConventions("antigravity-cli")?.cli?.command).toBe("agy")
  })
})
