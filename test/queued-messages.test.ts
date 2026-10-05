import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { attachSqliteSubscribers } from "../src/storage/subscribers"
import { getEventBus } from "../src/events/bus"
import { clearQueuedMessages, listQueuedMessages } from "../src/storage/queued-messages"

// #443: the daemon mirrors the line behind each busy agent in the database,
// with who sent each message, so the member page can count what is ahead
// of a teammate's. A row lives while the message waits, and the mirror is
// emptied when the daemon boots.

let dir: string
let db: Database.Database
let detach: () => void

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "queued-messages-"))
  db = openDb({ path: join(dir, "db.sqlite"), quiet: true } as any)!
  detach = attachSqliteSubscribers(db)
})
afterEach(() => {
  detach()
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const at = (ms: number) => new Date(ms).toISOString()

describe("the line on disk", () => {
  it("keeps each queued message with its person until the line is handed over", () => {
    const bus = getEventBus()
    const t0 = Date.now() - 10_000
    bus.emit("task:queued", { agentId: "coder", channel: "telegram", chatId: "c1", at: at(t0), person: "sara", sender: { name: "Sara" }, messagePreview: "  first\nline  ", queuedAt: t0 })
    bus.emit("task:queued", { agentId: "coder", channel: "telegram", chatId: "c1", at: at(t0 + 1), sender: { id: "77" }, queuedAt: t0 + 1 })
    bus.emit("task:queued", { agentId: "coder", channel: "telegram", chatId: "c2", at: at(t0 + 2), person: "omar", queuedAt: t0 + 2 })
    expect(listQueuedMessages(db).map((r) => [r.chatId, r.person, r.sender, r.messagePreview])).toEqual([
      ["c1", "sara", "Sara", "first line"], ["c1", null, "77", null], ["c2", "omar", null, null],
    ])
    // The flush of c1 frees that chat's line; a message queued after it stays.
    const flushedAt = t0 + 5
    bus.emit("task:queued", { agentId: "coder", channel: "telegram", chatId: "c1", at: at(flushedAt + 1), person: "sara", queuedAt: flushedAt + 1 })
    bus.emit("task:queue-flushed", { agentId: "coder", channel: "telegram", chatId: "c1", flushedAt, count: 2, at: at(flushedAt) })
    expect(listQueuedMessages(db).map((r) => [r.chatId, r.person])).toEqual([["c2", "omar"], ["c1", "sara"]])
    expect(clearQueuedMessages(db)).toBe(2)
    expect(listQueuedMessages(db)).toEqual([])
  })

  it("takes the time from the event when the queue time is missing, and clips the preview", () => {
    const t0 = Date.UTC(2026, 9, 5, 8, 0)
    getEventBus().emit("task:queued", { agentId: "ops", channel: "whatsapp", chatId: "w1", at: at(t0), messagePreview: "x".repeat(300) })
    const [row] = listQueuedMessages(db)
    expect(row.queuedAt).toBe(t0)
    expect(row.messagePreview).toHaveLength(200)
  })
})
