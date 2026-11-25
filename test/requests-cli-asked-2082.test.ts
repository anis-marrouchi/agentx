import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { closeDb, openDb } from "../src/storage/sqlite"
import { requests } from "../src/commands/requests"
import { OWNER_ASKED, OWNER_BY, RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"

// #2082 review: the CLI must not let an agent past the owner's question.

const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
const ID = "req-t1"
let tmp: string
let cwd: string
let store: RequestStore
const agentEnv = process.env.AGENTX_AGENT_ID

beforeEach(() => {
  cwd = process.cwd()
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "agentx-cli-asked-")))
  process.chdir(tmp)
  writeFileSync(path.join(tmp, "agentx.json"), JSON.stringify({ node: { id: "n", name: "n" }, agents: {} }))
  const db = openDb()!
  store = new RequestStore(db)
  new RequestTracker(store, () => settings, () => {}, () => 5_000).taskStarted({
    agentId: "artist", channel: "telegram", chatId: "chat-1", taskId: "t1", messagePreview: "x", fullMessage: "x",
    at: "", humanRoot: true, sender: { id: "4242" },
  } as any)
  db.prepare("UPDATE requests SET state = 'waiting_owner', owner_check = ? WHERE id = ?").run(OWNER_ASKED, ID)
})
afterEach(() => {
  closeDb()
  process.chdir(cwd)
  process.exitCode = undefined
  if (agentEnv === undefined) delete process.env.AGENTX_AGENT_ID
  else process.env.AGENTX_AGENT_ID = agentEnv
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

describe("agentx requests drop while the owner is asked", () => {
  it("refuses the agent's drop and leaves the request waiting on the owner", async () => {
    process.env.AGENTX_AGENT_ID = "artist"
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
    await requests.parseAsync(["drop", ID, "--reason", "no longer needed"], { from: "user" })
    expect(process.exitCode).toBe(1)
    expect(String(err.mock.calls[0]?.[0])).toContain("the owner is asked")
    expect(store.get(ID)).toMatchObject({ state: "waiting_owner", ownerCheck: OWNER_ASKED })
  })

  it("lets the owner's own drop through", async () => {
    delete process.env.AGENTX_AGENT_ID
    vi.spyOn(console, "log").mockImplementation(() => {})
    await requests.parseAsync(["drop", ID, "--reason", "agreed"], { from: "user" })
    expect(process.exitCode).toBeUndefined()
    expect(store.get(ID)).toMatchObject({ state: "dropped", closedBy: OWNER_BY })
  })
})
