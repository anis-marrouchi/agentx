import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { WikiHub } from "../../src/wiki/hub"
import { FactLedger, factId } from "../../src/wiki/facts/ledger"
import { approveHeld, heldChange, listHeld, mergeContributions, rejectHeld, runContribution, type ContributionPatch } from "../../src/wiki/contributions"
import { holdPatches, refreshHeld, heldKey, CURATOR_REASON, CURATOR_WAITING_CAP } from "../../src/wiki/curator-queue"
import { pageFingerprint } from "../../src/wiki/curate"
import { createCard, decideCard } from "../../src/approvals/cards"
import { wiki } from "../../src/commands/wiki"
import type { WikiArticleMeta } from "../../src/wiki/types"

// The curator's wiki changes (noqta#910, design noqta#906 §3 and §5).
// Design tests covered here: 5, 6a, 6b, 12, 13, 15.

const NOW = Date.parse("2026-11-26T09:00:00Z")
let dir: string
let hub: WikiHub

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "curator-queue-"))
  hub = new WikiHub(dir, () => {})
  // Commander keeps option values between parseAsync calls on one program.
  const contributions = wiki.commands.find((c) => c.name() === "contributions")
  for (const c of contributions?.commands ?? []) c.setOptionValue("card", undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  rmSync(dir, { recursive: true, force: true })
})

const BODY = "Acme buys olive oil in bulk.\n\nThey pay by bank transfer on net 30 terms, as agreed in the spring call with their buyer."

function page(agent: string, path: string, title: string, body = BODY, extra: Partial<WikiArticleMeta> = {}): void {
  hub.getAgentWiki(agent).writeArticle(path, {
    title, tags: [], owner: agent, access: "public", created: "2026-09-01", lastUpdated: "2026-09-01", sources: [], ...extra,
  }, body, agent)
}
const read = (agent: string, path: string) => hub.getAgentWiki(agent).readArticle(path)!

function patch(over: Partial<ContributionPatch> = {}): ContributionPatch {
  return {
    id: over.id ?? `p-${Math.random().toString(36).slice(2, 8)}`,
    kind: "add", page: "Acme", attribute: "main contact", value: "Sara Ben Ali",
    source: "#821 note 1", checkedAt: "2026-11-25T10:00:00Z", agentId: "pm-agent", ...over,
  }
}

describe("holding curator patches (12)", () => {
  it("holds each patch with the curator reason and the page fingerprint", () => {
    page("sales-agent", "projects/acme.md", "Acme")
    const r = holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    expect(r.held).toHaveLength(1)
    const [h] = listHeld(dir)
    expect(h).toMatchObject({ id: "h-a1", reason: CURATOR_REASON, status: "held", pageFingerprint: pageFingerprint(read("sales-agent", "projects/acme.md")) })
  })

  it("never holds a key again once it is held, approved or rejected", () => {
    page("sales-agent", "projects/acme.md", "Acme")
    holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    expect(rejectHeld(dir, "h-a1", { by: "Anis (popup)" }).ok).toBe(true)
    // Same page, attribute and value from a later run, other id and check.
    const again = holdPatches(hub, dir, [patch({ id: "a2", checkedAt: "2026-11-26T08:00:00Z", value: " sara ben ali " })], { now: NOW })
    expect(again.held).toHaveLength(0)
    expect(again.skipped[0].why).toMatch(/already held, approved or rejected/)
    expect(heldKey(patch({ kind: "remove", previous: "net 30" }))).not.toBe(heldKey(patch()))
  })

  it("skips a page the proposing agent cannot read", () => {
    page("sales-agent", "projects/acme.md", "Acme", BODY, { access: "private" })
    const r = holdPatches(hub, dir, [patch()], { now: NOW })
    expect(r.held).toHaveLength(0)
    expect(r.skipped[0].why).toMatch(/cannot read/)
  })

  it("holds at most CURATOR_WAITING_CAP waiting changes", () => {
    page("sales-agent", "projects/acme.md", "Acme")
    const many = Array.from({ length: CURATOR_WAITING_CAP + 2 }, (_, i) => patch({ id: `n${i}`, value: `value ${i}` }))
    const r = holdPatches(hub, dir, many, { now: NOW })
    expect(r.held).toHaveLength(CURATOR_WAITING_CAP)
    expect(r.skipped.map((s) => s.why)).toEqual([`${CURATOR_WAITING_CAP} changes already wait for the approver`, `${CURATOR_WAITING_CAP} changes already wait for the approver`])
    // A decided change frees a place.
    expect(rejectHeld(dir, "h-n0", { by: "x" }).ok).toBe(true)
    expect(holdPatches(hub, dir, [patch({ id: "late", value: "late" })], { now: NOW }).held).toHaveLength(1)
  })

  it("--work keeps no cursor and --hold queues nothing for the merge", async () => {
    page("sales-agent", "projects/acme.md", "Acme")
    const call = async () => ({ text: JSON.stringify([{ kind: "add", page: "Acme", attribute: "main contact", value: "Sara", source: "#821", checkedAt: "2026-11-25T10:00:00Z" }]), costUsd: 0 })
    const work = [{ id: "w1", at: "2026-11-25T10:00:00Z", kind: "chat" as const, title: "#821", text: "Sara is the main contact" }]
    const batch = await runContribution(hub, dir, "pm-agent", { model: "m", call, work, dryRun: true, now: NOW })
    expect(batch.patches).toHaveLength(1)
    const full = await runContribution(hub, dir, "pm-agent", { model: "m", call, work, now: NOW })
    expect(full.workIds).toEqual(["w1"])
    // No cursor: the same items are read again next time.
    const again = await runContribution(hub, dir, "pm-agent", { model: "m", call, work, dryRun: true, now: NOW })
    expect(again.workIds).toEqual(["w1"])
  })
})

describe("approving a curator change (5)", () => {
  it("writes a page another agent owns as its owner, keeps access, saves a version, then the ledger", () => {
    page("sales-agent", "projects/acme.md", "Acme", BODY, { access: "shared", sharedWith: ["pm-agent"] })
    holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    const r = approveHeld(hub, dir, "h-a1", { by: "Anis (popup)", now: NOW })
    expect(r.ok).toBe(true)
    const a = read("sales-agent", "projects/acme.md")
    expect(a.meta).toMatchObject({ owner: "sales-agent", access: "shared" })
    expect(a.content).toContain("**main contact:** Sara Ben Ali")
    expect(hub.getAgentWiki("sales-agent").getVersions("projects/acme.md").length).toBeGreaterThan(0)
    expect(new FactLedger(dir).get(factId("Acme", "main contact"))?.value).toBe("Sara Ben Ali")
    expect(listHeld(dir, { all: true })[0]).toMatchObject({ status: "approved", decidedBy: "Anis (popup)" })
  })

  it("refuses a page changed since it was shown; the change stays held", () => {
    page("sales-agent", "projects/acme.md", "Acme")
    holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    page("sales-agent", "projects/acme.md", "Acme", `${BODY}\n\nA person edited this.`)
    const r = approveHeld(hub, dir, "h-a1", { by: "Anis (popup)", now: NOW })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/changed/)
    expect(listHeld(dir)[0].status).toBe("held")
    expect(new FactLedger(dir).get(factId("Acme", "main contact"))).toBeNull()
  })

  it("undoes a write whose version was not saved, with no ledger write", () => {
    page("sales-agent", "projects/acme.md", "Acme")
    holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    vi.spyOn(hub.getAgentWiki("sales-agent"), "getVersions").mockReturnValue([])
    const r = approveHeld(hub, dir, "h-a1", { by: "Anis (popup)", now: NOW })
    expect(r.ok).toBe(false)
    expect(read("sales-agent", "projects/acme.md").content).toBe(BODY)
    expect(new FactLedger(dir).get(factId("Acme", "main contact"))).toBeNull()
    expect(listHeld(dir)[0].status).toBe("held")
  })

  it("refuses a value the ledger holds with a newer check, with no page write", () => {
    page("sales-agent", "projects/acme.md", "Acme")
    new FactLedger(dir).write({ subject: "Acme", attribute: "main contact", value: "Karim", source: "call", verifiedBy: "sales-agent", verifiedAt: "2026-11-26T07:00:00Z" }, { now: NOW })
    holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    const r = approveHeld(hub, dir, "h-a1", { by: "Anis (popup)", now: NOW })
    expect(r.ok).toBe(false)
    expect(read("sales-agent", "projects/acme.md").content).toBe(BODY)
    expect(new FactLedger(dir).get(factId("Acme", "main contact"))?.value).toBe("Karim")
  })

  it("does not refuse a removal on a short page (shrink guard)", () => {
    const short = "Acme pays net 30, agreed on the spring call with the buyer there."
    page("sales-agent", "projects/acme.md", "Acme", `${short}\n\nOld line: they also buy capers.`)
    holdPatches(hub, dir, [patch({ id: "r1", kind: "remove", attribute: undefined, value: undefined, previous: "Old line: they also buy capers." })], { now: NOW })
    const r = approveHeld(hub, dir, "h-r1", { by: "Anis (popup)", now: NOW })
    expect(r.ok).toBe(true)
    expect(read("sales-agent", "projects/acme.md").content).not.toContain("capers")
  })
})

describe("crash cases (6a, 6b)", () => {
  it("6a: page written, crash before the ledger and decide: the re-run finishes, no refusal", () => {
    page("sales-agent", "projects/acme.md", "Acme")
    holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    // The first approve wrote the page, then the process died.
    const a = read("sales-agent", "projects/acme.md")
    hub.getAgentWiki("sales-agent").writeArticle("projects/acme.md", a.meta, heldChange(a.content, listHeld(dir)[0].patch), "sales-agent")
    const r = approveHeld(hub, dir, "h-a1", { by: "Anis (popup)", now: NOW })
    expect(r.ok).toBe(true)
    expect(new FactLedger(dir).get(factId("Acme", "main contact"))?.value).toBe("Sara Ben Ali")
    expect(listHeld(dir, { all: true })[0].status).toBe("approved")
    expect(read("sales-agent", "projects/acme.md").content.match(/main contact/g)).toHaveLength(1)
  })

  it("6b: decided before the crash: approve answers already approved", () => {
    page("sales-agent", "projects/acme.md", "Acme")
    holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    expect(approveHeld(hub, dir, "h-a1", { by: "Anis (popup)", now: NOW }).ok).toBe(true)
    const again = approveHeld(hub, dir, "h-a1", { by: "Anis (popup)", now: NOW })
    expect(!again.ok && again.error).toMatch(/already approved/)
  })
})

describe("refresh at each ask (13)", () => {
  it("a page edited after queueing: refresh saves the new fingerprint and approve then writes", () => {
    page("sales-agent", "projects/acme.md", "Acme")
    holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    page("sales-agent", "projects/acme.md", "Acme", `${BODY}\n\nA person edited this.`)
    const r = refreshHeld(hub, dir, { reasonPrefix: "curator:", now: NOW })
    expect(r.refreshed).toHaveLength(1)
    expect(r.refreshed[0].fingerprint).toBe(pageFingerprint(read("sales-agent", "projects/acme.md")))
    expect(r.refreshed[0].after).toContain("Sara Ben Ali")
    expect(approveHeld(hub, dir, "h-a1", { by: "Anis (popup)", now: NOW }).ok).toBe(true)
  })

  it("drops a correction whose old text is gone, and leaves other reasons alone", () => {
    page("sales-agent", "projects/acme.md", "Acme")
    holdPatches(hub, dir, [patch({ id: "c1", kind: "correct", attribute: "terms", value: "net 45", previous: "net 30" })], { now: NOW })
    page("sales-agent", "projects/acme.md", "Acme", BODY.replace("net 30", "net 60"))
    const r = refreshHeld(hub, dir, { reasonPrefix: "curator:", by: "sales-curate: no longer applies", now: NOW })
    expect(r.dropped).toEqual([{ id: "h-c1", page: "Acme", why: "the text it changes is no longer on the page" }])
    expect(listHeld(dir, { all: true })[0]).toMatchObject({ status: "rejected", decidedBy: "sales-curate: no longer applies" })
  })
})

describe("S1 and the lock (15)", () => {
  const card = (popup: boolean, opts: { verdict?: "yes" | "no"; names?: string } = {}) => {
    const c = createCard(dir, {
      title: "Curator changes", ask: "Apply?", recommend: "See the note", if_silent: "keep", raised_by: "pm-agent",
      context: `w1 ${opts.names ?? "h-a1"}: Acme contact`,
    }, { popupOnly: true })
    if (!c.ok) throw new Error(c.error)
    decideCard(dir, c.card.id, opts.verdict ?? (popup ? "yes" : "no"), { by: "anis", popup })
    return c.card.id
  }

  it("a no in the popup applies nothing, and still rejects", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir)
    page("sales-agent", "projects/acme.md", "Acme")
    holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const no = card(true, { verdict: "no" })
    await wiki.parseAsync(["contributions", "approve", "h-a1", "--dir", dir, "--card", no], { from: "user" })
    expect(process.exitCode).toBe(1)
    expect(log.mock.calls.flat().join("\n")).toMatch(/answered no/)
    expect(listHeld(dir)[0].status).toBe("held")
    process.exitCode = undefined
    await wiki.parseAsync(["contributions", "reject", "h-a1", "--dir", dir, "--card", no], { from: "user" })
    expect(process.exitCode).toBeUndefined()
    expect(listHeld(dir, { all: true })[0].status).toBe("rejected")
    cwd.mockRestore()
  })

  it("a yes card raised for another change cannot approve this one", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir)
    page("sales-agent", "projects/acme.md", "Acme")
    holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    // h-a10 contains h-a1 but is another id.
    for (const names of ["h-a2", "h-a10"]) {
      await wiki.parseAsync(["contributions", "approve", "h-a1", "--dir", dir, "--card", card(true, { names })], { from: "user" })
      expect(process.exitCode).toBe(1)
      process.exitCode = undefined
    }
    expect(log.mock.calls.flat().join("\n")).toMatch(/not raised for h-a1/)
    expect(listHeld(dir)[0].status).toBe("held")
    cwd.mockRestore()
  })

  it("the CLI refuses a curator entry without a card answered in the popup", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir)
    page("sales-agent", "projects/acme.md", "Acme")
    holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await wiki.parseAsync(["contributions", "approve", "h-a1", "--dir", dir], { from: "user" })
    expect(process.exitCode).toBe(1)
    expect(log.mock.calls.flat().join("\n")).toMatch(/answered on their card/)
    process.exitCode = undefined
    await wiki.parseAsync(["contributions", "approve", "h-a1", "--dir", dir, "--card", card(false)], { from: "user" })
    expect(process.exitCode).toBe(1)
    expect(listHeld(dir)[0].status).toBe("held")
    process.exitCode = undefined
    await wiki.parseAsync(["contributions", "approve", "h-a1", "--dir", dir, "--card", card(true)], { from: "user" })
    expect(process.exitCode).toBeUndefined()
    expect(listHeld(dir, { all: true })[0]).toMatchObject({ status: "approved", decidedBy: expect.stringMatching(/^anis \(popup, card /) })
    cwd.mockRestore()
  })

  it("a merge and a curator hold at once lose no entry", () => {
    page("sales-agent", "projects/acme.md", "Acme")
    holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    // A decide reads the file again under the lock: an entry added after
    // approveHeld's first read is kept.
    const first = listHeld(dir, { all: true })
    holdPatches(hub, dir, [patch({ id: "a2", attribute: "phone", value: "+216 71 000 000" })], { now: NOW })
    expect(first).toHaveLength(1)
    expect(rejectHeld(dir, "h-a1", { by: "x" }).ok).toBe(true)
    expect(listHeld(dir, { all: true }).map((h) => h.id).sort()).toEqual(["h-a1", "h-a2"])
    mergeContributions(hub, dir, { now: NOW })
    expect(listHeld(dir, { all: true })).toHaveLength(2)
  })
})

