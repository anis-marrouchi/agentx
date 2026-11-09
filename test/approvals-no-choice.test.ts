import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createCard, decideCard, verdictMessage, type DecisionCard } from "../src/approvals/cards"
import { isNoChoice } from "../src/approvals/choices"
import { parseAnswer } from "../src/approvals/card-window"
import { decide } from "../src/approvals/inbox"
import { readAnswered } from "../src/approvals/answered"
import { cardAsText, popupCaller, popupCliMode, popupLogLine } from "../src/approvals/popup-cli"

// #1788: a card's Send button returns yes with whatever option is picked,
// so "Don't send" travelled as "The operator said YES ... send exactly
// this". And `approvals popup <key>`, run by an agent to read a card, put
// the window on screen and recorded a click as the operator's answer.

const NOW = Date.parse("2026-11-09T08:00:00.000Z")
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agentx-nochoice-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function raise(extra: Record<string, unknown> = {}): DecisionCard {
  const r = createCard(root, {
    raised_by: "helper", title: "Reply to the supplier", ask: "Send this reply?",
    recommend: "Send as drafted: it answers their question", if_silent: "keep",
    choices: ["Send as drafted", "Send shorter", "Don't send"], draft: "Hello, yes we can.", ...extra,
  }, { now: NOW })
  if (!r.ok) throw new Error(r.error)
  return r.card
}

describe("options that mean no", () => {
  it("knows a no option from its first words", () => {
    for (const l of ["Don't send", "Don’t send", "Do not book", "No", "No: wait", "Not now", "Skip it", "Cancel", "Never", "Decline"]) expect(isNoChoice(l)).toBe(true)
    for (const l of ["Send as drafted", "Thursday 10:00", "Note it", "Nothing changed, send", "Knot", undefined, ""]) expect(isNoChoice(l)).toBe(false)
  })
})

describe("a yes with a no option is recorded as no", () => {
  it("keeps the pick, drops the text, and tells the agent no", () => {
    const card = raise()
    const r = decideCard(root, card.id, "yes", { by: "operator (popup)", choice: "Don't send", text: "Hello, yes we can.", now: NOW })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.card).toMatchObject({ status: "decided", verdict: "no", choice: "Don't send" })
    expect(r.card.text).toBeUndefined()
    const msg = verdictMessage(r.card)
    expect(msg).toContain("The operator said NO.")
    expect(msg).toContain("Chosen: Don't send (this option means no")
    expect(msg).not.toContain("YES")
    expect(msg).not.toContain("send exactly this")
  })

  it("leaves a send option a yes with its text", () => {
    const r = decideCard(root, raise().id, "yes", { choice: 2, text: "Yes.", now: NOW })
    expect(r.ok && r.card).toMatchObject({ verdict: "yes", choice: "Send shorter", text: "Yes." })
    if (r.ok) expect(verdictMessage(r.card)).toContain("send exactly this")
  })

  it("the inbox says no and the Answered list records no", async () => {
    const card = raise()
    const r = await decide({ root, now: NOW }, `card:${card.id}`, "yes", { by: "operator (popup)", choice: "Don't send", text: "Hello" })
    expect(r).toMatchObject({ ok: true, verdict: "no" })
    if (r.ok) expect(r.message).toContain("will be told no")
    const item = readAnswered(root).find((a) => a.key === `card:${card.id}`)
    expect(item).toMatchObject({ answer: "no", choice: "Don't send" })
    expect(item?.text).toBeUndefined()
  })

  it("a timeout or close stays a dismiss", () => {
    const card = raise()
    expect(parseAnswer(JSON.stringify({ action: "dismiss", why: "timed out" }), card)).toEqual({ action: "dismiss", why: "timed out" })
    expect(parseAnswer("garbage", card)).toEqual({ action: "dismiss" })
  })
})

describe("approvals popup from a terminal", () => {
  it("inside an agent's run it only prints, never records", () => {
    const env = { AGENTX_AGENT_ID: "coo-agent" }
    expect(popupCliMode({}, env)).toEqual({ mode: "print", agent: "coo-agent" })
    expect(popupCliMode({ dryRun: true }, env).mode).toBe("show")
    expect(popupCliMode({ print: true }, env).mode).toBe("print")
  })

  it("the operator's terminal records by default; --print and --dry-run do not", () => {
    expect(popupCliMode({}, {})).toEqual({ mode: "record", agent: undefined })
    expect(popupCliMode({ print: true }, {}).mode).toBe("print")
    expect(popupCliMode({ dryRun: true }, {}).mode).toBe("show")
    expect(popupCliMode({ sample: true }, { AGENTX_AGENT_ID: "x" }).mode).toBe("sample")
  })

  it("prints the card and logs who ran it", () => {
    const card = raise()
    const text = cardAsText(card)
    expect(text).toContain("Send this reply?")
    expect(text).toContain("3. Don't send")
    const who = popupCaller("coo-agent")
    expect(popupLogLine("card:x", who, "printed")).toBe("[approvals] popup (agent coo-agent (terminal)): printed card:x; nothing shown, nothing recorded")
    expect(popupLogLine("card:x", popupCaller(undefined), { action: "yes", choice: "Don't send" })).toContain("answered yes (Don't send)")
    expect(popupLogLine("card:x", who, { action: "dismiss", why: "closed" })).toContain("left waiting: closed")
  })
})
