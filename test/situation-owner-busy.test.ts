import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as realFs from "fs"
import { chmodSync, mkdtempSync, readdirSync, readFileSync as readText, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, relative } from "path"

// Every file read in this test is recorded, so a Linux node can be shown to
// read no macOS file at all (#1892 phase 3, proof of done).
const reads: string[] = []
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  const readFileSync = ((p: any, ...rest: any[]) => { reads.push(String(p)); return (actual.readFileSync as any)(p, ...rest) }) as typeof actual.readFileSync
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
})

import type { FocusState } from "../src/notify/focus"
import { readCall, readHold } from "../src/notify/hold"
import { notify } from "../src/notify"
import { NotificationQueue } from "../src/notify/queue"
import { ownerBusySources, ownerFocus, ownerHold } from "../src/situations/sources/owner-busy"
import { SignalSources } from "../src/situations/sources/registry"
import { isUnknown } from "../src/situations/sources/types"

// #1892 phase 3: Focus, the call hold and the widget hold are moved behind
// adapters (`macos-focus`, `call-hold`, `widget-hold`). The hold must not
// change: below, the code as it was before the move is kept verbatim
// (`before*`) and compared with the adapters over every state of the three
// files.

// ---- The hold as it was before phase 3 (notify/focus.ts, notify/hold.ts at 0.233.0), verbatim ----
function beforeReadFocus(path: string, holdPath: string): FocusState {
  const held = beforeReadWidgetHold(holdPath)
  if (held.active) return held
  return beforeReadSystemFocus(path)
}
function beforeReadWidgetHold(path: string): FocusState {
  try {
    const parsed = JSON.parse(realFs.readFileSync(path, "utf-8"))
    if (parsed?.active === true) {
      return { active: true, mode: "widget", reason: "holding — switched on from the widget" }
    }
  } catch { /* no file */ }
  return { active: false, mode: null, reason: "widget hold is off" }
}
function beforeReadSystemFocus(path: string): FocusState {
  let raw: string
  try {
    raw = realFs.readFileSync(path, "utf-8")
  } catch (e: any) {
    if (e?.code === "EPERM" || e?.code === "EACCES") {
      return { active: false, mode: null, reason: "Focus database not readable — grant Full Disk Access to the app running agentx" }
    }
    return { active: false, mode: null, reason: "no Focus database on this machine" }
  }
  let parsed: any
  try { parsed = JSON.parse(raw) } catch { return { active: false, mode: null, reason: "Focus database was not readable JSON" } }
  const record = Array.isArray(parsed?.data) ? parsed.data[0] : null
  const assertions = record?.storeAssertionRecords
  if (!Array.isArray(assertions) || assertions.length === 0) return { active: false, mode: null, reason: "no active Focus assertion" }
  const first = assertions[0]
  const mode = first?.assertionDetails?.assertionDetailsModeIdentifier ?? first?.assertionDetails?.assertionDetailsModeID ?? null
  return { active: true, mode: typeof mode === "string" ? mode : null, reason: `Focus assertion present${mode ? ` (${mode})` : ""}` }
}
function beforeReadCall(path: string, now: number): FocusState {
  try {
    const hold = JSON.parse(realFs.readFileSync(path, "utf-8"))
    if (hold?.active === true && !(hold.until && Date.parse(hold.until) <= now)) {
      return { active: true, mode: "call", reason: `in a call${hold.reason ? `: ${hold.reason}` : ""}` }
    }
  } catch { /* none */ }
  return { active: false, mode: null, reason: "not in a call" }
}
function beforeReadHold(focus: () => FocusState, call: () => FocusState): FocusState {
  const f = focus()
  return f.active ? f : call()
}
// ---- end of the code before ----

const NOW = Date.parse("2026-11-19T10:00:00Z")

const FOCUS_FILES: Record<string, string | null | "unreadable"> = {
  missing: null,
  unreadable: "unreadable",
  garbage: "{not json",
  off: JSON.stringify({ data: [{ storeInvalidationRecords: [] }] }),
  emptyAssertions: JSON.stringify({ data: [{ storeAssertionRecords: [] }] }),
  onNamed: JSON.stringify({ data: [{ storeAssertionRecords: [{ assertionDetails: { assertionDetailsModeIdentifier: "com.apple.sleep.sleep-mode" } }] }] }),
  onOldKey: JSON.stringify({ data: [{ storeAssertionRecords: [{ assertionDetails: { assertionDetailsModeID: "com.apple.focus.work" } }] }] }),
  onUnnamed: JSON.stringify({ data: [{ storeAssertionRecords: [{}] }] }),
}
const WIDGET_FILES: Record<string, string | null> = {
  missing: null, on: JSON.stringify({ active: true }), off: JSON.stringify({ active: false }), garbage: "{",
}
const CALL_FILES: Record<string, string | null> = {
  missing: null,
  on: JSON.stringify({ active: true, source: "daemon", reason: "the widget is busy", until: new Date(NOW + 60_000).toISOString() }),
  noReason: JSON.stringify({ active: true }),
  expired: JSON.stringify({ active: true, reason: "old", until: new Date(NOW - 1).toISOString() }),
  off: JSON.stringify({ active: false }),
  garbage: "{",
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-owner-busy-")); reads.length = 0 })
afterEach(() => {
  try { chmodSync(join(dir, "focus.json"), 0o600) } catch { /* none */ }
  rmSync(dir, { recursive: true, force: true })
})

function put(name: string, content: string | null | "unreadable"): string {
  const p = join(dir, name)
  rmSync(p, { force: true })
  if (content === null) return p
  if (content === "unreadable") { writeFileSync(p, "{}"); chmodSync(p, 0o000); return p }
  writeFileSync(p, content)
  return p
}

const runsAsRoot = typeof process.getuid === "function" && process.getuid() === 0

describe("hold before and after the move behind adapters: same answer in every state (macOS)", () => {
  for (const [fName, fContent] of Object.entries(FOCUS_FILES)) {
    if (fContent === "unreadable" && runsAsRoot) continue
    for (const [wName, wContent] of Object.entries(WIDGET_FILES)) {
      for (const [cName, cContent] of Object.entries(CALL_FILES)) {
        it(`focus ${fName}, widget ${wName}, call ${cName}`, () => {
          const assertions = put("Assertions.json", fContent)
          const widget = put("focus.json", wContent)
          const call = put("call.json", cContent)
          const paths = { assertions, widget, call, platform: "darwin" as const, now: () => NOW }
          expect(ownerFocus(paths)).toEqual(beforeReadFocus(assertions, widget))
          expect(ownerHold(paths)).toEqual(beforeReadHold(() => beforeReadFocus(assertions, widget), () => beforeReadCall(call, NOW)))
          // readHold keeps its signature and its injected readers.
          expect(readHold(() => ownerFocus(paths), () => readCall(call, NOW))).toEqual(ownerHold(paths))
        })
      }
    }
  }
})

describe("a Linux node reads no macOS file at all (phase 3 proof of done)", () => {
  const realPlatform = process.platform
  const asLinux = () => Object.defineProperty(process, "platform", { value: "linux", configurable: true })
  afterEach(() => Object.defineProperty(process, "platform", { value: realPlatform, configurable: true }))

  it("the hold, Focus and notify read only AgentX's own files", async () => {
    asLinux()
    reads.length = 0
    readHold()
    ownerFocus()
    ownerHold()
    const send = vi.fn(async () => {})
    await notify({ message: "Deploy done" }, send, { queue: new NotificationQueue(join(dir, "q.json")), alert: false })
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.filter((p) => /Library|DoNotDisturb|Assertions\.json/.test(p))).toEqual([])
  })

  it("its answer is the one the old code gave on a machine with no Focus database", () => {
    asLinux()
    for (const [wName, wContent] of Object.entries(WIDGET_FILES)) {
      for (const cContent of Object.values(CALL_FILES)) {
        const widget = put("focus.json", wContent)
        const call = put("call.json", cContent)
        const noMac = join(dir, "no-such-dir", "Assertions.json")
        const paths = { widget, call, now: () => NOW }
        expect(ownerFocus(paths), `widget ${wName}`).toEqual(beforeReadFocus(noMac, widget))
        expect(ownerHold(paths)).toEqual(beforeReadHold(() => beforeReadFocus(noMac, widget), () => beforeReadCall(call, NOW)))
      }
    }
  })

  it("the macos-focus adapter is not loaded; widget-hold and call-hold are", () => {
    const reg = new SignalSources({ platform: "linux" })
    for (const s of ownerBusySources()) reg.register(s)
    expect(reg.loaded().map((s) => s.id).sort()).toEqual(["call-hold", "widget-hold"])
    expect(reg.skipped()).toEqual([{ id: "macos-focus", reason: "needs darwin, this node is linux" }])
    expect(isUnknown(reg.read("macos-focus", {})[0])).toBe(true)
  })
})

describe("the busy adapters as signal sources", () => {
  it("each answers one `busy` signal about the owner, with the reader's reason", () => {
    const assertions = put("Assertions.json", FOCUS_FILES.onNamed as string)
    const widget = put("focus.json", WIDGET_FILES.off)
    const call = put("call.json", CALL_FILES.on)
    const reg = new SignalSources({ platform: "darwin", now: () => NOW })
    for (const s of ownerBusySources({ assertions, widget, call, now: () => NOW })) reg.register(s)
    expect(reg.read("macos-focus", {})[0]).toMatchObject({ source: "macos-focus", kind: "busy", subject: "owner", value: true, reason: "Focus assertion present (com.apple.sleep.sleep-mode)" })
    expect(reg.read("widget-hold", {})[0]).toMatchObject({ kind: "busy", value: false, reason: "widget hold is off" })
    expect(reg.read("call-hold", {})[0]).toMatchObject({ kind: "busy", value: true, reason: "in a call: the widget is busy" })
  })

  it("a Focus file the process may not read is unknown, not 'not busy'", () => {
    if (runsAsRoot) return
    const assertions = put("Assertions.json", "unreadable")
    const reg = new SignalSources({ platform: "darwin", now: () => NOW })
    for (const s of ownerBusySources({ assertions })) reg.register(s)
    const [s] = reg.read("macos-focus", {})
    expect(isUnknown(s)).toBe(true)
    expect(s.reason).toMatch(/Full Disk Access/)
  })
})

describe("no code outside the adapters reads the macOS Focus file", () => {
  it("readFocus / readSystemFocus are imported only by the macos-focus adapter, the macOS native adapter and the notify barrel", () => {
    const root = join(__dirname, "..", "src")
    const allowed = new Set(["native/macos/focus-source.ts", "native/macos/index.ts", "notify/index.ts", "notify/focus.ts"])
    const offenders: string[] = []
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!/\.tsx?$/.test(name)) continue
        const rel = relative(root, p)
        if (allowed.has(rel)) continue
        const src = readText(p, "utf-8")
        if (/import\s*{[^}]*\b(readFocus|readSystemFocus)\b[^}]*}/.test(src) || /\b(readFocus|readSystemFocus)\(/.test(src)) offenders.push(rel)
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
