import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { windDownBuilders } from "../src/agents/signals/builders"
import { meshStopAllReport, StopAllOrderStore, StopAllReporter } from "../src/agents/signals/orders"
import { DEFAULT_SIGNAL_SETTINGS, type SignalSender } from "../src/agents/signals/policy"
import { SignalService, stopAllReport, type RunningRef } from "../src/agents/signals/service"
import { StoppedTaskStore } from "../src/agents/signals/store"
import { handleSignalsHttp, type SignalsReply } from "../src/daemon/signals-api"

// The stop-all drill (#1328, epic #1271 step 7) on a test pair: two nodes,
// "mac" and "server", wired through the real HTTP handlers. Three tasks
// (two on mac, one on server) and one background builder (on server, with
// unsaved changes in its clone). The owner gives `stop --all --mesh` on
// mac, both nodes restart, every task resumes from its plan (the builder's
// from its WIP branch), and the owner gets exactly one report for both.

let tmp: string
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "agentx-drill-")) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "pipe" }).toString()

function builderClone(): string {
  const dir = path.join(tmp, "clone")
  mkdirSync(dir)
  git(dir, "init", "-q", "-b", "main")
  writeFileSync(path.join(dir, "app.ts"), "v1")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  git(dir, "checkout", "-qb", "feature/report")
  writeFileSync(path.join(dir, "app.ts"), "v2, half done")
  return dir
}

const task = (id: string, agentId: string, over: Partial<RunningRef> = {}): RunningRef => ({
  taskId: id, traceId: `trace-${id}`, agentId, channel: "telegram", chatId: id, rootId: `root-${id}`,
  originalMessage: `Request ${id}`, origin: { kind: "router", adapter: "telegram", message: { id: `m-${id}` } },
  ...over,
})

type Peers = Record<string, Node>

/** One daemon of the pair: its folders survive a restart, nothing else. */
class Node {
  running: RunningRef[]
  service!: SignalService
  reporter!: StopAllReporter
  resumed: Array<{ id: string; note: string }> = []
  told: string[] = []

  constructor(public name: string, private dir: string, running: RunningRef[], private calls: Record<string, any[]>, private mesh: Peers, private peerOf: string) {
    this.running = running
    this.boot()
  }

  /** A fresh process on the same folders. */
  boot(): void {
    this.service = new SignalService({
      settings: () => ({ ...DEFAULT_SIGNAL_SETTINGS, allowPeers: [this.peerOf] }),
      store: new StoppedTaskStore(path.join(this.dir, "stopped")),
      findRunning: (by) => this.running.find((r) => r.taskId === by.taskId) ?? null,
      listRunning: () => [...this.running],
      stopRun: (id) => { this.running = this.running.filter((r) => r.taskId !== id); return true },
      whenRunEnds: async () => {},
      toolCalls: (traceId) => this.calls[traceId ?? ""] ?? [],
      windDownBuilders: (input) => windDownBuilders(input),
      windDown: async ({ agentId, message }) => ({
        content: `Done: part.\nLeft: the rest for ${agentId}.\nNext action: ${/agentx\/wip\/\S+/.exec(message)?.[0] ?? "carry on"}.\nHalf-applied: nothing`,
      }),
      resume: async ({ record, note }) => { this.resumed.push({ id: record.id, note }) },
      publish: () => {},
      log: () => {},
    })
    this.reporter = new StopAllReporter({
      store: new StopAllOrderStore(path.join(this.dir, "orders")),
      selfNode: this.name,
      sendPart: async (coordinator, body) => {
        const reply = await this.mesh[coordinator].http("POST", "/api/signals/stop-all/report", { ...body, via: { node: this.name } }, { kind: "peer", peer: this.name })
        if (reply.status >= 400) throw new Error(String(reply.body.error))
      },
      tellOwner: async (text) => { this.told.push(text) },
      ownReport: (outcomes) => stopAllReport(this.name, outcomes),
      log: () => {},
      retryMs: 1,
      waitMs: 50,
    })
  }

  http(method: string, p: string, body: Record<string, unknown>, sender: SignalSender): Promise<SignalsReply> {
    return handleSignalsHttp(method, p, new URLSearchParams(), body, {
      service: this.service,
      selfNode: this.name,
      sender,
      peers: () => Object.keys(this.mesh).filter((n) => n !== this.name),
      forward: async (node, m, target, fwd) => {
        const peer = this.mesh[node]
        return peer ? peer.http(m, target, fwd ?? {}, { kind: "peer", peer: this.name }) : null
      },
      reporter: this.reporter,
    })
  }

  async restart(): Promise<{ retries: Promise<void>[] }> {
    this.reporter.close()
    this.boot()
    this.service.recover()
    return this.reporter.afterBoot(await this.service.resumeStopAll())
  }
}

function pair() {
  const clone = builderClone()
  const mesh: Peers = {}
  const calls = {
    "trace-s1": [
      { action: "Agent", inputSummary: JSON.stringify({ description: "Build the weekly report page", prompt: "…", run_in_background: true }) },
      { action: "Bash", inputSummary: JSON.stringify({ command: `cd ${clone} && pnpm test` }) },
    ],
  }
  mesh.mac = new Node("mac", path.join(tmp, "mac"), [task("m1", "coder"), task("m2", "writer")], calls, mesh, "server")
  mesh.server = new Node("server", path.join(tmp, "server"), [task("s1", "builder-lead")], calls, mesh, "mac")
  return { mac: mesh.mac, server: mesh.server, clone }
}

describe("stop-all drill on a test pair", () => {
  it("stops 3 tasks and 1 builder, restarts both, resumes everything, and sends one report", async () => {
    const { mac, server, clone } = pair()

    // 1. The owner's order on mac, for the whole mesh, waiting for the plans.
    const order = await mac.http("POST", "/api/signals/stop-all", { mesh: true, wait: true, reason: "drill" }, { kind: "owner" })
    expect(order.status).toBe(200)
    expect(order.body.safeToRestart).toBe(true)
    const orderId = order.body.orderId as string
    const peer = (order.body.peers as any[])[0]
    expect(peer).toMatchObject({ node: "server", ok: true, orderId })
    expect(peer.tasks[0]).toMatchObject({ id: "s1", state: "stopped", plan: "agent", builders: { count: 1, saved: 1 } })
    expect(mac.running).toEqual([])
    expect(server.running).toEqual([])
    // The builder's unsaved change is on its WIP branch; the clone is untouched.
    expect(git(clone, "show", "agentx/wip/s1:app.ts")).toBe("v2, half done")
    expect(git(clone, "branch", "--show-current").trim()).toBe("feature/report")
    expect(git(clone, "status", "--porcelain").trim()).toBe("M app.ts")

    // 2. Both hosts restart; server comes back first.
    const { retries } = await server.restart()
    await Promise.all(retries)
    expect(server.told).toEqual([]) // its part went to mac, not to the owner
    expect(mac.told).toEqual([])    // mac waits for its own pass
    await mac.restart()

    // 3. Every task resumed from its plan, the builder's from its branch.
    expect(mac.resumed.map((r) => r.id).sort()).toEqual(["m1", "m2"])
    expect(server.resumed.map((r) => r.id)).toEqual(["s1"])
    expect(server.resumed[0].note).toMatch(/Next action: agentx\/wip\/s1/)
    expect(server.resumed[0].note).toMatch(/Start each builder again from its saved branch/)

    // 4. One report, for both hosts, every task in it.
    expect(server.told).toEqual([])
    expect(mac.told).toHaveLength(1)
    const report = mac.told[0]
    expect(report.split("\n")[0]).toBe(`After the stop-all ${orderId} on 2 machine(s): 3 resumed, 0 failed, 0 skipped.`)
    expect(report).toMatch(/^mac: 2 resumed/m)
    expect(report).toMatch(/^server: 1 resumed/m)
    expect(report).toContain("- builder-lead s1: resumed (1 builder(s), work saved on agentx/wip/s1)")

    // 5. A later restart neither resumes nor reports anything again.
    await mac.restart()
    await Promise.all((await server.restart()).retries)
    expect(mac.resumed).toHaveLength(2)
    expect(mac.told).toHaveLength(1)
    expect(server.told).toEqual([])
  })

  it("names a host that sent nothing, and sends its part late", async () => {
    const { mac, server } = pair()
    const order = await mac.http("POST", "/api/signals/stop-all", { mesh: true, wait: true }, { kind: "owner" })
    await mac.restart()
    await new Promise((r) => setTimeout(r, 120))
    expect(mac.told).toHaveLength(1)
    expect(mac.told[0]).toMatch(/^server: no report \(nothing within 0 min; it may not have restarted yet/m)
    await Promise.all((await server.restart()).retries)
    expect(mac.told).toHaveLength(2)
    expect(mac.told[1]).toBe(`Late part of the stop-all ${order.body.orderId}:\nserver: 1 resumed, 0 failed, 0 skipped\n- builder-lead s1: resumed (1 builder(s), work saved on agentx/wip/s1)`)
  })

  it("keeps the coordinator's own part when it restarts twice before the peers report", async () => {
    const { mac, server } = pair()
    await mac.http("POST", "/api/signals/stop-all", { mesh: true, wait: true }, { kind: "owner" })
    await mac.restart()
    mac.reporter.close() // the deadline must not fire between the boots
    await mac.restart()
    mac.reporter.close()
    await Promise.all((await server.restart()).retries)
    expect(mac.told).toHaveLength(1)
    expect(mac.told[0]).toMatch(/on 2 machine\(s\): 3 resumed/)
    expect(mac.told[0]).toMatch(/^mac: 2 resumed/m)
  })

  it("tells the owner itself when the coordinator cannot be reached", async () => {
    const { mac, server } = pair()
    await mac.http("POST", "/api/signals/stop-all", { mesh: true, wait: true }, { kind: "owner" })
    // mac is gone for good.
    const real = mac.http.bind(mac)
    mac.http = async () => { throw new Error("connection refused") }
    await Promise.all((await server.restart()).retries)
    expect(server.told).toHaveLength(1)
    expect(server.told[0]).toMatch(/^After the stop-all on server: 1 resumed/)
    expect(server.told[0]).toMatch(/mac could not be reached for the combined report/)
    mac.http = real
  })

  it("reports a host that had nothing running", async () => {
    const { mac, server } = pair()
    server.running = []
    await mac.http("POST", "/api/signals/stop-all", { mesh: true, wait: true }, { kind: "owner" })
    await Promise.all((await server.restart()).retries)
    await mac.restart()
    expect(mac.told).toHaveLength(1)
    expect(mac.told[0]).toMatch(/^server: nothing was running$/m)
  })

  it("keeps a stop-all without --mesh to one report per node", async () => {
    const { mac } = pair()
    await mac.http("POST", "/api/signals/stop-all", { wait: true }, { kind: "owner" })
    await mac.restart()
    expect(mac.told).toHaveLength(1)
    expect(mac.told[0]).toMatch(/^After the stop-all on mac: 2 resumed/)
  })

  it("takes a part only from a peer that took the order", async () => {
    const { mac } = pair()
    const order = await mac.http("POST", "/api/signals/stop-all", { mesh: true, wait: true }, { kind: "owner" })
    const body = { orderId: order.body.orderId, outcomes: [] }
    expect((await mac.http("POST", "/api/signals/stop-all/report", body, { kind: "peer", peer: "laptop" })).status).toBe(403)
    expect((await mac.http("POST", "/api/signals/stop-all/report", body, { kind: "owner" })).status).toBe(403)
    expect((await mac.http("POST", "/api/signals/stop-all/report", { orderId: "stop-all-1", outcomes: [] }, { kind: "peer", peer: "server" })).status).toBe(400)
    expect((await mac.http("POST", "/api/signals/stop-all/report", body, { kind: "peer", peer: "server" })).status).toBe(200)
  })
})

describe("the mesh report", () => {
  it("lists every machine, and how to resume what did not", () => {
    const text = meshStopAllReport({
      orderId: "stop-all-20261025160000",
      nodes: [
        { node: "mac", outcomes: [{ id: "m1", agentId: "coder", decision: "resume-failed", reason: "channel down" }] },
        { node: "server", missing: "not heard from" },
      ],
    })
    expect(text).toBe([
      "After the stop-all stop-all-20261025160000 on 2 machine(s): 0 resumed, 1 failed, 0 skipped.",
      "mac: 0 resumed, 1 failed, 0 skipped",
      "- coder m1: failed (channel down)",
      "server: no report (not heard from)",
      "Resume one by hand with: agentx signal resume <id> (add --peer <machine> for another machine)",
    ].join("\n"))
  })
})
