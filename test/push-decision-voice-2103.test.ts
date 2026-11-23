import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { openDb, closeDb } from "../src/storage/sqlite"
import { PushStore } from "../src/channels/push-store"
import { PUSH_PREFS } from "../src/channels/push-prefs"
import {
  PushAdapter, PushRelayAdapter, buildPushPayload, channelPushKind, isPushHeldBySetting, remoteDeviceId,
  VOICE_ACTION, VOICE_LABEL, type PushSender,
} from "../src/channels/push"
import { deskPushTarget } from "../src/desk/route"
import { dictateLabel, parseOpenHash } from "../src/daemon/ui/pages/app-voice-reply-logic"
import { APP_SERVICE_WORKER } from "../src/daemon/ui/pages/app-sw"
import { renderAppPage } from "../src/daemon/ui/pages/app"
import { APP_DICTATE_SCRIPT } from "../src/daemon/ui/pages/app-dictate.client"
import { APP_DESK_SCRIPT } from "../src/daemon/ui/pages/app-desk.client"
import { APP_CHAT_SCRIPT } from "../src/daemon/ui/pages/app-chat.client"
import { APP_FLEET_SCRIPT } from "../src/daemon/ui/pages/app-fleet.client"
import { APP_ALERTS_SCRIPT } from "../src/daemon/ui/pages/app-alerts.client"

// #2103 PR A: a push when a decision waits, with a per-phone switch, and
// "Reply by voice" from the push or the chat.

let dir: string
let store: PushStore
beforeEach(() => {
  closeDb()
  dir = mkdtempSync(join(tmpdir(), "agentx-push-2103-"))
  store = new PushStore(openDb({ path: join(dir, "db.sqlite") })!)
})
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }) })

const KEYS = { publicKey: "pub", privateKey: "priv", createdAt: "2026-01-01T00:00:00Z" }
const sub = (n: number, deviceId = "tok_a") => ({ endpoint: `https://push.example.com/${n}`, p256dh: "k", auth: "a", deviceId, deviceName: `Phone ${deviceId}`, publicKey: "pub" })

function adapter(sender: PushSender) {
  return new PushAdapter({
    store, keys: () => KEYS, subject: "mailto:ops@example.com", ttlSeconds: 60, keepRecent: 5,
    deviceActive: () => true, sender, log: () => {},
  })
}

describe("the decision switch (#2103)", () => {
  it("is a per-phone switch, on by default, with field name decision", () => {
    expect(PUSH_PREFS.decision).toEqual({ field: "decision", default: true })
    expect(store.prefs.on("tok_new", "decision")).toBe(true)
    expect(store.prefs.all("tok_new").decision).toBe(true)
  })

  it("sends a decision only to phones that have it on", async () => {
    store.subscribe(sub(1, "tok_a")); store.subscribe(sub(2, "tok_b"))
    store.prefs.set("tok_b", "decision", false)
    const hit: string[] = []
    const n = await adapter(async (s) => { hit.push(s.endpoint) }).send({ channel: "push", chatId: "default", text: "Card\nPick one", pushKind: "decision" })
    expect(n).toBe("1")
    expect(hit).toEqual(["https://push.example.com/1"])
  })

  it("is held, not failed, when every subscribed phone has it off", async () => {
    store.subscribe(sub(1, "tok_a")); store.subscribe(sub(2, "tok_b"))
    store.prefs.set("tok_a", "decision", false); store.prefs.set("tok_b", "decision", false)
    let sent = 0
    const err = await adapter(async () => { sent++ }).send({ channel: "push", chatId: "default", text: "Card", pushKind: "decision" }).catch((e) => e)
    expect(sent).toBe(0)
    expect(isPushHeldBySetting(err)).toBe(true)
    // The subscriptions are kept: the owner turned a kind off, not the phone.
    expect(store.list()).toHaveLength(2)
  })

  it("still fails as before when no phone is subscribed at all", async () => {
    const err = await adapter(async () => {}).send({ channel: "push", chatId: "default", text: "Card", pushKind: "decision" }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(isPushHeldBySetting(err)).toBe(false)
  })

  it("leaves a message with no kind exactly as before, even with the switch off", async () => {
    store.subscribe(sub(1, "tok_a"))
    store.prefs.set("tok_a", "decision", false)
    store.prefs.set("tok_a", "finish", false)
    let sent = 0
    expect(await adapter(async () => { sent++ }).send({ channel: "push", chatId: "default", text: "Build failed" })).toBe("1")
    expect(sent).toBe(1)
  })

  it("reads the switch of a relayed phone by its id on the host", async () => {
    const scoped = remoteDeviceId("laptop", "tok_r")
    store.subscribe(sub(1, scoped))
    store.prefs.set(scoped, "decision", false)
    const err = await adapter(async () => {}).send({ channel: "push", chatId: "tok_r", origin: "laptop", text: "Card", pushKind: "decision" } as any).catch((e) => e)
    expect(isPushHeldBySetting(err)).toBe(true)
  })

  it("tells a held push apart when it comes back over the mesh as the host's error text", () => {
    expect(isPushHeldBySetting(new Error('push: laptop /channel/send -> 500 {"error":"push: held by phone setting: every subscribed phone has \\"decision\\" notifications off"}'))).toBe(true)
    expect(isPushHeldBySetting(new Error("push: no phone has turned on notifications"))).toBe(false)
  })
})

describe("the relay carries the kind and the voice path (#2103)", () => {
  it("forwards pushKind and voiceReply to the host", async () => {
    const sent: any[] = []
    const relay = new PushRelayAdapter("host", async (_p, payload) => { sent.push(payload); return "1" }, () => {}, "laptop")
    await relay.send({ channel: "push", chatId: "default", text: "Card", pushKind: "decision", open: "/app#desk=request%3Ar1", voiceReply: "/app#desk=request%3Ar1&voice=1" })
    expect(sent[0]).toMatchObject({ pushKind: "decision", open: "/app#desk=request%3Ar1", voiceReply: "/app#desk=request%3Ar1&voice=1", relayed: true, origin: "laptop" })
  })

  it("leaves both out when unset, so an older host sees the same body", async () => {
    const sent: any[] = []
    await new PushRelayAdapter("host", async (_p, payload) => { sent.push(payload) }, () => {}).send({ channel: "push", chatId: "default", text: "x" })
    expect(sent[0]).not.toHaveProperty("pushKind")
    expect(sent[0]).not.toHaveProperty("voiceReply")
  })

  it("the host accepts only known kinds from a body", () => {
    expect(channelPushKind("decision")).toBe("decision")
    expect(channelPushKind("finish")).toBe("finish")
    expect(channelPushKind("anything")).toBeUndefined()
    expect(channelPushKind(undefined)).toBeUndefined()
  })
})

describe("Reply by voice on the push (#2103)", () => {
  it("adds the voice button after the links, so a plain tap opens what it did before", () => {
    const p = buildPushPayload({ channel: "push", chatId: "tok_a", text: "Rassam\nDone.", buttons: [{ label: "Open", url: "/app#chat=c12345678" }], voiceReply: "/app#chat=c12345678&voice=1" })
    expect(p.url).toBe("/app#chat=c12345678")
    expect(p.actions).toEqual([
      { action: "b0", title: "Open", url: "/app#chat=c12345678" },
      { action: VOICE_ACTION, title: VOICE_LABEL, url: "/app#chat=c12345678&voice=1" },
    ])
  })

  it("a tap with no link opens msg.open, not the voice path", () => {
    const p = buildPushPayload({ channel: "push", chatId: "default", text: "Card", open: "/app#desk=request%3Ar1", voiceReply: "/app#desk=request%3Ar1&voice=1" })
    expect(p.url).toBe("/app#desk=request%3Ar1")
    expect(p.actions.map((a) => a.action)).toEqual([VOICE_ACTION])
  })

  it("keeps Chrome's two-button limit, voice last", () => {
    const p = buildPushPayload({ channel: "push", chatId: "default", text: "x", buttons: [{ label: "A", url: "/a" }, { label: "B", url: "/b" }], voiceReply: "/app#chat=c12345678&voice=1" })
    expect(p.actions.map((a) => a.title)).toEqual(["A", VOICE_LABEL])
  })

  it("never on a call, and never for a link off this node", () => {
    expect(buildPushPayload({ channel: "push", chatId: "default", text: "x", voiceReply: "https://evil.example.com" }).actions).toEqual([])
    expect(buildPushPayload({ channel: "push", chatId: "default", text: "x", voiceReply: "//evil.example.com" }).actions).toEqual([])
    const call = buildPushPayload({ channel: "push", chatId: "default", text: "x", voiceReply: "/app#chat=c12345678&voice=1", ring: { callId: "call1234", state: "ringing", urgent: false } } as any)
    expect(call.actions.find((a) => a.action === VOICE_ACTION)).toBeUndefined()
  })

  it("the service worker opens a button's own path (voice included), and posts it to an open app instead of reloading", () => {
    // urls[e.action] is how every button, the voice one too, is opened.
    expect(APP_SERVICE_WORKER).toContain("data.urls[e.action]")
    expect(APP_SERVICE_WORKER).toContain("app.postMessage({ type: 'agentx-open', url: target })")
    // The open app takes it as a hash change, which does not reload the page.
    expect(APP_ALERTS_SCRIPT).toContain("if (d.type === 'agentx-open' && d.url) location.href = d.url;")
  })
})

describe("a Desk push lands on its card (#2103)", () => {
  it("is a decision, opens the card, and offers voice where a written answer can go", () => {
    expect(deskPushTarget({ key: "request:r1", can: { answer: true, later: true, reply: true } })).toEqual({
      pushKind: "decision", open: "/app#desk=request%3Ar1", voiceReply: "/app#desk=request%3Ar1&voice=1",
    })
  })

  it("a yes/no card keeps its own buttons: no voice", () => {
    const t = deskPushTarget({ key: "card:ab12", can: { answer: true, later: true, reply: false } })
    expect(t).toEqual({ pushKind: "decision", open: "/app#desk=card%3Aab12" })
  })
})

describe("the app reads the link (#2103)", () => {
  it("reads a Desk card and a chat, with and without voice", () => {
    expect(parseOpenHash("#desk=request%3Ar1")).toEqual({ tab: "desk", id: "request:r1", voice: false })
    expect(parseOpenHash("#desk=request%3Ar1&voice=1")).toEqual({ tab: "desk", id: "request:r1", voice: true })
    expect(parseOpenHash("#desk=memory%3Arassam%2Fm1&voice=1")).toEqual({ tab: "desk", id: "memory:rassam/m1", voice: true })
    expect(parseOpenHash("#chat=c12345678")).toEqual({ tab: "chat", id: "c12345678", voice: false })
    expect(parseOpenHash("#chat=c12345678&voice=1")).toEqual({ tab: "chat", id: "c12345678", voice: true })
  })

  it("refuses anything else", () => {
    for (const h of ["", "#desk", "#alerts", "#chat=bad", "#chat=c12345678&voice=2", "#desk=%E0%A4%A", "#desk=nokey", "#desk=request%3A<script>"]) {
      expect(parseOpenHash(h)).toBeNull()
    }
  })

  it("the Desk reads it on a cold open and on a hash change (app already open)", () => {
    expect(APP_DESK_SCRIPT).toContain("if (parseOpenHash(location.hash)) fromHash();")
    expect(APP_DESK_SCRIPT).toContain("window.addEventListener('hashchange', fromHash);")
    expect(APP_DESK_SCRIPT).toContain("reply(c, true)")
  })

  it("the Chat reads it both ways too, and only marks the mic ready", () => {
    expect(APP_CHAT_SCRIPT).toContain("var t = parseOpenHash(location.hash);")
    expect(APP_CHAT_SCRIPT).toContain("window.addEventListener('hashchange', fromHash);")
    expect(APP_CHAT_SCRIPT).toContain("m.ready()")
  })

  it("the mic opens only on a tap: ready() never records", () => {
    const ready = APP_DICTATE_SCRIPT.slice(APP_DICTATE_SCRIPT.indexOf("ready: function"))
    expect(ready.slice(0, ready.indexOf("},"))).not.toContain("record(")
    // Recording starts inside the click handler only.
    expect(APP_DICTATE_SCRIPT.match(/IO\.record\(\)/g)).toHaveLength(1)
    expect(APP_DICTATE_SCRIPT).toContain("btn.addEventListener('click'")
  })

  it("the answer sheet shows the mic only where asked, and keeps typed text", () => {
    expect(APP_FLEET_SCRIPT).toContain("var mic = opts.input && opts.mic ? dictation() : null;")
    expect(APP_FLEET_SCRIPT).toContain("input.value.trim() ? input.value.trim() + ' ' + t : t")
  })

  it("the Alerts tab has the decision switch", () => {
    expect(APP_ALERTS_SCRIPT).toContain("field: 'decision'")
    expect(APP_ALERTS_SCRIPT).toContain("When a decision waits for you")
  })

  it("names each dictation state", () => {
    expect(dictateLabel("idle")).toBe("Speak")
    expect(dictateLabel("ready")).toBe("Tap to speak your answer")
    expect(dictateLabel("listening")).toContain("tap to stop")
  })
})

describe("the inlined scripts stay valid JavaScript", () => {
  it("the page declares parseOpenHash once (twice would be a SyntaxError across scripts), and every script parses", () => {
    const html = renderAppPage()
    expect(html.match(/const parseOpenHash=/g)).toHaveLength(1)
    expect(html.indexOf("const parseOpenHash=")).toBeLessThan(html.indexOf("var t = parseOpenHash(location.hash);"))
    expect(html).toContain("window.AXDictate")
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Function(m[1])).not.toThrow()
  })

  it("parses", () => {
    for (const s of [APP_DICTATE_SCRIPT, APP_DESK_SCRIPT, APP_CHAT_SCRIPT, APP_FLEET_SCRIPT, APP_ALERTS_SCRIPT]) {
      expect(() => new Function(s)).not.toThrow()
    }
  })
})
