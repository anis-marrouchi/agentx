import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { StepProofs, provenStep } from "../src/workflows/step-proof"
import { decideCard, readCard, DEFAULT_CARD_SETTINGS } from "../src/approvals/cards"
import { handleApprovalsApi, POPUP_IS_OFF, POPUP_ONLY_NEEDS_STEP } from "../src/approvals/daemon-api"
import { runApprovalsSweep, type ApprovalSettings } from "../src/approvals/sweep"

// A workflow step raises a popup-only card for its own agent (noqta#910,
// design noqta#906 v4 change 3 + v5 B1/S2/S3, review C1). What must hold:
//   - popup_only is accepted only with a step proof of the raising agent,
//     from this machine, and never with a peer `node` (forward path)
//   - while the popup is off the card is refused with 409, never stored
//   - the card gets origin step-raised: a yes counts only from the popup,
//     the sweep sends the agent no turn, and the agent's step closes it (C1)
//   - GET /approvals says whether the popup is on

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "step-raised-")) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const CARD = { title: "Curator changes 2026-11-26", ask: "Apply the changes?", recommend: "See the diff page", if_silent: "keep", raised_by: "pm-agent" }

const deps = (proofs: StepProofs, headers: Record<string, string>, opts: { popup?: boolean; fromLoopback?: boolean } = {}) => ({
  ctx: { root },
  settings: DEFAULT_CARD_SETTINGS,
  hasAgent: (id: string) => id === "pm-agent" || id === "cx-agent",
  hasPeer: (node: string) => node === "peer-1",
  provenAgent: () => null,
  provenStep: () => provenStep(proofs, { headers, fromLoopback: opts.fromLoopback ?? true }),
  popupEnabled: () => opts.popup ?? true,
})
const raise = (body: Record<string, unknown>, d: ReturnType<typeof deps>) =>
  handleApprovalsApi("POST", "/approvals", body, new URLSearchParams(), d)
const mint = (proofs: StepProofs, agentId = "pm-agent") =>
  proofs.mint({ runId: "run-7", nodeId: "ask", workflowId: "sales-curate", agentId }, 60_000).token

describe("raising a popup-only card", () => {
  it("a step of the raising agent raises it: popup_only and origin step-raised are set by the daemon", () => {
    const proofs = new StepProofs()
    const r = raise({ ...CARD, popup_only: true }, deps(proofs, { "x-agentx-step": mint(proofs) }))
    expect(r.status).toBe(201)
    const card = (r.body as any).card
    expect(card).toMatchObject({ popup_only: true, origin: { kind: "step-raised", runId: "run-7", nodeId: "ask" }, raised_by: "pm-agent" })
    expect(readCard(root, card.id)?.popup_only).toBe(true)
  })

  it("refuses it with 400 from a turn, a shell, another agent's step, a remote call, or a peer node (11)", () => {
    const proofs = new StepProofs()
    const body = { ...CARD, popup_only: true }
    const noProof = raise(body, deps(proofs, {}))
    expect(noProof).toEqual({ status: 400, body: { error: POPUP_ONLY_NEEDS_STEP } })
    expect(raise(body, deps(proofs, { "x-agentx-step": mint(proofs, "cx-agent") })).status).toBe(400)
    expect(raise(body, deps(proofs, { "x-agentx-step": mint(proofs) }, { fromLoopback: false })).status).toBe(400)
    expect(raise(body, deps(proofs, { "x-agentx-step": "forged" })).status).toBe(400)
    // A card from a peer node (forward.ts) is never popup-only (11g).
    expect(raise({ ...body, node: "peer-1", raised_by: "remote-agent" }, deps(proofs, { "x-agentx-step": mint(proofs) })).status).toBe(400)
    expect(raise({ ...CARD, popup_only: "yes" }, deps(proofs, { "x-agentx-step": mint(proofs) })).status).toBe(400)
    const listed = handleApprovalsApi("GET", "/approvals", undefined, new URLSearchParams(), deps(proofs, {}))
    expect((listed.body as any).count).toBe(0)
  })

  it("answers 409 popup is off and stores nothing while the popup is off (11f)", () => {
    const proofs = new StepProofs()
    const r = raise({ ...CARD, popup_only: true }, deps(proofs, { "x-agentx-step": mint(proofs) }, { popup: false }))
    expect(r).toEqual({ status: 409, body: { error: POPUP_IS_OFF } })
    const listed = handleApprovalsApi("GET", "/approvals", undefined, new URLSearchParams(), deps(proofs, {}, { popup: false }))
    expect((listed.body as any).count).toBe(0)
  })

  it("changes nothing without the flag: a step's plain card has no origin and is not popup-only", () => {
    const proofs = new StepProofs()
    const r = raise(CARD, deps(proofs, { "x-agentx-step": mint(proofs) }, { popup: false }))
    expect(r.status).toBe(201)
    expect((r.body as any).card.popup_only).toBeUndefined()
    expect((r.body as any).card.origin).toBeUndefined()
  })

  it("GET /approvals says whether the popup is on", () => {
    const proofs = new StepProofs()
    const on = handleApprovalsApi("GET", "/approvals", undefined, new URLSearchParams(), deps(proofs, {}))
    const off = handleApprovalsApi("GET", "/approvals", undefined, new URLSearchParams(), deps(proofs, {}, { popup: false }))
    expect((on.body as any).popup).toEqual({ enabled: true })
    expect((off.body as any).popup).toEqual({ enabled: false })
  })
})

describe("a step-raised card after it is raised", () => {
  const raised = (proofs: StepProofs) => {
    const r = raise({ ...CARD, popup_only: true }, deps(proofs, { "x-agentx-step": mint(proofs) }))
    if (r.status !== 201) throw new Error(JSON.stringify(r.body))
    return (r.body as any).card.id as string
  }

  it("a yes counts only from the popup (11)", () => {
    const id = raised(new StepProofs())
    expect(decideCard(root, id, "yes", { by: "operator" }).ok).toBe(false)
    expect(readCard(root, id)?.status).toBe("pending")
    const r = decideCard(root, id, "yes", { by: "operator", popup: true })
    expect(r.ok && r.card.decided_from).toBe("popup")
  })

  it("C1: a later step of the same agent closes its own step-raised card", () => {
    const proofs = new StepProofs()
    const id = raised(proofs)
    const next = proofs.mint({ runId: "run-8", nodeId: "ask", workflowId: "sales-curate", agentId: "pm-agent" }, 60_000).token
    const r = handleApprovalsApi("POST", `/approvals/${id}/resolve`, { reason: "replaced by the 2026-11-27 card" }, new URLSearchParams(), deps(proofs, { "x-agentx-step": next }))
    expect(r.status).toBe(200)
    expect(readCard(root, id)).toMatchObject({ status: "resolved", closed_via: { kind: "workflow-step", runId: "run-8", nodeId: "ask" } })
  })

  it("C4: a running turn of the same agent, not a workflow step, cannot close it", () => {
    const proofs = new StepProofs()
    const id = raised(proofs)
    const turn = { ...deps(proofs, {}), provenAgent: () => "pm-agent" }
    const r = handleApprovalsApi("POST", `/approvals/${id}/resolve`, { reason: "x" }, new URLSearchParams(), turn)
    expect(r.status).toBe(403)
    expect((r.body as any).error).toMatch(/workflow step/)
    expect(readCard(root, id)?.status).toBe("pending")
  })

  it("another agent's step still cannot close it", () => {
    const proofs = new StepProofs()
    const id = raised(proofs)
    const r = handleApprovalsApi("POST", `/approvals/${id}/resolve`, { reason: "x" }, new URLSearchParams(), deps(proofs, { "x-agentx-step": mint(proofs, "cx-agent") }))
    expect(r.status).toBe(403)
    expect(readCard(root, id)?.status).toBe("pending")
  })

  it("the sweep sends the agent no result turn for it (11h)", async () => {
    const id = raised(new StepProofs())
    decideCard(root, id, "yes", { by: "operator", popup: true })
    const tellAgent = vi.fn(async () => {})
    const settings: ApprovalSettings = { defaultExpiryDays: 3, maxExpiryDays: 30, laterHours: 24, notifyAgent: true, digest: { enabled: false, time: "09:00", timezone: "UTC" } }
    await runApprovalsSweep({ ctx: { root }, settings, tellAgent, hasAgent: () => true, log: () => {} })
    expect(tellAgent).not.toHaveBeenCalled()
  })
})
