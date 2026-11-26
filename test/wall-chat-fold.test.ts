import { describe, expect, it } from "vitest"
import { cfDuration, cfField, cfFoldHtml, cfParseLive, cfStepLine } from "../src/daemon/ui/pages/wall-chat-fold"
import { runPreview } from "../src/agents/registry"

// #2101 PR 2, R14: the Hub chat reads a run's live output like Claude Code.

describe("cfParseLive: the live output, line by line", () => {
  it("keeps tool calls and the answer after the last one, folds results and drops thoughts and init lines", () => {
    const out = cfParseLive([
      "· init model=claude-opus",
      "💭 I should read the log ↵ first",
      "Let me check.",
      '→ Read({"file_path":"/var/log/backup.log"})',
      "← 2026-11-23 disk full ↵ retry failed",
      '→ Bash({"command":"df -h"})',
      "← [error] permission denied",
      "",
      "The disk is **full**.",
      "Free 2 GB and run it again.",
      "[task finished]",
    ].join("\n"))
    expect(out.steps).toEqual([
      { tool: "Read", input: '{"file_path":"/var/log/backup.log"}', error: false, result: "2026-11-23 disk full ↵ retry failed" },
      { tool: "Bash", input: '{"command":"df -h"}', error: true, result: "permission denied" },
    ])
    expect(out.answer).toBe("The disk is **full**.\nFree 2 GB and run it again.")
    expect(out.errors).toEqual([])
  })

  it("keeps a refusal line ([error] …) visible, with its line breaks back", () => {
    const out = cfParseLive("[error] Held: the dispatch gate ↵ is closed for scout\n")
    expect(out.errors).toEqual(["Held: the dispatch gate\nis closed for scout"])
    expect(out.steps).toEqual([])
    expect(out.answer).toBe("")
  })

  it("reads codex commands as Bash steps and drops their results", () => {
    const out = cfParseLive("> codex command_execution git status\n< codex command_execution git status: clean\nAll clean.")
    expect(out.steps).toEqual([{ tool: "Bash", input: '{"command":"git status"}', error: false }])
    expect(out.answer).toBe("All clean.")
  })

  it("an answer with no tools is the whole text", () => {
    expect(cfParseLive("Just text\nover two lines").answer).toBe("Just text\nover two lines")
  })
})

describe("cfStepLine: one line a step", () => {
  it.each([
    ["Read", '{"file_path":"/repo/src/a.ts"}', "Read a.ts"],
    ["Edit", '{"file_path":"/repo/src/b.ts","old_string":"x"}', "Edited b.ts"],
    ["MultiEdit", '{"file_path":"C:\\\\repo\\\\c.ts"}', "Edited c.ts"],
    ["Write", '{"file_path":"/tmp/out.md"}', "Wrote out.md"],
    ["Bash", '{"command":"npm test\\nnpm run lint"}', "Ran npm test"],
    ["Grep", '{"pattern":"TODO"}', "Searched for TODO"],
    ["Glob", '{"pattern":"src/**/*.ts"}', "Listed src/**/*.ts"],
    ["WebFetch", '{"url":"https://example.com/page"}', "Fetched example.com/page"],
    ["TodoWrite", "{}", "Updated the to-do list"],
    ["mcp__agentx__agentx_task", "{}", "Used agentx task (agentx)"],
    ["Strange", "{}", "Used Strange"],
  ])("%s", (tool, input, line) => {
    expect(cfStepLine(tool, input)).toBe(line)
  })

  it("reads a field from input the daemon cut short", () => {
    expect(cfField('{"file_path":"/a/very/long/path.ts","content":"abc…[+120 chars]', ["file_path"])).toBe("/a/very/long/path.ts")
    expect(cfField('{"command":"echo \\"hi\\""}', ["command"])).toBe('echo "hi"')
  })

  it("says how long in s, m s, h m", () => {
    expect(cfDuration(12_400)).toBe("12s")
    expect(cfDuration(72_000)).toBe("1m 12s")
    expect(cfDuration(3_780_000)).toBe("1h 03m")
    expect(cfDuration(null)).toBe("0s")
  })

  it("keeps two digits after the first unit and never rounds up, for a ticking clock (#2306)", () => {
    expect(cfDuration(242_000)).toBe("4m 02s")
    expect(cfDuration(59_900)).toBe("59s")
    expect(cfDuration(134_999)).toBe("2m 14s")
    expect(cfDuration(-5)).toBe("0s")
  })
})

describe("cfFoldHtml: Worked for …", () => {
  const steps = [{ tool: "Read", input: '{"file_path":"/a/<b>.ts"}', error: false }, { tool: "Bash", input: '{"command":"make"}', error: true }]

  it("folds the steps under a summary, escaped, and marks a failed one", () => {
    const html = cfFoldHtml({ key: "task-1", steps, ms: 72_000 })
    expect(html).toMatch(/^<details class="hc__fold" data-hc-fold="task-1">/)
    expect(html).toContain("<summary>Worked for 1m 12s · 2 steps")
    expect(html).toContain('<span class="hc__foldbad">1 failed</span>')
    expect(html).toContain("Read &lt;b&gt;.ts")
    expect(html).toContain('<li class="hc__step is-err">Ran make <b>failed</b></li>')
  })

  it("stays open when the reader opened it, and names the current step while live", () => {
    expect(cfFoldHtml({ key: "k", steps, ms: 1000, open: true })).toContain('data-hc-fold="k" open>')
    const live = cfFoldHtml({ key: "k", steps, ms: 5000, live: true })
    expect(live).toContain("hc__fold is-live")
    expect(live).toContain("Working for 5s · 2 steps")
    expect(live).toContain('<span class="hc__foldnow">Ran make</span>')
  })

  it("draws nothing for an answer with no steps", () => {
    expect(cfFoldHtml({ key: "k", steps: [], ms: 1000 })).toBe("")
  })
})

describe("the left tree titles a chat run by its question", () => {
  it("prefers the sentence the person typed over the prompt wrapper", () => {
    expect(runPreview({ message: "You are answering the operator…\nTHEIR QUESTION:\nWhy?", requestText: "Why did the backup fail?" })).toBe("Why did the backup fail?")
    expect(runPreview({ message: "A plain task" })).toBe("A plain task")
    expect(runPreview({ message: "x".repeat(300) })).toHaveLength(200)
  })
})
