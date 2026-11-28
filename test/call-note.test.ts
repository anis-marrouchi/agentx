import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { callNote } from "../src/calls/call-note"
import { SUMMARY_PROMPT } from "../src/calls/service"
import { chatCallNote, chatLogHtml } from "../src/daemon/ui/pages/wall-chat-view"
import { tsCallNote, tsFoldHtml, tsTurnHtml } from "../src/daemon/ui/pages/wall-task-session"
import { ChatTurn } from "../src/hub/pages/ShellPage"
import { WALL_CHAT_SCRIPT } from "../src/daemon/ui/pages/wall-chat.client"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import { APP_CHAT_LOG_SCRIPT } from "../src/daemon/ui/pages/app-chat-log.client"

// The daemon's own call prompts show as a system line, never as the
// owner's message (#2101, Anis 11-28: "[Call ended] The owner hung up..."
// showed as if Anis or Hakim sent it).

const ANSWERED = '[Call answered] The owner called you to talk about this: "the deploy". Speak first.'

describe("callNote", () => {
  it("names the daemon's call prompts", () => {
    expect(callNote(SUMMARY_PROMPT)).toBe("Call ended")
    expect(callNote(ANSWERED)).toBe("Call answered")
    expect(callNote("  " + SUMMARY_PROMPT)).toBe("Call ended")
  })
  it("the injected copies say the same", () => {
    for (const t of [SUMMARY_PROMPT, ANSWERED, "  " + SUMMARY_PROMPT, "hello [Call ended]", "", undefined]) {
      expect(chatCallNote(t)).toBe(callNote(t))
      expect(tsCallNote(t)).toBe(callNote(t))
    }
  })
  it("leaves the owner's own words alone", () => {
    expect(callNote("Why did the [Call ended] prompt show?")).toBe("")
    expect(callNote("")).toBe("")
    expect(callNote(undefined)).toBe("")
  })
})

describe("the old Hub chat", () => {
  it("draws the prompt as a system line, not the owner's bubble", () => {
    const html = chatLogHtml([
      { seq: 0, role: "user", content: SUMMARY_PROMPT, status: "done" },
      { seq: 1, role: "assistant", content: "We agreed to ship.", status: "done" },
    ], { agent: "Dev Session" })
    expect(html).toContain('<div class="hc__note" data-hc-note>Call ended</div>')
    expect(html).not.toContain("hc__me")
    expect(html).not.toContain("The owner hung up")
  })
  it("a folded turn opened by the prompt reads Call ended", () => {
    const html = chatLogHtml([
      { seq: 0, role: "user", content: SUMMARY_PROMPT, status: "done" },
      { seq: 1, role: "assistant", content: "Summary.", status: "done" },
      { seq: 2, role: "user", content: "next", status: "done" },
      { seq: 3, role: "assistant", content: "ok", status: "done" },
    ], { agent: "Dev Session", foldTurns: true })
    expect(html).toContain('<span class="hc__turnask">Call ended</span>')
  })
  it("ships callNote with the chat script", () => {
    expect(WALL_CHAT_SCRIPT).toContain('globalThis.__axBind("chatCallNote"')
  })
})

describe("the Task page's turns", () => {
  const o = { agent: "Dev Session", href: "#page=task&task=1", md: (s: string) => "<p>" + s + "</p>", plain: (s: string) => s, when: () => "today" }
  it("a turn the prompt started shows Call ended, from AgentX", () => {
    const h = tsTurnHtml({ id: "t1", n: 2, sender: "Voice", message: SUMMARY_PROMPT, responseText: "We agreed.", ok: true }, o)
    expect(h).toContain('<span class="wsess__note">Call ended</span>')
    expect(h).toContain("from AgentX")
    expect(h).not.toContain("The owner hung up")
    expect(h).not.toContain(">Voice<")
  })
  it("ships tsCallNote with the Wall's script", () => {
    expect(WALL_PAGE_SCRIPT).toContain('globalThis.__axBind("tsCallNote"')
  })
  it("its fold line reads Call ended", () => {
    const t = { id: "t1", n: 2, message: SUMMARY_PROMPT, ok: true }
    expect(tsFoldHtml(t, "", false, (s) => s)).toContain('<span class="wsess__foldask">Call ended</span>')
  })
})

describe("the React Hub chat", () => {
  it("draws the prompt as a system line", () => {
    const html = renderToStaticMarkup(createElement(ChatTurn, { m: { seq: 0, role: "user", content: SUMMARY_PROMPT, status: "done" } }))
    expect(html).toContain('data-shell="call-note"')
    expect(html).toContain(">Call ended<")
    expect(html).not.toContain("The owner hung up")
  })
  it("the owner's own message is still theirs", () => {
    const html = renderToStaticMarkup(createElement(ChatTurn, { m: { seq: 0, role: "user", content: "hello", status: "done" } }))
    expect(html).toContain('data-role="user"')
  })
})

describe("the phone chat", () => {
  it("shows the hang-up prompt as a note too", () => {
    expect(APP_CHAT_LOG_SCRIPT).toContain("'Call ended'")
  })
})
