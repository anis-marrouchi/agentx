// The shell chat's live answer (#2101, req-01M83KYQ): the run's stream
// read as it comes, rendered as markdown, never the {"answer":"…"} wrapper.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  TASK_FINISHED, TASK_STREAM_RETRY_MS, followTaskStream, liveAnswer, storedAnswer, taskStreamUrl, unwrapAnswer,
} from "../src/hub/shell/chat-stream"
import { ChatAnswer } from "../src/hub/pages/ShellPage"
import ChatMarkdown from "../src/hub/shell/ChatMarkdown"

describe("unwrapAnswer", () => {
  it("leaves plain text as it is", () => {
    expect(unwrapAnswer("**Role:** builder")).toBe("**Role:** builder")
    expect(unwrapAnswer("**Role:** builder", true)).toBe("**Role:** builder")
  })
  it("shows nothing while the wrapper's first characters arrive", () => {
    for (const t of ["{", '{"', '{"ans', '{"answer"', '{"answer":', ' { "answer" ']) expect(unwrapAnswer(t, true)).toBe("")
  })
  it("a finished text that merely starts with { stays as it is", () => {
    expect(unwrapAnswer("{", false)).toBe("{")
  })
  it("reads the answer inside the wrapper as far as it has come", () => {
    expect(unwrapAnswer('{"answer":"Hel', true)).toBe("Hel")
    expect(unwrapAnswer('{"answer":"**Role:** a\\nb \\"c\\"', true)).toBe('**Role:** a\nb "c"')
    expect(unwrapAnswer('{ "answer" : "done"}', true)).toBe("done")
  })
  it("never shows a half escape", () => {
    expect(unwrapAnswer('{"answer":"a\\', true)).toBe("a")
    expect(unwrapAnswer('{"answer":"a\\u00', true)).toBe("a")
    expect(unwrapAnswer('{"answer":"a\\u00e9b', true)).toBe("aéb")
  })
  it("stops at the closing quote: the rest of the wrapper is not shown", () => {
    expect(unwrapAnswer('{"answer":"ok","confidence":0.9}', true)).toBe("ok")
  })
})

describe("storedAnswer", () => {
  it("unwraps a stored answer that is the whole wrapper", () => {
    expect(storedAnswer('{"answer":"**Hi**\\nthere"}')).toBe("**Hi**\nthere")
  })
  it("keeps anything else as it is", () => {
    expect(storedAnswer("plain")).toBe("plain")
    expect(storedAnswer('{"answer":"x","more":1}')).toBe('{"answer":"x","more":1}')
    expect(storedAnswer('{"answer":"cut')).toBe('{"answer":"cut')
  })
})

describe("liveAnswer", () => {
  it("keeps the text after the last tool call, without results or thoughts", () => {
    const raw = "· init\n→ Read({\"file_path\":\"/a/b.ts\"})\n← 10 lines\n💭 thinking\nThe **answer** so far"
    expect(liveAnswer(raw)).toBe("The **answer** so far")
  })
  it("unwraps graph-agent's wrapper while it streams", () => {
    expect(liveAnswer('{"answer":"Part')).toBe("Part")
    expect(liveAnswer('{"ans')).toBe("")
  })
})

describe("taskStreamUrl", () => {
  it("goes through the dashboard's relay with the thread's node", () => {
    expect(taskStreamUrl("http://127.0.0.1:18800", "dev-session", "t 1"))
      .toBe("/api/task/stream?node=http%3A%2F%2F127.0.0.1%3A18800&agent=dev-session&task=t%201")
  })
})

class FakeSource {
  fns: Record<string, ((ev: any) => void)[]> = {}
  closed = false
  addEventListener(type: string, fn: (ev: any) => void) { (this.fns[type] ||= []).push(fn) }
  close() { this.closed = true }
  emit(type: string, data?: unknown) { for (const fn of this.fns[type] || []) fn(data === undefined ? {} : { data: typeof data === "string" ? data : JSON.stringify(data) }) }
}

function harness() {
  const sources: FakeSource[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const texts: string[] = []
  let ends = 0
  const stop = followTaskStream("/u", (t) => texts.push(t), () => { ends++ }, {
    open: () => { const s = new FakeSource(); sources.push(s); return s },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t },
    clearTimer: (t) => { const i = timers.indexOf(t as any); if (i >= 0) timers.splice(i, 1) },
  })
  return { sources, timers, texts, ends: () => ends, stop }
}

describe("followTaskStream", () => {
  it("hands over the output as each chunk arrives, not at the end", () => {
    const h = harness()
    h.sources[0].emit("start", { initial: "Hel" })
    h.sources[0].emit("chunk", { text: "lo " })
    h.sources[0].emit("chunk", { text: "world" })
    expect(h.texts).toEqual(["Hel", "Hello ", "Hello world"])
  })
  it("gives the start event and each chunk's time to the Task page (#2101 T2)", () => {
    const starts: unknown[] = []
    const seen: [string, { text: string; at: number } | undefined][] = []
    const s = new FakeSource()
    followTaskStream("/u", (t, c) => seen.push([t, c]), () => {}, { open: () => s, onStart: (d) => starts.push(d) })
    s.emit("start", { initial: "a", stamps: [[0, 5]], message: "Fix it" })
    s.emit("chunk", { text: "b", at: 9 })
    expect(starts).toEqual([{ initial: "a", stamps: [[0, 5]], message: "Fix it" }])
    expect(seen).toEqual([["a", undefined], ["ab", { text: "b", at: 9 }]])
  })
  it("skips the finish marker and ends on 'end'", () => {
    const h = harness()
    h.sources[0].emit("chunk", { text: "a" })
    h.sources[0].emit("chunk", { text: TASK_FINISHED })
    h.sources[0].emit("end")
    expect(h.texts).toEqual(["a"])
    expect(h.ends()).toBe(1)
    expect(h.sources[0].closed).toBe(true)
  })
  it("a run already done ends at once", () => {
    const h = harness()
    h.sources[0].emit("start", { initial: "all", done: true })
    expect(h.ends()).toBe(1)
  })
  it("a dropped connection opens again and starts from the output so far", () => {
    const h = harness()
    h.sources[0].emit("chunk", { text: "ab" })
    h.sources[0].emit("error")
    expect(h.sources[0].closed).toBe(true)
    expect(h.timers.map((t) => t.ms)).toEqual([TASK_STREAM_RETRY_MS[0]])
    h.timers.shift()!.fn()
    expect(h.sources).toHaveLength(2)
    h.sources[1].emit("start", { initial: "abc" })
    h.sources[1].emit("chunk", { text: "d" })
    expect(h.texts.at(-1)).toBe("abcd")
  })
  it("gives up after the last wait; the node's own error is not retried", () => {
    const h = harness()
    for (let i = 0; i < TASK_STREAM_RETRY_MS.length; i++) { h.sources.at(-1)!.emit("error"); h.timers.shift()!.fn() }
    h.sources.at(-1)!.emit("error")
    expect(h.timers).toHaveLength(0)
    const g = harness()
    g.sources[0].emit("error", { message: "unknown task" })
    expect(g.timers).toHaveLength(0)
  })
  it("stop closes the stream and drops a pending reopen", () => {
    const h = harness()
    h.sources[0].emit("error")
    h.stop()
    expect(h.timers).toHaveLength(0)
    const k = harness()
    k.stop()
    expect(k.sources[0].closed).toBe(true)
  })
})

describe("ChatAnswer", () => {
  it("shows the text at once while the renderer loads", () => {
    const html = renderToStaticMarkup(createElement(ChatAnswer, { md: "**Role:** x", streaming: false }))
    expect(html).toContain('data-shell="answer"')
    expect(html).toContain("**Role:** x")
  })
})

describe("ChatMarkdown", () => {
  it("renders markdown, not its asterisks (the Task page's renderer)", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { md: "**Role:** builder\n\n- one\n- two", streaming: false }))
    expect(html).toContain("axc-md")
    expect(html).not.toContain("**Role:**")
    expect(html).toMatch(/<(strong|span)[^>]*data-streamdown="strong"[^>]*>Role:<\/(strong|span)>/)
    expect(html).toMatch(/<li[^>]*>.*one/)
  })
  it("does not render raw HTML from an answer", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { md: "<img src=x onerror=alert(1)>", streaming: false }))
    expect(html).not.toMatch(/<img/i)
  })
  it("a half-written reply (open fence) still renders while streaming", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { md: "Here:\n```ts\nconst a = 1", streaming: true }))
    expect(html).toContain("Here:")
  })
})
