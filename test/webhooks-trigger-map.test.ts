import { describe, it, expect, beforeEach } from "vitest"
import { IncomingMessage as IM } from "http"
import { Socket } from "net"
import { WebhookHandler } from "../src/daemon/webhooks"

function makeReq(headers: Record<string, string>, body: string): IM {
  const req = new IM(new Socket())
  ;(req as any).headers = headers
  process.nextTick(() => {
    req.emit("data", Buffer.from(body))
    req.emit("end")
  })
  return req
}

class CapturingResponse {
  status?: number
  body?: string
  writeHead(status: number) { this.status = status }
  end(body: string) { this.body = body }
}

class StubDispatcher {
  calls: any[] = []
  async dispatchWorkflow(args: any) {
    this.calls.push(args)
    return { claimed: true, run: { id: "run-" + this.calls.length } }
  }
}

const fakeRegistry: any = {
  execute: async () => ({ content: "ok", duration: 0 }),
}

describe("webhook trigger map", () => {
  it("dispatches the workflow named in triggers[<event>]", async () => {
    const dispatcher = new StubDispatcher()
    const handler = new WebhookHandler(
      fakeRegistry,
      {},
      () => {},
      undefined,
      [{
        id: "gh-1",
        source: "github",
        agentId: "coder-agent",
        enabled: true,
        triggers: {
          "issues.opened": "wf-triage",
          "pull_request.opened": "wf-review",
        },
      }],
    )
    handler.setWorkflowDispatcher(dispatcher as any)
    const req = makeReq(
      { "x-github-event": "issues" },
      JSON.stringify({ action: "opened", number: 1 }),
    )
    const res = new CapturingResponse() as any
    await handler.handle(req, res, "/webhook/coder-agent")
    expect(res.status).toBe(202)
    expect(dispatcher.calls).toHaveLength(1)
    expect(dispatcher.calls[0].workflowId).toBe("wf-triage")
  })

  it("dispatches different workflows for different action variants", async () => {
    const dispatcher = new StubDispatcher()
    const handler = new WebhookHandler(
      fakeRegistry,
      {},
      () => {},
      undefined,
      [{
        id: "gh-1",
        source: "github",
        agentId: "coder-agent",
        enabled: true,
        triggers: {
          "issues.opened": "wf-triage",
          "issues.assigned": "wf-assign-handler",
        },
      }],
    )
    handler.setWorkflowDispatcher(dispatcher as any)

    const r1 = new CapturingResponse() as any
    await handler.handle(
      makeReq({ "x-github-event": "issues" }, JSON.stringify({ action: "opened" })),
      r1, "/webhook/coder-agent",
    )

    const r2 = new CapturingResponse() as any
    await handler.handle(
      makeReq({ "x-github-event": "issues" }, JSON.stringify({ action: "assigned" })),
      r2, "/webhook/coder-agent",
    )
    expect(dispatcher.calls.map(c => c.workflowId)).toEqual(["wf-triage", "wf-assign-handler"])
  })

  it("falls back to defaultWorkflow when no triggers entry matches", async () => {
    const dispatcher = new StubDispatcher()
    const handler = new WebhookHandler(
      fakeRegistry,
      {},
      () => {},
      undefined,
      [{
        id: "gh-1",
        source: "github",
        agentId: "coder-agent",
        enabled: true,
        triggers: { "issues.opened": "wf-triage" },
        defaultWorkflow: "wf-default",
      }],
    )
    handler.setWorkflowDispatcher(dispatcher as any)
    await handler.handle(
      makeReq({ "x-github-event": "push" }, JSON.stringify({ ref: "main" })),
      new CapturingResponse() as any, "/webhook/coder-agent",
    )
    expect(dispatcher.calls[0].workflowId).toBe("wf-default")
  })

  it("falls through to agent execute when triggers + defaultWorkflow both miss", async () => {
    const dispatcher = new StubDispatcher()
    const executes: any[] = []
    const reg: any = { execute: async (req: any) => { executes.push(req); return { content: "ok", duration: 0 } } }
    const handler = new WebhookHandler(
      reg,
      {},
      () => {},
      undefined,
      [{ id: "gh-1", source: "github", agentId: "coder-agent", enabled: true }],
    )
    handler.setWorkflowDispatcher(dispatcher as any)
    await handler.handle(
      makeReq({ "x-github-event": "issues" }, JSON.stringify({ action: "opened" })),
      new CapturingResponse() as any, "/webhook/coder-agent",
    )
    expect(dispatcher.calls).toHaveLength(0)
    expect(executes).toHaveLength(1)
  })

  it("respects backward compat: webhook without triggers uses agent path", async () => {
    const dispatcher = new StubDispatcher()
    const executes: any[] = []
    const reg: any = { execute: async (req: any) => { executes.push(req); return { content: "ok", duration: 0 } } }
    const handler = new WebhookHandler(
      reg,
      {},
      () => {},
      undefined,
      [], // no entries → no triggers, no defaultWorkflow
    )
    handler.setWorkflowDispatcher(dispatcher as any)
    await handler.handle(
      makeReq({ "x-github-event": "issues" }, JSON.stringify({ action: "opened" })),
      new CapturingResponse() as any, "/webhook/coder-agent",
    )
    expect(dispatcher.calls).toHaveLength(0)
    expect(executes).toHaveLength(1)
  })

  it("recognizes gitlab event-types", async () => {
    const dispatcher = new StubDispatcher()
    const handler = new WebhookHandler(
      fakeRegistry,
      {},
      () => {},
      undefined,
      [{
        id: "gl-1",
        source: "gitlab",
        agentId: "pm-ksi",
        enabled: true,
        triggers: { "Note Hook": "wf-note", "Merge Request Hook": "wf-mr" },
      }],
    )
    handler.setWorkflowDispatcher(dispatcher as any)
    await handler.handle(
      makeReq({ "x-gitlab-event": "Note Hook" }, "{}"),
      new CapturingResponse() as any, "/webhook/pm-ksi",
    )
    expect(dispatcher.calls[0].workflowId).toBe("wf-note")
  })
})
