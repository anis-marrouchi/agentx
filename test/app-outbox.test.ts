import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { OUTBOX_DIR, OUTBOX_MAX_AGE_MS, prepareOutbox } from "../src/utils/app-outbox"
import { APP_ATTACH_HINT } from "../src/utils/artifact-sentinel"

// The phone app outbox (#258): one folder inside the workspace, created on
// first use, emptied of week-old copies, and nothing else ever touched.

let dir: string, ws: string
const NOW = Date.now()
// ctime can't be set back, so "old" means pruning a week from now.
const LATER = NOW + OUTBOX_MAX_AGE_MS + 60_000
const monthOld = (path: string) => { const t = (NOW - 30 * 24 * 60 * 60 * 1000) / 1000; utimesSync(path, t, t) }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-outbox-"))
  ws = join(dir, "ws")
  mkdirSync(ws)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("the outbox", () => {
  it("is created on first use, and the hint names it", () => {
    expect(prepareOutbox(ws, { now: NOW })).toBe(0)
    expect(existsSync(join(ws, OUTBOX_DIR))).toBe(true)
    expect(APP_ATTACH_HINT).toContain(".agentx/outbox/")
  })

  it("is not created by a cleanup-only pass", () => {
    expect(prepareOutbox(ws, { now: NOW, create: false })).toBe(0)
    expect(existsSync(join(ws, OUTBOX_DIR))).toBe(false)
  })

  it("loses files older than 7 days; the rest of the workspace stays", () => {
    const box = join(ws, OUTBOX_DIR)
    mkdirSync(join(box, "sub"), { recursive: true })
    writeFileSync(join(box, "old.png"), "x")
    writeFileSync(join(box, "sub/old.pdf"), "x")
    writeFileSync(join(ws, "old-report.pdf"), "x")
    writeFileSync(join(ws, ".agentx/old-state.json"), "x")

    expect(prepareOutbox(ws, { now: LATER })).toBe(2)
    expect(existsSync(join(box, "old.png"))).toBe(false)
    expect(existsSync(join(box, "sub/old.pdf"))).toBe(false)
    expect(existsSync(join(box, "sub"))).toBe(true)
    expect(existsSync(join(ws, "old-report.pdf"))).toBe(true)
    expect(existsSync(join(ws, ".agentx/old-state.json"))).toBe(true)
  })

  it("keeps a file that just arrived, even with an old mtime (mv, cp -p, tar x)", () => {
    const box = join(ws, OUTBOX_DIR)
    mkdirSync(box, { recursive: true })
    writeFileSync(join(box, "new.png"), "x")
    writeFileSync(join(box, "moved.png"), "x"); monthOld(join(box, "moved.png"))

    expect(prepareOutbox(ws, { now: NOW })).toBe(0)
    expect(existsSync(join(box, "new.png"))).toBe(true)
    expect(existsSync(join(box, "moved.png"))).toBe(true)
  })

  it("removes an old link, never the file it points at", () => {
    const box = join(ws, OUTBOX_DIR)
    mkdirSync(box, { recursive: true })
    writeFileSync(join(ws, "keep.png"), "x")
    symlinkSync(join(ws, "keep.png"), join(box, "link.png"))

    expect(prepareOutbox(ws, { now: LATER })).toBe(1)
    expect(existsSync(join(ws, "keep.png"))).toBe(true)
  })

  it("touches nothing when the outbox or .agentx is a link out of the workspace", () => {
    const elsewhere = join(dir, "home")
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, "old.txt"), "x")

    mkdirSync(join(ws, ".agentx"))
    symlinkSync(elsewhere, join(ws, OUTBOX_DIR))
    expect(prepareOutbox(ws, { now: LATER })).toBe(0)
    expect(existsSync(join(elsewhere, "old.txt"))).toBe(true)

    rmSync(join(ws, ".agentx"), { recursive: true })
    symlinkSync(elsewhere, join(ws, ".agentx"))
    expect(prepareOutbox(ws, { now: LATER })).toBe(0)
    expect(existsSync(join(elsewhere, "old.txt"))).toBe(true)
    expect(existsSync(join(elsewhere, "outbox"))).toBe(false)
  })

  it("does nothing for a missing workspace", () => {
    expect(prepareOutbox(join(dir, "gone"), { now: NOW })).toBe(0)
    expect(existsSync(join(dir, "gone"))).toBe(false)
  })
})
