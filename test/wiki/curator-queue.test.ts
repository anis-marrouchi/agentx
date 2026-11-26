import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
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
// An AgentX home: agentx.json beside .agentx/, the wiki in .agentx/wiki.
let home: string
let dir: string
let hub: WikiHub

function makeHome(prefix: string): string {
  const h = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(h, ".agentx", "wiki"), { recursive: true })
  writeFileSync(join(h, "agentx.json"), "{}")
  return h
}

beforeEach(() => {
  home = makeHome("curator-queue-")
  dir = join(home, ".agentx", "wiki")
  hub = new WikiHub(dir, () => {})
  // Commander keeps option values between parseAsync calls on one program.
  const contributions = wiki.commands.find((c) => c.name() === "contributions")
  for (const c of contributions?.commands ?? []) { c.setOptionValue("card", undefined); c.setOptionValue("fingerprint", undefined) }
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  rmSync(home, { recursive: true, force: true })
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

  it("C3: an undated change against an undated fact with another value is refused, page untouched", () => {
    page("sales-agent", "projects/acme.md", "Acme")
    new FactLedger(dir).write({ subject: "Acme", attribute: "main contact", value: "Karim", source: "call", verifiedBy: "sales-agent" }, { now: NOW })
    holdPatches(hub, dir, [patch({ id: "a1", checkedAt: "" })], { now: NOW })
    const r = approveHeld(hub, dir, "h-a1", { by: "Anis (popup)", now: NOW })
    expect(r.ok).toBe(false)
    expect(read("sales-agent", "projects/acme.md").content).toBe(BODY)
    expect(new FactLedger(dir).get(factId("Acme", "main contact"))?.value).toBe("Karim")
    expect(listHeld(dir)[0].status).toBe("held")
  })

  it("C3: a ledger refusal after the page write fails the approve; the change stays held", () => {
    page("sales-agent", "projects/acme.md", "Acme")
    holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    vi.spyOn(FactLedger.prototype, "write").mockReturnValue({ status: "contradiction", fact: {} as never, questionId: "q-1" } as never)
    const r = approveHeld(hub, dir, "h-a1", { by: "Anis (popup)", now: NOW })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/q-1/)
    expect(listHeld(dir)[0].status).toBe("held")
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
  type CardOpts = { verdict?: "yes" | "no"; names?: string; fp?: string | null; root?: string; raisedBy?: string; stepRaised?: boolean }
  /** A popup-only card a workflow step of pm-agent raised, naming the held
   *  change as `<id>@<fingerprint>`, answered in the popup or not. */
  const card = (popup: boolean, opts: CardOpts = {}) => {
    const root = opts.root ?? home
    const names = opts.names ?? "h-a1"
    const fp = opts.fp === undefined ? listHeld(dir, { all: true }).find((h) => h.id === names)?.pageFingerprint : opts.fp
    const c = createCard(root, {
      title: "Curator changes", ask: "Apply?", recommend: "See the note", if_silent: "keep", raised_by: opts.raisedBy ?? "pm-agent",
      context: `w1 ${names}${fp ? `@${fp}` : ""}: Acme contact`,
    }, { popupOnly: true, ...(opts.stepRaised === false ? {} : { origin: { kind: "step-raised" as const, runId: "run-7", nodeId: "ask" } }) })
    if (!c.ok) throw new Error(c.error)
    decideCard(root, c.card.id, opts.verdict ?? (popup ? "yes" : "no"), { by: "anis", popup })
    return c.card.id
  }
  const cli = (...args: string[]) => wiki.parseAsync(["contributions", ...args], { from: "user" })
  const setup = () => {
    page("sales-agent", "projects/acme.md", "Acme")
    holdPatches(hub, dir, [patch({ id: "a1" })], { now: NOW })
    return vi.spyOn(console, "log").mockImplementation(() => {})
  }
  const logged = (log: ReturnType<typeof setup>) => log.mock.calls.flat().join("\n")

  it("a no in the popup applies nothing and rejects; a yes does not reject (C4)", async () => {
    const log = setup()
    const no = card(true, { verdict: "no" })
    await cli("approve", "h-a1", "--dir", dir, "--card", no)
    expect(process.exitCode).toBe(1)
    expect(logged(log)).toMatch(/answered no/)
    expect(listHeld(dir)[0].status).toBe("held")
    process.exitCode = undefined
    await cli("reject", "h-a1", "--dir", dir, "--card", card(true))
    expect(process.exitCode).toBe(1)
    expect(logged(log)).toMatch(/answered yes, so h-a1 is not rejected/)
    expect(listHeld(dir)[0].status).toBe("held")
    process.exitCode = undefined
    await cli("reject", "h-a1", "--dir", dir, "--card", no)
    expect(process.exitCode).toBeUndefined()
    expect(listHeld(dir, { all: true })[0].status).toBe("rejected")
  })

  it("a yes card raised for another change cannot approve this one", async () => {
    const log = setup()
    // h-a10 contains h-a1 but is another id.
    for (const names of ["h-a2", "h-a10"]) {
      await cli("approve", "h-a1", "--dir", dir, "--card", card(true, { names, fp: "0123456789abcdef" }))
      expect(process.exitCode).toBe(1)
      process.exitCode = undefined
    }
    expect(logged(log)).toMatch(/not raised for h-a1/)
    expect(listHeld(dir)[0].status).toBe("held")
  })

  it("B1: a decided card in another folder is refused, whatever the current folder", async () => {
    const log = setup()
    const mine = makeHome("curator-forged-")
    try {
      // An agent writes its own yes card in its own folder and runs from there.
      const forged = card(true, { root: mine })
      vi.spyOn(process, "cwd").mockReturnValue(mine)
      await cli("approve", "h-a1", "--dir", dir, "--card", forged)
      expect(process.exitCode).toBe(1)
      expect(logged(log)).toMatch(/no card .* in the cards of/)
      expect(listHeld(dir)[0].status).toBe("held")
      expect(read("sales-agent", "projects/acme.md").content).toBe(BODY)
    } finally {
      rmSync(mine, { recursive: true, force: true })
    }
  })

  it("B1: a wiki outside an AgentX home takes no card", async () => {
    const loose = mkdtempSync(join(tmpdir(), "curator-loose-"))
    try {
      const looseHub = new WikiHub(loose, () => {})
      looseHub.getAgentWiki("sales-agent").writeArticle("projects/acme.md", { title: "Acme", tags: [], owner: "sales-agent", access: "public", created: "2026-09-01", lastUpdated: "2026-09-01", sources: [] }, BODY, "sales-agent")
      holdPatches(looseHub, loose, [patch({ id: "a1" })], { now: NOW })
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      vi.spyOn(process, "cwd").mockReturnValue(loose)
      await cli("approve", "h-a1", "--dir", loose, "--card", card(true, { root: loose, fp: listHeld(loose)[0].pageFingerprint }))
      expect(process.exitCode).toBe(1)
      expect(logged(log)).toMatch(/not the wiki of an AgentX home/)
      expect(listHeld(loose)[0].status).toBe("held")
    } finally {
      rmSync(loose, { recursive: true, force: true })
    }
  })

  it("C1: the card must be step-raised, by the agent that proposed the change", async () => {
    const log = setup()
    await cli("approve", "h-a1", "--dir", dir, "--card", card(true, { stepRaised: false }))
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
    await cli("approve", "h-a1", "--dir", dir, "--card", card(true, { raisedBy: "cx-agent" }))
    expect(process.exitCode).toBe(1)
    expect(logged(log)).toMatch(/not raised by a workflow step of pm-agent/)
    expect(listHeld(dir)[0].status).toBe("held")
  })

  it("C2: approve writes only onto the page the card showed", async () => {
    const log = setup()
    // No fingerprint on the card: refused.
    await cli("approve", "h-a1", "--dir", dir, "--card", card(true, { fp: null }))
    expect(process.exitCode).toBe(1)
    expect(logged(log)).toMatch(/does not show the page/)
    process.exitCode = undefined
    // The card is shown, then the page changes and a refresh saves the new
    // fingerprint: the owner never saw that page, so nothing is applied.
    const shown = card(true)
    page("sales-agent", "projects/acme.md", "Acme", `${BODY}\n\nA person edited this.`)
    refreshHeld(hub, dir, { reasonPrefix: "curator:" })
    await cli("approve", "h-a1", "--dir", dir, "--card", shown)
    expect(process.exitCode).toBe(1)
    expect(logged(log)).toMatch(/changed/)
    expect(listHeld(dir)[0].status).toBe("held")
    process.exitCode = undefined
    // A --fingerprint that is not the card's is refused.
    await cli("approve", "h-a1", "--dir", dir, "--card", card(true), "--fingerprint", "ffffffffffffffff")
    expect(process.exitCode).toBe(1)
    expect(logged(log)).toMatch(/not the page the card showed/)
  })

  it("the CLI applies a curator change only with its yes card from the popup", async () => {
    const log = setup()
    await cli("approve", "h-a1", "--dir", dir)
    expect(process.exitCode).toBe(1)
    expect(logged(log)).toMatch(/answered on their card/)
    process.exitCode = undefined
    await cli("approve", "h-a1", "--dir", dir, "--card", card(false))
    expect(process.exitCode).toBe(1)
    expect(listHeld(dir)[0].status).toBe("held")
    process.exitCode = undefined
    // Run from any folder: the card is read from the wiki's own home.
    vi.spyOn(process, "cwd").mockReturnValue(tmpdir())
    await cli("approve", "h-a1", "--dir", dir, "--card", card(true))
    expect(process.exitCode).toBeUndefined()
    expect(listHeld(dir, { all: true })[0]).toMatchObject({ status: "approved", decidedBy: expect.stringMatching(/^anis \(popup, card /) })
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

