import { describe, expect, it, vi } from "vitest"
import { loadNativeAdapter } from "../../src/native"
import { macosAdapter } from "../../src/native/macos"
import { macosTasks } from "../../src/native/macos/tasks"
import { runNativeContract } from "./contract"
import { fakeRemindctl } from "./fake-remindctl"

// #1062 step 3: the macOS adapter wraps what AgentX already did on a Mac.
// Every program is faked, so this runs on any OS in CI.

const HELPER = "/Apps/AgentX Helper.app/Contents/MacOS/agentx-mac-helper"
const fakeIo = () => ({
  run: vi.fn(async () => true),
  capture: vi.fn(async () => '{"authorization":"authorized","alertStyle":"banner"}'),
  output: fakeRemindctl(),
  helper: HELPER,
  isExecutable: () => true,
})

runNativeContract("macos", () => macosAdapter({}, fakeIo()))

describe("macOS adapter (#1062 step 3)", () => {
  it("is what darwin gets on auto, and nowhere else", () => {
    expect(loadNativeAdapter({}, { platform: "darwin" }).os).toBe("macos")
    expect(loadNativeAdapter({}, { platform: "linux" }).os).toBe("none")
    expect(loadNativeAdapter({}, { platform: "win32" }).os).toBe("none")
  })

  it("reports a banner as posted through the helper, or failed when both ways fail", async () => {
    const io = fakeIo()
    expect(await macosAdapter({}, io).banner!.post({ title: "t", message: "m" })).toBe("posted")
    expect(io.run.mock.calls[0]).toEqual([HELPER, ["notify", "--title", "t", "--message", "m"]])
    const down = { ...fakeIo(), run: vi.fn(async () => false) }
    expect(await macosAdapter({}, down).banner!.post({ title: "t", message: "m" })).toBe("failed")
    expect(down.run.mock.calls.map(([f]) => f)).toEqual([HELPER, "/usr/bin/osascript"])
  })

  it("reads the helper's permission without posting", async () => {
    const io = { ...fakeIo(), capture: vi.fn(async () => '{"authorization":"denied"}') }
    expect(await macosAdapter({}, io).banner!.status()).toBe("not-allowed")
    expect(io.capture).toHaveBeenCalledWith(HELPER, ["notify-status"])
    expect(io.run).not.toHaveBeenCalled()
    expect(await macosAdapter({}, { ...fakeIo(), helper: null }).banner!.status()).toBe("missing")
  })

  it("plays no file for a sound name that is a path", async () => {
    const io = fakeIo()
    await macosAdapter({}, io).sound!.play("../../etc/passwd", 1)
    expect(io.run).not.toHaveBeenCalled()
    expect(macosAdapter({}, io).sound!.has("../x")).toBe(false)
  })

  it("reads open reminders and ticks one off through the configured command", async () => {
    const output = vi.fn(async (_f: string, args: string[]) => args[0] === "show"
      ? JSON.stringify([{ id: "A", title: "a", isCompleted: false }, { id: "B", title: "b", isCompleted: true }, { title: "no id" }])
      : "{}")
    const tasks = macosTasks("/opt/bin/remindctl", output)
    expect((await tasks.listOpen("AgentX")).map((r) => r.id)).toEqual(["A"])
    await tasks.complete("A")
    expect(output.mock.calls).toEqual([
      ["/opt/bin/remindctl", ["show", "all", "--list", "AgentX", "--json", "--no-input"]],
      ["/opt/bin/remindctl", ["complete", "A", "--json", "--no-input"]],
    ])
  })

  it("passes quotes and newlines as argv, and protects a value that starts with a dash", async () => {
    const output = vi.fn(async (_f: string, _a: string[]) => '{"id":"X-1"}')
    const tasks = macosTasks("remindctl", output)
    expect(await tasks.add({ list: "AgentX Desk", title: '-1 "quoted"', notes: "a\n- b", due: new Date("2030-01-02T03:04:05.678Z"), priority: "high" })).toEqual({ id: "X-1" })
    expect(output.mock.calls[0][1]).toEqual([
      "add", "--title", '\u200b-1 "quoted"', "--list", "AgentX Desk", "--notes", "a\n- b",
      "--due", "2030-01-02T03:04:05Z", "--priority", "high", "--json", "--no-input",
    ])
    await tasks.update("X-1", { notes: "-x", due: null })
    expect(output.mock.calls[1][1]).toEqual(["edit", "X-1", "--notes", "\u200b-x", "--clear-due", "--json", "--no-input"])
    await tasks.remove("X-1")
    expect(output.mock.calls[2][1]).toEqual(["delete", "X-1", "--force", "--json", "--no-input"])
  })

  it("fails an add whose answer has no id, and skips an update that changes nothing", async () => {
    const output = vi.fn(async () => "✓ done")
    const tasks = macosTasks("remindctl", output)
    await expect(tasks.add({ list: "L", title: "t", notes: "" })).rejects.toThrow(/no reminder id/)
    await tasks.update("X-1", {})
    expect(output).toHaveBeenCalledOnce()
  })

  it("names a missing remindctl in describe()", async () => {
    const d = await macosAdapter({ reminders: { command: "remindctl" } }, { ...fakeIo(), isExecutable: () => false }).describe()
    expect(d.tasks).toBe(true)
    expect(d.problems.join(" ")).toMatch(/remindctl not found/)
  })

  it("is turned off by native.adapter none, for banners, sounds and the reminders poller too", async () => {
    expect(loadNativeAdapter({ native: { adapter: "none" } }, { platform: "darwin" }).os).toBe("none")
    const { localAlert, DEFAULT_LOCAL } = await import("../../src/notify/local")
    const run = vi.fn(async () => true)
    await localAlert(DEFAULT_LOCAL, { run, platform: "darwin", helper: HELPER, native: { adapter: "none" } })("t", "m")
    expect(run).not.toHaveBeenCalled()
    const { startRemindersPoller } = await import("../../src/reminders/daemon")
    const logs: string[] = []
    const stop = startRemindersPoller({
      settings: { enabled: true, lists: ["AgentX"], pollSeconds: 3600, lookbackHours: 24, command: "remindctl" },
      root: "/nonexistent", execute: async () => ({ content: "" }), hasAgent: () => true, send: async () => {},
      isStopping: () => false, log: (m) => logs.push(m), platform: "darwin", native: { adapter: "none" },
    } as any)
    expect(stop).toBeNull()
    expect(logs[0]).toMatch(/not polling/)
  })
})
