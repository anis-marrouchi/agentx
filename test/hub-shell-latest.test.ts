// #2101 R26: a click on an agent opens what it is doing. Working: its live
// run. Idle: its latest conversation from any channel, read only, with New
// Hub chat; no conversation (or a Hub chat): the Hub chat. A node that does
// not answer: "not checked".
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import {
  LATEST_TURNS, chatName, isHubChat, latestUrl, latestView, nodeName, rowOpens, runHref, sessionUrl, turnMessages, whenLabel,
} from "../src/hub/shell/latest"
import { LatestConversation } from "../src/hub/shell/LatestConversation"
import { TooltipProvider } from "../src/hub/ui"

const NODE = "http://127.0.0.1:18800"

describe("what a row opens", () => {
  it("a working agent with a run: its live run", () => {
    expect(rowOpens({ state: "working", taskId: "t1", nodeUrl: NODE })).toBe("run")
  })
  it("an agent with questions: the chat with its questions (#2505)", () => {
    expect(rowOpens({ state: "needs", taskId: "", nodeUrl: NODE })).toBe("chat")
  })
  it("idle, done today or failed: its latest conversation", () => {
    for (const state of ["idle", "done", "failed"] as const) expect(rowOpens({ state, taskId: "", nodeUrl: NODE })).toBe("latest")
  })
  it("a working agent never opens an older conversation, on this machine too (Anis 11-28)", () => {
    expect(rowOpens({ state: "working", taskId: "t1", nodeUrl: "" })).toBe("run")
    expect(rowOpens({ state: "working", taskId: "", nodeUrl: NODE })).toBe("chat")
  })
  it("a working row whose run is not known yet, or a row with no machine: the chat", () => {
    expect(rowOpens({ state: "working", taskId: "", nodeUrl: "" })).toBe("chat")
    expect(rowOpens({ state: "idle", taskId: "", nodeUrl: "" })).toBe("chat")
    expect(rowOpens(undefined)).toBe("chat")
  })
  it("the run link is the Task page address the old Hub's row opens", () => {
    const h = runHref({ id: "dev-session", taskId: "1795-abc", nodeUrl: NODE })
    const q = new URLSearchParams(h.slice(1))
    expect(Object.fromEntries(q)).toEqual({ page: "task", task: "1795-abc", agent: "dev-session", node: NODE })
  })
})

describe("the reads (GET only, behind the dashboard guard)", () => {
  it("asks the node for the latest chat, then that chat's last turns", () => {
    expect(latestUrl(NODE, "pm agent")).toBe("/api/mesh/latest?node=" + encodeURIComponent(NODE) + "&agent=pm+agent&limit=1")
    const s = new URLSearchParams(sessionUrl(NODE, "pm", "t9").split("?")[1])
    expect(s.get("session")).toBe("1")
    expect(s.get("task")).toBe("t9")
    expect(s.get("limit")).toBe(String(LATEST_TURNS))
  })
})

describe("what the centre shows", () => {
  it("a node that does not answer: not checked, never 'no conversation'", () => {
    expect(latestView({ failed: true }, "Mac")).toEqual({ kind: "unchecked", node: "Mac" })
  })
  it("loading until the read is in", () => {
    expect(latestView({ failed: false }, "Mac")).toEqual({ kind: "loading" })
  })
  it("no conversation: the Hub chat (C4)", () => {
    expect(latestView({ failed: false, data: { found: false, runs: [] } }, "Mac")).toEqual({ kind: "hub" })
  })
  it("the latest is a Hub chat: the Hub chat itself", () => {
    expect(isHubChat("dashboard", "assistant")).toBe(true)
    expect(latestView({ failed: false, data: { found: true, channel: "dashboard", chatId: "assistant", runs: [{ taskId: "t" }] } }, "Mac")).toEqual({ kind: "hub" })
  })
  it("a Telegram or agent-to-agent chat: read only, named in words", () => {
    expect(latestView({ failed: false, data: { found: true, channel: "telegram", chatId: "1", runs: [{ taskId: "t1" }] } }, "Mac")).toEqual({ kind: "read", channel: "Telegram", chat: "", taskId: "t1" })
    expect(latestView({ failed: false, data: { found: true, channel: "a2a", chatId: "a2a:x", runs: [{ taskId: "t2" }] } }, "Mac")).toMatchObject({ channel: "Agent to agent" })
  })
  it("names a machine by its name, else its host", () => {
    expect(nodeName(NODE, "Mac")).toBe("Mac")
    expect(nodeName("http://10.0.0.2:18800")).toBe("10.0.0.2:18800")
  })
  it("turns become the chat's messages: asked, then the answer, the error or the pending line", () => {
    const m = turnMessages([
      { id: "1", message: "Status?", responseText: "All green.", ok: true },
      { id: "2", message: "Deploy?", ok: false, error: "Timed out" },
      { id: "3", message: "Again", running: true },
    ])
    expect(m.map((x) => [x.role, x.status, x.content])).toEqual([
      ["user", "done", "Status?"], ["assistant", "done", "All green."],
      ["user", "done", "Deploy?"], ["assistant", "error", "Timed out"],
      ["user", "done", "Again"], ["assistant", "pending", ""],
    ])
  })
})

function draw(seed: (c: QueryClient) => void, hub: ReactNode = createElement("p", { "data-test": "hub-chat" }, "Hub chat")) {
  // retryOnMount off: a seeded error stays an error in a server render.
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } })
  seed(client)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(TooltipProvider, null,
      createElement(LatestConversation, {
        agent: { id: "pm", name: "PM" }, nodeUrl: NODE, node: "Mac", hub, onNewChat: () => {},
        turn: (m) => createElement("p", { "data-turn": m.role }, m.content),
      }))))
}

describe("the view", () => {
  it("shows the latest Telegram turns read only, with New Hub chat", () => {
    const html = draw((c) => {
      c.setQueryData(["agent-latest", NODE, "pm"], { found: true, channel: "telegram", chatId: "1", runs: [{ taskId: "t1" }] })
      c.setQueryData(["agent-latest-turns", NODE, "pm", "t1"], { turns: [{ id: "t1", message: "Where is the report?", responseText: "Sent at 09:00.", ok: true }] })
    })
    expect(html).toContain('data-shell="latest"')
    expect(html).toContain("Telegram · read only")
    expect(html).toContain('data-turn="user">Where is the report?')
    expect(html).toContain('data-turn="assistant">Sent at 09:00.')
    expect(html).toContain('data-shell="new-hub-chat"')
    expect(html).toContain("New Hub chat")
    // Read only: no writing box.
    expect(html).not.toContain("<textarea")
  })
  it("no conversation: opens the Hub chat instead (C4)", () => {
    const html = draw((c) => c.setQueryData(["agent-latest", NODE, "pm"], { found: false, runs: [] }))
    expect(html).toContain('data-test="hub-chat"')
    expect(html).not.toContain('data-shell="latest"')
  })
  it("a node that does not answer: not checked, with New Hub chat (C3)", () => {
    const html = draw((c) => {
      const q = c.getQueryCache().build(c, { queryKey: ["agent-latest", NODE, "pm"] })
      q.setState({ status: "error", error: new Error("502"), fetchStatus: "idle" })
    })
    expect(html).toContain("Latest conversation not checked")
    expect(html).toContain("Mac did not answer")
    expect(html).toContain('data-shell="new-hub-chat"')
    expect(html).not.toContain('data-test="hub-chat"')
  })
})

describe("when and where it came from (#2552 C1, Anis 11-28: \"no dates, no mention\")", () => {
  const NOW = new Date(2026, 10, 28, 10, 0).getTime()
  it("says the day and time in plain words", () => {
    expect(whenLabel(new Date(2026, 10, 28, 8, 55).getTime(), NOW)).toBe("Today 08:55")
    expect(whenLabel(new Date(2026, 10, 27, 21, 10).getTime(), NOW)).toBe("Yesterday 21:10")
    expect(whenLabel(new Date(2026, 10, 24, 9, 5).getTime(), NOW)).toBe("Tue 24 Nov, 09:05")
    expect(whenLabel(new Date(2025, 11, 31, 23, 0).getTime(), NOW)).toBe("Wed 31 Dec 2025, 23:00")
  })
  it("names the chat: the other agent, the schedule's job, else the id; never a bare number", () => {
    expect(chatName("a2a", "a2a:pm-agent:dev-session:dlg-1", "dev-session")).toBe("with pm-agent")
    expect(chatName("a2a", "a2a:dev-session:coder-agent:dlg-2", "dev-session")).toBe("with coder-agent")
    expect(chatName("cron", "cron:daily-digest", "pm")).toBe("daily-digest")
    expect(chatName("github", "anis-marrouchi/agentx#2101", "pm")).toBe("anis-marrouchi/agentx#2101")
    expect(chatName("telegram", "-100123", "pm")).toBe("")
    expect(chatName("whatsapp", "21612345678@s.whatsapp.net", "pm")).toBe("")
    expect(chatName("gitlab", "-", "pm")).toBe("")
    expect(chatName("workflow", "x".repeat(40), "pm")).toBe("x".repeat(31) + "…")
  })
  it("the read view carries the chat's name", () => {
    expect(latestView({ data: { found: true, channel: "a2a", chatId: "a2a:pm-agent:dev-session:d", runs: [{ taskId: "t1" }] }, failed: false }, "Mac", "dev-session"))
      .toEqual({ kind: "read", channel: "Agent to agent", chat: "with pm-agent", taskId: "t1" })
  })
  it("each asked turn carries its time and sender", () => {
    const m = turnMessages([{ id: "t1", message: "Status?", responseText: "Green.", ok: true, startedAt: "2026-11-28T08:55:00.000Z", sender: "Anis" }])
    expect(m[0]).toMatchObject({ role: "user", at: Date.parse("2026-11-28T08:55:00.000Z"), from: "Anis" })
    expect(m[1].at).toBeUndefined()
  })
  it("the view shows the chat in the header, the last time, and each turn's time and sender", () => {
    const at = "2026-11-27T08:55:00.000Z"
    const html = draw((c) => {
      c.setQueryData(["agent-latest", NODE, "pm"], { found: true, channel: "a2a", chatId: "a2a:dev-session:pm:dlg-9", runs: [{ taskId: "t1" }] })
      c.setQueryData(["agent-latest-turns", NODE, "pm", "t1"], { turns: [{ id: "t1", message: "Ready time?", responseText: "18:19Z.", ok: true, startedAt: at, sender: "dev-session" }] })
    })
    expect(html).toContain("Agent to agent · with dev-session · read only")
    expect(html).toContain('data-shell="latest-when"')
    expect(html).toContain(`dateTime="${at}"`)
    expect(html).toContain('data-shell="turn-meta"')
    expect(html).toContain("from dev-session")
    expect(html).toContain("It happened in Agent to agent · with dev-session.")
  })
  it("a turn with no time or sender shows no empty line", () => {
    const html = draw((c) => {
      c.setQueryData(["agent-latest", NODE, "pm"], { found: true, channel: "telegram", chatId: "1", runs: [{ taskId: "t1" }] })
      c.setQueryData(["agent-latest-turns", NODE, "pm", "t1"], { turns: [{ id: "t1", message: "Hi", responseText: "Hello", ok: true }] })
    })
    expect(html).not.toContain('data-shell="turn-meta"')
    expect(html).not.toContain('data-shell="latest-when"')
  })
})
