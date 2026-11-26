import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { readFileSync } from "fs"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { makeStreamEventFormatter } from "../src/agents/registry"
import { parseStream } from "../src/web/task-conversation/parse"
import { bundledLanguagesInfo } from "../src/web/task-conversation/shiki-lite"
import { Response } from "../src/web/task-conversation/elements/Response"
import { tsCatchUp } from "../src/daemon/ui/pages/wall-task-session"
import { APP_CHAT_LOG_SCRIPT } from "../src/daemon/ui/pages/app-chat-log.client"
import { APP_CHAT_VIEW_SCRIPT } from "../src/daemon/ui/pages/app-chat-view.client"
import { APP_CHAT_CSS } from "../src/daemon/ui/pages/app-chat.css"

// #2175: the Hub's conversations show Markdown and fold tool steps. PR #2176
// did the Hub chat; these are the gaps its check found (issue comment
// 7176245705): the Task view and the phone chat keep an opened tool fold
// open while the run updates, and the Task view shows code blocks in the
// languages agents write, also while a block is still open.

function claudeStream(events: any[]): string {
  let buf = ""
  const f = makeStreamEventFormatter(() => !buf || buf.endsWith("\n"))
  for (const e of events) buf += f(e)
  return buf
}
const say = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } })
const use = (name: string, input: any) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } })
const result = (content: string, is_error = false) => ({ type: "user", message: { content: [{ type: "tool_result", content, is_error }] } })

const CLAUDE = claudeStream([
  { type: "system", subtype: "init", model: "claude-opus-5-5", session_id: "abcdef123456" },
  say("Looking at **the file**."),
  use("Read", { file_path: "/repo/src/a.ts" }),
  result("line 1\nline 2"),
  use("Bash", { command: "npm test" }),
  result("1 failed", true),
  say("Fixed. ✅ Café — naïve.\n\n```ts\nconst a = 1\n```"),
  { type: "result", duration_ms: 4200 },
])
// What the formatter writes for a Codex run (registry.ts): items open with
// "> codex", close with "< codex".
const CODEX = [
  ". codex thread started",
  "Checking the repo.",
  "> codex command_execution git status",
  "< codex exit 0",
  "> codex file_change src/b.ts",
  "< codex ok",
  "Done: `src/b.ts` changed.",
  "",
].join("\n")

/** The kind of each part, which is what keys it on the Task page (main.tsx). */
const keys = (raw: string, final: boolean) => parseStream(raw, { final }).map((p, i) => p.kind + i)

describe("Task view: an opened tool step stays open while the run goes on (#2175)", () => {
  for (const [name, raw] of [["Claude", CLAUDE], ["Codex", CODEX]] as const) {
    it(name + ": every part keeps its key as more output arrives, so its open state stays", () => {
      let before: string[] = []
      for (let cut = 1; cut <= raw.length; cut++) {
        const now = keys(raw.slice(0, cut), cut === raw.length)
        // A part shown once keeps its kind and place. Only the last one may
        // still change (half-written reply text that turns out to be cut).
        const settled = before.slice(0, -1)
        expect(now.slice(0, settled.length)).toEqual(settled)
        before = now
      }
      expect(parseStream(raw, { final: true }).some((p) => p.kind === "tool")).toBe(true)
    })
  }

  it("keys parts by kind and place in the bundle, and can take the whole output again", () => {
    const main = readFileSync("src/web/task-conversation/main.tsx", "utf8")
    expect(main).toContain("<Tool key={p.kind + i}")
    expect(main).toMatch(/reset\(text: string\) \{ raw = String\(text \|\| ""\); schedule\(\) \}/)
  })
})

describe("Task view: a stream that comes back does not show the output twice (#2175)", () => {
  it("adds only the new part when the node resends the whole output", () => {
    expect(tsCatchUp("", "abc")).toEqual({ add: "abc" })
    expect(tsCatchUp("→ Read({})\n", "→ Read({})\n← ok\n")).toEqual({ add: "← ok\n" })
    expect(tsCatchUp("same", "same")).toEqual({ add: "" })
  })

  it("draws again from the node's output when it kept less than the page shows", () => {
    expect(tsCatchUp("old start, then more", "then more, and new")).toEqual({ reset: "then more, and new" })
  })

  it("keeps every part's key across a replay, so open steps stay open", () => {
    const half = CLAUDE.slice(0, Math.floor(CLAUDE.length / 2))
    const c = tsCatchUp(half, CLAUDE)
    expect("add" in c && half + c.add).toBe(CLAUDE)
    const k = keys(half, false).slice(0, -1)
    expect(keys(CLAUDE, true).slice(0, k.length)).toEqual(k)
  })

  it("the Task page's start event goes through the catch-up, not a plain append", () => {
    const src = readFileSync("src/daemon/ui/pages/wall-task.client.ts", "utf8")
    expect(src).toContain("if (d.initial) catchUp(d.initial);")
    expect(src).not.toContain("if (d.initial) append(d.initial);")
    expect(readFileSync("src/daemon/ui/pages/wall.client.ts", "utf8")).toMatch(/injectFns\(\{[^}]*tsCatchUp/)
  })
})

describe("Task view: code blocks (#2175)", () => {
  // Streamdown uses useLayoutEffect; rendered on the server, React warns.
  const quiet = vi.spyOn(console, "error")
  beforeAll(() => { quiet.mockImplementation(() => {}) })
  afterAll(() => { quiet.mockRestore() })

  it("highlights the languages agents write, under their usual fence names", () => {
    const names = new Set(bundledLanguagesInfo.flatMap((l) => [l.id, ...l.aliases]))
    for (const n of ["ts", "js", "tsx", "jsx", "json", "yaml", "bash", "sh", "diff", "py", "sql", "css", "go", "rust", "dockerfile", "toml"]) {
      expect(names.has(n), n).toBe(true)
    }
  })

  it("keeps a code block that is still open as reply text while the run goes", () => {
    const raw = "Here:\n\n```ts\nconst a = 1\nconst b"
    const parts = parseStream(raw, { final: false })
    expect(parts).toEqual([{ kind: "text", md: "Here:\n\n```ts\nconst a = 1\nconst b" }])
  })

  it("renders an open code block as code, with its spaces, not as broken text", () => {
    const html = renderToString(createElement(Response, { md: "Run:\n\n```bash\nnpm  test\n  --watch", streaming: true }))
    expect(html).toContain("npm  test")
    expect(html).toContain("  --watch")
    expect(html).not.toContain("```")
  })

  it("renders Unicode and escaped punctuation in a finished reply", () => {
    const html = renderToString(createElement(Response, { md: "Café ✅ naïve \\*not bold\\*", streaming: false }))
    expect(html).toContain("Café ✅ naïve")
    expect(html).toContain("*not bold*")
    expect(html).not.toContain("<em>")
  })

  it("styles bold the way Streamdown draws it, so **bold** is bold on the Task page", () => {
    // Found in the real Claude run for #2175: Streamdown draws bold as a
    // <span data-streamdown="strong"> with a Tailwind class, and the Hub has
    // no Tailwind, so the stylesheet must name that span.
    const html = renderToString(createElement(Response, { md: "A **bold** word", streaming: false }))
    expect(html).toMatch(/<span[^>]*data-streamdown="strong"[^>]*>bold<\/span>/)
    const css = readFileSync(new URL("../src/web/task-conversation/styles.css", import.meta.url), "utf8")
    expect(css).toMatch(/\.axc-md \[data-streamdown="strong"\][^{]*\{[^}]*font-weight:\s*600/)
  })
})

// --- The phone chat (app-chat-log.client.ts) ---

/** Just enough DOM for AXChatLog: elements, attributes, children and the
 *  two selectors it uses on answers ('[data-cx-turn]', '.cx-tools'). */
function fakeEl(cls = ""): any {
  const attrs: Record<string, string> = {}
  const el: any = {
    className: cls, children: [] as any[], hidden: false, textContent: "", classList: { add() {}, remove() {}, contains: () => false },
    setAttribute: (k: string, v: string) => { attrs[k] = v },
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    hasAttr: (k: string) => k in attrs,
    appendChild: (c: any) => { el.children.push(c); return c },
    replaceChild: () => {},
    querySelector: (sel: string) => {
      if (sel === ".cx-tools") return el.tools || null
      return fakeEl()
    },
    querySelectorAll: (sel: string) => (sel === "[data-cx-turn]" ? el.children.filter((c: any) => c.hasAttr && c.hasAttr("data-cx-turn")) : []),
  }
  Object.defineProperty(el, "innerHTML", { get: () => "", set: (v: string) => { if (v === "") el.children = [] } })
  return el
}

function phoneLog() {
  const log = fakeEl(), empty = fakeEl()
  const V = {
    md: () => fakeEl(), retire() {}, renderUi() {}, renderFiles() {}, preview: (t: string) => t,
    // The real setTools makes the <details class="cx-tools"> once per answer.
    setTools: (el: any, tools: any[]) => { if (tools && tools.length && !el.tools) el.tools = { open: false } },
  }
  const document = { createElement: () => fakeEl() }
  const window: any = {}
  new Function("window", "document", APP_CHAT_LOG_SCRIPT)(window, document)
  const L = window.AXChatLog({ V, log, empty, notes: { running: "Working…" }, queue: () => [], send() {} })
  const answers = () => log.children.filter((c: any) => c.hasAttr("data-cx-turn"))
  return { L, answers }
}

const tool = { name: "Bash", arg: "npm test" }
const conv = (id: string, running: boolean) => ({
  id, running,
  messages: [
    { role: "user", content: "one" }, { role: "assistant", content: "a", tools: [tool], status: "done" },
    { role: "user", content: "two" },
    ...(running ? [] : [{ role: "assistant", content: "b", tools: [tool, tool], status: "done" }]),
  ],
  partial: running ? { text: "working", tools: [tool, tool] } : null,
})

describe("phone chat: an opened tools fold stays open when the answer is drawn again (#2175)", () => {
  it("keeps the live answer's fold open when the turn ends and the conversation is drawn again", () => {
    const p = phoneLog()
    const live = p.L.renderConversation(conv("c1", true))
    expect(p.answers().map((a: any) => a.getAttribute("data-cx-turn"))).toEqual(["0", "1"])
    live.tools.open = true // the reader opens the running answer's tools
    p.L.renderConversation(conv("c1", false)) // the turn ended: drawn from the saved conversation
    const [first, second] = p.answers()
    expect(second.tools.open).toBe(true)
    expect(first.tools.open).toBe(false)
  })

  it("starts another conversation with every fold shut", () => {
    const p = phoneLog()
    p.L.renderConversation(conv("c1", false))
    p.answers()[1].tools.open = true
    p.L.renderConversation(conv("c2", false))
    expect(p.answers().map((a: any) => a.tools.open)).toEqual([false, false])
  })

  it("is a native <details> fold, reachable by keyboard, with a visible focus ring", () => {
    expect(APP_CHAT_VIEW_SCRIPT).toContain("document.createElement('details')")
    expect(APP_CHAT_VIEW_SCRIPT).toContain("<summary></summary>")
    expect(APP_CHAT_CSS).toMatch(/\.cx-tools summary:focus-visible \{ outline: 2px solid/)
  })
})
