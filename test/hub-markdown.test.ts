import { makeStreamEventFormatter } from "../src/agents/registry"
import { cfParseLive } from "../src/daemon/ui/pages/wall-chat-fold"
import { describe, expect, it } from "vitest"
import { markdownToHtml } from "../src/utils/markdown-html"
import { chatLogHtml } from "../src/daemon/ui/pages/wall-chat-view"

describe("Hub conversation Markdown", () => {
  it("shows an unfinished streamed fence and preserves code whitespace and punctuation", () => {
    const source = "Voilà \\*literal\\*\r\n\r\n```c++\r\n  **x** & <t>  \r\n\r\n"
    const html = markdownToHtml(source)
    expect(html).toContain("Voilà &#42;literal&#42;")
    expect(html).toContain('<pre><code class="lang-c++">  **x** &amp; &lt;t&gt;  \n\n</code></pre>')
    expect(markdownToHtml(source + "```\r\n\r\nDone")).toBe(html + "<p>\nDone</p>")
  })

  it("renders stored requests with the same renderer as replies", () => {
    const html = chatLogHtml([{ role: "user", status: "done", content: "**Inspect**\n\nAttached: a.txt" }], {
      agent: "Scout", md: markdownToHtml,
    })
    expect(html).toContain("<strong>Inspect</strong>")
    expect(html).toContain("a.txt")
  })
})

it("folds Codex output with line breaks and records completed-only tools", () => {
  const format = makeStreamEventFormatter()
  const item = { id: "cmd-1", type: "command_execution", command: "printf hello" }
  const live = format({ type: "item.started", item }) +
    format({ type: "item.completed", item: { ...item, aggregatedOutput: "one\ntwo", exitCode: 1 } }) +
    format({ type: "item.completed", item: { type: "file_change", changes: [{ path: "test.ts" }] } }) +
    "Finished."
  expect(cfParseLive(live)).toEqual({
    steps: [
      { tool: "Bash", input: '{"command":"printf hello"}', result: "one\ntwo", error: true },
      { tool: "Edit", input: '{"path":"test.ts"}', error: false },
    ],
    errors: [],
    answer: "Finished.",
  })
})
