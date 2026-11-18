import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { JobStore } from "../src/jobs/store"
import { JobMesh, PASS_SIZE, UNKNOWN_GRACE_MS } from "../src/jobs/mesh"
import { handleJobsApi } from "../src/jobs/api"
import { statusLine } from "../src/jobs/status"
import { JobDoors } from "../src/jobs/doors"
import { RequestStore } from "../src/requests/store"
import { jlDetailHtml, type HubJob } from "../src/daemon/ui/pages/wall-jobledger"

const NOW = Date.UTC(2026, 10, 14, 10, 0, 0)
const HOUR = 3_600_000

let tmp: string
let here: Database.Database
let there: Database.Database
let jobs: JobStore
let far: JobStore
let mesh: JobMesh
let down: boolean
let asked: string[]

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-jobmesh-"))
  here = new Database(path.join(tmp, "here.sqlite"))
  there = new Database(path.join(tmp, "there.sqlite"))
  jobs = new JobStore(here)
  far = new JobStore(there)
  down = false
  asked = []
  // The other node answers GET /jobs/<id> from its own ledger.
  mesh = new JobMesh({
    jobs, log: () => {},
    fetchJob: async (peer, id) => {
      asked.push(`${peer}:${id}`)
      if (down) throw new Error("connect ECONNREFUSED")
      const reply = handleJobsApi("GET", `/jobs/${id}`, { store: far, now: NOW })
      return { status: reply.status, body: reply.body }
    },
  })
})

afterEach(() => {
  here.close(); there.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** A hand-off from coder here to devops on clawd, as the doors open it on each side. */
function handOff() {
  const dlg = { id: "dlg-abc-12", caller: "coder", callee: "devops", peer: "clawd", origin: { channel: "telegram", chatId: "c1" } }
  new JobDoors({ jobs, requests: new RequestStore(here), settings: () => ({ enabled: true }), log: () => {}, now: () => NOW })
    .delegationStarted({ ...dlg, request: "deploy the build" })
  const doorsThere = new JobDoors({ jobs: far, requests: new RequestStore(there), settings: () => ({ enabled: true }), log: () => {}, now: () => NOW })
  doorsThere.taskStarted({ agentId: "devops", channel: "a2a", chatId: "a2a:coder:devops:dlg-abc-12", taskId: "r1", messagePreview: "deploy the build", at: "", sender: { name: "agent:coder" } } as any)
  return doorsThere
}

describe("a job handed to another node", () => {
  it("is one row on each side under the same id", () => {
    handOff()
    expect(jobs.get("job-dlg-abc-12")).toMatchObject({ state: "waiting", peer: "clawd", waitingOn: "devops@clawd" })
    expect(far.get("job-dlg-abc-12")).toMatchObject({ state: "working", assignee: "devops", requester: "coder", peer: null })
    expect(jobs.openOnPeers().map((j) => j.id)).toEqual(["job-dlg-abc-12"])
    expect(far.openOnPeers()).toEqual([])
  })

  it("is read from that node with its runs and its children there", async () => {
    const doorsThere = handOff()
    doorsThere.delegationStarted({ id: "dlg-def-34", caller: "devops", callee: "qa", origin: { channel: "a2a", chatId: "a2a:coder:devops:dlg-abc-12" } })
    const remote = await mesh.remoteOf(jobs.get("job-dlg-abc-12")!)
    expect(asked).toEqual(["clawd:job-dlg-abc-12"])
    expect(remote).toMatchObject({ peer: "clawd", job: { id: "job-dlg-abc-12", state: "working", assignee: "devops" } })
    expect(remote!.runs!.map((r) => r.runId)).toEqual(["r1"])
    expect(remote!.children!.map((c) => c.id)).toEqual(["job-dlg-def-34"])
    expect(typeof remote!.job!.status).toBe("string")
  })

  it("says why when that node has no such job, answers badly or is down; a local job has no other node", async () => {
    jobs.open({ id: "job-x", door: "a2a", requester: "coder", assignee: "devops", channel: "a2a", chatId: "x", text: "t", peer: "clawd", state: "waiting", waitingOn: "devops@clawd", now: NOW })
    expect((await mesh.remoteOf(jobs.get("job-x")!))!.error).toMatch(/no such job/)
    down = true
    expect((await mesh.remoteOf(jobs.get("job-x")!))!.error).toMatch(/did not answer \(connect ECONNREFUSED\)/)
    jobs.open({ id: "job-l", door: "cron", requester: "cron:n", assignee: "coder", channel: "cron", chatId: "cron:n", text: "t", now: NOW })
    expect(await mesh.remoteOf(jobs.get("job-l")!)).toBeNull()
  })

  it("each minute its line here quotes its status there, without counting as progress", async () => {
    handOff()
    const before = jobs.get("job-dlg-abc-12")!
    expect(await mesh.refresh()).toBe(1)
    const job = jobs.get("job-dlg-abc-12")!
    expect(job.note).toMatch(/^there: /)
    expect(job.remoteId).toBe("job-dlg-abc-12")
    expect(job.updatedAt).toBe(before.updatedAt)
    expect(job.state).toBe("waiting")
    expect(statusLine(job, {}, NOW)).toMatch(/^waiting on devops@clawd \(there: .+\)$/)
    // That node closed it: the line here says so until the answer is back.
    far.declare("job-dlg-abc-12", { state: "done", proof: "https://x.test/deploy/1" }, { now: NOW })
    await mesh.refresh()
    expect(statusLine(jobs.get("job-dlg-abc-12")!, {}, NOW)).toBe("waiting on devops@clawd (there: done: https://x.test/deploy/1)")
    // A node that is down changes nothing.
    down = true
    expect(await mesh.refresh()).toBe(0)
    expect(jobs.get("job-dlg-abc-12")!.note).toBe("there: done: https://x.test/deploy/1")
  })

  it("is marked stalled when that node still has no record of it after the grace time, never sooner or while down", async () => {
    let now = NOW
    const m = new JobMesh({ jobs, log: () => {}, now: () => now, fetchJob: async (_p, id) => {
      if (down) throw new Error("connect ECONNREFUSED")
      const reply = handleJobsApi("GET", `/jobs/${id}`, { store: far, now })
      return { status: reply.status, body: reply.body }
    } })
    jobs.open({ id: "job-lost", door: "a2a", requester: "coder", assignee: "pm", channel: "a2a", chatId: "a2a:coder:pm:lost", text: "t", peer: "clawd", state: "waiting", waitingOn: "pm@clawd", now: NOW })
    now = NOW + UNKNOWN_GRACE_MS - 1
    await m.refresh()
    expect(jobs.get("job-lost")!.state).toBe("waiting")
    now = NOW + UNKNOWN_GRACE_MS + HOUR
    down = true
    await m.refresh()
    expect(jobs.get("job-lost")!.state).toBe("waiting")
    down = false
    await m.refresh()
    expect(jobs.get("job-lost")).toMatchObject({ state: "stalled", note: "clawd has no record of this job 7 h after it was handed there: the hand-off did not start there, or was lost" })
    expect(jobs.stalledUntold().map((j) => j.id)).toEqual(["job-lost"])
    // A job that node knows is never stalled by this, however old.
    handOff()
    await m.refresh()
    expect(jobs.get("job-dlg-abc-12")!.state).toBe("waiting")
  })

  it("is read in turn when there are more than one pass holds, the oldest too, and stalled like any other", async () => {
    let now = NOW
    const m = new JobMesh({ jobs, log: () => {}, now: () => now, fetchJob: async (peer, id) => {
      asked.push(`${peer}:${id}`)
      const reply = handleJobsApi("GET", `/jobs/${id}`, { store: far, now })
      return { status: reply.status, body: reply.body }
    } })
    const total = PASS_SIZE * 2 + 5
    // The oldest is the least recently active: a newest-first window never reaches it.
    for (let i = 0; i < total; i++) {
      jobs.open({ id: `job-${i}`, door: "a2a", requester: "coder", assignee: "pm", channel: "a2a", chatId: `a2a:coder:pm:${i}`, text: "t", peer: "clawd", state: "waiting", waitingOn: "pm@clawd", now: NOW + i })
    }
    far.open({ id: "job-0", door: "a2a", requester: "coder", assignee: "pm", channel: "a2a", chatId: "a2a:coder:pm:0", text: "t", now: NOW })
    expect(await m.refresh()).toBe(1)
    expect(jobs.get("job-0")!.note).toMatch(/^there: /)
    await m.refresh()
    await m.refresh()
    expect(new Set(asked).size).toBe(total)
    expect(asked).toHaveLength(total)
    // The next pass starts again from the first.
    await m.refresh()
    expect(asked[total]).toBe("clawd:job-0")
    // Past the grace time every one that node does not know is stalled, in three passes.
    now = NOW + UNKNOWN_GRACE_MS + HOUR
    for (let i = 0; i < 3; i++) await m.refresh()
    expect(jobs.openOnPeers(500).map((j) => j.id)).toEqual(["job-0"])
    expect(jobs.get(`job-${total - 1}`)!.state).toBe("stalled")
    expect(jobs.get("job-1")!.state).toBe("stalled")
  })

  it("is not stalled when that node keeps no jobs, or runs a version that cannot say", async () => {
    let now = NOW
    let answer: { status: number; body: unknown } = { status: 404, body: null }
    const m = new JobMesh({ jobs, log: () => {}, now: () => now, fetchJob: async () => answer })
    jobs.open({ id: "job-off", door: "a2a", requester: "coder", assignee: "pm", channel: "a2a", chatId: "a2a:coder:pm:off", text: "t", peer: "clawd", state: "waiting", waitingOn: "pm@clawd", now: NOW })
    now = NOW + UNKNOWN_GRACE_MS + HOUR
    // Its ledger is off: the 404 says so.
    answer = handleJobsApi("GET", "/jobs/job-off", { store: far, now, ledgerOff: true })
    expect(answer).toMatchObject({ status: 404, body: { ledger: "off" } })
    await m.refresh()
    expect(jobs.get("job-off")!.state).toBe("waiting")
    const off = (await m.remoteOf(jobs.get("job-off")!))!
    expect(off.unknown).toBeUndefined()
    expect(off.error).toMatch(/keeps no jobs/)
    // An older version: a 404 that does not say.
    for (const body of [null, { error: 'no job "job-off"' }, { error: "Not found" }]) {
      answer = { status: 404, body }
      await m.refresh()
      expect(jobs.get("job-off")!.state).toBe("waiting")
      expect((await m.remoteOf(jobs.get("job-off")!))!.error).toMatch(/older version/)
    }
    // Its ledger is on and it has no such job: stalled.
    answer = handleJobsApi("GET", "/jobs/job-off", { store: far, now })
    expect(answer).toMatchObject({ status: 404, body: { ledger: "on" } })
    await m.refresh()
    expect(jobs.get("job-off")!.state).toBe("stalled")
  })

  it("does not ask a node that is down for each of its jobs in one pass", async () => {
    for (let i = 0; i < 5; i++) jobs.open({ id: `job-d${i}`, door: "a2a", requester: "coder", assignee: "pm", channel: "a2a", chatId: `a2a:coder:pm:d${i}`, text: "t", peer: i === 2 ? "other" : "clawd", state: "waiting", waitingOn: "pm@clawd", now: NOW })
    const m = new JobMesh({ jobs, log: () => {}, fetchJob: async (peer, id) => {
      asked.push(`${peer}:${id}`)
      if (peer === "clawd") throw new Error("connect ECONNREFUSED")
      return { status: 404, body: { ledger: "on" } }
    } })
    await m.refresh()
    expect(asked).toEqual(["clawd:job-d0", "other:job-d2"])
  })

  it("is not read while blocked or stalled here, so the reason is never written over", async () => {
    handOff()
    jobs.declare("job-dlg-abc-12", { state: "blocked", why: "the hand-off failed: peer refused" }, { now: NOW })
    expect(jobs.openOnPeers()).toEqual([])
    expect(await mesh.refresh()).toBe(0)
    expect(jobs.setRemote("job-dlg-abc-12", "job-dlg-abc-12", "there: working")).toBe(false)
    expect(jobs.get("job-dlg-abc-12")).toMatchObject({ state: "blocked", note: "the hand-off failed: peer refused" })
    jobs.markStalled("job-dlg-abc-12", "no answer for 2 hours", NOW + 1)
    expect(jobs.openOnPeers()).toEqual([])
    expect(await mesh.refresh()).toBe(0)
    expect(jobs.get("job-dlg-abc-12")!.note).toBe("no answer for 2 hours")
  })

  describe("once the hand-off's answer is back, it follows that node's end", () => {
    let out: boolean
    let told: Array<{ to: string; id: string; text: string }>
    let m: JobMesh
    const pair = (id: string) => {
      jobs.open({ id, door: "a2a", requester: "coder", assignee: "pm", channel: "a2a", chatId: `a2a:coder:pm:${id}`, text: "t", peer: "clawd", state: "waiting", waitingOn: "pm@clawd", now: NOW })
      far.open({ id, door: "a2a", requester: "coder", assignee: "pm", channel: "a2a", chatId: `a2a:coder:pm:${id}`, text: "t", now: NOW })
    }
    beforeEach(() => {
      out = false
      told = []
      m = new JobMesh({
        jobs, log: () => {}, now: () => NOW, handOffOut: () => out,
        hasAgent: (id) => id === "coder",
        tell: (to, text, job) => { told.push({ to, id: job.id, text }); return true },
        fetchJob: async (_p, id) => {
          const reply = handleJobsApi("GET", `/jobs/${id}`, { store: far, now: NOW })
          return { status: reply.status, body: reply.body }
        },
      })
    })

    it("not while the hand-off is out: its answer closes the job here itself", async () => {
      out = true
      pair("job-done"); pair("job-stalled")
      far.declare("job-done", { state: "done", proof: "https://x.test/deploy/1" }, { now: NOW })
      far.markStalled("job-stalled", "run ended 3 h ago with no state", NOW)
      await m.refresh()
      expect(jobs.get("job-done")!.state).toBe("waiting")
      expect(jobs.get("job-stalled")!.state).toBe("waiting")
    })

    it("done there is done here; dropped there is dropped here; still going there keeps waiting", async () => {
      pair("job-done"); pair("job-dropped"); pair("job-working")
      far.declare("job-done", { state: "done", proof: "https://x.test/deploy/1" }, { now: NOW })
      there.prepare("UPDATE requests SET job_state = 'dropped' WHERE id = 'job-dropped'").run()
      await m.refresh()
      expect(jobs.get("job-done")).toMatchObject({ state: "done", proof: "on clawd: done: https://x.test/deploy/1" })
      expect(jobs.get("job-dropped")).toMatchObject({ state: "dropped", note: "on clawd: dropped" })
      expect(jobs.get("job-working")).toMatchObject({ state: "waiting" })
      expect(jobs.openOnPeers(500).map((j) => j.id)).toEqual(["job-working"])
      expect(told).toEqual([])
    })

    it("blocked there keeps it waiting here, quoting why, and tells the one who asked once", async () => {
      pair("job-blocked")
      far.declare("job-blocked", { state: "blocked", why: "no access to the server" }, { now: NOW })
      await m.refresh()
      await m.refresh()
      expect(jobs.get("job-blocked")).toMatchObject({ state: "waiting", note: "there: blocked: no access to the server" })
      expect(statusLine(jobs.get("job-blocked")!, {}, NOW)).toBe("waiting on pm@clawd (there: blocked: no access to the server)")
      expect(told.map((t) => [t.to, t.id])).toEqual([["coder", "job-blocked"]])
      expect(told[0].text).toContain("blocked on clawd")
      expect(told[0].text).toContain("no access to the server")
      // Done there later: done here.
      far.declare("job-blocked", { state: "done", proof: "https://x.test/fixed" }, { now: NOW })
      await m.refresh()
      expect(jobs.get("job-blocked")).toMatchObject({ state: "done", proof: "on clawd: done: https://x.test/fixed" })
      expect(told).toHaveLength(1)
    })

    it("blocked again after it moved on there is told again", async () => {
      pair("job-b")
      far.declare("job-b", { state: "blocked", why: "no key" }, { now: NOW })
      await m.refresh()
      far.working("job-b", NOW)
      await m.refresh()
      far.declare("job-b", { state: "blocked", why: "no key again" }, { now: NOW })
      await m.refresh()
      expect(told.map((t) => t.id)).toEqual(["job-b", "job-b"])
    })

    it("stalled there is stalled here, still read, and closed by a later done there with no second notice", async () => {
      pair("job-stalled")
      far.markStalled("job-stalled", "run ended 3 h ago with no state", NOW)
      await m.refresh()
      const stalled = jobs.get("job-stalled")!
      expect(stalled).toMatchObject({ state: "stalled", note: "on clawd: stalled, run ended 3 h ago with no state" })
      expect(jobs.stalledUntold().map((j) => j.id)).toEqual(["job-stalled"])
      jobs.markRequesterTold("job-stalled", NOW)
      // Read again, nothing changes while it stays stalled there.
      await m.refresh()
      expect(jobs.get("job-stalled")).toMatchObject({ state: "stalled", stalledAt: stalled.stalledAt, requesterToldAt: NOW })
      expect(jobs.stalledUntold()).toEqual([])
      // Done there: done here.
      far.declare("job-stalled", { state: "done", proof: "https://x.test/late" }, { now: NOW })
      await m.refresh()
      expect(jobs.get("job-stalled")).toMatchObject({ state: "done", proof: "on clawd: done: https://x.test/late" })
      expect(told).toEqual([])
    })

    it("stalled there, then picked up again there: waiting here again", async () => {
      pair("job-s")
      far.markStalled("job-s", "nobody on it", NOW)
      await m.refresh()
      expect(jobs.get("job-s")!.state).toBe("stalled")
      far.working("job-s", NOW)
      await m.refresh()
      expect(jobs.get("job-s")).toMatchObject({ state: "waiting", waitingOn: "pm@clawd" })
      expect(jobs.get("job-s")!.note).toMatch(/^there: /)
      expect(jobs.get("job-s")!.stalledAt).toBeNull()
    })

    it("a job stalled here for another reason is still never read", async () => {
      pair("job-x")
      jobs.markStalled("job-x", "no answer for 2 hours", NOW)
      expect(jobs.openOnPeers(500)).toEqual([])
    })
  })

  it("stops being read once it is closed here", async () => {
    handOff()
    jobs.declare("job-dlg-abc-12", { state: "done", proof: "p" }, { now: NOW })
    expect(jobs.openOnPeers()).toEqual([])
    expect(jobs.setRemote("job-dlg-abc-12", "x", "there: late")).toBe(false)
    expect(await mesh.refresh()).toBe(0)
  })
})

describe("the Jobs page shows the other machine", () => {
  const job = (over: Partial<HubJob>): HubJob => ({
    id: "job-dlg-abc-12", door: "a2a", state: "waiting", status: "waiting on devops@clawd", requester: "coder", assignee: "devops",
    text: "deploy the build", headline: null, home: null, parentId: null, updatedAt: NOW - HOUR, ...over,
  })

  it("with the job as that machine keeps it and what it handed out there, opening on that machine", () => {
    const html = jlDetailHtml({
      job: job({ peer: "clawd" }), runs: [], parent: null, children: [],
      remote: {
        peer: "clawd", err: "",
        detail: { job: job({ state: "working", status: "working, last tool call 40 s ago" }), runs: [], parent: null, children: [job({ id: "job-dlg-def-34", assignee: "qa", text: "test <the> build", status: "stalled, run ended 3 h ago with no state", state: "stalled" })] },
      },
    }, "", "", NOW)
    expect(html).toContain('<p class="k">On clawd</p>')
    expect(html).toContain('data-jlopen="job-dlg-abc-12" data-jlnode="clawd"')
    expect(html).toContain("working, last tool call 40 s ago")
    expect(html).toContain("Handed out there (1)")
    expect(html).toContain('data-jlopen="job-dlg-def-34" data-jlnode="clawd">test &lt;the&gt; build</button>')
    expect(html).toContain('<span class="wjl__st is-stalled">stalled, run ended 3 h ago with no state</span>')
  })

  it("says so when that machine could not be read, and shows nothing for a local job", () => {
    const html = jlDetailHtml({ job: job({ peer: "clawd" }), runs: [], parent: null, children: [], remote: { peer: "<clawd>", detail: null, err: "this Hub does not read that machine" } }, "", "", NOW)
    expect(html).toContain("Not read from &lt;clawd&gt;: this Hub does not read that machine.")
    expect(jlDetailHtml({ job: job({}), runs: [], parent: null, children: [] }, "", "", NOW)).not.toContain("wjl__far")
  })
})
