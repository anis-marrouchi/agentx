import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { makeStreamEventFormatter } from "../src/agents/registry"
import { parseStream } from "../src/web/task-conversation/parse"
import { editDiff, toolSummary } from "../src/web/task-conversation/tools"
import { diffCounts, diffRows } from "../src/web/task-conversation/elements/DiffView"
import { bundledLanguagesInfo, bundledLanguages } from "../src/web/task-conversation/shiki-lite"

// #2101 R16: the Task page shows a run's conversation as parts (reply,
// tool steps, edits as diffs, thinking). The parts come from the daemon's
// formatted stream; these tests feed it what the formatter really writes.

function stream(events: any[]): string {
  let buf = ""
  const f = makeStreamEventFormatter(() => !buf || buf.endsWith("\n"))
  for (const e of events) buf += f(e)
  return buf
}

const say = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } })
const use = (name: string, input: any) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } })
const result = (content: string, is_error = false) => ({ type: "user", message: { content: [{ type: "tool_result", content, is_error }] } })

describe("the Task page stream as conversation parts (#2101 R16)", () => {
  const raw = stream([
    { type: "system", subtype: "init", model: "claude-opus-5-5", session_id: "abcdef123456" },
    say("I'll fix the **bug**."),
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "Line one\nline two" }] } },
    use("Read", { file_path: "/repo/src/util/a.ts" }),
    result("line 1\nline 2\n\nline 4"),
    use("Edit", { file_path: "/repo/src/util/a.ts", old_string: "const a = 1\nconst b = 2", new_string: "const a = 1\nconst b = 3\nconst c = 4" }),
    result("ok"),
    use("Bash", { command: "npm test", description: "Run the tests" }),
    result("1 failed", true),
    say("Done.\n\n```ts\nconst x = 1\n```"),
    { type: "result", duration_ms: 4200 },
  ])

  it("keeps a multi-line tool result on one line, so the reply after it stays a reply", () => {
    expect(raw).toContain("← line 1\u2028line 2\u2028\u2028line 4\n")
    // The second, shorter message is written whole, on its own line.
    expect(raw).toContain("\nDone.\n")
  })

  it("marks every line of a thought", () => {
    expect(raw).toContain("💭 Line one\n💭 line two\n")
  })

  it("reads reply, thought, tool steps with results, and an edit", () => {
    const parts = parseStream(raw, { final: true })
    expect(parts.map((p) => p.kind)).toEqual(["system", "text", "thought", "tool", "tool", "tool", "text", "system"])
    expect(parts[1]).toEqual({ kind: "text", md: "I'll fix the **bug**." })
    expect(parts[2]).toEqual({ kind: "thought", text: "Line one\nline two" })
    expect(parts[3]).toMatchObject({ kind: "tool", name: "Read", done: true, error: false, result: "line 1\nline 2\n\nline 4" })
    expect(parts[5]).toMatchObject({ kind: "tool", name: "Bash", done: true, error: true, result: "1 failed" })
    expect(parts[6]).toEqual({ kind: "text", md: "Done.\n\n```ts\nconst x = 1\n```" })
  })

  it("shows an edit as a diff with its counts", () => {
    const edit = parseStream(raw, { final: true })[4] as any
    const d = editDiff(edit.name, edit.input)!
    expect(d).toEqual({ file: "/repo/src/util/a.ts", before: "const a = 1\nconst b = 2", after: "const a = 1\nconst b = 3\nconst c = 4", isNew: false })
    const rows = diffRows(d.before, d.after)
    expect(rows.map((r) => r.kind)).toEqual(["same", "del", "add", "add"])
    expect(diffCounts(rows)).toEqual({ added: 2, removed: 1 })
    expect(toolSummary("Edit", edit.input)).toEqual({ verb: "Edited", object: "util/a.ts" })
  })

  it("keeps a long edit whole enough to diff (inputs of other tools stay short)", () => {
    const big = "x".repeat(3000)
    const s = stream([use("Edit", { file_path: "a.ts", old_string: big, new_string: big + "y" }), use("Bash", { command: big })])
    const [edit, bash] = parseStream(s, { final: true }) as any[]
    expect(editDiff("Edit", edit.input)).not.toBeNull()
    expect(bash.input.length).toBeLessThan(500)
  })

  it("names a step in one line, from clipped input too", () => {
    expect(toolSummary("Bash", '{"command":"npm test","description":"Run the tests"}')).toEqual({ verb: "Ran", object: "Run the tests" })
    expect(toolSummary("Grep", '{"pattern":"onDelta","path":"src"}')).toEqual({ verb: "Searched", object: "onDelta" })
    expect(toolSummary("Read", '{"file_path":"/a/b/c/d.ts","lim …[+20 chars]')).toEqual({ verb: "Read", object: "c/d.ts" })
    expect(toolSummary("mcp__agentx__agentx_send", '{"message":"hi"}')).toEqual({ verb: "agentx_send (agentx)", object: "hi" })
  })

  it("while the run goes, holds back a half-written marker line and shows half-written reply text", () => {
    expect(parseStream("Working on it\n→ Read({\"file_pa", {}).map((p) => p.kind)).toEqual(["text"])
    const parts = parseStream("Hello\nwor", {})
    expect(parts).toEqual([{ kind: "text", md: "Hello\nwor" }])
    // A call with no result yet is open.
    expect(parseStream('→ Read({"file_path":"a.ts"})\n', {})[0]).toMatchObject({ kind: "tool", done: false })
  })

  it("strips internal markers from the reply with the page's plain()", () => {
    const parts = parseStream("Hi [[secret]] there\n", { final: true, plain: (s) => s.replace(/\[\[[^\]]*\]\] ?/g, "") })
    expect(parts).toEqual([{ kind: "text", md: "Hi there" }])
  })

  it("reads errors, codex items and the finish marker", () => {
    const parts = parseStream("[error] budget cap reached\n> codex command_execution ls\n< codex command_execution ls: a b\n[task finished]\n", { final: true })
    expect(parts).toEqual([
      { kind: "error", text: "budget cap reached" },
      { kind: "tool", name: "codex", input: "command_execution ls", result: "command_execution ls: a b", done: true },
      { kind: "system", text: "task finished" },
    ])
  })
})

describe("the conversation bundle (#2101 R16)", () => {
  it("is built as its own web entry and loaded by the Task page, with the old renderer as fallback", () => {
    expect(readFileSync("tsup.web.config.ts", "utf8")).toContain('"task-conversation": "src/web/task-conversation/main.tsx"')
    const page = readFileSync("src/daemon/ui/pages/wall-task.client.ts", "utf8")
    expect(page).toContain("/assets/task-conversation.global.js")
    expect(page).toContain("convFallback")
  })

  it("does not render raw HTML from agent output", () => {
    const src = readFileSync("src/web/task-conversation/elements/Response.tsx", "utf8")
    expect(src).toMatch(/name !== "raw"/)
  })

  it("keeps the AI Elements licence notice", () => {
    expect(readFileSync("src/web/task-conversation/elements/NOTICE.md", "utf8")).toMatch(/Apache License/)
  })

  it("has a loader for every language it lists, and every alias points at one", () => {
    for (const l of bundledLanguagesInfo) expect(typeof bundledLanguages[l.id]).toBe("function")
    expect(Object.keys(bundledLanguages).sort()).toEqual(bundledLanguagesInfo.map((l) => l.id).sort())
  })
})
