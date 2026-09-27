import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, statSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { openDb, closeDb } from "../src/storage/sqlite"
import { PushStore } from "../src/channels/push-store"
import { PushAdapter, PushRelayAdapter, buildPushPayload, DEFAULT_OPEN_URL, type PushSender } from "../src/channels/push"
import { readPushKeys, writePushKeys } from "../src/channels/push-keys"
import { patchPush } from "../src/notify/push-settings"
import { daemonConfigSchema } from "../src/daemon/config"

let dir: string
let store: PushStore
beforeEach(() => {
  closeDb()
  dir = mkdtempSync(join(tmpdir(), "agentx-push-"))
  store = new PushStore(openDb({ path: join(dir, "db.sqlite") })!)
})
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }) })

const MINIMAL = { node: { id: "n1", name: "Node" } }
const KEYS = { publicKey: "pub", privateKey: "priv", createdAt: "2026-01-01T00:00:00Z" }
const sub = (n: number, deviceId = "tok_a") => ({ endpoint: `https://push.example.com/${n}`, p256dh: "p256dh-key", auth: "auth-key", deviceId, deviceName: `Phone ${deviceId}` })

function adapter(sender: PushSender, over: Partial<ConstructorParameters<typeof PushAdapter>[0]> = {}) {
  return new PushAdapter({
    store, keys: () => KEYS, subject: "mailto:ops@example.com", ttlSeconds: 60, keepRecent: 3,
    deviceActive: () => true, sender, log: () => {}, ...over,
  })
}

describe("buildPushPayload", () => {
  it("takes the title from the first line and buttons as actions", () => {
    const p = buildPushPayload({
      channel: "push", chatId: "default", text: "Build failed\nThe nightly job stopped.",
      buttons: [{ label: "Open run", url: "https://ci.example.com/1" }, { label: "B", url: "https://b" }, { label: "C", url: "https://c" }],
    })
    expect(p.title).toBe("Build failed")
    expect(p.body).toBe("The nightly job stopped.")
    expect(p.url).toBe("https://ci.example.com/1")
    expect(p.actions.map((a) => a.action)).toEqual(["b0", "b1"])
  })

  it("opens the Alerts tab when there is no button, and caps the body", () => {
    const p = buildPushPayload({ channel: "push", chatId: "default", text: "x".repeat(5000) })
    expect(p.title).toBe("AgentX")
    expect(p.url).toBe(DEFAULT_OPEN_URL)
    expect(p.body.length).toBeLessThanOrEqual(1200)
  })
})

describe("PushAdapter", () => {
  it("sends to every subscription, encrypted with the VAPID details, and logs it", async () => {
    store.subscribe(sub(1)); store.subscribe(sub(2, "tok_b"))
    const calls: any[] = []
    const n = await adapter(async (s, payload, opts) => { calls.push({ s, payload: JSON.parse(payload), opts }) })
      .send({ channel: "push", chatId: "default", text: "Hello\nWorld" })
    expect(n).toBe("2")
    expect(calls).toHaveLength(2)
    expect(calls[0].opts).toEqual({ vapidDetails: { subject: "mailto:ops@example.com", publicKey: "pub", privateKey: "priv" }, TTL: 60 })
    expect(calls[0].s.keys).toEqual({ p256dh: "p256dh-key", auth: "auth-key" })
    expect(calls[0].payload.title).toBe("Hello")
    expect(store.recent(10)).toMatchObject([{ title: "Hello", body: "World", delivered: 2 }])
  })

  it("addresses one phone by its device id", async () => {
    store.subscribe(sub(1)); store.subscribe(sub(2, "tok_b"))
    const hit: string[] = []
    await adapter(async (s) => { hit.push(s.endpoint) }).send({ channel: "push", chatId: "tok_b", text: "hi" })
    expect(hit).toEqual(["https://push.example.com/2"])
  })

  it("drops subscriptions the push service reports gone (404/410), keeps others", async () => {
    store.subscribe(sub(1)); store.subscribe(sub(2)); store.subscribe(sub(3))
    const send: PushSender = async (s) => {
      if (s.endpoint.endsWith("/1")) throw Object.assign(new Error("gone"), { statusCode: 410 })
      if (s.endpoint.endsWith("/2")) throw Object.assign(new Error("slow"), { statusCode: 503 })
    }
    expect(await adapter(send).send({ channel: "push", chatId: "default", text: "x" })).toBe("1")
    expect(store.list().map((s) => s.endpoint)).toEqual(["https://push.example.com/2", "https://push.example.com/3"])
  })

  it("skips and removes subscriptions of a revoked phone", async () => {
    store.subscribe(sub(1, "tok_gone")); store.subscribe(sub(2))
    const hit: string[] = []
    await adapter(async (s) => { hit.push(s.endpoint) }, { deviceActive: (id) => id !== "tok_gone" })
      .send({ channel: "push", chatId: "default", text: "x" })
    expect(hit).toEqual(["https://push.example.com/2"])
    expect(store.list().map((s) => s.deviceId)).toEqual(["tok_a"])
  })

  it("fails loudly with no subscriber, no keys, or nothing delivered", async () => {
    await expect(adapter(async () => {}).send({ channel: "push", chatId: "default", text: "x" })).rejects.toThrow(/no phone/)
    store.subscribe(sub(1))
    await expect(adapter(async () => {}, { keys: () => null }).send({ channel: "push", chatId: "default", text: "x" })).rejects.toThrow(/push-keys/)
    await expect(adapter(async () => { throw Object.assign(new Error("x"), { statusCode: 500, body: "boom" }) })
      .send({ channel: "push", chatId: "default", text: "x" })).rejects.toThrow(/HTTP 500 boom/)
    expect(store.recent(10)).toEqual([])
  })

  it("keeps only the newest keepRecent entries", async () => {
    store.subscribe(sub(1))
    const a = adapter(async () => {})
    for (const t of ["a", "b", "c", "d"]) await a.send({ channel: "push", chatId: "default", text: t })
    expect(store.recent(10).map((r) => r.body)).toEqual(["d", "c", "b"])
  })
})

describe("PushStore", () => {
  it("replaces a re-subscribed endpoint and only removes a device's own", () => {
    store.subscribe(sub(1)); store.subscribe({ ...sub(1), p256dh: "new-key" })
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].p256dh).toBe("new-key")
    expect(store.unsubscribe(sub(1).endpoint, "tok_other")).toBe(false)
    expect(store.unsubscribe(sub(1).endpoint, "tok_a")).toBe(true)
  })
})

describe("PushRelayAdapter", () => {
  it("forwards to the host with buttons, marked relayed", async () => {
    const sent: any[] = []
    const relay = new PushRelayAdapter("host-node", async (peer, p) => { sent.push({ peer, p }); return "1" }, () => {})
    await relay.send({ channel: "push", chatId: "", text: "hi", buttons: [{ label: "Open", url: "https://x" }] })
    expect(sent).toEqual([{ peer: "host-node", p: { channel: "push", chatId: "default", text: "hi", buttons: [{ label: "Open", url: "https://x" }], relayed: true } }])
  })

  it("refuses a message another relay already forwarded", async () => {
    const relay = new PushRelayAdapter("b", async () => "1", () => {})
    await expect(relay.send({ channel: "push", chatId: "default", text: "x", relayed: true })).rejects.toThrow(/relays too/)
  })
})

describe("push keys and settings", () => {
  it("writes keys readable by the owner only", () => {
    const path = join(dir, "keys", "push-keys.json")
    expect(readPushKeys(path)).toBeNull()
    writePushKeys(path, { publicKey: "p", privateKey: "s" })
    expect(readPushKeys(path)).toMatchObject({ publicKey: "p", privateKey: "s" })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("needs a subject (or a relay) before enabling", () => {
    expect(() => patchPush({}, { enabled: true })).toThrow(/subject/)
    expect(() => patchPush({}, { subject: "ops@example.com" })).toThrow(/mailto/)
    expect(patchPush({}, { subject: "mailto:ops@example.com", enabled: true })).toEqual({ subject: "mailto:ops@example.com", enabled: true })
    expect(patchPush({}, { relayTo: "host", enabled: true })).toEqual({ relayTo: "host", enabled: true })
    expect(patchPush({ relayTo: "host", subject: "mailto:a@b.c" }, { relayTo: "" })).toEqual({ subject: "mailto:a@b.c" })
  })

  it("config defaults: push off, notify goes to push", () => {
    const cfg = daemonConfigSchema.parse(MINIMAL)
    expect(cfg.channels.push).toMatchObject({ enabled: false, keysFile: ".agentx/push-keys.json", ttlSeconds: 86400, keepRecent: 50 })
    expect(cfg.notifications.channel).toBe("push")
    expect(() => daemonConfigSchema.parse({ ...MINIMAL, channels: { push: { subject: "ops@example.com" } } })).toThrow()
  })
})
