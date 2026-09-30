import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createCard, decideCard, readCard, verdictMessage, type DecisionCard } from "../src/approvals/cards"
import { buildChoices, draftFor, resolveAnswer, CHOICE_LIMITS } from "../src/approvals/choices"
import { decide, listInbox } from "../src/approvals/inbox"
import { chooseArgs, dialogArgs, parseDialog, showPopup, spokenLine, type PopupSettings, type Run } from "../src/approvals/popup"
import { nextCardToPop, popNext, type PopupRunnerSettings } from "../src/approvals/popup-runner"
import { readInboxState, snooze } from "../src/approvals/state"
import { daemonConfigSchema } from "../src/daemon/config"

// The Mac popup for decision cards. What must hold:
//   - choices, a draft and a spoken line are optional; plain cards are unchanged
//   - a yes on a card with choices says which one, and carries the final text
//   - the agent's result message carries the pick and the exact text
//   - card text reaches osascript as argv, never as script
//   - nothing pops in Focus, one popup at a time, each card once
//   - Cancel, Not now or no answer leaves the card waiting: nothing is decided

const NOW = Date.parse("2026-09-30T08:00:00.000Z")
const HOUR = 3_600_000

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agentx-popup-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const BASE = {
  raised_by: "helper",
  title: "New meeting date for the client",
  ask: "Which date should I offer?",
  recommend: "Thursday: the calendar is free",
  if_silent: "discard",
}
const SLOTS = ["Thu 1 Oct 12:00", "Sun 4 Oct 11:00", "Mon 5 Oct 14:00"]

function raise(extra: Record<string, unknown> = {}, now = NOW): DecisionCard {
  const r = createCard(root, { ...BASE, ...extra }, { now })
  if (!r.ok) throw new Error(r.error)
  return r.card
}

const POPUP: PopupRunnerSettings = { enabled: true, speak: true, sound: "Glass", volume: 0.4, timeoutSeconds: 60 }
const off = () => ({ active: false, mode: null, reason: "test" })
const inFocus = () => ({ active: true, mode: "com.apple.focus.work", reason: "test" })

describe("card choices", () => {
  it("are optional: a plain card has none", () => {
    const c = raise()
    expect(c.choices).toBeUndefined()
    expect(c.draft).toBeUndefined()
  })

  it("keeps choices, draft and say", () => {
    const c = raise({ choices: SLOTS, draft: "Hello,\nhow about {choice}?", say: "The client needs a date" })
    expect(c.choices).toEqual(SLOTS)
    expect(c.draft).toBe("Hello,\nhow about {choice}?")
    expect(c.say).toBe("The client needs a date")
  })

  it("refuses bad choices", () => {
    expect(buildChoices({ choices: "one" }).ok).toBe(false)
    expect(buildChoices({ choices: ["a", ""] }).ok).toBe(false)
    expect(buildChoices({ choices: ["a", "a"] }).ok).toBe(false)
    expect(buildChoices({ choices: ["1", "2", "3", "4", "5", "6"] }).ok).toBe(false)
    expect(buildChoices({ choices: ["x".repeat(CHOICE_LIMITS.label + 1)] }).ok).toBe(false)
    expect(buildChoices({ say: "x".repeat(CHOICE_LIMITS.say + 1) }).ok).toBe(false)
    expect(createCard(root, { ...BASE, choices: ["a", "a"] }).ok).toBe(false)
  })

  it("fills {choice} into the draft", () => {
    expect(draftFor("See you {choice}.", "Thu")).toBe("See you Thu.")
    expect(draftFor("See you soon.", "Thu")).toBe("See you soon.")
    expect(draftFor(undefined, "Thu")).toBe("")
  })

  it("a yes must pick one, by number or label", () => {
    const card = { choices: SLOTS, draft: "How about {choice}?" }
    expect(resolveAnswer(card, "yes", {}).ok).toBe(false)
    expect(resolveAnswer(card, "yes", { choice: 4 }).ok).toBe(false)
    expect(resolveAnswer(card, "yes", { choice: "2" })).toEqual({ ok: true, choice: SLOTS[1], text: `How about ${SLOTS[1]}?` })
    expect(resolveAnswer(card, "yes", { choice: SLOTS[2], text: "Edited" })).toEqual({ ok: true, choice: SLOTS[2], text: "Edited" })
    expect(resolveAnswer(card, "no", {})).toEqual({ ok: true })
    expect(resolveAnswer({}, "yes", { choice: 1 }).ok).toBe(false)
  })

  it("the agent is told the pick and the exact text", () => {
    const c = raise({ choices: SLOTS, draft: "How about {choice}?" })
    const r = decideCard(root, c.id, "yes", { choice: 1, text: "Edited: Thursday works", now: NOW })
    expect(r.ok).toBe(true)
    const msg = verdictMessage(readCard(root, c.id)!)
    expect(msg).toContain(`Chosen: ${SLOTS[0]}`)
    expect(msg).toContain("Edited: Thursday works")
  })

  it("a no carries no text", () => {
    const c = raise({ choices: SLOTS, draft: "How about {choice}?" })
    decideCard(root, c.id, "no", { now: NOW })
    expect(verdictMessage(readCard(root, c.id)!)).not.toContain("Approved text")
  })

  it("the inbox shows the choices, and yes without one is refused", async () => {
    const c = raise({ choices: SLOTS })
    const item = listInbox({ root, now: NOW }).items[0]
    expect(item.choices).toEqual(SLOTS)
    const refused = await decide({ root, now: NOW }, `card:${c.id}`, "yes")
    expect(refused.ok).toBe(false)
    const ok = await decide({ root, now: NOW }, `card:${c.id}`, "yes", { choice: 3 })
    expect(ok.ok && ok.message).toContain(SLOTS[2])
  })
})

describe("the dialog", () => {
  it("passes card text as argv, not script", () => {
    const evil = 'x" & (do shell script "rm -rf ~") & "'
    const args = chooseArgs(evil, evil, [evil])
    const script = args.filter((_, i) => args[i - 1] === "-e").join("\n")
    expect(script).not.toContain("rm -rf")
    expect(args.slice(-3)).toEqual([evil, evil, evil])
    const d = dialogArgs(evil, evil, ["Cancel", "Send"], 60, evil)
    expect(d.filter((_, i) => d[i - 1] === "-e").join("\n")).not.toContain("rm -rf")
  })

  it("reads the button and a multi-line text", () => {
    expect(parseDialog("Send\nHello\nthere\n")).toEqual({ button: "Send", text: "Hello\nthere" })
    expect(parseDialog("Yes\n")).toEqual({ button: "Yes", text: "" })
    expect(parseDialog("")).toBeNull()
  })

  it("speaks the say line, else the title, kept short", () => {
    expect(spokenLine({ say: "Pick a date", title: "T" })).toBe("Pick a date")
    expect(spokenLine({ title: "Title only" })).toBe("Title only")
    expect(spokenLine({ title: "x".repeat(400) }).length).toBe(160)
  })

  /** A fake osascript: answers each dialog in turn; records every call. */
  function fake(answers: string[]): { run: Run; calls: Array<{ file: string; args: string[] }> } {
    const calls: Array<{ file: string; args: string[] }> = []
    const run: Run = async (file, args) => {
      calls.push({ file, args })
      if (file !== "/usr/bin/osascript") return { ok: true, stdout: "" }
      const out = answers.shift()
      return out === undefined ? { ok: false, stdout: "" } : { ok: true, stdout: out }
    }
    return { run, calls }
  }
  const S: PopupSettings = { style: "dialog", speak: true, sound: "", volume: 0.4, timeoutSeconds: 60 }

  it("choice, then edit, then Send", async () => {
    const c = raise({ choices: SLOTS, draft: "How about {choice}?", say: "Pick a date" })
    const f = fake([`${SLOTS[1]}\n`, `Send\nHow about ${SLOTS[1]}? Thanks\n`])
    expect(await showPopup(c, S, { run: f.run })).toEqual({ action: "yes", choice: SLOTS[1], text: `How about ${SLOTS[1]}? Thanks` })
    expect(f.calls[0]).toEqual({ file: "/usr/bin/say", args: ["--", "Pick a date"] })
    // The edit box opens with the draft already filled for that pick.
    expect(f.calls[2].args.at(-1)).toBe(`How about ${SLOTS[1]}?`)
  })

  it("Not now, Cancel, an emptied box or a timeout is a dismiss", async () => {
    const c = raise({ choices: SLOTS, draft: "How about {choice}?" })
    expect(await showPopup(c, S, { run: fake(["\n"]).run })).toEqual({ action: "dismiss" })
    expect(await showPopup(c, S, { run: fake([`${SLOTS[0]}\n`, "Cancel\nHow about it\n"]).run })).toEqual({ action: "dismiss" })
    expect(await showPopup(c, S, { run: fake([`${SLOTS[0]}\n`, "Send\n   \n"]).run })).toEqual({ action: "dismiss" })
    expect(await showPopup(c, S, { run: fake([]).run })).toEqual({ action: "dismiss" })
  })

  it("a plain card is Yes, No or Not now", async () => {
    const c = raise()
    expect(await showPopup(c, S, { run: fake(["Yes\n"]).run })).toEqual({ action: "yes" })
    expect(await showPopup(c, S, { run: fake(["No\n"]).run })).toEqual({ action: "no" })
    expect(await showPopup(c, S, { run: fake(["Not now\n"]).run })).toEqual({ action: "dismiss" })
  })

  it("stays quiet when speech and sound are off", async () => {
    const f = fake(["Yes\n"])
    await showPopup(raise(), { ...S, speak: false, sound: "" }, { run: f.run })
    expect(f.calls.map((c) => c.file)).toEqual(["/usr/bin/osascript"])
  })
})

describe("when the popup shows", () => {
  const logs: string[] = []
  const deps = (extra: Partial<Parameters<typeof popNext>[0]> = {}) => ({
    ctx: { root, now: NOW }, settings: POPUP, log: (m: string) => logs.push(m), platform: "darwin" as const, focus: off, ...extra,
  })

  it("is off by default, and off outside macOS", async () => {
    expect(daemonConfigSchema.parse({ node: { id: "n", name: "n" } }).approvals.popup.enabled).toBe(false)
    raise()
    expect(await popNext(deps({ settings: { ...POPUP, enabled: false } }))).toBe("off")
    expect(await popNext(deps({ platform: "linux" }))).toBe("off")
  })

  it("holds in Focus and shows once Focus ends", async () => {
    const c = raise()
    let shown = 0
    const show = async () => { shown++; return { action: "dismiss" as const } }
    expect(await popNext(deps({ focus: inFocus, show }))).toBe("held")
    expect(shown).toBe(0)
    expect(await popNext(deps({ show }))).toBe("shown")
    expect(shown).toBe(1)
    expect(readInboxState(root).popped?.[`card:${c.id}`]).toBeTruthy()
  })

  it("shows each card once; a dismiss leaves it waiting", async () => {
    const c = raise()
    const show = async () => ({ action: "dismiss" as const })
    expect(await popNext(deps({ show }))).toBe("shown")
    expect(await popNext(deps({ show }))).toBe("none")
    expect(readCard(root, c.id)?.status).toBe("pending")
  })

  it("records Send as the operator's yes, with the pick and text", async () => {
    const c = raise({ choices: SLOTS, draft: "How about {choice}?" })
    const show = async () => ({ action: "yes" as const, choice: SLOTS[0], text: "Thursday then" })
    await popNext(deps({ show }))
    const done = readCard(root, c.id)!
    expect(done).toMatchObject({ status: "decided", verdict: "yes", choice: SLOTS[0], text: "Thursday then", decided_by: "operator (popup)" })
  })

  it("one at a time", async () => {
    raise(); raise({ title: "Second" })
    let release!: () => void
    const show = () => new Promise<{ action: "dismiss" }>((r) => { release = () => r({ action: "dismiss" }) })
    const first = popNext(deps({ show }))
    expect(await popNext(deps({ show }))).toBe("busy")
    release()
    expect(await first).toBe("shown")
  })

  it("an answer given elsewhere first wins", async () => {
    const c = raise()
    const show = async () => {
      decideCard(root, c.id, "no", { now: NOW })
      return { action: "yes" as const }
    }
    await popNext(deps({ show }))
    expect(readCard(root, c.id)?.verdict).toBe("no")
  })

  it("skips cards put off with later, and old ones", () => {
    const old = raise({}, NOW - 30 * HOUR)
    expect(nextCardToPop({ root, now: NOW })).toBeNull()
    const fresh = raise({ title: "Fresh" })
    snooze(root, `card:${fresh.id}`, new Date(NOW + HOUR), NOW)
    expect(nextCardToPop({ root, now: NOW })).toBeNull()
    expect(nextCardToPop({ root, now: NOW + 2 * HOUR })?.id).toBe(fresh.id)
    expect(old.id).toBeTruthy()
  })
})
