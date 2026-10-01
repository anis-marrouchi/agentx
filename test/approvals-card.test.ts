import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createCard, type DecisionCard } from "../src/approvals/cards"
import { recommended, renderCardPage } from "../src/approvals/card-page"
import { parseAnswer, showCardWindow, WINDOW_JXA } from "../src/approvals/card-window"
import { showPopup, type PopupSettings, type Run } from "../src/approvals/popup"
import { sampleCard } from "../src/approvals/sample-card"
import { daemonConfigSchema } from "../src/daemon/config"

// The Mac card (a web page in a floating window). What must hold:
//   - every piece of card text is escaped; the page can't load anything
//   - the page's answer is checked against the card again: a pick the card
//     didn't offer, or an empty message, is a dismiss, never a yes
//   - the page file is private and removed after
//   - when the window can't open, the plain dialogs take over

const NOW = Date.parse("2026-09-30T08:00:00.000Z")
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agentx-card-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function raise(extra: Record<string, unknown> = {}): DecisionCard {
  const r = createCard(root, {
    raised_by: "helper", title: "New meeting date", ask: "Which date?", recommend: "Thursday", if_silent: "keep", ...extra,
  }, { now: NOW })
  if (!r.ok) throw new Error(r.error)
  return r.card
}

describe("the card page", () => {
  it("escapes card text and forbids the network", () => {
    const c = raise({ title: `<img src=x onerror=alert(1)>`, context: `</script><script>alert(2)</script>`, choices: ["A & B", `"quoted"`] })
    const html = renderCardPage(c, { now: NOW })
    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).not.toContain("</script><script>alert(2)")
    expect(html).toContain("A &amp; B")
    expect(html).toMatch(/Content-Security-Policy" content="default-src 'none'/)
    // Only the page's own script runs: it carries the nonce.
    const nonce = /script-src 'nonce-([^']+)'/.exec(html)![1]
    expect(html.match(/<script nonce="/g)).toHaveLength(1)
    expect(html).toContain(`<script nonce="${nonce}">`)
  })

  it("shows the parts that are there, and the sender's name", () => {
    const plain = renderCardPage(raise(), { now: NOW, from: "Robin" })
    expect(plain).toContain("Robin recommends")
    expect(plain).toContain('class="kind decision"')
    expect(plain).not.toContain('class="options"')
    expect(plain).not.toContain("<textarea")
    expect(plain).toContain(">Yes<kbd>")
    const full = renderCardPage(raise({ choices: ["Thu", "Sun"], draft: "Ok for {choice}", context: "He said: pick one" }), { now: NOW })
    expect(full).toContain('class="options"')
    expect(full).toContain('data-i="1"')
    expect(full).toContain("<textarea")
    expect(full).toContain("He said: pick one")
    expect(full).toContain(">Send<kbd>")
  })

  it("marks reminder cards and keeps Arabic readable", () => {
    const html = renderCardPage(sampleCard(NOW), { now: NOW })
    expect(html).toContain(">Reminder<")
    expect(html).toMatch(/<textarea id="text" dir="auto"/)
    expect(html).toMatch(/since \d\d:\d\d</)
    expect(html).toMatch(/If you don't answer by [A-Z][a-z]{2} \d\d:\d\d: keep\./)
    const old = renderCardPage({ ...sampleCard(NOW), created_at: "2026-09-27T12:00:00.000Z", expires: "2026-10-20T12:00:00.000Z" }, { now: NOW })
    expect(old).toContain("since 27 Sep<")
    expect(old).toMatch(/by Tue 20 Oct \d\d:\d\d: keep/)
  })

  it("carries its own colours, not the dashboard's", () => {
    const html = renderCardPage(sampleCard(NOW), { now: NOW })
    expect(html).toContain("--ac-paper")
    expect(html).not.toContain("--ax-")
  })

  it("marks the option the recommendation names and opens on it", () => {
    const data = (html: string) => JSON.parse(/<script type="application\/json" id="data">(.*?)<\/script>/s.exec(html)![1])
    const named = raise({ choices: ["Thu", "Thu 10:00", "Sun"], recommend: "thu 10:00: the room is free", draft: "Ok for {choice}" })
    expect(recommended(named)).toEqual({ index: 1, why: "The room is free" })
    const html = renderCardPage(named, { now: NOW })
    expect(html).toMatch(/data-i="1"><span class="n">2<\/span><span class="t">Thu 10:00<\/span><i class="dot">/)
    expect(html.match(/<i class="dot"><\/i><\/button>/g)).toHaveLength(1)
    expect(html).toContain('<p class="why" dir="auto">The room is free</p>')
    expect(data(html).pick).toBe(1)
    // A pick asked for wins over the recommendation.
    expect(data(renderCardPage(named, { now: NOW, pick: 3 })).pick).toBe(2)
    // Advice that names no option: nothing is picked, the line shows whole.
    const unnamed = raise({ choices: ["Thu", "Sun"], recommend: "Whichever is sooner" })
    expect(recommended(unnamed)).toEqual({ index: -1, why: "Whichever is sooner" })
    expect(data(renderCardPage(unnamed, { now: NOW })).pick).toBe(-1)
    expect(recommended(raise({ choices: ["Thu", "Sun"], recommend: "Sun" }))).toEqual({ index: 1, why: "" })
  })

  it("plays the chime only when asked", () => {
    const data = (html: string) => JSON.parse(/<script type="application\/json" id="data">(.*?)<\/script>/s.exec(html)![1])
    expect(data(renderCardPage(raise(), { sound: "chime" })).chime).toBe(true)
    expect(data(renderCardPage(raise(), { sound: "Glass" })).chime).toBe(false)
  })
})

describe("the page's answer", () => {
  const card = () => raise({ choices: ["Thu", "Sun"], draft: "Ok for {choice}" })
  it("takes a yes with an offered pick and the edited text", () => {
    expect(parseAnswer('{"action":"yes","choice":"Sun","text":" Ok for Sun, thanks \\r\\n"}', card()))
      .toEqual({ action: "yes", choice: "Sun", text: "Ok for Sun, thanks" })
    expect(parseAnswer('{"action":"no"}', card())).toEqual({ action: "no" })
  })
  it("turns anything odd into a dismiss", () => {
    for (const out of ["", "garbage", '{"action":"yes","choice":"Mon","text":"x"}', '{"action":"yes","choice":"Sun","text":"  "}',
      '{"action":"yes","text":"no pick"}', '{"action":"maybe"}']) {
      expect(parseAnswer(out, card())).toEqual({ action: "dismiss" })
    }
  })
  it("a plain card's yes carries nothing", () => {
    expect(parseAnswer('{"action":"yes","choice":"x","text":"y"}', raise())).toEqual({ action: "yes" })
  })
})

describe("the window", () => {
  it("runs the JXA script on a private page file and removes it after", async () => {
    let seen: string[] = []
    let page = ""
    const run: Run = async (file, args) => {
      seen = [file, ...args]
      page = args[4]
      expect(readFileSync(page, "utf-8")).toContain("New meeting date")
      return { ok: true, stdout: '{"action":"no"}\n' }
    }
    expect(await showCardWindow(raise(), { timeoutSeconds: 60 }, run)).toEqual({ action: "no" })
    expect(seen.slice(0, 4)).toEqual(["/usr/bin/osascript", "-l", "JavaScript", "-e"])
    expect(seen[4]).toBe(WINDOW_JXA)
    // The window is see-through: the page draws the card and its shadow.
    expect(WINDOW_JXA).toContain("NSColor.clearColor")
    expect(existsSync(page)).toBe(false)
  })

  it("holds the card still for a picture", async () => {
    const pages: string[] = []
    const run: Run = async (_f, args) => { pages.push(readFileSync(args[4], "utf-8")); return { ok: true, stdout: "" } }
    await showCardWindow(raise(), { timeoutSeconds: 60 }, run)
    await showCardWindow(raise(), { timeoutSeconds: 60, capture: join(root, "card.png") }, run)
    expect(pages[0]).toContain('<main class="card">')
    expect(pages[1]).toContain('<main class="card still">')
  })

  it("falls back to the dialogs when the window can't open", async () => {
    const calls: string[] = []
    const run: Run = async (file, args) => {
      calls.push(args[1] === "JavaScript" ? "window" : file.endsWith("osascript") ? "dialog" : file)
      if (args[1] === "JavaScript") return { ok: false, stdout: "" }
      return { ok: true, stdout: "Yes\n" }
    }
    const s: PopupSettings = { style: "card", speak: false, sound: "", volume: 0.4, timeoutSeconds: 30 }
    expect(await showPopup(raise(), s, { run })).toEqual({ action: "yes" })
    expect(calls).toEqual(["window", "dialog"])
  })

  it("a closed window leaves the card waiting, without the dialogs", async () => {
    const calls: string[] = []
    const run: Run = async (_f, args) => { calls.push(args[1] ?? ""); return { ok: true, stdout: "" } }
    const s: PopupSettings = { speak: false, sound: "", volume: 0.4, timeoutSeconds: 30 }
    expect(await showPopup(raise(), s, { run })).toEqual({ action: "dismiss" })
    expect(calls).toEqual(["JavaScript"])
  })

  it("the chime is the card's; a system sound still plays through afplay", async () => {
    const files: string[] = []
    const run: Run = async (file) => { files.push(file); return { ok: true, stdout: "" } }
    await showPopup(raise(), { speak: false, sound: "chime", volume: 0.4, timeoutSeconds: 30 }, { run })
    expect(files).not.toContain("/usr/bin/afplay")
  })
})

describe("settings", () => {
  it("default to the card with the chime, following the system theme", () => {
    const p = daemonConfigSchema.parse({ node: { id: "n", name: "n" } }).approvals.popup
    expect(p).toMatchObject({ enabled: false, style: "card", theme: "system", sound: "chime" })
  })
})
