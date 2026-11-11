import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { AdmissionQueue, DEFAULT_ADMISSION_SETTINGS, type AdmissionSettings } from "../src/admission/queue"
import { ResourceSampler, type ResourceSample } from "../src/native/resources"
import { planHoldText, plainWaitReason, utcClock, waitNoticeText, waitRefusalText } from "../src/admission/wait-notice"
import { InflightLog, MessageRouter } from "../src/channels/router"
import { GitLabAdapter } from "../src/channels/gitlab"
import type { IncomingMessage } from "../src/channels/types"

// A chat message that waits in the node queue gets one written line after
// admission.waitNotice.afterSeconds, so the person who asked sees it
// arrived. On GitLab that line is a top-level note anyone on the project
// can read, so it must carry no numbers, host names or client detail.

const roomy: ResourceSample = {
  at: 0, memTotalMB: 8192, memAvailableMB: 4000, swapTotalMB: 2048, swapUsedMB: 100, swapGrows: true,
  diskFreeMB: 50_000, load1: 2, cpuCount: 8,
}

function setup(over: Partial<AdmissionSettings> = {}, sample: Partial<ResourceSample> = {}) {
  let now = 1_000_000
  const res: { current: ResourceSample } = { current: { ...roomy, ...sample } }
  const settings: AdmissionSettings = {
    ...DEFAULT_ADMISSION_SETTINGS,
    allowOneWhenIdle: false,
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

/** Machine detail that must never reach a thread: digits, sizes, hosts. */
function expectPlain(text: string) {
  expect(text).not.toMatch(/\d/)
  expect(text).not.toMatch(/\bMB\b|\bGB\b|localhost|\.local\b|\.tn\b|\bhost\b/i)
}

const DISK = "disk: 3931 MB free, needs 2048 MB"

describe("queue: long-wait notice", () => {
  it("is not called for a run admitted before the time", async () => {
    const { q, res, advance } = setup({}, { diskFreeMB: 100 })
    const notify = vi.fn()
    let started = false
    void q.admit({ agentId: "a", channel: "gitlab", longWait: { afterMs: 120_000, notify } }).then((o) => { started = o.ok })
    await tick(); await tick()
    advance(119_000); await q.pump()
    res.current = { ...roomy }
    await q.pump()
    expect(started).toBe(true)
    advance(10_000); await q.pump()
    expect(notify).not.toHaveBeenCalled()
  })

  it("is called once, with the reasons, once the run has waited the time", async () => {
    const { q, advance } = setup({}, { diskFreeMB: 100 })
    const notify = vi.fn()
    void q.admit({ agentId: "a", channel: "gitlab", longWait: { afterMs: 120_000, notify } })
    await tick(); await tick()
    advance(120_000); await q.pump()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0].blockedBy.join()).toMatch(/^disk:/)
    for (let i = 0; i < 10; i++) { advance(5_000); await q.pump() }
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it("covers a run held only by its own busy agent", async () => {
    const { q, advance } = setup()
    const notify = vi.fn()
    void q.admit({ agentId: "a", channel: "gitlab", canStart: () => false, longWait: { afterMs: 120_000, notify } })
    await tick(); await tick()
    advance(121_000); await q.pump()
    expect(notify.mock.calls[0][0].blockedBy).toEqual(["agent busy"])
  })

  it("a throwing callback is logged once and the run still starts later", async () => {
    const { q, res, logs, advance } = setup({}, { diskFreeMB: 100 })
    const notify = vi.fn(() => { throw new Error("gitlab down") })
    let started = false
    void q.admit({ agentId: "a", channel: "gitlab", longWait: { afterMs: 120_000, notify } }).then((o) => { started = o.ok })
    await tick(); await tick()
    advance(120_000); await q.pump()
    advance(5_000); await q.pump()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(logs.filter((l) => l.includes("long-wait notice failed"))).toHaveLength(1)
    res.current = { ...roomy }
    await q.pump()
    expect(started).toBe(true)
  })

  it("is never called in observe mode", async () => {
    const { q, advance } = setup({ mode: "observe" }, { diskFreeMB: 100 })
    const notify = vi.fn()
    void q.admit({ agentId: "a", channel: "gitlab", longWait: { afterMs: 120_000, notify } })
    await tick(); await tick()
    advance(200_000); await q.pump()
    expect(notify).not.toHaveBeenCalled()
  })
})

describe("wait-notice texts", () => {
  const table: Array<[string, RegExp]> = [
    [DISK, /free disk space/],
    ["memory: 300 MB available, needs 819 MB", /free memory/],
    ["swap: 4610 MB used, limit 3072 MB", /free memory/],
    ["load: 22, limit 16", /very busy/],
    ["session cap: 6/6 running", /other work is ahead/],
    ["start pace: next start in 8s", /other work is ahead/],
    ["behind earlier work", /other work is ahead/],
    ["class browser: 1/1 running", /other work is ahead/],
    ["agent busy", /working on another request/],
  ]
  for (const [reason, word] of table) {
    it(`"${reason.split(":")[0]}" reads as plain words, with no numbers`, () => {
      expect(plainWaitReason([reason])).toMatch(word)
      expectPlain(waitNoticeText([reason]))
      expectPlain(waitRefusalText([reason]))
    })
  }

  it("names the machine's own limit before a busy agent", () => {
    expect(plainWaitReason(["agent busy", DISK])).toMatch(/free disk space/)
  })

  it("the refusal keeps the promise the wait line made", () => {
    expect(waitNoticeText([DISK])).toMatch(/I will say so here/)
    expect(waitNoticeText([DISK])).not.toMatch(/no need to ask again/i)
    expect(waitRefusalText([DISK])).toMatch(/Please send it again/)
  })

  it("the plan-limit line asks for the message again after a UTC time, never 'no need to ask'", () => {
    const at = Date.UTC(2026, 10, 12, 14, 29, 10)
    expect(utcClock(at)).toBe("14:30 UTC")
    expect(planHoldText(at)).toMatch(/send it again after 14:30 UTC\.$/)
    expect(planHoldText(at)).not.toMatch(/no need to ask/i)
    expect(planHoldText()).toMatch(/send it again later\.$/)
    expectPlain(planHoldText())
  })
})

// --- Router: from the GitLab note to the posted line ---

const PROJECT = "acme/widgets"
const CHAT = `${PROJECT}:issue:4`

function fakeRegistry(execute: (task: any) => Promise<any>) {
  return {
    getAgent: (id: string) => (id === "coder-agent" ? { id, name: "Coder", mentions: ["@coder_bot"], tier: "claude-code" } : undefined),
    refusalFor: () => null,
    getSessionStore: () => undefined,
    execute: vi.fn(execute),
  } as any
}

describe("router: wait line on GitLab", () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "agentx-wait-notice-")) })
  afterEach(() => { vi.unstubAllGlobals(); rmSync(tmp, { recursive: true, force: true }) })

  function router(registry: any): MessageRouter {
    const r = new MessageRouter(registry, { channels: { telegram: { accounts: {} } } } as any, undefined, () => {})
    ;(r as any).inflight = new InflightLog(tmp)
    return r
  }

  it("a note that waits gets one top-level note in plain words, from handleNote to the GitLab API", async () => {
    const posted: Array<{ url: string; body: string }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      if (init?.method === "POST" && /\/notes$/.test(String(url))) posted.push({ url: String(url), body: JSON.parse(init.body).body })
      return { ok: true, status: 201, json: async () => ({ id: 77 }), text: async () => "{}" }
    }))
    const gl = new GitLabAdapter({
      webhookPort: 0, host: "https://gitlab.example.test", token: "global", routes: [],
      agentMappings: [{ agentId: "coder-agent", gitlabUsernames: ["coder_bot"], keywords: [] }],
    } as any, () => {})
    ;(gl as any).usernameToAgent.set("coder_bot", "coder-agent")

    let finish!: () => void
    const registry = fakeRegistry(async (task) => {
      task.onHeld?.({ waitedMs: 120_000, blockedBy: [DISK] })
      task.onHeld?.({ waitedMs: 125_000, blockedBy: [DISK] })
      await new Promise<void>((r) => { finish = r })
      return { content: "Here is the answer." }
    })
    router(registry).addChannel(gl)

    await (gl as any).handleNote({
      object_kind: "note",
      object_attributes: { id: 501, note: "@coder_bot please look", noteable_type: "Issue" },
      project: { path_with_namespace: PROJECT },
      user: { username: "sam", name: "Sam Example" },
      issue: { iid: 4, title: "Export" },
    }, { writeHead: vi.fn(), end: vi.fn() })
    for (let i = 0; i < 20 && !posted.length; i++) await tick()

    expect(registry.execute).toHaveBeenCalledTimes(1)
    expect(registry.execute.mock.calls[0][0].onHeld).toBeTypeOf("function")
    expect(posted).toHaveLength(1)
    expect(posted[0].url).toContain("/issues/4/notes")
    expect(posted[0].body).toContain("free disk space")
    expectPlain(posted[0].body.split("\n")[0])
    expect(posted[0].body).not.toContain("3931")

    finish()
    for (let i = 0; i < 20 && posted.length < 2; i++) await tick()
    expect(posted.map((p) => p.body).filter((b) => b.includes("have not started yet"))).toHaveLength(1)
  })

  it("two restarts while the message waits post one line only", async () => {
    const msg: IncomingMessage = {
      id: "601", channel: "gitlab", accountId: "default",
      sender: { id: "u1", name: "Sam Example", isBot: false },
      text: "@coder_bot please look", group: { id: CHAT, name: "widgets" },
      resolvedAgent: "coder-agent",
    } as any
    const adapter = () => ({ name: "gitlab", send: vi.fn(async () => "n1"), react: vi.fn(), sendTyping: vi.fn(), onMessage: vi.fn() })
    // Held every time, never started: the daemon stops before it runs.
    const held = () => fakeRegistry(async (task) => {
      task.onHeld?.({ waitedMs: 120_000, blockedBy: [DISK] })
      return new Promise(() => {})
    })
    const waitLines = (a: any) => a.send.mock.calls.filter(([m]: any[]) => String(m.text).includes("have not started yet"))

    const first = adapter()
    const r1 = router(held()); r1.addChannel(first as any)
    void r1.handleMessage(first as any, msg)
    for (let i = 0; i < 20 && !waitLines(first).length; i++) await tick()
    expect(waitLines(first)).toHaveLength(1)

    for (const _restart of [1, 2]) {
      const a = adapter()
      const reg = held()
      const r = router(reg); r.addChannel(a as any)
      await (r as any).replayInflight()
      for (let i = 0; i < 20 && !reg.execute.mock.calls.length; i++) await tick()
      expect(reg.execute).toHaveBeenCalledTimes(1)
      expect(waitLines(a)).toHaveLength(0)
    }
  })

  function directMsg(id: string): IncomingMessage {
    return {
      id, channel: "gitlab", accountId: "default",
      sender: { id: "u1", name: "Sam Example", isBot: false },
      text: "@coder_bot please look", group: { id: CHAT, name: "widgets" },
    } as any
  }

  it("a plan-limit hold posts the plain line once per thread, until a run answers", async () => {
    const at = Date.now() + 45 * 60_000
    let answer: any = { content: "", error: "Claude plan limit reached: ... run: agentx usage plan --lift", errorKind: "dispatch_hold", retryAt: at }
    const r = router(fakeRegistry(async () => answer))
    const a = { name: "gitlab", send: vi.fn(async () => "n1"), react: vi.fn(), sendTyping: vi.fn() }
    await (r as any).processResolvedMessage(a, directMsg("701"), "coder-agent", CHAT)
    await (r as any).processResolvedMessage(a, directMsg("702"), "coder-agent", CHAT)
    expect(a.send).toHaveBeenCalledTimes(1)
    const text = a.send.mock.calls[0][0].text as string
    expect(text).toBe(planHoldText(at))
    expect(text).not.toContain("agentx usage")
    expect(text).not.toMatch(/^Error:/)

    // A run on the thread answers: the next hold says it again.
    answer = { content: "ok" }
    await (r as any).processResolvedMessage(a, directMsg("703"), "coder-agent", CHAT)
    answer = { content: "", error: "held", errorKind: "dispatch_hold", retryAt: at }
    await (r as any).processResolvedMessage(a, directMsg("704"), "coder-agent", CHAT)
    expect(a.send.mock.calls.filter(([m]: any[]) => String(m.text).includes("plan limit"))).toHaveLength(2)
  })

  it("the refusal after the long wait is posted as plain words, not as an Error", async () => {
    const r = router(fakeRegistry(async () => ({ content: "", error: waitRefusalText([DISK]), errorKind: "no_room" })))
    const a = { name: "gitlab", send: vi.fn(async () => "n1"), react: vi.fn(), sendTyping: vi.fn() }
    await (r as any).processResolvedMessage(a, directMsg("801"), "coder-agent", CHAT)
    expect(a.send).toHaveBeenCalledTimes(1)
    expect(a.send.mock.calls[0][0].text).toBe(waitRefusalText([DISK]))
    expectPlain(a.send.mock.calls[0][0].text)
  })

  it("channels outside admission.waitNotice keep the old path and get no onHeld", async () => {
    const reg = fakeRegistry(async () => ({ content: "", error: "Claude plan limit reached", errorKind: "dispatch_hold" }))
    const r = router(reg)
    const a = { name: "telegram", send: vi.fn(async () => "n1"), react: vi.fn(), sendTyping: vi.fn() }
    await (r as any).processResolvedMessage(a, { ...directMsg("901"), channel: "telegram" }, "coder-agent", CHAT)
    expect(reg.execute.mock.calls[0][0].onHeld).toBeUndefined()
    expect(a.send.mock.calls[0][0].text).toMatch(/^Error: Claude plan limit reached/)
  })
})
