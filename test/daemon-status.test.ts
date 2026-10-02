import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { BOOT_LOG_FILE, LAST_STOP_FILE, readBootLog, recordBootEntry, restartSummary, writeLastStop } from "../src/daemon/boot-record"
import { compareDiskBuild } from "../src/utils/build-info"
import { ago, lastBoot, stamp, statusBlock, stoppedBlock } from "../src/commands/daemon-status"
import { headerBuild, renderTopbar } from "../src/daemon/topbar"

const NOW = Date.parse("2026-03-10T13:26:00Z")
const HOUR = 3_600_000
const DAY = 24 * HOUR

let dir: string
beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), "agentx-boot-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("boot log", () => {
  it("keeps who stopped the process before, and uses that stop only once", () => {
    recordBootEntry(dir, NOW - 8 * HOUR)
    writeLastStop(dir, { at: new Date(NOW - 1000).toISOString(), by: "agentx daemon restart", reason: "SIGTERM" })

    const log = recordBootEntry(dir, NOW)
    expect(log).toEqual([
      { at: NOW - 8 * HOUR, by: null, reason: null },
      { at: NOW, by: "agentx daemon restart", reason: "SIGTERM" },
    ])
    expect(existsSync(resolve(dir, LAST_STOP_FILE))).toBe(false)

    // A crash leaves no stop file: the next boot does not inherit the old one.
    expect(recordBootEntry(dir, NOW + HOUR).at(-1)).toEqual({ at: NOW + HOUR, by: null, reason: null })
    expect(JSON.parse(readFileSync(resolve(dir, BOOT_LOG_FILE), "utf-8"))).toHaveLength(3)
  })

  it("starts from the older start times when no log exists yet", () => {
    const log = recordBootEntry(dir, NOW, [NOW - 2 * DAY, NOW - DAY])
    expect(log.map((e) => e.at)).toEqual([NOW - 2 * DAY, NOW - DAY, NOW])
    // Once the log exists, the seed is not read again.
    expect(recordBootEntry(dir, NOW + HOUR, [1, 2, 3]).map((e) => e.at)).toEqual([NOW - 2 * DAY, NOW - DAY, NOW, NOW + HOUR])
  })

  it("survives a corrupt log and a corrupt stop file", () => {
    writeFileSync(resolve(dir, BOOT_LOG_FILE), "{not json")
    writeFileSync(resolve(dir, LAST_STOP_FILE), "{not json")
    expect(recordBootEntry(dir, NOW)).toEqual([{ at: NOW, by: null, reason: null }])
  })

  it("reads boot-history.json in a folder an older version left", () => {
    writeFileSync(resolve(dir, "boot-history.json"), JSON.stringify([NOW - DAY, NOW - HOUR]))
    expect(readBootLog(dir).map((e) => e.at)).toEqual([NOW - DAY, NOW - HOUR])
    expect(lastBoot(dir)).toEqual({ at: new Date(NOW - HOUR).toISOString(), by: null, reason: null })
    expect(lastBoot(resolve(dir, "missing"))).toBeNull()
  })
})

describe("restartSummary", () => {
  it("gives the last restart, the boot before it and the counts", () => {
    const log = [NOW - 9 * DAY, NOW - 3 * DAY, NOW - 2 * DAY, NOW - 2 * HOUR, NOW - HOUR].map((at) => ({ at, by: null, reason: null }))
    log[4] = { at: NOW - HOUR, by: "restart-when-idle from the dashboard", reason: "restart" } as never
    const midnight = new Date(NOW); midnight.setHours(0, 0, 0, 0)
    const s = restartSummary(log, NOW)
    expect(s.lastRestart).toEqual({
      at: new Date(NOW - HOUR).toISOString(),
      by: "restart-when-idle from the dashboard",
      reason: "restart",
      previousBootAt: new Date(NOW - 2 * HOUR).toISOString(),
    })
    expect(s.restarts.last7d).toBe(4)
    expect(s.restarts.today).toBe(log.filter((e) => e.at >= midnight.getTime()).length)
    expect(s.restarts.since).toBe(new Date(NOW - 9 * DAY).toISOString())
  })

  it("is empty before the first boot is recorded", () => {
    expect(restartSummary([], NOW)).toEqual({ lastRestart: null, restarts: { today: 0, last7d: 0, since: null } })
  })
})

describe("compareDiskBuild", () => {
  const running = { version: "1.4.0", startedAt: new Date(NOW).toISOString() }

  it("is not newer when the entry file predates the process and the version matches", () => {
    expect(compareDiskBuild(running, { mtimeMs: NOW - HOUR, version: "1.4.0" }).newer).toBe(false)
  })

  it("is newer after a rebuild (entry file written after the process started)", () => {
    const d = compareDiskBuild(running, { mtimeMs: NOW + HOUR, version: "1.4.0" })
    expect(d).toEqual({ newer: true, changedAt: new Date(NOW + HOUR).toISOString(), version: "1.4.0" })
  })

  it("is newer after an npm upgrade, whose files keep an old date", () => {
    expect(compareDiskBuild(running, { mtimeMs: Date.parse("1985-10-26T08:15:00Z"), version: "1.5.0" }).newer).toBe(true)
  })

  it("does not guess when nothing on disk can be read", () => {
    expect(compareDiskBuild(running, { mtimeMs: null, version: null })).toEqual({ newer: false, changedAt: null, version: null })
  })
})

describe("agentx daemon status block", () => {
  const health = {
    node: { id: "demo-node", name: "Demo" },
    version: "1.4.0",
    commit: "abc1234",
    startedAt: "2026-03-10T11:21:00Z",
    pid: 1827,
    lastRestart: { at: "2026-03-10T11:21:00Z", by: "agentx daemon restart", reason: "SIGTERM", previousBootAt: "2026-03-10T05:41:00Z" },
    restarts: { today: 3, last7d: 9, since: "2026-02-20T08:00:00Z" },
    build: { newer: false, changedAt: "2026-03-10T11:00:00Z", version: "1.4.0" },
  }
  const service = {
    service: { kind: "launchd" as const, label: "com.example.agentx", domain: "gui/501" },
    selfRestart: { ok: true as const, exitCode: 0, how: "launchd job com.example.agentx restarts it (KeepAlive)" },
  }

  it("answers version, running since, last restart, counts, build and service", () => {
    expect(statusBlock(health, service, NOW, "UTC")).toEqual([
      "AgentX 1.4.0 (abc1234)   node demo-node",
      "Running since   2026-03-10 11:21 (UTC), 2h 05m ago, pid 1827",
      "Last restart    2026-03-10 11:21 by agentx daemon restart (SIGTERM), previous boot 2026-03-10 05:41",
      "Restarts        3 today, 9 in the last 7 days",
      "Build on disk   dist newer than process: no",
      "Service         launchd com.example.agentx (KeepAlive)",
    ])
  })

  it("prints times in the reader's time zone", () => {
    expect(statusBlock(health, {}, NOW, "Asia/Tokyo")[1]).toBe("Running since   2026-03-10 20:21 (Asia/Tokyo), 2h 05m ago, pid 1827")
  })

  it("says what is on disk when it is newer, and when the week of counts is partial", () => {
    const lines = statusBlock({
      ...health,
      lastRestart: { at: health.startedAt, by: null, reason: null, previousBootAt: null },
      restarts: { today: 1, last7d: 1, since: "2026-03-10T11:21:00Z" },
      build: { newer: true, changedAt: "2026-03-10T12:30:00Z", version: "1.5.0" },
    }, { service: { kind: "none" } }, NOW, "UTC")
    expect(lines[2]).toBe("Last restart    2026-03-10 11:21, first start on record")
    expect(lines[3]).toBe("Restarts        1 today, 1 in the last 7 days (on record since 2026-03-10 11:21)")
    expect(lines[4]).toBe("Build on disk   dist newer than process: yes (1.5.0, written 2026-03-10 12:30), restart to load it")
    expect(lines[5]).toBe("Service         none (started from a terminal, nothing starts it again)")
  })

  it("says so when the process before did not stop cleanly", () => {
    const crashed = { ...health, lastRestart: { ...health.lastRestart, by: null, reason: null } }
    expect(statusBlock(crashed, {}, NOW, "UTC")[2]).toBe("Last restart    2026-03-10 11:21 no clean stop on record before it, previous boot 2026-03-10 05:41")
  })

  it("prints fewer lines for a daemon from before these fields", () => {
    expect(statusBlock({ node: { id: "demo-node" }, version: "1.0.0", commit: null, startedAt: health.startedAt }, {}, NOW, "UTC")).toEqual([
      "AgentX 1.0.0   node demo-node",
      "Running since   2026-03-10 11:21 (UTC), 2h 05m ago",
    ])
  })

  it("says stopped, with the last boot on record", () => {
    expect(stoppedBlock("demo-node", { at: "2026-03-10T11:21:00Z", by: null, reason: null }, NOW, "UTC")).toEqual([
      "AgentX is stopped   node demo-node",
      "Last boot       2026-03-10 11:21 (UTC), 2h 05m ago",
    ])
    expect(stoppedBlock("demo-node", null, NOW, "UTC")[1]).toBe("Last boot       none on record in this folder")
    // Too slow to answer is not the same as stopped.
    expect(stoppedBlock("demo-node", null, NOW, "UTC", "timeout")[0]).toBe("AgentX did not answer within 3 seconds   node demo-node")
  })

  it("formats ages and stamps", () => {
    expect([ago(45_000), ago(5 * 60_000), ago(2 * HOUR + 5 * 60_000), ago(3 * DAY + 4 * HOUR)]).toEqual(["45s", "5m", "2h 05m", "3d 4h"])
    expect(stamp("2026-03-10T11:21:00Z", "UTC")).toBe("2026-03-10 11:21")
  })
})

describe("dashboard header build", () => {
  it("takes version, commit, running since and the disk warning from the daemon's /health", () => {
    expect(headerBuild({
      node: { id: "demo-node" }, version: "1.4.0", commit: "abc1234", startedAt: "2026-03-10T11:21:00.000Z",
      build: { newer: true }, agents: [{ id: "private" }], usage: { cost: 1 },
    })).toEqual({ node: "demo-node", version: "1.4.0", commit: "abc1234", startedAt: "2026-03-10T11:21:00.000Z", diskNewer: true })
  })

  it("answers with blanks for a daemon from before these fields", () => {
    expect(headerBuild({ status: "ok" })).toEqual({ node: null, version: null, commit: null, startedAt: null, diskNewer: false })
  })

  it("is in the header of every page, hidden until the daemon answers", () => {
    expect(renderTopbar({ activeTab: "live", subtitle: "t" })).toContain('<span class="ax-build" hidden></span>')
  })
})
