import { describe, expect, it } from "vitest"
import { AdmissionQueue, DEFAULT_ADMISSION_SETTINGS, gateReasons, priorityOf, type AdmissionSettings, type AdmissionTicket } from "../src/admission/queue"
import { parseMeminfo, parseSwapUsage, parseVmStat, ResourceSampler, type ResourceSample } from "../src/native/resources"
import { formatQueue } from "../src/admission/format"

const roomy: ResourceSample = {
  at: 0, memTotalMB: 8192, memAvailableMB: 4000, swapTotalMB: 2048, swapUsedMB: 100, swapGrows: true,
  diskFreeMB: 50_000, load1: 2, cpuCount: 8,
}

function setup(over: Partial<AdmissionSettings> = {}, sample: Partial<ResourceSample> = {}) {
  let now = 1_000_000
  const res: { current: ResourceSample } = { current: { ...roomy, ...sample } }
  const settings: AdmissionSettings = {
    ...DEFAULT_ADMISSION_SETTINGS,
    minStartGapSeconds: 0,
    boot: { windowSeconds: 0, startsPerInterval: 0, intervalSeconds: 30 },
    sampleSeconds: 60,
    ...over,
  }
  const sampler = new ResourceSampler("/", 0, async () => ({ ...res.current, at: now }))
  const logs: string[] = []
  const q = new AdmissionQueue(() => settings, sampler, (m) => logs.push(m), () => now)
  return { q, res, logs, settings, advance: (ms: number) => { now += ms } }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/** Calls admit and records the ticket once it settles. */
function ask(q: AdmissionQueue, agentId: string, extra: Record<string, unknown> = {}) {
  const box: { ticket?: AdmissionTicket | null } = {}
  void q.admit({ agentId, channel: "telegram", ...extra }).then((o) => { box.ticket = o.ok ? o.ticket : null })
  return box
}

describe("admission gate (#1521)", () => {
  it("starts a run at once when the node has room", async () => {
    const { q } = setup()
    const a = ask(q, "a")
    await tick(); await tick()
    expect(a.ticket).toBeTruthy()
    expect(q.snapshot().running.map((r) => r.agentId)).toEqual(["a"])
  })

  it("holds work while memory is short and starts it once memory frees up", async () => {
    const { q, res } = setup({}, { memAvailableMB: 200 })
    const first = ask(q, "first")
    await tick(); await tick()
    // Nothing of ours runs: one start is still allowed.
    expect(first.ticket).toBeTruthy()
    const second = ask(q, "second")
    await tick(); await tick()
    expect(second.ticket).toBeUndefined()
    expect(q.snapshot().waiting[0].blockedBy.join()).toMatch(/memory: 200 MB available/)
    res.current = { ...roomy }
    await q.pump()
    expect(second.ticket).toBeTruthy()
  })

  it("holds even the first run when allowOneWhenIdle is off", async () => {
    const { q } = setup({ allowOneWhenIdle: false }, { load1: 40 })
    const a = ask(q, "a")
    await tick(); await tick()
    expect(a.ticket).toBeUndefined()
    expect(q.snapshot().gate.open).toBe(false)
  })

  it("keeps to the session cap, and the next run starts when one ends", async () => {
    const { q } = setup({ maxSessions: 2, ownerExtraSessions: 0 })
    const a = ask(q, "a"), b = ask(q, "b"), c = ask(q, "c")
    await tick(); await tick()
    expect([!!a.ticket, !!b.ticket, c.ticket]).toEqual([true, true, undefined])
    expect(q.snapshot().next?.agentId).toBe("c")
    a.ticket!.release()
    await tick(); await tick()
    expect(c.ticket).toBeTruthy()
    expect(q.snapshot().running).toHaveLength(2)
  })

  it("orders the queue owner > critical > normal > background, then by age", async () => {
    const { q, advance } = setup({ maxSessions: 1, ownerExtraSessions: 0, priority: { ...DEFAULT_ADMISSION_SETTINGS.priority, criticalAgents: ["crit"] } })
    const hold = ask(q, "busy")
    await tick(); await tick()
    ask(q, "cron-job", { channel: "cron" }); advance(10)
    ask(q, "normal-1"); advance(10)
    ask(q, "crit"); advance(10)
    ask(q, "normal-2"); advance(10)
    ask(q, "voice", { channel: "voice" })
    await tick(); await tick()
    expect(q.snapshot().waiting.map((w) => w.agentId)).toEqual(["voice", "crit", "normal-1", "normal-2", "cron-job"])
    hold.ticket!.release()
  })

  it("lets owner turns go one over the cap, never past resources", async () => {
    const { q, res } = setup({ maxSessions: 1, ownerExtraSessions: 1 })
    ask(q, "a")
    await tick(); await tick()
    const owner = ask(q, "v", { channel: "voice" })
    await tick(); await tick()
    expect(owner.ticket).toBeTruthy()
    res.current = { ...roomy, swapUsedMB: 7000 }
    const owner2 = ask(q, "v2", { owner: true })
    await tick(); await tick()
    expect(owner2.ticket).toBeUndefined()
  })

  it("a full class only holds its own runs", async () => {
    const { q } = setup({ classes: { browser: { max: 1, agents: ["web-1", "web-2"] } } })
    const w1 = ask(q, "web-1")
    await tick(); await tick()
    const w2 = ask(q, "web-2"), other = ask(q, "other")
    await tick(); await tick()
    expect(w1.ticket).toBeTruthy()
    expect(w2.ticket).toBeUndefined()
    expect(other.ticket).toBeTruthy()
    expect(q.snapshot().caps.classes.browser).toEqual({ max: 1, running: 1 })
    w1.ticket!.release()
    await tick(); await tick()
    expect(w2.ticket).toBeTruthy()
  })

  it("paces starts in the warm-up window after boot", async () => {
    const { q, advance } = setup({ boot: { windowSeconds: 300, startsPerInterval: 2, intervalSeconds: 30 } })
    const boxes = ["a", "b", "c", "d"].map((id) => ask(q, id))
    await tick(); await tick()
    expect(boxes.map((b) => !!b.ticket)).toEqual([true, true, false, false])
    expect(q.snapshot().waiting[0].blockedBy.join()).toMatch(/start pace/)
    advance(30_001)
    await q.pump()
    expect(boxes.map((b) => !!b.ticket)).toEqual([true, true, true, true])
  })

  it("owner turns skip the warm-up pace", async () => {
    const { q } = setup({ boot: { windowSeconds: 300, startsPerInterval: 1, intervalSeconds: 30 } })
    ask(q, "a")
    await tick(); await tick()
    const v = ask(q, "v", { channel: "voice" })
    const n = ask(q, "n")
    await tick(); await tick()
    expect(v.ticket).toBeTruthy()
    expect(n.ticket).toBeUndefined()
  })

  it("observe mode starts everything and logs what it would hold", async () => {
    const { q, logs } = setup({ mode: "observe", maxSessions: 1, ownerExtraSessions: 0 })
    const a = ask(q, "a"), b = ask(q, "b")
    await tick(); await tick()
    expect(!!a.ticket && !!b.ticket).toBe(true)
    expect(logs.some((l) => /observe: would hold b/.test(l))).toBe(true)
  })

  it("off: starts everything and still lists what runs", async () => {
    const { q } = setup({ enabled: false, maxSessions: 1 })
    const a = await q.admit({ agentId: "a", channel: "api" })
    const b = await q.admit({ agentId: "b", channel: "api" })
    expect(a.ok && b.ok).toBe(true)
    expect(q.snapshot().running).toHaveLength(2)
  })

  it("a caller that leaves is dropped from the queue", async () => {
    const { q } = setup({ maxSessions: 1, ownerExtraSessions: 0 })
    ask(q, "a")
    await tick(); await tick()
    const ac = new AbortController()
    const p = q.admit({ agentId: "b", channel: "api", signal: ac.signal })
    await tick()
    expect(q.snapshot().waiting).toHaveLength(1)
    ac.abort()
    expect((await p).ok).toBe(false)
    expect(q.snapshot().waiting).toHaveLength(0)
  })

  it("on close, a kept chat message is never answered; other waiting runs are told", async () => {
    const { q } = setup({ maxSessions: 1, ownerExtraSessions: 0 })
    const a = ask(q, "a")
    await tick(); await tick()
    const chat = ask(q, "chat", { keepOnClose: true })
    let cron: any
    void q.admit({ agentId: "cron", channel: "cron" }).then((o) => { cron = o })
    await tick(); await tick()
    expect(q.close()).toEqual({ kept: 1, refused: 1 })
    await tick()
    expect(cron).toMatchObject({ ok: false, reason: "closed" })
    a.ticket!.release()
    await tick(); await tick()
    expect(chat.ticket).toBeUndefined()
    expect(q.snapshot().waiting).toHaveLength(0)
  })

  it("release is idempotent", async () => {
    const { q } = setup({ maxSessions: 2 })
    const a = await q.admit({ agentId: "a", channel: "api" })
    await q.admit({ agentId: "b", channel: "api" })
    if (!a.ok) throw new Error("not admitted")
    a.ticket.release(); a.ticket.release()
    expect(q.snapshot().running).toHaveLength(1)
  })
})

describe("review fixes (#1526)", () => {
  it("a busy agent holds only its own run, and the slot is taken at admission", async () => {
    const { q } = setup()
    let slots = 1
    const busy = { canStart: () => slots > 0, onStart: () => { slots-- } }
    const first = ask(q, "a", busy)
    await tick(); await tick()
    expect(first.ticket).toBeTruthy()
    expect(slots).toBe(0)
    const second = ask(q, "a", busy), other = ask(q, "b")
    await tick(); await tick()
    expect(second.ticket).toBeUndefined()
    expect(other.ticket).toBeTruthy()
    expect(q.snapshot().waiting[0].blockedBy).toEqual(["agent busy"])
    slots = 1; first.ticket!.release()
    await tick(); await tick()
    expect(second.ticket).toBeTruthy()
  })

  it("a later owner message to the same agent goes before a waiting cron", async () => {
    const { q } = setup({ maxSessions: 1, ownerExtraSessions: 0 })
    const hold = ask(q, "other")
    await tick(); await tick()
    const cron = ask(q, "a", { channel: "cron" })
    const owner = ask(q, "a", { channel: "telegram", owner: true })
    await tick(); await tick()
    expect(q.snapshot().waiting.map((w) => w.priority)).toEqual(["owner", "background"])
    hold.ticket!.release()
    await tick(); await tick()
    expect(owner.ticket).toBeTruthy()
    expect(cron.ticket).toBeUndefined()
  })

  it("a delegated helper may go past a full cap, so parents waiting on it do not deadlock", async () => {
    const { q } = setup({ maxSessions: 2, delegationHeadroom: 2 })
    ask(q, "p1"); ask(q, "p2")
    await tick(); await tick()
    const plain = ask(q, "n")
    const helper = ask(q, "h", { channel: "a2a", delegated: true })
    await tick(); await tick()
    expect(plain.ticket).toBeUndefined()
    expect(helper.ticket).toBeTruthy()
  })

  it("refuses a run that waited past maxWaitMinutes", async () => {
    const { q, advance } = setup({ maxSessions: 1, ownerExtraSessions: 0, maxWaitMinutes: 1 })
    ask(q, "a")
    await tick(); await tick()
    let out: any
    void q.admit({ agentId: "b", channel: "api" }).then((o) => { out = o })
    await tick(); await tick()
    advance(61_000)
    await q.pump()
    expect(out).toMatchObject({ ok: false, reason: "timeout" })
    expect(out.blockedBy.join()).toMatch(/session cap/)
  })
})

describe("gate reasons", () => {
  it("names every limit that is crossed", () => {
    const r = gateReasons({ ...roomy, memAvailableMB: 300, swapUsedMB: 7000, diskFreeMB: 1000, load1: 30 }, DEFAULT_ADMISSION_SETTINGS)
    expect(r.map((x) => x.split(":")[0])).toEqual(["memory", "swap", "disk", "load"])
    // 10% of 8 GB beats the 512 MB floor; swap limit is 3/4 of the memory; load 2 × 8 CPUs.
    expect(r.join("\n")).toMatch(/needs 819 MB[\s\S]*limit 6144 MB[\s\S]*limit 16/)
  })

  it("skips swap when the node has none, and disk when unreadable", () => {
    expect(gateReasons({ ...roomy, swapTotalMB: 0, swapUsedMB: 0, diskFreeMB: null }, DEFAULT_ADMISSION_SETTINGS)).toEqual([])
  })

  it("defaults the cap to one session per GB above the first 2 GB", () => {
    const { q } = setup()
    return q.refresh().then(() => expect(q.snapshot().caps.maxSessions).toBe(6))
  })

  it("on a fixed swap size, holds above half of it", () => {
    const fixed = { ...roomy, swapGrows: false, swapTotalMB: 2048, swapUsedMB: 1100 }
    expect(gateReasons(fixed, DEFAULT_ADMISSION_SETTINGS)).toEqual(["swap: 1100 MB used, limit 1024 MB"])
  })
})

describe("priority", () => {
  it("reads channel, person and agent from settings", () => {
    const s = { ...DEFAULT_ADMISSION_SETTINGS, priority: { ...DEFAULT_ADMISSION_SETTINGS.priority, ownerPeople: ["sam"], criticalAgents: ["ops"] } }
    expect(priorityOf({ agentId: "x", channel: "voice" }, s)).toBe("owner")
    expect(priorityOf({ agentId: "x", channel: "telegram", person: "sam" }, s)).toBe("owner")
    expect(priorityOf({ agentId: "ops", channel: "telegram" }, s)).toBe("critical")
    expect(priorityOf({ agentId: "x", channel: "cron" }, s)).toBe("background")
    expect(priorityOf({ agentId: "x", channel: "telegram" }, s)).toBe("normal")
    expect(priorityOf({ agentId: "x", channel: "cron", priority: "critical" }, s)).toBe("critical")
  })
})

describe("resource parsers", () => {
  it("reads available memory from vm_stat", () => {
    const out = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               10000.",
      "Pages active:                             90000.",
      "Pages inactive:                           20000.",
      "Pages speculative:                         2000.",
      "Pages purgeable:                           4000.",
    ].join("\n")
    expect(parseVmStat(out)).toBe(Math.round((36000 * 16384) / 1048576))
    expect(parseVmStat("")).toBeNull()
  })

  it("reads swap from sysctl vm.swapusage", () => {
    expect(parseSwapUsage("total = 3072.00M  used = 2250.25M  free = 821.75M  (encrypted)")).toEqual({ totalMB: 3072, usedMB: 2250 })
    expect(parseSwapUsage("total = 2.00G  used = 1.50G  free = 0.50G")).toEqual({ totalMB: 2048, usedMB: 1536 })
    expect(parseSwapUsage("")).toBeNull()
  })

  it("reads /proc/meminfo", () => {
    const out = "MemTotal: 8000000 kB\nMemAvailable: 2048000 kB\nSwapTotal: 1048576 kB\nSwapFree: 524288 kB\n"
    expect(parseMeminfo(out)).toEqual({ availableMB: 2000, swapTotalMB: 1024, swapUsedMB: 512 })
  })
})

describe("agentx queue output", () => {
  it("shows resources, gate, running, waiting and next", async () => {
    const { q, advance } = setup({ maxSessions: 1, ownerExtraSessions: 0 }, { swapUsedMB: 7000 })
    ask(q, "a")
    await tick(); await tick()
    ask(q, "b", { chatId: "42" })
    await tick(); await tick()
    advance(5000)
    const text = formatQueue(q.snapshot(), 1_005_000)
    expect(text).toMatch(/Gate: closed — swap: 7000 MB used/)
    expect(text).toMatch(/Running \(1\)\n {2}a {2}normal {2}telegram/)
    expect(text).toMatch(/1\. b {2}normal {2}telegram:42 {2}waiting 5s/)
    expect(text).toMatch(/Next: b \(normal, telegram:42\)/)
  })
})
