import { beforeEach, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { appChangesReply, changesRequestFor } from "../src/daemon/app-changes"
import type { WallDiffDeps } from "../src/daemon/wall-diff"

// #2101 C1b: the phone's Changes screen reads the Hub's Diff view (#2102)
// for the agent in view: its newest open request on a GitHub or GitLab home.

const T0 = 1_700_000_000_000
const DIFF = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3\n"
let store: RequestStore
let deps: WallDiffDeps

const add = (id: string, agentId: string, link: string | null, at: number) => {
  store.addCandidate({ id, runId: `t-${id}`, channel: "telegram", chatId: "chat-A", sender: "anis", agentId, text: `Work ${id}`, now: at })
  store.progress(id, at + 1)
  if (link) store.setHome(id, { kind: "link", link } as any, at + 2)
}

beforeEach(() => {
  store = new RequestStore(new Database(":memory:"))
  add("old", "coder", "https://github.com/acme/shop/pull/12", T0)
  add("new", "coder", "https://github.com/acme/shop/pull/14", T0 + 10_000)
  add("bare", "coder", null, T0 + 20_000)
  add("pm1", "pm", "https://github.com/acme/shop/pull/99", T0 + 30_000)
  deps = {
    store, gitlabUrl: null, cache: new Map(),
    forge: { pull: async (h) => ({ title: `T ${h.key}`, state: "open", headSha: "a".repeat(40) }), linked: async () => [], diff: async () => DIFF },
  }
})

describe("the phone's Changes screen", () => {
  it("takes the agent's newest open request that has a forge home", () => {
    expect(changesRequestFor("coder", store.listOpen(), null)?.id).toBe("new")
    expect(changesRequestFor("pm", store.listOpen(), null)?.id).toBe("pm1")
    expect(changesRequestFor("sales", store.listOpen(), null)).toBeNull()
  })

  it("answers the Hub's diff with the request it read", async () => {
    const r = await appChangesReply({ agent: "coder" }, store.listOpen(), deps)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ request: { id: "new" }, ref: "acme/shop#14", files: [{ file: "src/app.ts" }] })
  })

  it("says there is nothing when the agent has no such request, and refuses a bad agent id", async () => {
    expect((await appChangesReply({ agent: "sales" }, store.listOpen(), deps)).body).toMatchObject({ request: null, ref: null, files: [] })
    expect((await appChangesReply({ agent: "a b" }, store.listOpen(), deps)).status).toBe(400)
    expect((await appChangesReply({ agent: "coder" }, store.listOpen(), null)).body).toMatchObject({ request: null })
  })
})
