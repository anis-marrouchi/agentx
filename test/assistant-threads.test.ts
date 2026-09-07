import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { openDb, closeDb } from "../src/storage/sqlite"
import { AssistantStore } from "../src/daemon/assistant-store"
import { ASSISTANT_SCRIPT, ASSISTANT_HTML } from "../src/daemon/ui/assistant"

let dir: string
beforeEach(() => { closeDb(); dir = mkdtempSync(join(tmpdir(), "assist-")) })
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }) })
const store = () => new AssistantStore(openDb({ path: join(dir, "db.sqlite") })!)

describe("assistant conversations", () => {
  it("keeps a turn alive across a page navigation", () => {
    // The dashboard is multi-page, so the browser loses everything on a click.
    // The thread lives here, and the answer lands whether or not the page that
    // asked is still open.
    const s = store()
    const t = s.createThread("atlas", null, "why is the Hasanah work stuck?")
    const seq = s.appendTurn(t.id, "why is the Hasanah work stuck?")
    expect(s.messages(t.id).map(m => m.status)).toEqual(["done", "pending"])
    s.resolve(t.id, seq, "Because !64 is unreviewed.", "done")
    expect(s.messages(t.id)[1]).toMatchObject({ role: "assistant", status: "done" })
  })

  it("never leaves a turn spinning after a restart", () => {
    const s = store()
    const t = s.createThread("atlas", null, "q")
    s.appendTurn(t.id, "q")
    closeDb()
    // A turn in flight when the process died is not coming back.
    const again = new AssistantStore(openDb({ path: join(dir, "db.sqlite") })!)
    const last = again.messages(t.id)[1]
    expect(last.status).toBe("error")
    expect(last.content).toMatch(/restarted/)
  })

  it("titles a conversation by what was asked", () => {
    const s = store()
    expect(s.createThread("a", null, "  why   is this   stuck? ").title).toBe("why is this stuck?")
    expect(s.createThread("a", null, "x".repeat(200)).title.length).toBe(60)
  })

  it("lists newest first and deletes cleanly", () => {
    const s = store()
    const a = s.createThread("atlas", null, "first")
    const b = s.createThread("atlas", null, "second")
    s.appendTurn(b.id, "second")
    expect(s.listThreads().map(t => t.id)).toEqual([b.id, a.id])
    s.deleteThread(b.id)
    expect(s.listThreads().map(t => t.id)).toEqual([a.id])
    expect(s.messages(b.id)).toEqual([])
  })

  it("gives the drawer history, continue and new-chat controls", () => {
    for (const id of ["ax-as-hist", "ax-as-new", "ax-as-hist-list", "ax-as-title"]) {
      expect(ASSISTANT_HTML).toContain(`id="${id}"`)
    }
    // Remembering only the thread id is what makes navigation survivable.
    expect(ASSISTANT_SCRIPT).toContain("localStorage.setItem('ax-assistant-thread'")
    expect(ASSISTANT_SCRIPT).toContain("loadThread(threadId);loadHistory();")
    // A pending answer keeps polling rather than being lost.
    expect(ASSISTANT_SCRIPT).toContain("if(pending)poll=setTimeout")
  })
})
