import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MessageRouter } from "../src/channels/router"
import type { ChannelAdapter, OutgoingMessage } from "../src/channels/types"

// #191: relayed agent text (async mesh results, /send, cross-channel) goes
// through sendOutbound, which used to post a trailing ```agentx:ui block as raw
// text. It must render like the normal reply path — or be stripped when the
// agent has rich messages off.

const BLOCK = '```agentx:ui\n{"buttons":[{"label":"Open docs","url":"https://example.com"}]}\n```'

function stubAdapter(name: string, sent: OutgoingMessage[]): ChannelAdapter {
  return {
    name,
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    send: async (m: OutgoingMessage) => { sent.push(m); return "1" },
  } as unknown as ChannelAdapter
}

function harness(agents: Record<string, { richMessages?: boolean }> = {}) {
  const sent: OutgoingMessage[] = []
  const registry = {
    getAgent: (id: string) => agents[id],
    getSessionStore: () => ({ addAgentMessage: () => {} }),
  }
  const config = { channels: { telegram: { accounts: {} } } }
  const router = new MessageRouter(registry as any, config as any, undefined, () => {})
  router.addChannel(stubAdapter("telegram", sent))
  router.addChannel(stubAdapter("github", sent))
  return { router, sent }
}

describe("sendOutbound — agentx:ui directive (#191)", () => {
  const cwd = process.cwd()
  let dir: string
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agentx-191-")); process.chdir(dir) })
  afterAll(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }) })

  it("strips the block and renders its buttons", async () => {
    const { router, sent } = harness({ a: {} })
    await router.sendOutbound({ channel: "telegram", chatId: "42", accountId: "bot", agentId: "a", text: `Here you go.\n\n${BLOCK}` })
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toBe("Here you go.")
    expect(sent[0].buttons).toEqual([{ label: "Open docs", url: "https://example.com" }])
  })

  it("still strips the block when the agent has richMessages off", async () => {
    const { router, sent } = harness({ a: { richMessages: false } })
    await router.sendOutbound({ channel: "telegram", chatId: "42", accountId: "bot", agentId: "a", text: `Here you go.\n\n${BLOCK}` })
    expect(sent[0].text).toBe("Here you go.")
    expect(sent[0].buttons).toBeUndefined()
  })

  it("maps a poll onto the message", async () => {
    const { router, sent } = harness({ a: {} })
    const poll = '```agentx:ui\n{"poll":{"question":"Deploy?","options":["Yes","No"]}}\n```'
    await router.sendOutbound({ channel: "telegram", chatId: "42", accountId: "bot", agentId: "a", text: `Vote:\n${poll}` })
    expect(sent[0].text).toBe("Vote:")
    expect(sent[0].poll).toEqual({ name: "Deploy?", values: ["Yes", "No"], selectableCount: 1 })
  })

  it("leaves text alone when the caller passed explicit buttons", async () => {
    const { router, sent } = harness({ a: {} })
    const buttons = [{ label: "Mine", url: "https://mine.example" }]
    const text = `Docs example:\n${BLOCK}`
    await router.sendOutbound({ channel: "telegram", chatId: "42", accountId: "bot", agentId: "a", text, buttons })
    expect(sent[0].text).toBe(text)
    expect(sent[0].buttons).toBe(buttons)
  })

  it("does not touch channels without rich rendering", async () => {
    const { router, sent } = harness({ a: {} })
    const text = `Example:\n${BLOCK}`
    await router.sendOutbound({ channel: "github", chatId: "o/r:issue:1", agentId: "a", text })
    expect(sent[0].text).toBe(text)
  })
})
