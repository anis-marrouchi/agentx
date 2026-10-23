import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MessageRouter } from "../src/channels/router"
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../src/channels/types"

// WhatsApp clients show an edited message as deleted, so a streamed reply
// (first block sent, later blocks + final text as edits) looked gone. The
// router must send each WhatsApp reply once, with no edits — even though the
// WhatsApp adapter implements editMessage.

function editingAdapter(name: string, sent: OutgoingMessage[], edits: string[]): ChannelAdapter {
  let n = 0
  return {
    name,
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    send: async (m: OutgoingMessage) => { sent.push(m); return String(++n) },
    editMessage: async (_chatId: string, _id: string, text: string) => { edits.push(text); return true },
  } as unknown as ChannelAdapter
}

// Streams the reply as several paragraph-sized deltas, then returns it.
const BLOCKS = [
  "First paragraph of a long reply, long enough to be emitted as its own block.\n\n",
  "Second paragraph of the same reply, again long enough to form a block.\n\n",
  "Third and last paragraph closes the reply.",
]

function harness(channel: string) {
  const sent: OutgoingMessage[] = []
  const edits: string[] = []
  const registry = {
    getAgent: () => ({ name: "Helper", mentions: [] }),
    getSessionStore: () => ({ addAgentMessage: () => {} }),
    execute: async (_req: unknown, onDelta?: (d: string, full: string) => void) => {
      let full = ""
      for (const b of BLOCKS) {
        full += b
        onDelta?.(b, full)
        await new Promise((r) => setTimeout(r, 5))
      }
      return { content: full }
    },
  }
  const router = new MessageRouter(registry as any, { channels: { telegram: { accounts: {} } } } as any, undefined, () => {})
  const adapter = editingAdapter(channel, sent, edits)
  router.addChannel(adapter)
  const msg: IncomingMessage = {
    id: "in-1",
    channel,
    chatId: "c1",
    sender: { id: "u1", name: "User" },
    text: "hello",
    timestamp: new Date().toISOString(),
  } as unknown as IncomingMessage
  const run = () => (router as any).processResolvedMessage(adapter, msg, "helper", "c1") as Promise<void>
  return { run, sent, edits }
}

describe("router reply delivery — WhatsApp is not streamed", () => {
  const cwd = process.cwd()
  let dir: string
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agentx-wa-nostream-")); process.chdir(dir) })
  afterAll(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }) })

  it("sends a WhatsApp reply once and never edits it", async () => {
    const { run, sent, edits } = harness("whatsapp")
    await run()
    // WhatsApp's human pacing delays a streamed block by up to 2.5 s; wait
    // that out so a late preview send or edit would be counted.
    await new Promise((r) => setTimeout(r, 2700))
    expect(edits).toEqual([])
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain("First paragraph")
    expect(sent[0].text).toContain("Third and last paragraph")
  })

  it("still streams on other channels with editMessage", async () => {
    const { run, sent, edits } = harness("discord")
    await run()
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect(edits.length).toBeGreaterThanOrEqual(1)
  })
})
