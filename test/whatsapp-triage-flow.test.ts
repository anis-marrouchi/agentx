import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { createHmac } from "crypto"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { IncomingMessage } from "http"
import { Socket } from "net"
import { whatsappTriageSchema, type WhatsappTriageConfig } from "../src/whatsapp-triage/config"
import { TriageService } from "../src/whatsapp-triage/service"
import { TriageStore } from "../src/whatsapp-triage/store"
import { listDrafts, type ReplyDraft } from "../src/whatsapp-triage/drafts"
import { handleWacliWebhook } from "../src/whatsapp-triage/http"
import { decide, listInbox } from "../src/approvals/inbox"
import type { WaMessage } from "../src/whatsapp-triage/message"

// WhatsApp inbound triage (#328): batching, dedup, approvals, the receiver.

const CHAT = "15550001111@s.whatsapp.net"

let root: string
let db: Database.Database
let cfg: WhatsappTriageConfig
let runs: Array<{ agentId: string; message: string }>
let answer: string
let sent: ReplyDraft[]
let notices: Array<{ title: string; message: string }>

const verdict = (v: object) => "done\n```whatsapp-triage\n" + JSON.stringify(v) + "\n```"

function service(): TriageService {
  return new TriageService({
    root,
    store: new TriageStore(db),
    config: () => cfg,
    execute: async (t) => { runs.push(t); return { content: answer } },
    notify: async (n) => { notices.push(n) },
    send: async (d) => { sent.push(d); return { ok: true } },
    now: () => Date.UTC(2026, 0, 1, 12),
    log: () => {},
  })
}

const msg = (id: string, over: Partial<WaMessage> = {}): WaMessage => ({
  id, chat: CHAT, sender: CHAT, chatName: "Test contact", at: "2026-01-01T12:00:00Z", text: `message ${id}`, ...over,
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wa-triage-"))
  db = new Database(":memory:")
  cfg = whatsappTriageSchema.parse({ enabled: true, batchSeconds: 60, rules: [{ id: "test", agent: "helper", chats: ["15550001111"] }] })
  runs = []
  answer = verdict({ triage: "fyi", summary: "nothing to do" })
  sent = []
  notices = []
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe("TriageService", () => {
  it("drops and does not store a message no rule covers", async () => {
    const s = service()
    expect(s.receive(msg("A", { chat: "15559999999@s.whatsapp.net", sender: "15559999999@s.whatsapp.net" }))).toEqual({ status: "ignored" })
    await s.drain()
    expect(db.prepare("SELECT COUNT(*) AS n FROM whatsapp_triage_messages").get()).toEqual({ n: 0 })
    expect(runs).toHaveLength(0)
  })

  it("does nothing while turned off", () => {
    cfg.enabled = false
    expect(service().receive(msg("A"))).toEqual({ status: "ignored" })
  })

  it("turns a burst from one chat into one task", async () => {
    const s = service()
    for (const id of ["A", "B", "C"]) expect(s.receive(msg(id)).status).toBe("queued")
    await s.drain()
    expect(runs).toHaveLength(1)
    expect(runs[0].agentId).toBe("helper")
    for (const id of ["A", "B", "C"]) expect(runs[0].message).toContain(`message ${id}`)
  })

  it("keeps different chats in different tasks", async () => {
    cfg.rules[0].chats.push("15552223333")
    const s = service()
    s.receive(msg("A"))
    s.receive(msg("B", { chat: "15552223333@s.whatsapp.net", sender: "15552223333@s.whatsapp.net" }))
    await s.drain()
    expect(runs).toHaveLength(2)
  })

  it("ignores a redelivered message", async () => {
    const s = service()
    expect(s.receive(msg("A")).status).toBe("queued")
    expect(s.receive(msg("A")).status).toBe("duplicate")
    await s.drain()
    expect(s.receive(msg("A")).status).toBe("duplicate")
    await s.drain()
    expect(runs).toHaveLength(1)
  })

  it("after a restart, triages what was queued and never repeats what was handed over", async () => {
    const before = service()
    before.receive(msg("A"))
    before.stop()
    const after = service()
    expect(after.resume()).toBe(1)
    await after.drain()
    expect(runs).toHaveLength(1)

    const third = service()
    expect(third.resume()).toBe(0)
    expect(third.receive(msg("A")).status).toBe("duplicate")
    await third.drain()
    expect(runs).toHaveLength(1)
  })

  it("notifies the owner for action items, except in quiet hours", async () => {
    answer = verdict({ triage: "action", summary: "Export button fails" })
    let s = service()
    s.receive(msg("A"))
    await s.drain()
    expect(notices).toHaveLength(1)
    expect(notices[0].message).toContain("Export button fails")

    cfg.timezone = "UTC"
    cfg.rules[0].quietHours = { start: "11:00", end: "13:00" }
    s = service()
    s.receive(msg("B"))
    await s.drain()
    expect(notices).toHaveLength(1)
  })

  it("tells the owner when the agent gives no verdict", async () => {
    answer = "I forgot the block"
    const s = service()
    s.receive(msg("A"))
    await s.drain()
    expect(notices[0].title).toContain("Couldn't triage")
    expect(new TriageStore(db).recent()[0].error).toContain("no triage block")
  })
})

describe("no send without approval", () => {
  it("saves a draft reply and sends nothing", async () => {
    answer = verdict({ triage: "action", summary: "Bug report", reply: "Thanks, we're looking into it." })
    const s = service()
    s.receive(msg("A"))
    await s.drain()
    expect(sent).toHaveLength(0)
    const drafts = listDrafts(root, "pending")
    expect(drafts).toHaveLength(1)
    expect(drafts[0].to).toBe(CHAT)
    expect(notices[0].message).toContain(`whatsapp:${drafts[0].id}`)
    const item = listInbox({ root }).items.find((i) => i.kind === "whatsapp")!
    expect(item.ask).toContain("Thanks, we're looking into it.")
  })

  it("sends once on yes, never on no", async () => {
    answer = verdict({ triage: "ack", summary: "Hello", reply: "Hi!" })
    const s = service()
    s.receive(msg("A"))
    s.receive(msg("B", { chat: "15552223333@s.whatsapp.net" }))
    await s.drain()
    const send = async (d: ReplyDraft) => { sent.push(d); return { ok: true as const } }
    const [first] = listDrafts(root, "pending")

    const no = await decide({ root, sendWhatsApp: send }, `whatsapp:${first.id}`, "no")
    expect(no.ok).toBe(true)
    expect(sent).toHaveLength(0)
    expect((await decide({ root, sendWhatsApp: send }, `whatsapp:${first.id}`, "yes")).ok).toBe(false)
    expect(sent).toHaveLength(0)

    cfg.rules[0].chats.push("15552223333")
    const s2 = service()
    s2.receive(msg("C", { chat: "15552223333@s.whatsapp.net" }))
    await s2.drain()
    const [second] = listDrafts(root, "pending")
    const both = await Promise.all([
      decide({ root, sendWhatsApp: send }, `whatsapp:${second.id}`, "yes"),
      decide({ root, sendWhatsApp: send }, `whatsapp:${second.id}`, "yes"),
    ])
    expect(both.filter((r) => r.ok)).toHaveLength(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toBe("Hi!")
  })

  it("auto-acknowledges only with both switches on, and only an ack", async () => {
    answer = verdict({ triage: "ack", summary: "Hello", reply: "Got it." })
    cfg.rules[0].autoAck = true
    let s = service()
    s.receive(msg("A"))
    await s.drain()
    expect(sent).toHaveLength(0)

    cfg.allowAutoAck = true
    answer = verdict({ triage: "action", summary: "Bug", reply: "Looking." })
    s = service()
    s.receive(msg("B"))
    await s.drain()
    expect(sent).toHaveLength(0)

    answer = verdict({ triage: "ack", summary: "Hello", reply: "Got it." })
    s = service()
    s.receive(msg("C"))
    await s.drain()
    expect(sent.map((d) => d.text)).toEqual(["Got it."])
  })
})

describe("POST /webhook/wacli", () => {
  function req(body: string, sig?: string): IncomingMessage {
    const r = new IncomingMessage(new Socket())
    ;(r as any).headers = sig ? { "x-wacli-signature": sig } : {}
    process.nextTick(() => { r.emit("data", Buffer.from(body)); r.emit("end") })
    return r
  }
  class Res { status?: number; body?: any; writeHead(s: number) { this.status = s } end(b: string) { this.body = JSON.parse(b) } }
  const payload = JSON.stringify({ Chat: CHAT, ID: "W1", SenderJID: CHAT, Timestamp: "2026-01-01T12:00:00Z", FromMe: false, Text: "hi" })
  const sign = (body: string, secret = "s3cret") => "sha256=" + createHmac("sha256", secret).update(body).digest("hex")

  async function post(body: string, sig?: string, env: NodeJS.ProcessEnv = { WACLI_WEBHOOK_SECRET: "s3cret" }) {
    const res = new Res()
    const s = service()
    await handleWacliWebhook(req(body, sig), res as any, { config: () => cfg, service: () => s, env, log: () => {} })
    return res
  }

  it("queues a signed message", async () => {
    const res = await post(payload, sign(payload))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, status: "queued", rule: "test" })
  })

  it("refuses unsigned and wrongly signed requests without storing them", async () => {
    expect((await post(payload)).status).toBe(401)
    expect((await post(payload, sign(payload, "wrong"))).status).toBe(401)
    expect(db.prepare("SELECT COUNT(*) AS n FROM whatsapp_triage_messages").get()).toEqual({ n: 0 })
  })

  it("refuses everything when the secret is not set, or triage is off", async () => {
    expect((await post(payload, sign(payload), {})).status).toBe(503)
    cfg.enabled = false
    expect((await post(payload, sign(payload))).status).toBe(404)
  })

  it("accepts and ignores a receipt", async () => {
    const receipt = JSON.stringify({ EventType: "receipt", Chat: CHAT })
    const res = await post(receipt, sign(receipt))
    expect(res.body.status).toBe("ignored")
  })
})
