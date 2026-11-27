import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The whole upgrade run with launchd, the daemon and the network faked:
// checks the wiring from the post-upgrade checks (#2227) to RESULT, exit
// code and last.json. No launchctl, no real daemon.

const h = vi.hoisted(() => ({
  root: "",
  config: {} as any,
  configThrows: null as Error | null,
  healthCalls: 0,
  fetch: (_url: string): Response | Promise<Response> => new Response("", { status: 404 }),
  // Drain (#2360): a busy node with a full queue. While starts are not held
  // a finished run is replaced at once; once held, two finish per check.
  canHold: true,
  held: false,
  running: 0,
  /** Runs that never finish. */
  stuck: false,
  posts: [] as string[],
  /** What each POST sent: its operator key header and minutes. */
  sent: [] as { key?: string; minutes?: number }[],
  /** Runs when the daemon job is reloaded: the old daemon's shutdown. */
  onReload: null as null | (() => void),
  /** Calls to pruneReleases (#2495). */
  pruned: [] as any[],
  linksMoved: 0,
}))

vi.mock("child_process", async (orig) => ({
  ...(await orig<typeof import("child_process")>()),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "0.2.0\n", stderr: "" })),
}))
vi.mock("../src/daemon/config", async (orig) => ({
  ...(await orig<typeof import("../src/daemon/config")>()),
  loadDaemonConfig: () => { if (h.configThrows) throw h.configThrows; return h.config },
}))
vi.mock("../src/daemon/restart", () => ({
  // Ten checks, then the timeout, like the real wait.
  waitForIdle: async (o: { read: () => Promise<number | null> }) => {
    let n: number | null = null
    for (let i = 0; i < 10; i++) {
      n = await o.read()
      if (n === 0) return { outcome: "idle", waitedMs: i * 10_000 }
    }
    return { outcome: "timeout", waitedMs: 100_000, inflight: n }
  },
}))
vi.mock("../src/daemon/restart-host", () => ({
  launchdDomain: () => "gui/501",
  launchdPlistPath: () => join(h.root, "daemon.plist"),
}))
vi.mock("../src/native/macos/launchd", () => ({
  jobPid: () => 100,
  loadedJobsNaming: () => [],
  plistValid: () => true,
  readPlistJson: () => ({ ProgramArguments: ["/usr/bin/node", join(h.root, "old/dist/cli.js"), "daemon", "start"] }),
  reloadJob: async () => { h.onReload?.(); h.onReload = null; return true },
}))
vi.mock("../src/daemon/upgrade-prune", () => ({
  linkDirs: () => [],
  listLinks: () => [],
  moveReleaseLinks: vi.fn(() => { h.linksMoved = (h.linksMoved ?? 0) + 1; return [] }),
  pruneReleases: vi.fn((o: any) => { h.pruned.push(o); return { keep: o.keep, pruned: [{ dir: "/r/agentx-release-old", bytes: 1024 }], keptInUse: [], freedBytes: 1024 } }),
}))
vi.mock("../src/daemon/shutdown", () => ({ writeShutdownRequest: () => {} }))
vi.mock("../src/daemon/upgrade-native", () => ({ ensureNativeModules: () => ({ ok: true, detail: "loads" }) }))
vi.mock("../src/commands/daemon-http", () => {
  return {
    daemonBase: () => "http://daemon.test",
    drainLimitMs: () => 1000,
    readInflight: async () => {
      if (h.held && !h.stuck) h.running = Math.max(0, h.running - 2)
      return h.running
    },
    postJson: async (url: string, body: any, _ms?: number, headers: Record<string, string> = {}) => {
      h.posts.push(url.replace("http://daemon.test", ""))
      h.sent.push({ key: headers["x-agentx-operator"], minutes: body?.minutes })
      if (!h.canHold) return null
      if (url.endsWith("/daemon/upgrade/hold")) { h.held = true; return { by: "agentx daemon upgrade", until: "later", waiting: 40, running: h.running } }
      if (url.endsWith("/hold/release")) { h.held = false; return { waiting: 41 } }
      return null
    },
    readHolding: async () => 0,
    readRunning: async () => [],
    getJson: async (url: string) => {
      if (url.endsWith("/daemon/restart")) return { cwd: h.root, pid: 100, service: { kind: "launchd", label: "tn.test.agentx", domain: "gui/501" }, startHold: h.held ? { waiting: 42 } : null }
      // First /health is the old daemon, later ones the new one.
      return h.healthCalls++ === 0 ? { version: "0.1.0", pid: 100 } : { version: "0.2.0", pid: 200, commit: "abc12345" }
    },
  }
})

const html = () => new Response("<html>" + "x".repeat(4096) + "</html>", { status: 200, headers: { "content-type": "text/html" } })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

async function run(over: { timeoutMin?: number; keepReleases?: number } = {}) {
  vi.resetModules()
  const { runUpgrade } = await import("../src/commands/daemon-upgrade-run")
  const code = await runUpgrade({ dir: join(h.root, "new"), timeoutMin: 1, force: false, bootTimeoutMin: 1, hubWaitMs: 0, ...over })
  const last = JSON.parse(readFileSync(join(h.root, ".agentx/upgrade/last.json"), "utf-8"))
  return { code, last }
}

describe("daemon upgrade run: checks after the upgrade (#2227)", () => {
  beforeEach(() => {
    h.root = mkdtempSync(join(tmpdir(), "upgrade-run-"))
    mkdirSync(join(h.root, "new/dist"), { recursive: true })
    writeFileSync(join(h.root, "new/dist/cli.js"), "")
    writeFileSync(join(h.root, "daemon.plist"), `<plist><string>${join(h.root, "old")}/dist/cli.js</string></plist>`)
    h.configThrows = null
    h.healthCalls = 0
    h.canHold = true
    h.held = false
    h.running = 0
    h.posts = []
    h.config = {
      mesh: { enabled: true, peers: [{ name: "clawd", url: "http://peer.test" }] },
      dashboard: { enabled: true, bind: "::", port: 4202 },
    }
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn(async (url: string) => h.fetch(url)))
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it("ends degraded with exit 1 when the Hub page fails, and keeps the fetch error", async () => {
    h.fetch = (url) => {
      if (url.startsWith("http://peer.test")) return json({ version: "0.2.0", commit: "abc12345" })
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED 127.0.0.1:4202") })
    }
    const { code, last } = await run()
    expect(code).toBe(1)
    expect(last.result).toBe("degraded")
    expect(last.hub[0]).toMatchObject({ name: "Hub page", url: "http://127.0.0.1:4202/", ok: false, detail: "fetch failed: connect ECONNREFUSED 127.0.0.1:4202" })
  })

  it("ends ok with exit 0 when only a peer runs another version", async () => {
    h.fetch = (url) => {
      if (url.startsWith("http://peer.test")) return json({ version: "0.1.0", commit: "bffdedf7" })
      if (url.endsWith("/api/app/conversations")) return json({ error: "unpaired" }, 401)
      return html()
    }
    const { code, last } = await run()
    expect(code).toBe(0)
    expect(last.result).toBe("ok")
    expect(last.peerSkew).toEqual([{ peer: "clawd", url: "http://peer.test", version: "0.1.0", commit: "bffdedf7" }])
    expect(last.reason).toContain("peer clawd runs 0.1.0")
  })

  it("prunes old release folders only after an ok upgrade (#2495)", async () => {
    h.pruned = []
    h.linksMoved = 0
    h.fetch = (url) => {
      if (url.startsWith("http://peer.test")) return json({ version: "0.2.0", commit: "abc12345" })
      if (url.endsWith("/api/app/conversations")) return json({ error: "unpaired" }, 401)
      return html()
    }
    const ok = await run({ keepReleases: 2 })
    expect(ok.last.result).toBe("ok")
    expect(h.pruned).toEqual([{ live: join(h.root, "new"), rollback: join(h.root, "old"), keep: 2 }])
    expect(ok.last.releases.pruned).toEqual([{ dir: "/r/agentx-release-old", bytes: 1024 }])
    expect(h.linksMoved).toBe(1)

    h.pruned = []
    h.linksMoved = 0
    h.healthCalls = 0
    h.fetch = () => { throw new TypeError("fetch failed") }
    const degraded = await run({ keepReleases: 2 })
    expect(degraded.last.result).toBe("degraded")
    expect(h.pruned).toEqual([])
    expect(degraded.last.releases).toBeUndefined()
    expect(h.linksMoved).toBe(0)
  })

  it("keeps every release with --keep-releases 0", async () => {
    h.pruned = []
    h.fetch = (url) => url.endsWith("/api/app/conversations") ? json({}, 401) : url.startsWith("http://peer.test") ? json({ version: "0.2.0", commit: "abc12345" }) : html()
    h.linksMoved = 0
    const { last } = await run({ keepReleases: 0 })
    expect(last.result).toBe("ok")
    expect(h.pruned).toEqual([])
    // The CLI link still follows the live release.
    expect(h.linksMoved).toBe(1)
  })

  it("records the checks as skipped, with the reason, when agentx.json does not load", async () => {
    h.configThrows = new Error("Unexpected token } in JSON")
    const { last } = await run()
    expect(last.checksSkipped).toBe("agentx.json did not load: Unexpected token } in JSON")
    expect(last.reason).toContain("peer and Hub checks skipped")
  })
})

describe("daemon upgrade run: drain the queue instead of waiting for idle (#2360)", () => {
  beforeEach(() => {
    h.root = mkdtempSync(join(tmpdir(), "upgrade-drain-"))
    mkdirSync(join(h.root, "new/dist"), { recursive: true })
    writeFileSync(join(h.root, "new/dist/cli.js"), "")
    writeFileSync(join(h.root, "daemon.plist"), `<plist><string>${join(h.root, "old")}/dist/cli.js</string></plist>`)
    h.configThrows = null
    h.healthCalls = 0
    h.config = {}
    h.canHold = true
    h.held = false
    h.running = 6
    h.stuck = false
    h.onReload = null
    h.posts = []
    h.sent = []
    mkdirSync(join(h.root, ".agentx"), { recursive: true })
    writeFileSync(join(h.root, ".agentx/operator.key"), "op-key-1\n")
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })))
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it("a busy node with a full queue upgrades without --force: starts held, switch at 0 running", async () => {
    const { code, last } = await run()
    expect(code).toBe(0)
    expect(last.result).toBe("ok")
    expect(h.posts).toEqual(["/daemon/upgrade/hold"])
    expect(h.running).toBe(0)
    // The queued runs were kept through the switch, not dropped or reopened on the old daemon.
    expect(last.drain).toMatchObject({ heldAtStart: 40, heldAtEnd: 42 })
    expect(typeof last.drain.idleAfterSeconds).toBe("number")
    expect(last.drain.reopenedAt).toBeUndefined()
  })

  it("reopens starts when the wait runs out and the upgrade is refused", async () => {
    // Runs that never finish: still 6 running at the timeout.
    h.stuck = true
    const { code, last } = await run()
    expect(code).toBe(1)
    expect(last.result).toBe("refused")
    expect(last.reason).toContain("still 6 task(s) running")
    expect(h.posts).toEqual(["/daemon/upgrade/hold", "/daemon/upgrade/hold/release"])
    expect(h.held).toBe(false)
    expect(last.drain).toMatchObject({ heldAtStart: 40, heldAtEnd: 41 })
    expect(last.drain.reopenedAt).toBeTruthy()
    // Both calls show the operator key; loopback alone is refused.
    expect(h.sent.map((x) => x.key)).toEqual(["op-key-1", "op-key-1"])
  })

  it("records what the old daemon's queue kept and refused at the switch", async () => {
    // The old daemon closes its queue on the way down (index.ts stop()).
    h.onReload = () => {
      mkdirSync(join(h.root, ".agentx/upgrade"), { recursive: true })
      writeFileSync(join(h.root, ".agentx/upgrade/queue-at-close.json"), JSON.stringify({ at: new Date().toISOString(), kept: 40, refused: 0 }))
    }
    const { code, last } = await run()
    expect(code).toBe(0)
    expect(last.drain).toMatchObject({ keptAtSwitch: 40, refusedAtSwitch: 0 })
  })

  it("ignores a queue record from an earlier stop", async () => {
    mkdirSync(join(h.root, ".agentx/upgrade"), { recursive: true })
    writeFileSync(join(h.root, ".agentx/upgrade/queue-at-close.json"), JSON.stringify({ at: "2020-01-01T00:00:00.000Z", kept: 9, refused: 9 }))
    const logs = vi.spyOn(console, "log").mockImplementation(() => {})
    const { last } = await run()
    expect(last.drain.refusedAtSwitch).toBeUndefined()
    // A missing record is said, not silent.
    expect(logs.mock.calls.flat().join("\n")).toMatch(/no record of the old daemon's queue at the switch in .*queue-at-close\.json/)
    logs.mockRestore()
  })

  it("asks for at most the 2 hour cap, even with a longer --timeout", async () => {
    h.running = 0
    await run({ timeoutMin: 300 })
    expect(h.sent[0]).toEqual({ key: "op-key-1", minutes: 120 })
  })

  it("waits for idle as before when the daemon cannot hold starts", async () => {
    h.canHold = false
    h.running = 0
    const { code, last } = await run()
    expect(code).toBe(0)
    expect(last.drain).toBeUndefined()
    expect(h.posts).toEqual(["/daemon/upgrade/hold"])
  })
})
