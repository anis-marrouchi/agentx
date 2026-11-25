import { describe, expect, it, vi } from "vitest"
import {
  bootstrapWithRetry, countHolding, healthIsUpgraded, holdsUpgrade, oneShotPlist, plistNamesDir, releaseDirFromArgs, retargetPlist,
  runsToCut, upgradeJobLabel,
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
