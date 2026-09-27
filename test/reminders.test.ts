import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseTrailer, splitContext } from "../src/reminders/trailer"
import { ReminderPoller, type DispatchResult, type PollerDeps } from "../src/reminders/poller"
import { readClaims } from "../src/reminders/store"
import type { Reminder, ReminderSource } from "../src/reminders/source"
import { daemonConfigSchema } from "../src/daemon/config"
import { startRemindersPoller, type RemindersDaemonDeps } from "../src/reminders/daemon"

// Due Apple Reminders go back to the agent that created them (#186). What must hold:
//   - exactly one task per due reminder, ticked off once the task is accepted;
//   - a claimed reminder is never dispatched again, even after a restart;
//   - a refused dispatch leaves the reminder open and is retried with backoff;
//   - no trailer / unknown agent → untouched, logged once;
//   - overdue past the lookback window → reported to the agent, not run.

const NOW = Date.parse("2026-09-27T10:00:00Z")

function fakeSource(items: Reminder[]): ReminderSource & { completed: string[] } {
  const completed: string[] = []
  return {
    completed,
    async listOpen() { return items.filter((r) => !completed.includes(r.id)) },
    async complete(id) { completed.push(id) },
  }
}

function reminder(over: Partial<Reminder> = {}): Reminder {
  return {
    id: "AAAA-1",
    title: "Retry the deploy",
    notes: "Staging failed on Friday.\n\nagentx: agent=coder-agent context=telegram:42",
    dueDate: "2026-09-27T09:00:00Z",
    isCompleted: false,
    ...over,
  }
}

describe("parseTrailer", () => {
  it("reads agent, context and the detail above the trailer", () => {
    expect(parseTrailer("line one\n\nagentx: agent=coder-agent context=gitlab:grp/proj#7\n")).toEqual({
      agent: "coder-agent", context: "gitlab:grp/proj#7", detail: "line one",
    })
  })
  it("returns null without a trailer or without an agent", () => {
    expect(parseTrailer("just notes")).toBeNull()
    expect(parseTrailer(undefined)).toBeNull()
    expect(parseTrailer("agentx: context=telegram:1")).toBeNull()
    expect(parseTrailer("agentx: agent=a\nmore text after")).toBeNull()
  })
  it("splits a context on the first colon", () => {
    expect(splitContext("github:owner/repo:issue:9")).toEqual({ channel: "github", chatId: "owner/repo:issue:9" })
    expect(splitContext("nocolon")).toBeNull()
    expect(splitContext(undefined)).toBeNull()
  })
})

describe("ReminderPoller", () => {
  let dir: string
  let claimsPath: string
  let logs: string[]
  let dispatched: Array<{ agentId: string; message: string }>
  let now: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-reminders-"))
    claimsPath = join(dir, "claims.json")
    logs = []
    dispatched = []
    now = NOW
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function poller(source: ReminderSource, over: Partial<PollerDeps> & { result?: () => DispatchResult } = {}) {
    return new ReminderPoller({
      settings: { lists: ["AgentX"], pollSeconds: 60, lookbackHours: 24 },
      source,
      claimsPath,
      hasAgent: (id) => id === "coder-agent",
      dispatch: async (input) => {
        dispatched.push({ agentId: input.agentId, message: input.message })
        return over.result ? over.result() : { accepted: true }
      },
      log: (m) => logs.push(m),
      now: () => now,
      ...over,
    })
  }

  it("dispatches a due reminder once, with title and notes, and ticks it off", async () => {
    const source = fakeSource([reminder()])
    const p = poller(source)
    await p.poll()
    await p.poll()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].agentId).toBe("coder-agent")
    expect(dispatched[0].message).toContain("[Reminder due 2026-09-27 09:00 UTC · id AAAA-1]")
    expect(dispatched[0].message).toContain("Retry the deploy")
    expect(dispatched[0].message).toContain("Staging failed on Friday.")
    expect(dispatched[0].message).toContain("Context: telegram:42")
    expect(dispatched[0].message).not.toContain("agentx: agent=")
    expect(source.completed).toEqual(["AAAA-1"])
    expect(readClaims(claimsPath)["AAAA-1"].status).toBe("done")
  })

  it("leaves reminders that aren't due yet alone", async () => {
    const source = fakeSource([reminder({ dueDate: "2026-09-27T11:00:00Z" }), reminder({ id: "B", dueDate: undefined })])
    await poller(source).poll()
    expect(dispatched).toHaveLength(0)
    expect(source.completed).toEqual([])
  })

  it("never dispatches twice when a restart lands between dispatch and tick-off", async () => {
    const items = [reminder()]
    // First daemon: dispatch accepted, but ticking off fails (e.g. killed mid-way).
    const broken: ReminderSource = { listOpen: async () => items, complete: async () => { throw new Error("killed") } }
    await poller(broken).poll()
    expect(dispatched).toHaveLength(1)
    expect(readClaims(claimsPath)["AAAA-1"].status).toBe("claimed")

    // Second daemon (fresh poller, same claims file): only ticks it off.
    const source = fakeSource(items)
    await poller(source).poll()
    expect(dispatched).toHaveLength(1)
    expect(source.completed).toEqual(["AAAA-1"])
  })

  it("keeps a refused dispatch open and retries it with backoff", async () => {
    const source = fakeSource([reminder()])
    let refuse = true
    const p = poller(source, { result: () => refuse ? { accepted: false, error: "dispatch-budget hit" } : { accepted: true } })
    await p.poll()
    expect(source.completed).toEqual([])
    const rec = readClaims(claimsPath)["AAAA-1"]
    expect(rec).toMatchObject({ status: "retry", attempts: 1, error: "dispatch-budget hit" })

    await p.poll() // same instant: backoff not over
    expect(dispatched).toHaveLength(1)

    now += 60_000
    await p.poll() // attempt 2, still refused → backoff doubles
    expect(dispatched).toHaveLength(2)
    expect(Date.parse(readClaims(claimsPath)["AAAA-1"].nextAt!)).toBe(now + 120_000 - 1000)

    refuse = false
    now += 120_000
    await p.poll()
    expect(dispatched).toHaveLength(3)
    expect(source.completed).toEqual(["AAAA-1"])
  })

  it("treats a throwing dispatch as refused", async () => {
    const source = fakeSource([reminder()])
    await poller(source, { dispatch: async () => { throw new Error("boom") } }).poll()
    expect(source.completed).toEqual([])
    expect(readClaims(claimsPath)["AAAA-1"]).toMatchObject({ status: "retry", error: "boom" })
  })

  it("leaves reminders without a trailer or with an unknown agent untouched, logged once", async () => {
    const source = fakeSource([
      reminder({ id: "NT", notes: "no trailer here" }),
      reminder({ id: "UA", notes: "agentx: agent=someone-else" }),
    ])
    const events: string[] = []
    const p = poller(source, { publish: (type, _a, _s, id) => events.push(`${type}:${id}`) })
    await p.poll()
    await p.poll()
    expect(dispatched).toHaveLength(0)
    expect(source.completed).toEqual([])
    expect(logs.filter((l) => l.includes("NT"))).toHaveLength(1)
    expect(logs.filter((l) => l.includes("UA") && l.includes('"someone-else" is not on this node'))).toHaveLength(1)
    expect(events).toEqual(["reminder:skipped:NT", "reminder:skipped:UA"])
  })

  it("reports reminders overdue past the lookback window instead of running them", async () => {
    const source = fakeSource([
      reminder({ id: "OLD1", dueDate: "2026-09-25T09:00:00Z" }),
      reminder({ id: "OLD2", title: "Check the reply", dueDate: "2026-09-24T09:00:00Z" }),
    ])
    const p = poller(source)
    await p.poll()
    await p.poll()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].message).toContain("[Reminders overdue while AgentX was down]")
    expect(dispatched[0].message).toContain("OLD1")
    expect(dispatched[0].message).toContain("Check the reply")
    expect(source.completed).toEqual([])
    expect(readClaims(claimsPath)["OLD2"].status).toBe("reported")
  })

  it("emits due and dispatched events carrying the reminder id", async () => {
    const events: string[] = []
    await poller(fakeSource([reminder()]), { publish: (type, _a, _s, id) => events.push(`${type}:${id}`) }).poll()
    expect(events).toEqual(["reminder:due:AAAA-1", "reminder:dispatched:AAAA-1"])
  })

  it("keeps polling other lists when one can't be read", async () => {
    const source: ReminderSource = {
      listOpen: async (l) => { if (l === "Broken") throw new Error("no such list"); return [reminder()] },
      complete: async () => {},
    }
    await poller(source, { settings: { lists: ["Broken", "AgentX"], pollSeconds: 60, lookbackHours: 24 } }).poll()
    expect(dispatched).toHaveLength(1)
    expect(logs.some((l) => l.includes('can\'t read list "Broken"'))).toBe(true)
  })
})

describe("reminders config", () => {
  it("is off by default with neutral defaults", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n", name: "n" } })
    expect(cfg.reminders).toEqual({ enabled: false, lists: ["AgentX"], pollSeconds: 60, lookbackHours: 24, command: "remindctl" })
  })
})

describe("startRemindersPoller", () => {
  let root: string
  let logs: string[]
  let sent: Array<{ channel: string; chatId: string; text: string }>
  let stop: (() => void) | null = null

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentx-reminders-daemon-"))
    logs = []
    sent = []
  })
  afterEach(() => {
    stop?.()
    stop = null
    rmSync(root, { recursive: true, force: true })
  })

  function start(over: Partial<RemindersDaemonDeps> & { items?: Reminder[] } = {}) {
    const source = fakeSource(over.items ?? [reminder({ dueDate: new Date(Date.now() - 60_000).toISOString() })])
    stop = startRemindersPoller({
      settings: { enabled: true, lists: ["AgentX"], pollSeconds: 3600, lookbackHours: 24, command: "remindctl" },
      root,
      execute: async () => ({ content: "Deploy retried, green." }),
      hasAgent: () => true,
      send: async (m) => { sent.push(m) },
      isStopping: () => false,
      log: (m) => logs.push(m),
      platform: "darwin",
      source,
      ...over,
    })
    return source
  }

  it("says it is unavailable and does nothing off macOS", () => {
    const source = start({ platform: "linux" })
    expect(stop).toBeNull()
    expect(logs[0]).toContain("only available on macOS")
    expect(source.completed).toEqual([])
  })

  it("does nothing when disabled", () => {
    start({ settings: { enabled: false, lists: ["AgentX"], pollSeconds: 60, lookbackHours: 24, command: "remindctl" } })
    expect(stop).toBeNull()
    expect(logs).toEqual([])
  })

  it("runs on the reminder channel, ticks off, and delivers the answer to the trailer's context", async () => {
    const tasks: any[] = []
    const source = start({ execute: async (task) => { tasks.push(task); return { content: "Deploy retried, green." } } })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(tasks[0]).toMatchObject({ agentId: "coder-agent", context: { channel: "reminder", chatId: "reminder:AAAA-1" } })
    expect(source.completed).toEqual(["AAAA-1"])
    expect(sent[0]).toMatchObject({ channel: "telegram", chatId: "42", text: "Deploy retried, green." })
  })

  it("falls back to notifications.destination when the context can't be delivered", async () => {
    start({
      send: async (m) => { if (m.channel === "telegram") throw new Error("Unknown channel"); sent.push(m) },
      fallbackDestination: { channel: "ops", chatId: "op-1" },
    })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({ channel: "ops", chatId: "op-1" })
  })

  it("treats an error before the run starts as a refusal: open, nothing delivered", async () => {
    const source = start({ execute: async () => ({ content: "", error: "Claude-code fleet dispatch-budget hit: 5/5" }) })
    await vi.waitFor(() => expect(logs.some((l) => l.includes("refused"))).toBe(true))
    expect(source.completed).toEqual([])
    expect(sent).toEqual([])
  })

  it("counts a queued task as accepted: dispatched once, ticked off, not retried", async () => {
    let calls = 0
    const source = start({ execute: async () => { calls++; return { content: "", error: "__queued__:collect:1" } } })
    await vi.waitFor(() => expect(source.completed).toEqual(["AAAA-1"]))
    expect(calls).toBe(1)
    expect(sent).toEqual([])
    expect(logs.some((l) => l.includes("refused"))).toBe(false)
  })

  it("accepts at the first stream event and ticks off before the run ends", async () => {
    let finish!: (r: { content: string }) => void
    const source = start({
      execute: (_t, _d, _th, onEvent) => { onEvent?.({ type: "system" }); return new Promise((r) => { finish = r }) },
    })
    await vi.waitFor(() => expect(source.completed).toEqual(["AAAA-1"]))
    expect(sent).toEqual([])
    finish({ content: "done later" })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
  })
})

describe("doctor: reminders", () => {
  it("warns off macOS, fails without remindctl, passes with it", async () => {
    const { runReminderChecks } = await import("../src/commands/doctor")
    const cfg = { reminders: { enabled: true, lists: ["AgentX"], command: "remindctl" } }
    const off: any[] = []
    runReminderChecks(off, { reminders: { enabled: false } }, "darwin")
    expect(off).toEqual([])

    const linux: any[] = []
    runReminderChecks(linux, cfg, "linux")
    expect(linux[0]).toMatchObject({ severity: "warn", group: "Reminders" })

    const missing: any[] = []
    runReminderChecks(missing, cfg, "darwin", () => false)
    expect(missing[0]).toMatchObject({ severity: "fail", title: "remindctl not found" })

    const ok: any[] = []
    runReminderChecks(ok, { reminders: { ...cfg.reminders, command: "/opt/bin/remindctl" } }, "darwin", (f) => f === "/opt/bin/remindctl")
    expect(ok[0]).toMatchObject({ severity: "ok", detail: "/opt/bin/remindctl" })
  })
})
