import { describe, expect, it } from "vitest"
import { appendFileSync, mkdtempSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { resolveCard, saveCard, type DecisionCard } from "../src/approvals/cards"
import { decide } from "../src/approvals/inbox"
import { answeredSince, readAnswered, recordAnswered } from "../src/approvals/answered"
import { handleApprovalsPanelApi } from "../src/daemon/approvals-panel"

// #1440: every yes or no through decide() lands on the answered list the
// Wall's Answered tab reads, and so does a card its agent closed after the
// owner answered elsewhere (resolveCard). "Later" and a refused answer do not.

const card = (id: string, extra: Partial<DecisionCard> = {}): DecisionCard => ({
  id, title: `Card ${id}`, ask: "Go?", recommend: "Tuesday", if_silent: "keep",
  expires: new Date(Date.now() + 3600e3).toISOString(), raised_by: "quill", created_at: new Date().toISOString(), status: "pending", ...extra,
})
const fresh = () => mkdtempSync(join(tmpdir(), "agentx-answered-"))
const file = (root: string) => join(root, ".agentx", "approvals", "_answered.jsonl")
const line = (n: number) => ({ key: `card:${n}`, kind: "card", title: "t", raised_by: "x", answer: "yes" as const, by: "o", at: new Date(n).toISOString() })

describe("answered list (#1440)", () => {
  it("keeps yes and no with the title and the pick, newest first; not later or a refusal", async () => {
    const root = fresh()
    saveCard(root, card("a", { choices: ["Now", "Tuesday"] }))
    saveCard(root, card("b"))
    saveCard(root, card("c"))
    expect((await decide({ root }, "card:a", "yes", { choice: 2, by: "operator (dashboard)" })).ok).toBe(true)
    // Later is a snooze, not an answer: the card still waits.
    expect((await decide({ root }, "card:b", "later")).ok).toBe(true)
    expect((await decide({ root }, "card:c", "no")).ok).toBe(true)
    expect((await decide({ root }, "card:missing", "yes")).ok).toBe(false)
    const list = readAnswered(root)
    expect(list.map((i) => [i.key, i.answer])).toEqual([["card:c", "no"], ["card:a", "yes"]])
    expect(list[1]).toMatchObject({ title: "Card a", kind: "card", raised_by: "quill", choice: "Tuesday", by: "operator (dashboard)" })
  })

  it("caps free text at 200 characters", async () => {
    const root = fresh()
    saveCard(root, card("t", { choices: ["Now", "Later"], draft: "Send it {choice}." }))
    expect((await decide({ root }, "card:t", "yes", { choice: 1, text: "x".repeat(900) })).ok).toBe(true)
    const [a] = readAnswered(root)
    expect(a.text!.length).toBe(200)
    expect(a.text!.endsWith("…")).toBe(true)
  })

  it("keeps a card its agent closed, as closed by that agent, here or from another node", () => {
    const root = fresh()
    saveCard(root, card("r"))
    saveCard(root, card("f", { raised_by: "scout", node: "mini" }))
    expect(resolveCard(root, "r", { by: "quill", reason: "Owner said yes in chat; sent it" }).ok).toBe(true)
    // The forwarded close (forward.ts) arrives with the raising node.
    expect(resolveCard(root, "f", { by: "scout", node: "mini", reason: "Answered on Telegram" }).ok).toBe(true)
    // Refused: another agent's card. Not on the list.
    saveCard(root, card("x"))
    expect(resolveCard(root, "x", { by: "scout", reason: "no" }).ok).toBe(false)
    const list = readAnswered(root)
    expect(list.map((i) => [i.key, i.answer, i.by])).toEqual([["card:f", "closed", "scout on mini"], ["card:r", "closed", "quill"]])
    expect(list[1]).toMatchObject({ title: "Card r", raised_by: "quill", text: "Owner said yes in chat; sent it" })
  })

  it("trims to the last 500 lines", () => {
    const root = fresh()
    for (let n = 0; n < 700; n++) recordAnswered(root, line(n))
    expect(readFileSync(file(root), "utf-8").split("\n").filter(Boolean)).toHaveLength(500)
    expect(readAnswered(root)).toHaveLength(50)
    expect(readAnswered(root, 1)[0].key).toBe("card:699")
    expect(readAnswered(root, 1000).at(-1)!.key).toBe("card:200")
  })

  it("skips a line that does not parse", () => {
    const root = fresh()
    recordAnswered(root, line(1))
    appendFileSync(file(root), "{not json\n[]\n")
    recordAnswered(root, line(2))
    appendFileSync(file(root), '{"key":"card:3","at":')
    expect(readAnswered(root).map((i) => i.key)).toEqual(["card:2", "card:1"])
  })

  it("keeps the day it started, from the first read or answer", () => {
    const root = fresh()
    const since = answeredSince(root)
    expect(Date.parse(since)).toBeGreaterThan(0)
    recordAnswered(root, line(1))
    expect(answeredSince(root)).toBe(since)
  })

  it("GET ?answered=1 sends the list and its start, past a bad line", async () => {
    const root = fresh()
    saveCard(root, card("g"))
    await decide({ root }, "card:g", "no")
    appendFileSync(file(root), "garbage\n")
    const res = fakeRes()
    const url = new URL("http://x/api/admin/approvals?answered=1")
    expect(await handleApprovalsPanelApi({ method: "GET" } as any, res as any, url.pathname, url, { ctx: { root, configPath: join(root, "agentx.json"), reload: false } })).toBe(true)
    expect(res.status).toBe(200)
    expect(res.json.answered.map((i: any) => [i.key, i.answer])).toEqual([["card:g", "no"]])
    expect(Date.parse(res.json.answered_since)).toBeGreaterThan(0)
    // Without the flag: not sent.
    const plain = fakeRes()
    const u2 = new URL("http://x/api/admin/approvals")
    await handleApprovalsPanelApi({ method: "GET" } as any, plain as any, u2.pathname, u2, { ctx: { root, configPath: join(root, "agentx.json"), reload: false } })
    expect(plain.json.answered).toBeUndefined()
  })
})

function fakeRes() {
  const r: any = { status: 0, json: undefined, headers: {} }
  r.writeHead = (s: number, h?: any) => { r.status = s; Object.assign(r.headers, h ?? {}); return r }
  r.setHeader = (k: string, v: string) => { r.headers[k] = v }
  r.end = (body?: string) => { if (body) r.json = JSON.parse(body) }
  return r
}
