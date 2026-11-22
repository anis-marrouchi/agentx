import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parsePmset, type BatteryReading } from "../src/sensors/battery"
import { sensorSchema } from "../src/sensors/config"
import { HOLD_MS } from "../src/sensors/levels"
import { SensorRunner, type WakeRequest } from "../src/sensors/runner"
import type { OwnerPushResult } from "../src/notify/owner-push"
import { SCRIPT_LEVELS } from "./fixtures/sensor-levels"

// #863: the sensor loop on the daemon. Wakes are held or failed by a fake
// registry, pushes fail or go out by a fake gate; the clock is set by hand.

const T0 = Date.parse("2030-05-01T10:00:00Z")
const cfg = sensorSchema.parse(SCRIPT_LEVELS)

let dir: string
let now: number
let runner: SensorRunner
let reading: BatteryReading
let wakeCalls: WakeRequest[]
let pushCalls: Array<{ level: string; text: string }>
let pushResults: OwnerPushResult[]
let wall: string[]
let logs: string[]
/** How each wake goes: "hold" never starts it, "fail" ends it in error. */
let wakeMode: "start" | "hold" | "fail"

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-sensors-"))
  now = T0
  wakeCalls = []
  pushCalls = []
  pushResults = []
  wall = []
  logs = []
  wakeMode = "start"
  reading = { ok: true, percent: 80, onBattery: false, onAC: true }
  runner = new SensorRunner({
    sensors: () => ({ battery: cfg }),
    read: async () => reading,
    wake: (w) => {
      wakeCalls.push(w)
      if (wakeMode === "start") { w.onStart(); return Promise.resolve({}) }
      if (wakeMode === "fail") return Promise.resolve({ error: "Agent not started: no room" })
      // Held in the queue until the caller drops it.
      return new Promise((resolve) => w.signal.addEventListener("abort", () => resolve({ error: "caller gone" })))
    },
    push: async (_s, level, text) => {
      pushCalls.push({ level: level.id, text })
      return pushResults.shift() ?? { ok: true, reason: "urgent, sent during Focus" }
    },
    wall: (_s, text) => { wall.push(text) },
    log: (m) => { logs.push(m) },
    stateFile: join(dir, "state", "sensors.json"),
    now: () => now,
  })
})

afterEach(() => {
  runner.stop()
  rmSync(dir, { recursive: true, force: true })
})

const bat = (percent: number) => { reading = { ok: true, percent, onBattery: true, onAC: false } }

describe("sensor runner", () => {
  it("wakes the target at critical priority in the sensor channel, and keeps state out of agentx.json", async () => {
    bat(45)
    await runner.readOnce("battery")
    await runner.idle()
    expect(wakeCalls.map((w) => [w.level, w.target])).toEqual([["below-50", "ops-agent"]])
    expect(runner.state("battery").levels["below-50"].sent).toBe(true)
    const file = join(dir, "state", "sensors.json")
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, "utf8")).battery.levels["below-50"].sent).toBe(true)
  })

  it("15% level held (not started in 2 min): the model-free push exactly once, and a Wall line", async () => {
    wakeMode = "hold"
    bat(14)
    await runner.readOnce("battery")
    await runner.idle()
    // The urgent 25% push went at once; the 15% wake waits in the queue.
    expect(pushCalls.map((p) => p.level)).toEqual(["below-25"])
    expect(wakeCalls.map((w) => w.level)).toEqual(["below-15"])
    now += HOLD_MS
    await runner.checkHolds("battery")
    await runner.idle()
    expect(wakeCalls[0].signal.aborted).toBe(true)
    expect(pushCalls.map((p) => p.level)).toEqual(["below-25", "below-15"])
    expect(pushCalls[1].text).toBe("Ops battery watch, URGENT: Mac on battery at 14%, under the 15% line, 0 min on battery.")
    expect(wall).toEqual([expect.stringMatching(/below-15 wake to ops-agent not started in 2 min; sending the urgent push instead, and waking it again/)])
    // Held again and again: the wake is retried, the push is not repeated.
    for (let i = 0; i < 3; i++) {
      now += 60_000
      await runner.readOnce("battery")
      now += HOLD_MS
      await runner.checkHolds("battery")
      await runner.idle()
    }
    expect(pushCalls.filter((p) => p.level === "below-15")).toHaveLength(1)
    expect(wakeCalls.length).toBeGreaterThan(1)
    expect(wall).toHaveLength(1)
  })

  it("#2063: a wake that fails every time, read every minute for an hour, wakes 1 + wakeRetry.max times", async () => {
    wakeMode = "fail"
    bat(45)
    for (let m = 0; m < 60; m++) {
      await runner.readOnce("battery")
      await runner.idle()
      now += 60_000
    }
    expect(wakeCalls.filter((w) => w.level === "below-50")).toHaveLength(1 + cfg.wakeRetry.max)
    expect(wakeCalls.filter((w) => w.level === "on-30min")).toHaveLength(1 + cfg.wakeRetry.max)
    expect(wall.filter((t) => t.includes("below-50"))).toEqual([expect.stringMatching(/retry 1 of 3/), expect.stringMatching(/no more wakes for this level until the Mac is back on AC/)])
  })

  it("30-min level held: a Wall line and a retry, no push", async () => {
    wakeMode = "hold"
    bat(70)
    await runner.readOnce("battery")
    now += 30 * 60_000
    await runner.readOnce("battery")
    await runner.idle()
    expect(wakeCalls.map((w) => w.level)).toEqual(["on-30min"])
    now += HOLD_MS
    await runner.checkHolds("battery")
    await runner.idle()
    expect(wall).toEqual([expect.stringMatching(/on-30min wake to ops-agent not started in 2 min; waking it again in 5 min or later/)])
    expect(pushCalls).toEqual([])
    now += 5 * 60_000
    wakeMode = "start"
    await runner.readOnce("battery")
    await runner.idle()
    expect(wakeCalls.map((w) => w.level)).toEqual(["on-30min", "on-30min"])
    expect(runner.state("battery").levels["on-30min"].sent).toBe(true)
    expect(pushCalls).toEqual([])
  })

  it("24% with the queue held: the 25% push once, the held 50% wake a Wall line and a retry, no other push", async () => {
    wakeMode = "hold"
    bat(24)
    await runner.readOnce("battery")
    await runner.idle()
    expect(pushCalls.map((p) => p.level)).toEqual(["below-25"])
    expect(wakeCalls.map((w) => w.level)).toEqual(["below-50"])
    now += HOLD_MS
    await runner.checkHolds("battery")
    await runner.idle()
    expect(wakeCalls[0].signal.aborted).toBe(true)
    expect(wall).toEqual([expect.stringMatching(/below-50 wake to ops-agent not started in 2 min; waking it again/)])
    now += 5 * 60_000
    await runner.readOnce("battery")
    await runner.idle()
    expect(wakeCalls.map((w) => w.level)).toEqual(["below-50", "below-50"])
    expect(pushCalls.map((p) => p.level)).toEqual(["below-25"])
  })

  it("15% level held and its fallback push fails: retried at the next reading, result logged, sent once", async () => {
    wakeMode = "hold"
    pushResults = [{ ok: true, reason: "sent" }, { ok: false, why: "daemon 503" }, { ok: true, reason: "sent" }]
    bat(14)
    await runner.readOnce("battery")
    now += HOLD_MS
    await runner.checkHolds("battery")
    await runner.idle()
    expect(pushCalls.map((p) => p.level)).toEqual(["below-25", "below-15"])
    expect(logs.some((l) => /below-15 push failed, retry at the next reading: daemon 503/.test(l))).toBe(true)
    now += 60_000
    await runner.readOnce("battery")
    await runner.idle()
    expect(pushCalls.map((p) => p.level)).toEqual(["below-25", "below-15", "below-15"])
    expect(runner.state("battery").levels["below-15"].fallback).toBe("sent")
    now += 60_000
    await runner.readOnce("battery")
    await runner.idle()
    expect(pushCalls).toHaveLength(3)
  })

  it("15% level failed: the push at once, the wake retried at the next reading", async () => {
    wakeMode = "fail"
    pushResults = [{ ok: true, reason: "sent" }]
    bat(14)
    await runner.readOnce("battery")
    await runner.idle()
    await runner.idle()
    expect(pushCalls.map((p) => p.level)).toEqual(["below-25", "below-15"])
    expect(wall).toEqual([expect.stringMatching(/below-15 wake to ops-agent failed/)])
  })

  it("a failed push is retried at the next reading and not counted as sent", async () => {
    pushResults = [{ ok: false, why: "not sent (repeat)" }, { ok: false, why: "daemon 503" }, { ok: true, reason: "sent" }]
    bat(24)
    for (let i = 0; i < 4; i++) {
      await runner.readOnce("battery")
      now += 60_000
    }
    await runner.idle()
    expect(pushCalls.map((p) => p.level)).toEqual(["below-25", "below-25", "below-25"])
    expect(logs.filter((l) => /push failed, retry at the next reading/.test(l))).toHaveLength(2)
    expect(logs.some((l) => /below-25 push sent/.test(l))).toBe(true)
    expect(runner.state("battery").levels["below-25"].sent).toBe(true)
  })

  it('"No batteries" output: no wake, one Wall line', async () => {
    reading = parsePmset("Now drawing from 'AC Power'\nNo batteries available")
    for (let i = 0; i < 3; i++) { await runner.readOnce("battery"); now += 60_000 }
    await runner.idle()
    expect(wakeCalls).toEqual([])
    expect(pushCalls).toEqual([])
    expect(wall).toEqual(["battery reading unavailable: no battery on this machine"])
  })

  it("unparsable output: no wake, one Wall line", async () => {
    reading = parsePmset("something else entirely")
    for (let i = 0; i < 3; i++) { await runner.readOnce("battery"); now += 60_000 }
    await runner.idle()
    expect(wakeCalls).toEqual([])
    expect(wall).toHaveLength(1)
    expect(wall[0]).toMatch(/^battery reading unavailable: pmset output not understood/)
  })
})
