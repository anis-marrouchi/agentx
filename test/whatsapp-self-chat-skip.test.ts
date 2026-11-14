import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// noqta/noqta#777: a page sends Anis's sign-in code to his own number, so it
// lands in the self-chat the agent reads as Anis. Tagged self-chat messages
// must start no run and leave their text in no log.

const handlers: Record<string, (arg: any) => any> = {}
const ME = "15550001111"
const LID = "214990000000001"

vi.mock("@whiskeysockets/baileys", () => {
  const makeWASocket = () => ({
    ev: { on: (name: string, fn: (arg: any) => any) => { handlers[name] = fn } },
    user: { id: `${ME}:3@s.whatsapp.net`, lid: `${LID}:3@lid` },
    end: () => {},
  })
  return {
    default: makeWASocket,
    makeWASocket,
    useMultiFileAuthState: async () => ({ state: { creds: { registered: true }, keys: {} }, saveCreds: () => {} }),
    fetchLatestBaileysVersion: async () => { throw new Error("offline") },
    DisconnectReason: {},
    makeCacheableSignalKeyStore: undefined,
    downloadMediaMessage: async () => null,
  }
})

import { WhatsAppAdapter, isSelfChatSkipped } from "../src/channels/whatsapp"

const TAG = "[no-agent]"
const CODE = "رمز الدخول إلى صفحة طلباتك: 482913 — صالح 10 دقائق."

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wa-777-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function adapter(prefixes: string[] | undefined) {
  const logs: string[] = []
  const runs: string[] = []
  const wa = new WhatsAppAdapter(
    { sessionDir: join(dir, "s"), defaultAgent: "main", allowFrom: ["+15550009999"], selfChatSkipPrefixes: prefixes },
    (...a: unknown[]) => { logs.push(a.map(String).join(" ")) },
  )
  wa.onMessage(async (m) => { runs.push(m.text) })
  await wa.start()
  const deliver = async (msg: any) => { await handlers["messages.upsert"]({ type: "notify", messages: [msg] }) }
  return { wa, logs, runs, deliver }
}

const selfMsg = (id: string, text: string, remoteJid = `${LID}@lid`) => ({ key: { id, fromMe: true, remoteJid }, message: { conversation: text }, messageTimestamp: 1 })
const otherMsg = (id: string, text: string) => ({ key: { id, fromMe: false, remoteJid: "15550009999@s.whatsapp.net" }, message: { conversation: text }, messageTimestamp: 1, pushName: "Other" })

describe("WhatsApp self-chat skip by prefix (noqta/noqta#777)", () => {
  it("drops a tagged self-chat message: no run, one log line with the id, text in no log", async () => {
    const { wa, logs, runs, deliver } = await adapter([TAG])
    await deliver(selfMsg("ID-TAGGED", `${TAG}\n${CODE}`))
    await deliver(selfMsg("ID-TAGGED-2", `${TAG}\n${CODE}`, `${ME}@s.whatsapp.net`))
    expect(runs).toEqual([])
    expect(logs.filter((l) => l.includes("self-chat skipped by prefix"))).toEqual([
      "self-chat skipped by prefix: id=ID-TAGGED",
      "self-chat skipped by prefix: id=ID-TAGGED-2",
    ])
    expect(logs.some((l) => l.includes("482913") || l.includes(TAG))).toBe(false)
    await wa.stop()
  })

  it("runs an untagged self-chat message as today", async () => {
    const { wa, runs, deliver } = await adapter([TAG])
    await deliver(selfMsg("ID-PLAIN", "what is on my desk?"))
    expect(runs).toEqual(["what is on my desk?"])
    await wa.stop()
  })

  it("runs a tagged message from another contact", async () => {
    const { wa, runs, deliver } = await adapter([TAG])
    await deliver(otherMsg("ID-OTHER", `${TAG} hello`))
    expect(runs).toEqual([`${TAG} hello`])
    await wa.stop()
  })

  it("changes nothing with an empty or unset list", async () => {
    for (const prefixes of [undefined, [], [" "]]) {
      const { wa, runs, deliver } = await adapter(prefixes)
      await deliver(selfMsg("ID-X", `${TAG}\n${CODE}`))
      expect(runs).toEqual([`${TAG}\n${CODE}`])
      await wa.stop()
    }
  })

  it("drops tagged self-chat lines from history, keeps the rest", async () => {
    const { wa, logs } = await adapter([TAG])
    const sock: any = (wa as any).sock
    sock.loadMessages = async () => [selfMsg("H1", `${TAG}\n${CODE}`), selfMsg("H2", "keep me"), otherMsg("H3", `${TAG} theirs`)]
    ;(wa as any).isConnected = () => true
    ;(wa as any).throttleMinMs = 0
    const seeded = await wa.seedHistory(`${LID}@lid`, { maxMessages: 10, maxChars: 10_000 })
    expect(seeded.map((m) => m.externalId)).toEqual(["H2", "H3"])
    expect(logs.some((l) => l.includes("482913"))).toBe(false)
    await wa.stop()
  })
})

describe("isSelfChatSkipped", () => {
  it("matches after leading spaces and direction marks", () => {
    expect(isSelfChatSkipped(`‏  ${TAG}\n${CODE}`, [TAG])).toBe(true)
    expect(isSelfChatSkipped(`⁧${TAG}`, [` ${TAG} `])).toBe(true)
  })
  it("does not match the tag in the middle, or with no list", () => {
    expect(isSelfChatSkipped(`hi ${TAG}`, [TAG])).toBe(false)
    expect(isSelfChatSkipped(`${TAG}`, undefined)).toBe(false)
    expect(isSelfChatSkipped("", [TAG])).toBe(false)
  })
})
