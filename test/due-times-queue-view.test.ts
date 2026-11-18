import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { JobStore } from "../src/jobs/store"
import { openPromise } from "../src/requests/promise"
import { queueLines } from "../src/requests/due-report"
import { JOBS_HUB_PATH, jobsHubReply } from "../src/jobs/hub-api"
import { jlQueueHtml, jobLedgerPageHtml } from "../src/daemon/ui/pages/wall-jobledger"

// The queue and its computed times on the dashboard's Jobs page (#1909):
// one line per agent.

const NOW = Date.UTC(2030, 0, 14, 8, 0, 0)
const MIN = 60_000

let tmp: string
let db: Database.Database
let store: RequestStore

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-queue-view-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  new JobStore(db)
})
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }) })

function work(agentId: string, minutes: number, i: number) {
  const r = openPromise(store, { agentId, owedTo: "owner", text: `job ${i}`, channel: "telegram", chatId: `c${i}`, now: NOW - (10 - i) * MIN, wake: false })
  store.setWork(r.id, { estimateMinutes: minutes })
}

const opts = { capacity: 4, lanes: () => 1, defaultMinutes: 30, factorDays: 30, factorMinRows: 3 }

describe("the queue, one line per agent", () => {
  it("counts each agent's open jobs, their minutes, when the next ends and when it is clear", () => {
    work("writer", 60, 1)
    work("writer", 30, 2)
    work("coder", 20, 3)
    expect(queueLines(db, { ...opts, now: NOW })).toEqual([
      { agentId: "writer", jobs: 2, minutes: 90, nextEndAt: NOW + 60 * MIN, clearsAt: NOW + 90 * MIN, factor: 1 },
      { agentId: "coder", jobs: 1, minutes: 20, nextEndAt: NOW + 20 * MIN, clearsAt: NOW + 20 * MIN, factor: 1 },
    ])
  })

  it("comes with the Hub's list only while due times are not off", () => {
    work("writer", 60, 1)
    expect((jobsHubReply(db, JOBS_HUB_PATH, new URLSearchParams(), NOW).body as any).queue).toBeUndefined()
    const on = jobsHubReply(db, JOBS_HUB_PATH, new URLSearchParams(), NOW, opts).body as any
    expect(on.queue).toHaveLength(1)
    expect(on.queue[0]).toMatchObject({ agentId: "writer", jobs: 1 })
  })

  it("shows as a block on the Jobs page", () => {
    const html = jlQueueHtml([{ agentId: "writer", jobs: 2, minutes: 90, nextEndAt: NOW + 60 * MIN, clearsAt: NOW + 90 * MIN, factor: 1.5 }], false, NOW)
    // Spans are written like the status lines: 90 minutes reads "2 h".
    expect(html).toContain("@writer</b> · 2 jobs, 2 h of work · next ends")
    expect(html).toContain("in 60 min</time> · clear")
    expect(html).toContain("correction ×1.5")
    expect(jlQueueHtml([], false, NOW)).toBe("")
    const page = jobLedgerPageHtml({
      list: [], counts: {}, total: 0, state: "open", door: "", open: "", detail: null, detailErr: "", missed: [], error: "", multi: false, now: NOW,
      queue: [{ agentId: "writer", jobs: 1, minutes: 20, nextEndAt: NOW + 20 * MIN, clearsAt: NOW + 20 * MIN, factor: 1 }],
    })
    expect(page).toContain('class="wjl__queue"')
    expect(page).not.toContain("correction ×")
  })
})
