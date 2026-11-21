import { describe, expect, it } from "vitest"
import { parsePmset, readBattery, type BatteryReading } from "../src/sensors/battery"
import { sensorSchema, sensorProblems, everyMs } from "../src/sensors/config"
import { crossFieldProblems, daemonConfigSchema } from "../src/daemon/config"
import { emptyState, failed, pushed, started, step, type SensorAction, type SensorState } from "../src/sensors/levels"

// #863: the battery sensor keeps every line of battery-watch.sh. These are
// the script's own cases, on the pure engine (no timer, no I/O).

export const SCRIPT_LEVELS = {
  reading: "battery",
  every: "60s",
  levels: [
    { id: "on-30min", when: { forMinutes: 30 }, target: "ops-agent", brief: "Ops battery watch" },
    { id: "below-50", when: { below: 50 }, target: "ops-agent", brief: "Ops battery watch" },
    { id: "below-25", when: { below: 25 }, urgent: true, push: { from: "Ops", key: "mac-battery-low" } },
    { id: "below-15", when: { below: 15 }, target: "ops-agent", critical: true, brief: "Ops battery watch" },
  ],
  rearm: { above: 30, onAC: true },
}
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
    const f = failed(cfg, first.state, "below-50", seq, "agent busy")
    expect(f.actions).toEqual([{ kind: "wall", text: expect.stringMatching(/below-50 wake to ops-agent failed \(agent busy\); waking it again/) }])
    expect(pushes(f.actions)).toEqual([])
    expect(wakes(step(cfg, f.state, bat(45), T0 + MIN).actions)).toEqual(["below-50"])
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
