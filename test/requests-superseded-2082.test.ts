import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { OWNER_ANSWERED, OWNER_ASKED, OWNER_BY, RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi } from "../src/requests/daemon-api"
import { DEFAULT_OWNER_CHECK, OwnerWordsCheck, mismatchText, ownerCheckPrompt } from "../src/requests/owner-check"
import { runRequestTool } from "../src/requests/tool"

// #2082: a decline as "superseded / no longer needed" was reopened three
// times by the owner-words check, until the agent sent old work to get out.

const SAID = "make a scroll video of the Muqtana preview site"
const NEWER = "https://git.example.test/marrouchi/muqtana/-/issues/108#note_157947"
const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-superseded-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  tracker = new RequestTracker(store, () => settings, () => {}, () => 5_000)
  tracker.taskStarted({
    agentId: "artist", channel: "telegram", chatId: "chat-1", taskId: "t1", messagePreview: SAID, fullMessage: SAID,
    at: "", humanRoot: true, sender: { id: "4242" },
  } as any)
  store.progress(ID, 5_500)
  at = 6_000
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const ID = "req-t1"
let at = 6_000
const api = (body: Record<string, unknown>) =>
  handleRequestsApi("POST", "/requests", { agentId: "artist", ...body }, {
    store, tracker, enabled: true, hasAgent: (id) => id === "artist", now: at,
    runningTurn: (agentId) => (agentId === "artist" ? { channel: "telegram", chatId: "chat-1" } : null),
  }, { taskId: "t1" })

const superseded = () => api({ action: "decline", id: ID, reasonKind: "superseded", link: NEWER, reason: "the v3 hero work replaced it" })

function checker(answer: string) {
  const prompts: string[] = []
  const told: Array<{ title: string; text: string }> = []
  const woken: string[] = []
  const lines: string[] = []
  const c = new OwnerWordsCheck({
    store,
    settings: () => ({ ...DEFAULT_OWNER_CHECK, enabled: true }),
    generate: async (p) => { prompts.push(p); return answer },
    tellOwner: (_r, title, text) => { told.push({ title, text }) },
    wake: (_r, text) => { woken.push(text) },
    log: (l) => lines.push(l),
    now: () => at + 1_000,
  })
  return { c, prompts, told, woken, lines }
}

describe("a decline as superseded carries its link", () => {
  it("is kept like a done's proof, with its kind", () => {
    expect(superseded().status).toBe(200)
    expect(store.get(ID)).toMatchObject({
      state: "declined", closeKind: "superseded", closeReason: "the v3 hero work replaced it",
      proof: { kind: "link", value: NEWER }, closedBy: "artist", ownerCheck: "pending",
    })
  })

  it("refuses a superseded decline without a link, and a link without the kind", () => {
    expect(api({ action: "decline", id: ID, reasonKind: "superseded", reason: "replaced" }).status).toBe(400)
    expect(api({ action: "decline", id: ID, reasonKind: "superseded", link: "not a link", reason: "replaced" }).status).toBe(400)
    expect(api({ action: "decline", id: ID, link: NEWER, reason: "replaced" }).status).toBe(400)
    expect(api({ action: "decline", id: ID, reasonKind: "obsolete", link: NEWER, reason: "replaced" }).status).toBe(400)
    expect(api({ action: "done", work: "ops", id: ID, evidence: NEWER, reasonKind: "superseded", link: NEWER }).status).toBe(400)
    expect(store.get(ID)?.state).toBe("in_progress")
  })

  it("the store refuses a superseded done or a superseded close without a link", () => {
    expect(() => store.close(ID, "done", "x", 6_000, { kind: "link", value: NEWER, ranAt: 6_000 }, "artist", "superseded")).toThrow(/decline or a drop/)
    expect(() => store.close(ID, "dropped", "x", 6_000, null, "artist", "superseded")).toThrow(/needs a link/)
  })

  it("the tool passes reasonKind and link, and says what replaced it", async () => {
    let sent: any = null
    const fetch = (async (_url: string, init: any) => {
      sent = JSON.parse(init.body)
      const out = superseded()
      return new Response(JSON.stringify(out.body), { status: out.status })
    }) as any
    const text = await runRequestTool(
      { action: "decline", id: ID, reasonKind: "superseded", link: NEWER, reason: "the v3 hero work replaced it", callerAgentId: "artist" },
      { daemonUrl: "http://daemon.test", fetch, env: {} },
    )
    expect(sent).toMatchObject({ reasonKind: "superseded", link: NEWER })
    expect(text).toContain(`superseded by ${NEWER}`)
  })
})

describe("the owner-words check and a close as superseded", () => {
  it("shows the link and says a superseded close is a match, an unreadable link unclear", () => {
    superseded()
    const prompt = ownerCheckPrompt(store.get(ID)!)
    expect(prompt).toContain(`Link given: ${NEWER}`)
    expect(prompt).toMatch(/SUPERSEDED.*is a "match", unless the owner's words say to deliver the old version anyway/)
    expect(prompt).toMatch(/link cannot be read.*answer "unclear", not "mismatch"/)
  })

  it("superseded decline with link: a match leaves it closed", async () => {
    superseded()
    const { c, told } = checker('{"verdict":"match","why":"The newer v3 hero work replaced it."}')
    expect(await c.run()).toMatchObject({ checked: 1, reopened: [], asked: [] })
    expect(store.get(ID)).toMatchObject({ state: "declined", ownerCheck: "match", closeKind: "superseded" })
    expect(told).toEqual([])
  })

  it("a decline without a link keeps today's prompt and today's reopen", async () => {
    expect(api({ action: "decline", id: ID, reason: "superseded / no longer needed" }).status).toBe(200)
    expect(store.get(ID)).toMatchObject({ closeKind: null, proof: null })
    const { c, prompts } = checker('{"verdict":"mismatch","why":"Nothing replaced it in your words."}')
    expect((await c.run()).reopened).toEqual([ID])
    expect(prompts[0]).not.toContain("SUPERSEDED")
    expect(prompts[0]).toContain("Closed as DECLINED by artist. Reason given: superseded / no longer needed")
    expect(store.get(ID)).toMatchObject({ state: "needs_attention", ownerReopens: 1 })
    // A second plain decline is judged by the model again, as before.
    at += 60_000
    expect(api({ action: "decline", id: ID, reason: "superseded / no longer needed" }).status).toBe(200)
    const again = checker('{"verdict":"mismatch","why":"Still nothing replaced it."}')
    expect(await again.c.run()).toMatchObject({ reopened: [ID], asked: [] })
    expect(again.prompts).toHaveLength(1)
  })

  it("same close reopened once: the next one goes to the owner as one question, not a second reopen", async () => {
    superseded()
    const first = checker('{"verdict":"mismatch","why":"You asked for the scroll video."}')
    expect((await first.c.run()).reopened).toEqual([ID])
    expect(store.get(ID)).toMatchObject({ state: "needs_attention", ownerReopens: 1 })
    // The reopen tells the agent its two ways out, never to send old work.
    const told = first.woken[0]
    expect(told).toContain("two ways out")
    expect(told).toContain('reasonKind:"superseded"')
    expect(told).toContain("Never send older work")

    at += 60_000
    expect(superseded().status).toBe(200)
    const second = checker('{"verdict":"mismatch","why":"should not be asked"}')
    const out = await second.c.run()
    expect(out).toMatchObject({ checked: 1, reopened: [], woken: [], asked: [ID] })
    expect(second.prompts).toEqual([])
    const r = store.get(ID)!
    expect(r).toMatchObject({
      state: "waiting_owner", closedAt: null, ownerCheck: OWNER_ASKED, ownerReopens: 1,
      question: `Closed as superseded by ${NEWER}. Agree?`, closeKind: "superseded", closeReason: "the v3 hero work replaced it",
    })
    expect(second.told).toHaveLength(1)
    expect(second.told[0].text).toContain(`Closed as superseded by ${NEWER}. Agree?`)
    expect(second.lines.join("\n")).toContain("asked the owner, not judged again")
    // Asked once: the next check has nothing to judge or ask.
    expect(await second.c.run()).toMatchObject({ checked: 0, asked: [] })
    expect(second.told).toHaveLength(1)

    // While the owner is asked, the agent cannot close it again.
    const refused = superseded()
    expect(refused.status).toBe(409)
    expect((refused.body as any).ownerAsked).toBe(true)
    // A word in the chat is not the answer: it stays waiting on the owner.
    expect(store.releaseOwnerWaits("artist", "telegram", "chat-1", at + 120_000)).toEqual([])
  })

  it("yes: the owner's close ends it, unchecked", async () => {
    await askedOnce()
    expect(store.close(ID, "dropped", "agreed: superseded", at + 2_000, null, OWNER_BY)).toBe(true)
    expect(store.get(ID)).toMatchObject({ state: "dropped", closedBy: OWNER_BY, ownerCheck: null })
  })

  it("no: the owner's reply sends it back with their words, and the next superseded close is asked again, not reopened", async () => {
    await askedOnce()
    expect(store.handOff(ID, "artist", "No, I still want the scroll video of the old page.", at + 2_000)).toBe(true)
    expect(store.get(ID)).toMatchObject({ state: "in_progress", ownerCheck: OWNER_ANSWERED, ownerNote: "No, I still want the scroll video of the old page." })
    at += 120_000
    expect(superseded().status).toBe(200)
    const again = checker('{"verdict":"mismatch","why":"x"}')
    expect(await again.c.run()).toMatchObject({ reopened: [], asked: [ID] })
    expect(store.get(ID)?.ownerReopens).toBe(1)
  })
})

describe("the reopen message", () => {
  it("names both ways out for any reopened close", () => {
    expect(api({ action: "decline", id: ID, reason: "busy" }).status).toBe(200)
    const text = mismatchText(store.get(ID)!, "you were asked for the video", null)
    expect(text).toContain("deliver what the owner asked")
    expect(text).toContain("close it as superseded with a link")
    expect(text).toContain("goes to the owner as one question")
    expect(text).toContain("Never send older work just to get the request closed.")
    expect(text).not.toMatch(/send (it|the old|the earlier)/i)
  })
})

async function askedOnce(): Promise<void> {
  superseded()
  await checker('{"verdict":"mismatch","why":"You asked for the scroll video."}').c.run()
  at += 60_000
  superseded()
  expect((await checker('{"verdict":"mismatch","why":"x"}').c.run()).asked).toEqual([ID])
}
