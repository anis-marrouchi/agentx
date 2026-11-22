import { describe, expect, it } from "vitest"
import { parsePmset, readBattery, type BatteryReading } from "../src/sensors/battery"
import { sensorSchema, sensorProblems, everyMs } from "../src/sensors/config"
import { crossFieldProblems, daemonConfigSchema } from "../src/daemon/config"
import { checkHolds, emptyState, failed, HOLD_MS, pushed, started, step, type SensorAction, type SensorState } from "../src/sensors/levels"
import { SCRIPT_LEVELS } from "./fixtures/sensor-levels"

// #863: the battery sensor keeps every line of battery-watch.sh. These are
// the script's own cases, on the pure engine (no timer, no I/O).

const cfg = sensorSchema.parse(SCRIPT_LEVELS)
const T0 = Date.parse("2030-05-01T10:00:00Z")
const MIN = 60_000

const bat = (percent: number): BatteryReading => ({ ok: true, percent, onBattery: true, onAC: false })
const ac = (percent: number): BatteryReading => ({ ok: true, percent, onBattery: false, onAC: true })
const kinds = (a: SensorAction[], kind: SensorAction["kind"]) => a.filter((x) => x.kind === kind)
const wakes = (a: SensorAction[]) => kinds(a, "wake").map((x) => (x as any).level)
const pushes = (a: SensorAction[]) => kinds(a, "push").map((x) => (x as any).level)

/** One reading; every wake starts at once and every push goes out. */
function read(state: SensorState, r: BatteryReading, now: number): { state: SensorState; actions: SensorAction[] } {
  let { state: s, actions } = step(cfg, state, r, now)
  for (const a of actions) {
    if (a.kind === "wake") s = started(cfg, s, a.level, now).state
    if (a.kind === "push") s = pushed(s, a.level, a.fallback, { ok: true, reason: "sent" }).state
  }
  return { state: s, actions }
}

describe("battery reader", () => {
  it("reads percent and power source from pmset", () => {
    expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=8061027)\t52%; discharging; 3:10 remaining present: true"))
      .toEqual({ ok: true, percent: 52, onBattery: true, onAC: false })
    expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true"))
      .toEqual({ ok: true, percent: 100, onBattery: false, onAC: true })
  })

  it("is ok:false for no battery, unparsable output and a missing pmset", async () => {
    expect(parsePmset("Now drawing from 'AC Power'\nNo batteries available")).toEqual({ ok: false, why: "no battery on this machine" })
    expect(parsePmset("Now drawing from 'AC Power'\n")).toEqual({ ok: false, why: "no battery on this machine" })
    expect(parsePmset("garbage 12%").ok).toBe(false)
    expect(parsePmset("").ok).toBe(false)
    const missing = Object.assign(new Error("spawn pmset ENOENT"), { code: "ENOENT" })
    expect(await readBattery(() => Promise.reject(missing))).toEqual({ ok: false, why: "pmset not found (not macOS)" })
  })
})

describe("sensor config", () => {
  it("refuses a battery sensor on a node that is not macOS", () => {
    const parsed = daemonConfigSchema.parse({ node: { id: "n", name: "n" }, agents: {}, sensors: { battery: { ...SCRIPT_LEVELS, levels: [SCRIPT_LEVELS.levels[2]] } } })
    expect(crossFieldProblems(parsed, "linux").join(" ")).toMatch(/sensors\.battery: a battery sensor reads pmset/)
    expect(crossFieldProblems(parsed, "darwin")).toEqual([])
  })

  it("defaults to no sensors, and checks levels, targets and every", () => {
    expect(daemonConfigSchema.parse({ node: { id: "n", name: "n" } }).sensors).toEqual({})
    expect(sensorProblems({ sensors: { battery: cfg }, agents: {} }, "darwin").join(" ")).toMatch(/"ops-agent" is no agent/)
    expect(sensorSchema.safeParse({ ...SCRIPT_LEVELS, every: "5s" }).success).toBe(false)
    expect(sensorSchema.safeParse({ ...SCRIPT_LEVELS, levels: [{ id: "x", when: { below: 20 } }] }).success).toBe(false)
    expect(sensorSchema.safeParse({ ...SCRIPT_LEVELS, levels: [{ id: "x", when: {}, target: "a" }] }).success).toBe(false)
    expect(everyMs("60s")).toBe(60_000)
    expect(everyMs("5m")).toBe(300_000)
  })
})

describe("battery levels (battery-watch.sh)", () => {
  it("14% on the first read sends the 15% level and the urgent push, not the 50% level", () => {
    const { state, actions } = read(emptyState(), bat(14), T0)
    expect(wakes(actions)).toEqual(["below-15"])
    expect(pushes(actions)).toEqual(["below-25"])
    expect((kinds(actions, "wake")[0] as any).text).toBe("Ops battery watch, URGENT: Mac on battery at 14%, under the 15% line, 0 min on battery.")
    expect((kinds(actions, "push")[0] as any).text).toBe("Mac on battery at 14%, under the 25% line, 0 min on battery. When it goes flat, every agent on it stops.")
    // The 50% level counts as sent with the 15% one: nothing more at 13%.
    expect(state.levels["below-50"].sent).toBe(true)
    expect(read(state, bat(13), T0 + MIN).actions.filter((a) => a.kind === "wake" || a.kind === "push")).toEqual([])
  })

  it("sends each level once per battery stretch", () => {
    let s = emptyState()
    const sent: string[] = []
    let t = T0
    for (const p of [80, 60, 49, 48, 40, 30, 24, 20, 14, 10]) {
      const r = read(s, bat(p), t)
      s = r.state
      sent.push(...wakes(r.actions), ...pushes(r.actions))
      t += 5 * MIN
    }
    expect(sent).toHaveLength(4)
    expect(new Set(sent)).toEqual(new Set(["below-50", "below-25", "below-15", "on-30min"]))
  })

  it("ends the stretch when AC returns: the agent levels go again on the next stretch", () => {
    let s = read(emptyState(), bat(45), T0).state
    s = read(s, ac(46), T0 + MIN).state
    expect(s.stretchStart).toBeNull()
    const again = read(s, bat(45), T0 + 2 * MIN)
    expect(wakes(again.actions)).toEqual(["below-50"])
  })

  it("8 -> 35% on AC re-arms the urgent push", () => {
    let s = read(emptyState(), bat(8), T0).state
    expect(s.levels["below-25"].sent).toBe(true)
    s = read(s, ac(20), T0 + 10 * MIN).state
    expect(s.levels["below-25"].sent).toBe(true)
    const r = read(s, ac(35), T0 + 60 * MIN)
    expect(r.state.levels["below-25"].sent).toBe(false)
    expect(r.actions.some((a) => a.kind === "log" && /re-armed: on AC at 35%/.test(a.text))).toBe(true)
    expect(pushes(read(r.state, bat(24), T0 + 90 * MIN).actions)).toEqual(["below-25"])
  })

  it("a short AC spell (AC back, but 30% or less) does not re-arm the urgent push", () => {
    let s = read(emptyState(), bat(22), T0).state
    s = read(s, ac(23), T0 + MIN).state
    s = read(s, ac(30), T0 + 2 * MIN).state
    const back = read(s, bat(29), T0 + 3 * MIN)
    expect(pushes(back.actions)).toEqual([])
    // The agent levels did start over: the stretch ended.
    expect(wakes(back.actions)).toEqual(["below-50"])
  })

  it("re-arms only on AC when rearm.onAC (another power source does not)", () => {
    let s = read(emptyState(), bat(20), T0).state
    s = read(s, { ok: true, percent: 40, onBattery: false, onAC: false }, T0 + MIN).state
    expect(s.levels["below-25"].sent).toBe(true)
  })

  it("a failed push is not counted and goes again at the next reading", () => {
    const first = step(cfg, emptyState(), bat(24), T0)
    expect(pushes(first.actions)).toEqual(["below-25"])
    const failedPush = pushed(first.state, "below-25", false, { ok: false, why: "daemon 503" })
    expect(failedPush.state.levels["below-25"].sent).toBeFalsy()
    expect(failedPush.actions[0]).toMatchObject({ kind: "log", text: expect.stringMatching(/push failed, retry at the next reading: daemon 503/) })
    const second = step(cfg, failedPush.state, bat(24), T0 + MIN)
    expect(pushes(second.actions)).toEqual(["below-25"])
    const ok = pushed(second.state, "below-25", false, { ok: true, reason: "urgent, sent during Focus" })
    expect(pushes(step(cfg, ok.state, bat(23), T0 + 2 * MIN).actions)).toEqual([])
  })

  it("a wake counts only once started; a failed one is retried with a Wall line", () => {
    const first = step(cfg, emptyState(), bat(45), T0)
    expect(wakes(first.actions)).toEqual(["below-50"])
    // Still waiting: not sent, not sent twice.
    expect(wakes(step(cfg, first.state, bat(45), T0 + 30_000).actions)).toEqual([])
    const seq = (kinds(first.actions, "wake")[0] as any).seq
    const f = failed(cfg, first.state, "below-50", seq, "agent busy", "battery", T0 + 30_000)
    expect(f.actions).toEqual([{ kind: "wall", text: expect.stringMatching(/below-50 wake to ops-agent failed \(agent busy\); waking it again in 5 min or later \(retry 1 of 3\)/) }])
    expect(pushes(f.actions)).toEqual([])
    // Not at the next reading: no sooner than wakeRetry.minutes after it failed.
    expect(wakes(step(cfg, f.state, bat(45), T0 + MIN).actions)).toEqual([])
    expect(wakes(step(cfg, f.state, bat(45), T0 + 30_000 + 5 * MIN).actions)).toEqual(["below-50"])
  })

  it("24% with the queue held: the 25% push is itself model-free; the held 50% wake gets a Wall line and a retry, no push", () => {
    const first = step(cfg, emptyState(), bat(24), T0)
    expect(pushes(first.actions)).toEqual(["below-25"])
    expect(wakes(first.actions)).toEqual(["below-50"])
    const sent = pushed(first.state, "below-25", false, { ok: true, reason: "sent" }).state
    const held = checkHolds(cfg, sent, T0 + HOLD_MS)
    expect(kinds(held.actions, "abort")).toHaveLength(1)
    expect(pushes(held.actions)).toEqual([])
    expect(kinds(held.actions, "wall")).toEqual([{ kind: "wall", text: expect.stringMatching(/below-50 wake to ops-agent not started in 2 min; waking it again in 5 min or later/) }])
    const next = step(cfg, held.state, bat(24), T0 + HOLD_MS + 5 * MIN)
    expect(wakes(next.actions)).toEqual(["below-50"])
    expect(pushes(next.actions)).toEqual([])
  })

  it("15% held: the fallback push at the 2 min check, not at the next reading; a failed one is retried, then never again", () => {
    const first = step(cfg, emptyState(), bat(14), T0)
    expect(wakes(first.actions)).toEqual(["below-15"])
    const held = checkHolds(cfg, first.state, T0 + HOLD_MS)
    expect(kinds(held.actions, "push")).toEqual([{ kind: "push", level: "below-15", fallback: true, text: "Ops battery watch, URGENT: Mac on battery at 14%, under the 15% line, 0 min on battery." }])
    const failedPush = pushed(held.state, "below-15", true, { ok: false, why: "daemon 503" }).state
    expect(failedPush.levels["below-15"].fallback).toBe("owed")
    // The next reading: one retry (not two, though the hold check runs in it too).
    const retry = step(cfg, failedPush, bat(14), T0 + HOLD_MS + MIN)
    expect(kinds(retry.actions, "push").filter((a) => (a as any).fallback)).toHaveLength(1)
    const ok = pushed(retry.state, "below-15", true, { ok: true, reason: "sent" }).state
    const later = checkHolds(cfg, ok, T0 + 2 * HOLD_MS + MIN)
    expect(kinds(later.actions, "push").filter((a) => (a as any).fallback)).toEqual([])
  })

  it("#2063: low readings every minute after failed wakes give at most 1 + wakeRetry.max wakes per level and stretch", () => {
    let s = emptyState()
    const total: Record<string, number> = {}
    const wall: string[] = []
    for (let m = 0; m < 120; m++) {
      const r = step(cfg, s, bat(45), T0 + m * MIN)
      s = r.state
      wall.push(...kinds(r.actions, "wall").map((a) => (a as any).text))
      for (const a of kinds(r.actions, "wake") as Array<Extract<SensorAction, { kind: "wake" }>>) {
        total[a.level] = (total[a.level] ?? 0) + 1
        const f = failed(cfg, s, a.level, a.seq, "agent busy", "battery", T0 + m * MIN)
        s = f.state
        wall.push(...kinds(f.actions, "wall").map((x) => (x as any).text))
      }
    }
    // The 50% level and, from 30 min on, the 30-min level: each capped.
    expect(total).toEqual({ "below-50": 1 + cfg.wakeRetry.max, "on-30min": 1 + cfg.wakeRetry.max })
    // Per level, one Wall line for the first failure, one when the retries run out.
    expect(wall.filter((t) => t.includes("below-50"))).toEqual([
      expect.stringMatching(/retry 1 of 3/),
      expect.stringMatching(/below-50 wake to ops-agent failed \(agent busy\); no more wakes for this level until the Mac is back on AC \(3 retries used\)/),
    ])
    // AC back: the count starts again on the next stretch.
    s = step(cfg, s, ac(60), T0 + 120 * MIN).state
    expect(wakes(step(cfg, s, bat(45), T0 + 121 * MIN).actions)).toEqual(["below-50"])
  })

  it("#2063: wakeRetry is a setting; max 0 means one wake per level and stretch", () => {
    expect(cfg.wakeRetry).toEqual({ max: 3, minutes: 5 })
    const none = sensorSchema.parse({ ...SCRIPT_LEVELS, wakeRetry: { max: 0 } })
    expect(none.wakeRetry).toEqual({ max: 0, minutes: 5 })
    expect(sensorSchema.safeParse({ ...SCRIPT_LEVELS, wakeRetry: { minutes: 0 } }).success).toBe(false)
    const first = step(none, emptyState(), bat(45), T0)
    const f = failed(none, first.state, "below-50", (kinds(first.actions, "wake")[0] as any).seq, "agent busy", "battery", T0)
    expect(f.actions).toEqual([{ kind: "wall", text: expect.stringMatching(/no more wakes for this level until the Mac is back on AC \(0 retries used\)/) }])
    expect(wakes(step(none, f.state, bat(45), T0 + 20 * MIN).actions)).toEqual([])
  })

  it("an urgent level cannot also carry fallbackPush", () => {
    expect(sensorSchema.safeParse({ ...SCRIPT_LEVELS, levels: [{ id: "x", when: { below: 25 }, urgent: true, fallbackPush: true }] }).success).toBe(false)
  })

  it("an unavailable reading is never a crossing: one Wall line, again only after a good reading", () => {
    const none: BatteryReading = { ok: false, why: "no battery on this machine" }
    const a = step(cfg, emptyState(), none, T0)
    expect(a.actions).toEqual([{ kind: "wall", text: "battery reading unavailable: no battery on this machine" }])
    const b = step(cfg, a.state, none, T0 + MIN)
    expect(kinds(b.actions, "wall")).toEqual([])
    const good = step(cfg, b.state, ac(90), T0 + 2 * MIN)
    expect(kinds(step(cfg, good.state, none, T0 + 3 * MIN).actions, "wall")).toHaveLength(1)
  })
})
