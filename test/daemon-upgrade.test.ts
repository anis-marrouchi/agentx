import { describe, expect, it, vi } from "vitest"
import {
  bootstrapWithRetry, chatRouteOk, checksSummary, countHolding, healthIsUpgraded, holdsUpgrade, hubPageOk, oneShotPlist, peerSkew,
  plistNamesDir, releaseDirFromArgs, retargetPlist, runsToCut, upgradeJobLabel,
} from "../src/daemon/upgrade"

// Pure parts of `agentx daemon upgrade`. Nothing here runs launchctl.

const OLD = "/srv/agentx/releases/agentx-release-aaaa1111"
const NEW = "/srv/agentx/releases/agentx-release-bbbb2222"

const plist = (dir: string) => `<dict>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/node</string><string>${dir}/dist/cli.js</string><string>daemon</string><string>start</string></array>
  <key>WorkingDirectory</key><string>/srv/agentx/work</string>
  <key>Note</key><string>${dir}-old copy is unrelated</string>
</dict>`

describe("release folder", () => {
  it("is read from the program arguments", () => {
    expect(releaseDirFromArgs(["/usr/bin/node", `${OLD}/dist/cli.js`, "daemon", "start"])).toBe(OLD)
  })

  it("is null when no argument is a release CLI", () => {
    expect(releaseDirFromArgs(["/usr/local/bin/agentx", "daemon", "start"])).toBeNull()
    expect(releaseDirFromArgs(undefined)).toBeNull()
  })
})

describe("retargeting a settings file", () => {
  it("moves every path inside the old folder and nothing else", () => {
    const r = retargetPlist(plist(OLD), OLD, NEW)
    expect(r.count).toBe(1)
    expect(r.text).toContain(`${NEW}/dist/cli.js`)
    expect(r.text).toContain(`${OLD}-old copy`)
    expect(r.text).toContain("/srv/agentx/work")
  })

  it("matches the folder itself, not a longer name that starts with it", () => {
    expect(plistNamesDir(plist(OLD), OLD)).toBe(true)
    expect(plistNamesDir(`<string>${OLD}0/dist/cli.js</string>`, OLD)).toBe(false)
    expect(plistNamesDir(`<string>${OLD}</string>`, OLD)).toBe(true)
  })
})

describe("the one-shot upgrade job", () => {
  const text = oneShotPlist({
    label: upgradeJobLabel("com.example.agentx"),
    programArguments: ["/usr/bin/node", "/x/cli.js", "daemon", "upgrade", NEW, "--run"],
    workingDirectory: "/srv/agentx/work",
    logPath: "/srv/agentx/work/.agentx/logs/upgrade.log",
    environment: { PATH: "/usr/bin:/bin", NOTE: "a<b&c" },
  })

  it("runs once and is never started again", () => {
    expect(text).toContain("<key>Label</key><string>com.example.agentx.upgrade</string>")
    expect(text).toMatch(/<key>KeepAlive<\/key><false\/>/)
    expect(text).toMatch(/<key>LaunchOnlyOnce<\/key><true\/>/)
  })

  it("survives the daemon's job stopping", () => {
    expect(text).toMatch(/<key>AbandonProcessGroup<\/key><true\/>/)
  })

  it("escapes XML in values", () => {
    expect(text).toContain("<string>a&lt;b&amp;c</string>")
  })
})

describe("is the new daemon up", () => {
  it("needs the new version from a new process", () => {
    expect(healthIsUpgraded({ version: "2.0.0", pid: 20 }, { version: "2.0.0", oldPid: 10 })).toBe(true)
    expect(healthIsUpgraded({ version: "2.0.0", pid: 10 }, { version: "2.0.0", oldPid: 10 })).toBe(false)
    expect(healthIsUpgraded({ version: "1.0.0", pid: 20 }, { version: "2.0.0", oldPid: 10 })).toBe(false)
    expect(healthIsUpgraded(null, { version: "2.0.0", oldPid: 10 })).toBe(false)
  })

  it("trusts the version alone when no PID is reported", () => {
    expect(healthIsUpgraded({ version: "2.0.0" }, { version: "2.0.0", oldPid: 10 })).toBe(true)
  })
})

describe("bootstrap retry", () => {
  const sleep = vi.fn(async () => {})

  it("retries while launchd answers 'Input/output error', until the job is loaded", async () => {
    const codes = [5, 5, 0]
    const bootstrap = vi.fn(() => codes.shift() ?? 0)
    expect(await bootstrapWithRetry({ bootstrap, loaded: () => false, sleep }, 10, 1)).toBe(true)
    expect(bootstrap).toHaveBeenCalledTimes(3)
  })

  it("counts a job that ended up loaded as success", async () => {
    expect(await bootstrapWithRetry({ bootstrap: () => 37, loaded: () => true, sleep }, 3, 1)).toBe(true)
  })

  it("gives up after the last attempt", async () => {
    const bootstrap = vi.fn(() => 5)
    expect(await bootstrapWithRetry({ bootstrap, loaded: () => false, sleep }, 4, 1)).toBe(false)
    expect(bootstrap).toHaveBeenCalledTimes(4)
  })
})

describe("runs that hold a --people-only upgrade", () => {
  it("does not wait for the fleet's own work", () => {
    for (const channel of ["a2a", "cron", "workflow", "reminder", "github", "gitlab", "subagent", "signals"]) {
      expect(holdsUpgrade({ channel })).toBe(false)
    }
    expect(holdsUpgrade({ channel: "A2A" })).toBe(false)
    expect(holdsUpgrade({ channel: "gitlab@second" })).toBe(false)
  })

  it("waits for a run a person is waiting on, and for a channel it does not know", () => {
    for (const channel of ["whatsapp", "email", "telegram", "voice", "web-chat", "app", "dashboard", "something-new"]) {
      expect(holdsUpgrade({ channel })).toBe(true)
    }
    expect(holdsUpgrade({ channel: "" })).toBe(true)
    expect(holdsUpgrade({ channel: null })).toBe(true)
    expect(holdsUpgrade({})).toBe(true)
  })

  it("counts the holding runs and lists the ones to cut", () => {
    const running = [
      { agentId: "ops", taskId: "t1", channel: "a2a", chatId: "x" },
      { agentId: "desk", taskId: "t2", channel: "whatsapp" },
      { agentId: "ops", taskId: "t3", channel: "cron" },
    ]
    expect(countHolding(running)).toBe(1)
    expect(countHolding([])).toBe(0)
    expect(runsToCut(running)).toEqual([
      { agentId: "ops", channel: "a2a", taskId: "t1" },
      { agentId: "ops", channel: "cron", taskId: "t3" },
    ])
  })
})

describe("waiting for idle on a busy daemon", () => {
  it("rides out a long run of missed checks instead of refusing the upgrade", async () => {
    const { IDLE_MAX_MISSES } = await import("../src/commands/daemon-upgrade-run")
    const { waitForIdle } = await import("../src/daemon/restart")
    const answers: Array<number | null> = [...Array(IDLE_MAX_MISSES - 1).fill(null), 0, 0]
    const r = await waitForIdle({
      read: async () => answers.shift() ?? 0, intervalMs: 10_000, timeoutMs: 60 * 60_000,
      maxUnreachable: IDLE_MAX_MISSES, sleep: async () => {}, now: () => 0,
    })
    expect(r.outcome).toBe("idle")
    expect(IDLE_MAX_MISSES).toBeGreaterThan(6)
  })
})

describe("checks after the upgrade (#2227)", () => {
  const self = { version: "0.278.0", commit: "08469c96aaaa" }
  it("finds no skew when every peer runs the same version and commit", () => {
    expect(peerSkew(self, [{ peer: "clawd", url: "http://c", health: { version: "0.278.0", commit: "08469c96aaaa" } }])).toEqual([])
  })
  it("reports a peer on another version, another commit, or not answering", () => {
    const skew = peerSkew(self, [
      { peer: "a", url: "http://a", health: { version: "0.277.0", commit: "bffdedf7" } },
      { peer: "b", url: "http://b", health: { version: "0.278.0", commit: "deadbeef" } },
      { peer: "c", url: "http://c", health: null },
    ])
    expect(skew.map((s) => s.peer)).toEqual(["a", "b", "c"])
    expect(skew[2]).toEqual({ peer: "c", url: "http://c", version: null, commit: null })
  })
  it("compares version only when a side has no commit", () => {
    expect(peerSkew({ version: "0.278.0", commit: null }, [{ peer: "x", url: "u", health: { version: "0.278.0", commit: "x" } }])).toEqual([])
  })
  it("counts the Hub page ok only for a real HTML page", () => {
    expect(hubPageOk(200, "text/html; charset=utf-8", 1_036_273)).toBe(true)
    expect(hubPageOk(200, "text/html", 200)).toBe(false)
    expect(hubPageOk(502, "text/html", 5000)).toBe(false)
    expect(hubPageOk(null, "", 0)).toBe(false)
  })
  it("counts the chat route ok when its handler answers JSON below 500", () => {
    expect(chatRouteOk(401, "application/json; charset=utf-8")).toBe(true)
    expect(chatRouteOk(200, "application/json")).toBe(true)
    expect(chatRouteOk(500, "application/json")).toBe(false)
    expect(chatRouteOk(200, "text/html")).toBe(false)
    expect(chatRouteOk(null, "")).toBe(false)
  })
  it("summarises skew and failed probes for the RESULT line", () => {
    expect(checksSummary(
      [{ peer: "clawd", url: "u", version: "0.277.0", commit: "bffdedf7bd35" }],
      [{ name: "Hub page", url: "h", status: 502, ok: false, detail: "text/html, 10 bytes" }, { name: "chat route", url: "c", status: 401, ok: true }],
    )).toBe("peer clawd runs 0.277.0 bffdedf7; Hub page failed (502, text/html, 10 bytes)")
    expect(checksSummary([], [])).toBe("")
  })
})
