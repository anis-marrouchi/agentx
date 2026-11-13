import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs"
import { createServer, type IncomingMessage, type Server } from "http"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { StepProofs, stepProofMinter, provenStep, maskStepProof, STEP_PROOF_GRACE_MS, STEP_PROOF_MASK } from "../src/workflows/step-proof"
import { runAction, isLoopbackUrl } from "../src/actions/runner"
import { actionSchema, type Action } from "../src/actions/types"
import { createCard, readCard, saveCard, DEFAULT_CARD_SETTINGS } from "../src/approvals/cards"
import { closeForwardedCard, handleApprovalsApi } from "../src/approvals/daemon-api"
import { forwardCard } from "../src/approvals/forward"
import { RunStore, WorkflowStore, WorkflowDispatcher, workflowSchema } from "../src/workflows"

// A workflow action.run step closes its own agent's card (#1849).
// What must hold:
//   - the proof is minted for action.run only, for the run's agent, held in
//     memory by hash, and dies when the step ends or its time is up
//   - it reaches the action only (shell env, http header), never the
//     command, url, body, step output or run log
//   - /approvals/:id/resolve accepts it from loopback only, for that
//     agent's own agent-closable card, and records how the card was closed
//   - no proof, another agent's proof, an ended proof: 403, card stays open

// The registry the action.run handler reads, filled per test.
const registry = vi.hoisted(() => ({ actions: new Map<string, unknown>() }))
vi.mock("../src/actions/store", () => ({
  ActionStore: class { get(id: string) { return registry.actions.get(id) ?? null } },
}))

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "step-proof-")); registry.actions.clear() })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const raise = (raisedBy = "alpha", extra: Record<string, unknown> = {}) => {
  const r = createCard(root, {
    title: "Ship the fix", ask: "Ship it?", recommend: "Yes: tested", if_silent: "discard", raised_by: raisedBy, ...extra,
  }, {})
  if (!r.ok) throw new Error(r.error)
  return r.card
}

const deps = (proofs: StepProofs, headers: Record<string, string>, fromLoopback = true) => ({
  ctx: { root },
  settings: DEFAULT_CARD_SETTINGS,
  hasAgent: (id: string) => id === "alpha" || id === "beta",
  provenAgent: () => null,
  provenStep: () => provenStep(proofs, { headers, fromLoopback }),
})
const close = (id: string, body: Record<string, unknown>, d: ReturnType<typeof deps>) =>
  handleApprovalsApi("POST", `/approvals/${id}/resolve`, body, new URLSearchParams(), d)

describe("the step proof store", () => {
  it("knows a token only while it lives, and keeps no token itself", () => {
    let now = 1_000
    const proofs = new StepProofs(() => now)
    const m = proofs.mint({ runId: "r1", nodeId: "n1", workflowId: "w", agentId: "alpha" }, 5_000)
    expect(m.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(proofs.check(m.token)).toMatchObject({ agentId: "alpha", runId: "r1", nodeId: "n1" })
    expect(JSON.stringify([...(proofs as any).live.entries()])).not.toContain(m.token)
    expect(proofs.check(m.token + "x")).toBeNull()
    expect(proofs.check("")).toBeNull()
    expect(proofs.check(undefined)).toBeNull()
    now += 5_000
    expect(proofs.check(m.token)).toBeNull()
    const m2 = proofs.mint({ runId: "r1", nodeId: "n1", workflowId: "w", agentId: "alpha" }, 5_000)
    m2.revoke(); m2.revoke()
    expect(proofs.check(m2.token)).toBeNull()
    expect(proofs.size).toBe(0)
  })

  it("acts for the run's starter, else the workflow owner, and only for an agent of this node", () => {
    const proofs = new StepProofs()
    const mint = stepProofMinter(proofs, (id) => id === "alpha" || id === "beta")
    const step = (startedBy?: string, ownerAgent?: string) =>
      mint({ workflow: { id: "w", ownerAgent }, run: { id: "r", meta: startedBy ? { startedBy } : {} }, node: { id: "n" } }, 1_000)
    expect(proofs.check(step(undefined, "alpha")!.token)?.agentId).toBe("alpha")
    expect(proofs.check(step("beta", "alpha")!.token)?.agentId).toBe("beta")
    expect(step(undefined, undefined)).toBeNull()
    expect(step(undefined, "ghost")).toBeNull()
  })

  it("a request proves a step only with the header and from this machine", () => {
    const proofs = new StepProofs()
    const { token } = proofs.mint({ runId: "r", nodeId: "n", workflowId: "w", agentId: "alpha" }, 1_000)
    expect(provenStep(proofs, { headers: { "x-agentx-step": token }, fromLoopback: true })?.agentId).toBe("alpha")
    expect(provenStep(proofs, { headers: { "x-agentx-step": token }, fromLoopback: false })).toBeNull()
    expect(provenStep(proofs, { headers: {}, fromLoopback: true })).toBeNull()
    expect(provenStep(proofs, { headers: { "x-agentx-step": "forged" }, fromLoopback: true })).toBeNull()
  })
})

describe("the action runner hands the proof to the action only", () => {
  // Printed backwards: the token itself is masked in captured output.
  const REVERSED = "node -e 'process.stdout.write((process.env.AGENTX_STEP_PROOF || \"\").split(\"\").reverse().join(\"\"))'"
  const shell = (extra: Record<string, unknown> = {}): Action =>
    // The script reads the env var itself, as the CX scripts do: a
    // `$AGENTX_STEP_PROOF` written in the command is filled from the
    // daemon's own env (empty), so the token never shows on a command line.
    actionSchema.parse({ id: "probe", title: "Probe", kind: "shell", command: REVERSED, ...extra })

  it("shell: in AGENTX_STEP_PROOF, which the action's own env cannot replace", async () => {
    expect((await runAction(actionSchema.parse({ id: "probe", title: "Probe", kind: "shell", command: "printf %s \"$AGENTX_STEP_PROOF\"" }), {}, { stepProof: "tok-1" })).output).toBe("")
    expect((await runAction(shell(), {}, { stepProof: "tok-1" })).output).toBe("1-kot")
    expect((await runAction(shell({ env: { AGENTX_STEP_PROOF: "fake" } }), {}, { stepProof: "tok-1" })).output).toBe("1-kot")
    expect((await runAction(shell({ env: { AGENTX_STEP_PROOF: "fake" } }), {})).output).toBe("")
    expect((await runAction(shell(), {})).output).toBe("")
  })

  it("masks the proof in what the step prints or the daemon answers (#1852)", async () => {
    const token = "tok-secret-0123456789"
    const echo = actionSchema.parse({ id: "echo", title: "Echo", kind: "shell", command: "env | grep AGENTX_STEP_PROOF; node -e 'console.error(process.env.AGENTX_STEP_PROOF); process.exit(3)'" })
    const r = await runAction(echo, {}, { stepProof: token })
    expect(r.ok).toBe(false)
    expect(r.output).toBe(`AGENTX_STEP_PROOF=${STEP_PROOF_MASK}\n`)
    expect(r.errors).toBe(`${STEP_PROOF_MASK}\n`)
    expect(JSON.stringify(r)).not.toContain(token)
    // Filling the buffer does not leave half a token at the cut.
    const flood = actionSchema.parse({ id: "flood", title: "Flood", kind: "shell", command: "node -e 'const t = process.env.AGENTX_STEP_PROOF; process.stdout.write(\"x\".repeat(32 * 1024 - 10) + t)'" })
    const cut = await runAction(flood, {}, { stepProof: token })
    expect(cut.output).not.toContain(token.slice(0, 6))
    // An http answer that echoes the header back is masked too.
    const server: Server = createServer((req, res) => { res.end(`you sent ${req.headers["x-agentx-step"]}`) })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    try {
      const port = (server.address() as { port: number }).port
      const http = actionSchema.parse({ id: "h", title: "H", kind: "http", method: "POST", url: `http://127.0.0.1:${port}/`, headers: { "X-AgentX-Step": "{{agentx_step_proof}}" } })
      expect((await runAction(http, {}, { stepProof: token })).output).toBe(`you sent ${STEP_PROOF_MASK}`)
    } finally {
      server.close()
    }
    expect(maskStepProof("a tok b tok", "tok")).toBe(`a ${STEP_PROOF_MASK} b ${STEP_PROOF_MASK}`)
    expect(maskStepProof("plain", undefined)).toBe("plain")
  })

  it("http: in a header that names {{agentx_step_proof}}, never in the url or body", async () => {
    const seen: IncomingMessage[] = []
    const bodies: string[] = []
    let redirectTo = ""
    const server: Server = createServer((req, res) => {
      seen.push(req); let b = ""
      req.on("data", (c) => { b += c })
      req.on("end", () => {
        bodies.push(b)
        if (req.url === "/redirect") { res.statusCode = 302; res.setHeader("Location", redirectTo); res.end(); return }
        res.end("ok")
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as { port: number }).port
    try {
      const action = actionSchema.parse({
        id: "probe", title: "Probe", kind: "http", method: "POST",
        url: `http://127.0.0.1:${port}/x?p={{agentx_step_proof}}`,
        headers: { "X-AgentX-Step": "{{agentx_step_proof}}" },
        body: "{\"p\":\"{{agentx_step_proof}}\",\"q\":\"{{q}}\"}",
        inputs: [{ name: "q" }, { name: "agentx_step_proof" }],
      })
      await runAction(action, { q: "1", agentx_step_proof: "fake" }, { stepProof: "tok-2" })
      expect(seen[0].headers["x-agentx-step"]).toBe("tok-2")
      expect(seen[0].url).not.toContain("tok-2")
      expect(bodies[0]).not.toContain("tok-2")
      await runAction(action, { q: "1" })
      expect(seen[1].headers["x-agentx-step"] ?? "").toBe("")
      // A redirect does not carry it on: the action sees the 3xx itself.
      const hop = actionSchema.parse({ ...action, id: "hop", url: `http://127.0.0.1:${port}/redirect`, body: undefined, inputs: [] })
      const before = seen.length
      redirectTo = `http://127.0.0.1:${port}/elsewhere`
      expect((await runAction(hop, {}, { stepProof: "tok-3" })).status).toBe(302)
      expect(seen.length).toBe(before + 1)
    } finally {
      server.close()
    }
  })

  it("http: only to this machine's loopback address", () => {
    expect(isLoopbackUrl("http://127.0.0.1:18800/approvals/x/resolve")).toBe(true)
    expect(isLoopbackUrl("http://localhost:18800/")).toBe(true)
    expect(isLoopbackUrl("http://[::1]:18800/")).toBe(true)
    expect(isLoopbackUrl("https://example.com/")).toBe(false)
    expect(isLoopbackUrl("http://127.0.0.1.example.com/")).toBe(false)
    expect(isLoopbackUrl("http://100.64.0.1:18800/")).toBe(false)
    expect(isLoopbackUrl("not a url")).toBe(false)
  })
})

describe("closing a card with a step proof", () => {
  it("the owner agent's step closes its card; the card records the step", () => {
    const proofs = new StepProofs()
    const c = raise("alpha")
    const { token } = proofs.mint({ runId: "run-1", nodeId: "prodok", workflowId: "w", agentId: "alpha" }, 60_000)
    const r = close(c.id, { reason: "answered on the CX page, shipped" }, deps(proofs, { "x-agentx-step": token }))
    expect(r.status).toBe(200)
    expect(readCard(root, c.id)).toMatchObject({
      status: "resolved", decided_by: "alpha", resolution: "answered on the CX page, shipped",
      closed_via: { kind: "workflow-step", runId: "run-1", nodeId: "prodok" },
    })
    expect(JSON.stringify(readCard(root, c.id))).not.toContain(token)
  })

  it("refuses another agent's step, no proof, an ended proof, a remote call and a body naming someone else", () => {
    const proofs = new StepProofs()
    const c = raise("alpha")
    const beta = proofs.mint({ runId: "r", nodeId: "n", workflowId: "w", agentId: "beta" }, 60_000)
    expect(close(c.id, { reason: "done" }, deps(proofs, { "x-agentx-step": beta.token })).status).toBe(403)
    expect(close(c.id, { reason: "done" }, deps(proofs, {})).status).toBe(403)
    expect(close(c.id, { raised_by: "alpha", reason: "done" }, deps(proofs, {})).status).toBe(403)
    expect(close(c.id, { reason: "done" }, deps(proofs, { "x-agentx-step": "guessed" })).status).toBe(403)
    const alpha = proofs.mint({ runId: "r", nodeId: "n", workflowId: "w", agentId: "alpha" }, 60_000)
    expect(close(c.id, { reason: "done" }, deps(proofs, { "x-agentx-step": alpha.token }, false)).status).toBe(403)
    expect(close(c.id, { raised_by: "beta", reason: "done" }, deps(proofs, { "x-agentx-step": alpha.token })).status).toBe(403)
    alpha.revoke()
    expect(close(c.id, { reason: "done" }, deps(proofs, { "x-agentx-step": alpha.token })).status).toBe(403)
    expect(readCard(root, c.id)?.status).toBe("pending")
  })

  it("never closes a card a workflow ask step raised (operator only)", () => {
    const proofs = new StepProofs()
    const c = raise("alpha")
    saveCard(root, { ...c, origin: { kind: "workflow", runId: "r1", nodeId: "ask" } })
    const { token } = proofs.mint({ runId: "r", nodeId: "n", workflowId: "w", agentId: "alpha" }, 60_000)
    expect(close(c.id, { reason: "done" }, deps(proofs, { "x-agentx-step": token })).status).toBe(409)
  })

  it("opens nothing else: deciding a card stays operator-only", () => {
    const proofs = new StepProofs()
    const c = raise("alpha")
    const { token } = proofs.mint({ runId: "r", nodeId: "n", workflowId: "w", agentId: "alpha" }, 60_000)
    const r = handleApprovalsApi("POST", `/approvals/${c.id}`, { verdict: "yes" }, new URLSearchParams(), deps(proofs, { "x-agentx-step": token }))
    expect(r.status).toBe(403)
    expect(readCard(root, c.id)?.status).toBe("pending")
  })
})

describe("closing a forwarded card with a step proof (approvals.forwardTo)", () => {
  // The card lives on the operator's node (opRoot); this node (root) only
  // forwarded it. The daemon runs the local handler first (404: not here),
  // then closeForwardedCard with the same proof deps.
  let opRoot: string
  beforeEach(() => { opRoot = mkdtempSync(join(tmpdir(), "step-proof-op-")) })
  afterEach(() => rmSync(opRoot, { recursive: true, force: true }))

  const operator = (async (url: string, init: RequestInit) => {
    const r = handleApprovalsApi(init.method ?? "GET", new URL(url).pathname, JSON.parse(String(init.body)), new URLSearchParams(), {
      ctx: { root: opRoot }, settings: DEFAULT_CARD_SETTINGS,
      hasAgent: () => false, hasPeer: (n: string) => n === "worker", tokenPeerIs: (n: string) => n === "worker",
    })
    return new Response(JSON.stringify(r.body), { status: r.status })
  }) as unknown as typeof fetch
  const forward = { self: "worker", peer: { name: "hq", url: "http://10.0.0.2:18800", token: "t" }, fetch: operator }
  const forwarded = async (proofs: StepProofs, headers: Record<string, string>, body: Record<string, unknown>, fromLoopback = true) => {
    const d = deps(proofs, headers, fromLoopback)
    const id = (await forwardCard({ title: "Ship the fix", ask: "Ship it?", recommend: "Yes: tested", if_silent: "discard", raised_by: "alpha" }, forward)).body as { card: { id: string } }
    const local = close(id.card.id, body, d)
    if (local.status !== 404) return { local, remote: null, id: id.card.id }
    return { local, remote: await closeForwardedCard(id.card.id, body, d, forward), id: id.card.id }
  }

  it("the owner agent's step closes its forwarded card on the operator's node", async () => {
    const proofs = new StepProofs()
    const { token } = proofs.mint({ runId: "run-1", nodeId: "prodok", workflowId: "w", agentId: "alpha" }, 60_000)
    const { remote, id } = await forwarded(proofs, { "x-agentx-step": token }, { reason: "answered on the CX page, shipped" })
    expect(remote?.status).toBe(200)
    expect(remote?.via).toEqual({ kind: "workflow-step", runId: "run-1", nodeId: "prodok" })
    expect(readCard(opRoot, id)).toMatchObject({ status: "resolved", decided_by: "alpha", node: "worker" })
    expect(JSON.stringify(readCard(opRoot, id))).not.toContain(token)
  })

  it("refuses what a local close refuses: no proof, another agent's step, a remote call, a body naming someone else", async () => {
    const proofs = new StepProofs()
    const alpha = proofs.mint({ runId: "r", nodeId: "n", workflowId: "w", agentId: "alpha" }, 60_000)
    const beta = proofs.mint({ runId: "r", nodeId: "n", workflowId: "w", agentId: "beta" }, 60_000)
    const refused = [
      await forwarded(proofs, {}, { raised_by: "alpha", reason: "done" }),
      await forwarded(proofs, { "x-agentx-step": "guessed" }, { reason: "done" }),
      await forwarded(proofs, { "x-agentx-step": alpha.token }, { reason: "done" }, false),
      await forwarded(proofs, { "x-agentx-step": alpha.token }, { raised_by: "beta", reason: "done" }),
    ]
    for (const r of refused) {
      expect(r.local.status).toBe(403)
      expect(readCard(opRoot, r.id)?.status).toBe("pending")
    }
    // beta's step names beta: the operator's node refuses alpha's card for it.
    const other = await forwarded(proofs, { "x-agentx-step": beta.token }, { reason: "done" })
    expect(other.remote?.status).toBe(403)
    expect(readCard(opRoot, other.id)?.status).toBe("pending")
  })
})

describe("a workflow action.run step, end to end", () => {
  let server: Server
  let port = 0
  let proofs: StepProofs
  const replies: number[] = []

  beforeEach(async () => {
    proofs = new StepProofs()
    replies.length = 0
    // Stands in for the daemon's /approvals route on loopback.
    server = createServer((req, res) => {
      let b = ""
      req.on("data", (c) => { b += c })
      req.on("end", () => {
        const id = decodeURIComponent(/^\/approvals\/([^/]+)\/resolve$/.exec(req.url ?? "")?.[1] ?? "")
        const headers = req.headers as Record<string, string>
        const r = close(id, JSON.parse(b || "{}"), deps(proofs, headers, true))
        replies.push(r.status)
        res.statusCode = r.status
        res.end(JSON.stringify(r.body))
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    port = (server.address() as { port: number }).port
  })
  afterEach(() => new Promise<void>((r) => server.close(() => r())))

  async function runStep(ownerAgent: string | undefined, cardId: string) {
    registry.actions.set("close-card", actionSchema.parse({
      id: "close-card", title: "Close card", kind: "http", method: "POST",
      url: `http://127.0.0.1:${port}/approvals/${cardId}/resolve`,
      headers: { "Content-Type": "application/json", "X-AgentX-Step": "{{agentx_step_proof}}" },
      body: "{\"reason\":\"answered on the CX page\"}",
      timeoutMs: 5_000,
    }))
    const dir = join(root, "wf")
    const store = new WorkflowStore({ baseDir: dir })
    store.save(workflowSchema.parse({
      id: "ship", title: "Ship", ...(ownerAgent ? { ownerAgent } : {}),
      nodes: [
        { id: "start", type: "trigger.manual", config: {} },
        { id: "prodok", type: "action.run", config: { actionId: "close-card" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "start", to: "prodok" }, { from: "prodok", to: "done" }],
    }))
    const runs = new RunStore({ baseDir: dir, nodeId: "node-a" })
    const ttls: number[] = []
    const minter = stepProofMinter(proofs, (id) => id === "alpha" || id === "beta")
    const dispatcher = new WorkflowDispatcher({
      store, runs, nodeId: "node-a", channels: {},
      agents: { execute: async () => ({ content: "" }) },
      stepProof: (step, ttl) => { ttls.push(ttl); return minter(step, ttl) },
    })
    await dispatcher.dispatchWorkflow({
      workflowId: "ship", trigger: { source: "manual" },
      entityRef: { backend: "manual", id: `ship@${cardId}` }, event: { id: `m:${cardId}`, payload: {} },
    })
    for (let i = 0; i < 100; i++) {
      const [run] = runs.list({ workflowId: "ship" })
      if (run && run.status !== "running") break
      await new Promise((r) => setTimeout(r, 20))
    }
    const [run] = runs.list({ workflowId: "ship" })
    const logs = readdirSync(resolve(dir, "_runs")).map((f) => readFileSync(resolve(dir, "_runs", f), "utf-8")).join("\n")
    return { run, ttls, logs }
  }

  it("the owner's step closes its card, and the proof dies with the step", async () => {
    const c = raise("alpha")
    const { run, ttls, logs } = await runStep("alpha", c.id)
    expect(replies).toEqual([200])
    expect(ttls).toEqual([5_000 + STEP_PROOF_GRACE_MS])
    expect(readCard(root, c.id)).toMatchObject({
      status: "resolved", decided_by: "alpha", closed_via: { kind: "workflow-step", runId: run.id, nodeId: "prodok" },
    })
    expect(proofs.size).toBe(0)
    expect(logs).not.toMatch(/[A-Za-z0-9_-]{43}/)
    expect(JSON.stringify(run.context)).not.toMatch(/[A-Za-z0-9_-]{43}/)
  })

  it("another agent's workflow step is refused", async () => {
    const c = raise("alpha")
    await runStep("beta", c.id)
    expect(replies).toEqual([403])
    expect(readCard(root, c.id)?.status).toBe("pending")
  })

  it("a workflow with no agent gets no proof and is refused", async () => {
    const c = raise("alpha")
    const { ttls } = await runStep(undefined, c.id)
    expect(ttls).toHaveLength(1)
    expect(replies).toEqual([403])
    expect(readCard(root, c.id)?.status).toBe("pending")
  })
})

describe("cancelling a run ends the proof of its running step", () => {
  it("revokes it at once, not at the action's timeout", async () => {
    const proofs = new StepProofs()
    const dir = join(root, "wf-cancel")
    const dispatcher = new WorkflowDispatcher({
      store: new WorkflowStore({ baseDir: dir }), runs: new RunStore({ baseDir: dir, nodeId: "node-a" }), nodeId: "node-a", channels: {},
      agents: { execute: async () => ({ content: "" }) },
      stepProof: stepProofMinter(proofs, (id) => id === "alpha"),
    })
    const mint = (runId: string) => (dispatcher as any).mintStepProof(
      { id: "w", ownerAgent: "alpha" }, { id: runId, meta: {} }, { id: "n", type: "action.run" }, 60_000)
    const a = mint("run-a")
    const b = mint("run-b")
    expect(proofs.check(a.token)).not.toBeNull()
    await dispatcher.cancelRun("run-a")
    expect(proofs.check(a.token)).toBeNull()
    expect(proofs.check(b.token)).not.toBeNull()
    b.revoke()
    expect(proofs.size).toBe(0)
    expect((dispatcher as any).liveProofs.size).toBe(0)
  })
})
