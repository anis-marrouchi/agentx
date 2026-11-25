import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const events: Array<{ outcome: string; reason?: string }> = []
vi.mock("../src/gates/events", () => ({
  recordGateEvent: (e: { outcome: string; reason?: string }) => { events.push(e) },
}))

import { claimRefs, judgeClaim, midRunClaims } from "../src/gates/status-claim"
import { ClaimHold } from "../src/gates/claim-hold"
import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import type { AgentResponse, AgentTask } from "../src/agents/runtime"
import type { SeatMode } from "../src/decisions/store"

// G3 (#2085): a reply to the owner that says merged, live, deployed,
// released or closed about a ref must rest on a read of that ref this run.

const ghView = (n: number) => ({ action: "Bash", inputSummary: `gh pr view ${n} --json state` })

describe("judgeClaim", () => {
  it("passes a claim whose ref was read this run", () => {
    expect(judgeClaim("PR #12 is merged.", [ghView(12)])).toEqual({ kind: "read" })
  })
  it("asks when another ref was read", () => {
    const v = judgeClaim("PR #12 is merged.", [ghView(13)])
    expect(v.kind).toBe("unread")
    expect(v.kind === "unread" && v.refs.map((r) => r.label)).toEqual(["#12"])
  })
  it("ties versions and shas, not bare numbers", () => {
    expect(claimRefs("0.263.1 is released at 1a24bd32.").map((r) => r.label)).toEqual(["0.263.1", "1a24bd32"])
    expect(judgeClaim("Released 0.263.1.", [{ action: "Bash", inputSummary: "npm view agentx version 0.263.1" }]).kind).toBe("read")
  })
  it("logs a claim with no ref as untied, and ignores text with no claim word", () => {
    expect(judgeClaim("It is deployed.", [])).toEqual({ kind: "untied" })
    expect(judgeClaim("PR #12 waits review.", [])).toEqual({ kind: "none" })
  })
  it("does not count a mention of the ref without a live read", () => {
    expect(judgeClaim("PR #12 is merged.", [{ action: "Edit", inputSummary: "notes about #12" }]).kind).toBe("unread")
  })
  it("finds claims sent mid-run through agentx_channel_reply", () => {
    const calls = [{ action: "mcp__agentx__agentx_channel_reply", inputSummary: "PR #7 is merged" }]
    expect(midRunClaims(calls).map((r) => r.label)).toEqual(["#7"])
    expect(midRunClaims([...calls, ghView(7)])).toEqual([])
  })
})

describe("ClaimHold", () => {
  it("passes text until the first claim word, then holds the rest", () => {
    const h = new ClaimHold()
    expect(h.push("Status: ")).toBe("Status: ")
    expect(h.push("PR #12 is mer")).toBe("PR #12 is mer")
    // A word split over two pieces is still caught.
    expect(h.push("ged and live.")).toBe("")
    expect(h.held).toBe(true)
    expect(h.push(" more")).toBe("")
    expect(h.rest("Status: PR #12 is mer… not checked.")).toBe("… not checked.")
    // A rewritten final text goes out whole, after a break.
    expect(h.rest("PR #12 is open (checked).")).toBe("\n\nPR #12 is open (checked).")
  })
  it("sends the tail of the final text when it starts with what went out", () => {
    const h = new ClaimHold()
    h.push("Hello. ")
    h.push("Deployed.")
    expect(h.rest("Hello. Deployed 0.263.1 (checked).")).toBe("Deployed 0.263.1 (checked).")
  })
})

describe("registry G3 check", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-g3-")); events.length = 0 })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function registry(mode: SeatMode, results: AgentResponse[], calls = [ghView(13)]) {
    const config = daemonConfigSchema.parse({
      node: { id: "t", name: "t" },
      agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir } },
      people: [{ id: "anis", name: "Anis", role: "owner", identities: ["telegram:42"] }],
      jobState: { enabled: false },
    })
    const r = new AgentRegistry(config, () => {})
    const seen: AgentTask[] = []
    let n = 0
    ;(r as any).executeInternal = async (task: AgentTask) => {
      task.taskId = `trace-${n}`
      seen.push({ ...task })
      return results[n++] ?? { content: "" }
    }
    r.setTraceToolCalls((id) => id === "trace-0" ? calls : [])
    r.setStatusClaimMode(() => mode)
    return { r, seen }
  }
  const owner = { channel: "telegram", chatId: "42", senderId: "42", sender: "Anis" }
  const other = { channel: "telegram", chatId: "99", senderId: "99", sender: "Sam" }

  it("active: asks once in the same session and posts the corrected answer", async () => {
    const { r, seen } = registry("active", [{ content: "PR #12 is merged." }, { content: "PR #12 is open (checked: gh pr view 12)." }])
    const res = await r.execute({ agentId: "ops", message: "status?", context: owner })
    expect(seen).toHaveLength(2)
    expect(seen[1].message).toMatch(/\[Status check\].*#12/)
    expect(seen[1].freshSession).toBe(false)
    expect(res.content).toBe("PR #12 is open (checked: gh pr view 12).")
    expect(events.map((e) => e.outcome)).toEqual(["asked", "corrected"])
    expect(r.holdsClaims(owner)).toBe(true)
  })

  it("active, no answer to the ask: the claim stays, marked not checked", async () => {
    const { r } = registry("active", [{ content: "PR #12 is merged." }, { content: "", error: "boom" }])
    const res = await r.execute({ agentId: "ops", message: "status?", context: owner })
    expect(res.content).toBe("PR #12 is merged.\n\n(Not checked in this run: #12.)")
    expect(events.map((e) => e.outcome)).toEqual(["asked", "not-fixed"])
  })

  it("a matching read asks nothing", async () => {
    const { r, seen } = registry("active", [{ content: "PR #12 is merged." }], [ghView(12)])
    expect((await r.execute({ agentId: "ops", message: "status?", context: owner })).content).toBe("PR #12 is merged.")
    expect(seen).toHaveLength(1)
    expect(events).toEqual([])
  })

  it("shadow: a row only, the answer as written", async () => {
    const { r, seen } = registry("shadow", [{ content: "PR #12 is merged." }])
    expect((await r.execute({ agentId: "ops", message: "status?", context: owner })).content).toBe("PR #12 is merged.")
    expect(seen).toHaveLength(1)
    expect(events.map((e) => e.outcome)).toEqual(["would-ask"])
    expect(r.holdsClaims(owner)).toBe(false)
  })

  it("not the owner, or off: nothing", async () => {
    const a = registry("active", [{ content: "PR #12 is merged." }])
    expect((await a.r.execute({ agentId: "ops", message: "status?", context: other })).content).toBe("PR #12 is merged.")
    expect(a.r.holdsClaims(other)).toBe(false)
    const b = registry("off", [{ content: "PR #12 is merged." }])
    expect((await b.r.execute({ agentId: "ops", message: "status?", context: owner })).content).toBe("PR #12 is merged.")
    expect(events).toEqual([])
  })

  it("an untied claim is logged and not asked", async () => {
    const { r, seen } = registry("active", [{ content: "It is deployed." }])
    expect((await r.execute({ agentId: "ops", message: "status?", context: owner })).content).toBe("It is deployed.")
    expect(seen).toHaveLength(1)
    expect(events.map((e) => e.outcome)).toEqual(["untied"])
  })
})
