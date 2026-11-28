// #2499 part 2: Waiting on you, one at a time ("Go through them").
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import {
  DECIDE_URL, answerWords, byUrgent, decideBody, oneByOne, sendsOutside, sentSummary, waitingDeploy, wizardSteps,
  type WaitingItem,
} from "../src/hub/waiting"
import { NeedsWizard, WizardSummary } from "../src/hub/pages/NeedsWizard"
import { TooltipProvider } from "../src/hub/ui"

const NOW = Date.parse("2026-11-28T09:00:00Z")
const H = 3_600_000
const iso = (t: number) => new Date(t).toISOString()
const html = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TooltipProvider, null, el)))

// Today's shape, small: cards, schedules, and many "Not finished" requests.
const req = (n: number): WaitingItem => ({ key: `request:r${n}`, kind: "request", title: `Request ${n}`, ask: "Not finished. Ask coder to pick it up again?", agent: n % 2 ? "coder" : "writer", askedAt: iso(NOW - n * H) })
const items: WaitingItem[] = [
  { key: "card:old", kind: "card", title: "Rename the docs folder?", agent: "writer", askedAt: iso(NOW - 40 * H) },
  { key: "card:soon", kind: "card", title: "Keep the weekly digest?", agent: "pm", expires: iso(NOW + 2 * H), askedAt: iso(NOW - 1 * H) },
  { key: "card:deploy", kind: "card", title: "Deploy the client site to production?", agent: "devops", askedAt: iso(NOW - 3 * H) },
  { key: "schedule:backup", kind: "schedule", title: "Start the weekly backup check", agent: "devops", askedAt: iso(NOW - 5 * H) },
  ...Array.from({ length: 56 }, (_, n) => req(n + 1)),
]

describe("the wizard's order (#2499 part 2)", () => {
  it("deploys first, then the soonest to expire, then the oldest", () => {
    expect(waitingDeploy(items[2])).toBe(true)
    expect(waitingDeploy({ title: "Merge it?", ask: "Then we deploy on Monday" })).toBe(true)
    expect(waitingDeploy(items[0])).toBe(false)
    const sorted = items.slice(0, 4).sort(byUrgent).map((i) => i.key)
    expect(sorted).toEqual(["card:deploy", "card:soon", "card:old", "schedule:backup"])
  })
  it("the 56 requests are one step, last; cards and schedules one by one", () => {
    const steps = wizardSteps(items)
    expect(steps).toHaveLength(5)
    expect(steps.slice(0, 4).map((s) => s.kind === "one" && s.item.key)).toEqual(["card:deploy", "card:soon", "card:old", "schedule:backup"])
    const last = steps[4]
    expect(last.kind).toBe("requests")
    if (last.kind === "requests") expect(last.items).toHaveLength(56)
  })
  it("a single request is a step of its own", () => {
    const steps = wizardSteps([items[0], req(1)])
    expect(steps.every((s) => s.kind === "one")).toBe(true)
    expect(steps).toHaveLength(2)
  })
  it("one by one opens the requests step into a step per request, in place", () => {
    const steps = oneByOne(wizardSteps(items), 4)
    expect(steps).toHaveLength(4 + 56)
    expect(steps.every((s) => s.kind === "one")).toBe(true)
    expect(oneByOne(wizardSteps(items), 0)).toEqual(wizardSteps(items))
  })
})

describe("what is sent, and the summary", () => {
  it("each answer goes through the feed's decide call, choices 1-based", () => {
    expect(DECIDE_URL).toBe("/api/admin/wall/decide")
    expect(decideBody("card:a", "yes", 1)).toEqual({ key: "card:a", action: "yes", choice: 2 })
    expect(decideBody("card:a", "no", 1)).toEqual({ key: "card:a", action: "no" })
    expect(decideBody("request:r1", "later")).toEqual({ key: "request:r1", action: "later" })
  })
  it("says each answer in words", () => {
    expect(answerWords({ kind: "request" }, "yes")).toBe("Pick it up again")
    expect(answerWords({ kind: "request" }, "no")).toBe("Close it")
    expect(answerWords({ kind: "card", choices: ["A", "B"] }, "yes", 1)).toBe("B")
    expect(answerWords({ kind: "card" }, "no")).toBe("No")
    expect(answerWords({ kind: "card" }, "later")).toBe("Later")
  })
  it("asks once more only before sending outside", () => {
    expect(["whatsapp", "email", "content"].every(sendsOutside)).toBe(true)
    expect(["card", "schedule", "request"].some(sendsOutside)).toBe(false)
  })
  it("groups what went to whom, and keeps what failed apart", () => {
    const s = sentSummary([
      { key: "a", title: "A", agent: "coder", words: "Yes" },
      { key: "b", title: "B", agent: "pm", words: "No" },
      { key: "c", title: "C", agent: "coder", words: "Later" },
      { key: "d", title: "D", agent: "pm", words: "Yes", error: "unauthorized" },
    ])
    expect(s.byAgent.map((g) => [g.agent, g.answers.map((a) => a.key)])).toEqual([["coder", ["a", "c"]], ["pm", ["b"]]])
    expect(s.failed.map((a) => a.key)).toEqual(["d"])
  })
})

describe("the wizard on screen", () => {
  it("opens on the most urgent, with N left and its answers", () => {
    const out = html(createElement(NeedsWizard, { items, live: null, onClose: () => {}, now: NOW }))
    expect(out).toContain('data-shell="wizard"')
    expect(out).toContain("5 left")
    expect(out).toContain("Deploy the client site to production?")
    expect(out).toContain('data-answer-act="yes"')
    expect(out).toContain('data-answer-act="skip"')
    expect(out).toContain("animate-ax-slide-in")
    expect(out).not.toContain("view=decide")
  })
  it("the summary says what went to whom and what was not sent", () => {
    const out = html(createElement(WizardSummary, {
      sent: [{ key: "a", title: "Deploy the client site", agent: "devops", words: "Yes" }, { key: "b", title: "B", agent: "pm", words: "No", error: "offline" }],
      onClose: () => {},
    }))
    expect(out).toContain("1 answer sent")
    expect(out).toContain('data-summary-agent="devops"')
    expect(out).toContain("Not sent · 1")
    expect(out).toContain("offline")
  })
  it("skipping them all says nothing was sent", () => {
    expect(html(createElement(WizardSummary, { sent: [], onClose: () => {} }))).toContain("Nothing sent")
  })
})
