import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createHmac } from "crypto"
import { IncomingMessage, ServerResponse } from "http"
import { Socket } from "net"
import { WebhookHandler } from "../src/daemon/webhooks"

function makeReq(headers: Record<string, string>, body: string): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  ;(req as any).headers = headers
  // Replay the body across the next event loop tick.
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

const fakeRegistry: any = {
  execute: async () => ({ content: "ok", duration: 0 }),
}

describe("WebhookHandler signature validation", () => {
  it("accepts a request with a valid GitHub signature", async () => {
    const secret = "whsec_test"
    const body = JSON.stringify({ action: "opened", number: 1 })
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
    const handler = new WebhookHandler(
      fakeRegistry,
      {},
      () => {},
      undefined,
      [{
        id: "gh-1",
        source: "github",
        agentId: "coder-agent",
        secretEnv: "TEST_GH_SECRET",
        enabled: true,
      }],
    )
    process.env.TEST_GH_SECRET = secret
    const req = makeReq({
      "x-github-event": "issues",
      "x-hub-signature-256": sig,
    }, body)
    const res = new CapturingResponse() as any
    await handler.handle(req, res, "/webhook/coder-agent")
    expect(res.status).toBe(200)
  })

  it("rejects 401 when the GitHub signature does not match", async () => {
    process.env.TEST_GH_SECRET = "whsec_test"
    const body = JSON.stringify({ action: "opened", number: 1 })
    const handler = new WebhookHandler(
      fakeRegistry,
      {},
      () => {},
      undefined,
      [{
        id: "gh-1",
        source: "github",
        agentId: "coder-agent",
        secretEnv: "TEST_GH_SECRET",
        enabled: true,
      }],
    )
    const req = makeReq({
      "x-github-event": "issues",
      "x-hub-signature-256": "sha256=ffff" + "0".repeat(60),
    }, body)
    const res = new CapturingResponse() as any
    await handler.handle(req, res, "/webhook/coder-agent")
    expect(res.status).toBe(401)
  })

  it("accepts a request with a valid GitLab token", async () => {
    process.env.TEST_GL_SECRET = "tok-1"
    const handler = new WebhookHandler(
      fakeRegistry,
      {},
      () => {},
      undefined,
      [{
        id: "gl-1",
        source: "gitlab",
        agentId: "pm-ksi",
        secretEnv: "TEST_GL_SECRET",
        enabled: true,
      }],
    )
    const req = makeReq({
      "x-gitlab-event": "Note Hook",
      "x-gitlab-token": "tok-1",
    }, "{}")
    const res = new CapturingResponse() as any
    await handler.handle(req, res, "/webhook/pm-ksi")
    expect(res.status).toBe(200)
  })

  it("rejects when secretEnv is configured but the env var is unset", async () => {
    delete process.env.MISSING_SECRET
    const handler = new WebhookHandler(
      fakeRegistry,
      {},
      () => {},
      undefined,
      [{
        id: "gh-1",
        source: "github",
        agentId: "coder-agent",
        secretEnv: "MISSING_SECRET",
        enabled: true,
      }],
    )
    const req = makeReq({ "x-github-event": "issues" }, "{}")
    const res = new CapturingResponse() as any
    await handler.handle(req, res, "/webhook/coder-agent")
    expect(res.status).toBe(401)
  })

  it("lets the request through when no webhook entry has a secretEnv", async () => {
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
      }],
    )
    const req = makeReq({ "x-github-event": "issues" }, "{}")
    const res = new CapturingResponse() as any
    await handler.handle(req, res, "/webhook/coder-agent")
    expect(res.status).toBe(200)
  })
})
