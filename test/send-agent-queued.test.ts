import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { readFileSync } from "fs"
import { join } from "path"
import { duplicateBody, queueSend, queuedBody, SendAgentDedupe, sendAgentKey, SEND_AGENT_DEDUPE_MS } from "../src/daemon/send-agent"
import { _handleToolCallForTesting, _resetDaemonUrlForTesting, sendAgentFetchError } from "../src/mcp/index"

// retro:01M4DJTC01FK0BVCMFKT5K4SRQ — #847: agentx_send_agent blocked for
// ~300 s on a long target task, reported "fetch failed" although the task
// was queued, and the retry created a duplicate.

describe("SendAgentDedupe", () => {
  it("returns the first body for a repeat inside the window, and forgets it after", () => {
    let now = 0
    const d = new SendAgentDedupe(SEND_AGENT_DEDUPE_MS, 10, () => now)
    const key = sendAgentKey("front", "devops", "deploy the fix")
    d.put(key, queuedBody("snd-1", "devops"))
    now = SEND_AGENT_DEDUPE_MS - 1
    expect(d.get(key)?.taskId).toBe("snd-1")
    now = SEND_AGENT_DEDUPE_MS + 1
    expect(d.get(key)).toBeNull()
  })

  it("keys on sender, target and text, and never holds the text", () => {
    const k = sendAgentKey("front", "devops", "secret deploy token abc")
    expect(k).not.toContain("secret")
    expect(sendAgentKey("other", "devops", "secret deploy token abc")).not.toBe(k)
    expect(sendAgentKey("front", "builder", "secret deploy token abc")).not.toBe(k)
    expect(sendAgentKey("front", "devops", "something else")).not.toBe(k)
  })

  it("is bounded", () => {
    const d = new SendAgentDedupe(SEND_AGENT_DEDUPE_MS, 2)
    d.put("a", { taskId: "a" }); d.put("b", { taskId: "b" }); d.put("c", { taskId: "c" })
    expect(d.get("a")).toBeNull()
    expect(d.get("c")?.taskId).toBe("c")
  })
})

describe("queueSend", () => {
  it("answers at once while the target's turn is still running, and logs the outcome later", async () => {
    const logs: string[] = []
    let finish!: () => void
    const running = new Promise<{ ok: boolean }>((r) => { finish = () => r({ ok: true }) })
    const started = Date.now()
    const body = queueSend({ agent: "devops", run: () => running, log: (m) => logs.push(m), newId: () => "X1" })
    expect(Date.now() - started).toBeLessThan(100)
    expect(body).toMatchObject({ accepted: true, status: "queued", taskId: "snd-X1", agent: "devops" })
    expect(logs).toEqual(["[send/agent] snd-X1 → devops queued"])
    finish()
    await new Promise((r) => setTimeout(r, 0))
    expect(logs[1]).toBe("[send/agent] snd-X1 → devops done")
  })

  it("logs a run that throws instead of letting it escape", async () => {
    const logs: string[] = []
    queueSend({ agent: "builder", peer: "vps", run: async () => { throw new Error("peer gone") }, log: (m) => logs.push(m), newId: () => "X2" })
    await new Promise((r) => setTimeout(r, 0))
    expect(logs[1]).toBe("[send/agent] snd-X2 → builder@vps failed: peer gone")
  })
})

describe("POST /send/agent through agentx_send_agent", () => {
  // A stand-in daemon built from the same helpers the real route uses. The
  // target's turn (a long DevOps task) never finishes during the test.
  let server: Server
  let runs = 0
  const dedupe = new SendAgentDedupe()
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ""
      req.on("data", (c) => { raw += c })
      req.on("end", () => {
        const body = JSON.parse(raw)
        const key = sendAgentKey(body.senderAgentId, body.agentId, body.text)
        const seen = dedupe.get(key)
        const answer = seen
          ? duplicateBody(seen)
          : queueSend({ agent: body.agentId, log: () => {}, run: () => { runs++; return new Promise(() => {}) } })
        if (!seen) dedupe.put(key, answer)
        res.writeHead(202, { "Content-Type": "application/json" })
        res.end(JSON.stringify(answer))
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    process.env.AGENTX_DAEMON_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    _resetDaemonUrlForTesting()
  })
  afterAll(() => {
    delete process.env.AGENTX_DAEMON_URL
    _resetDaemonUrlForTesting()
    server.close()
  })

  it("returns a task id within 5 s for a long-running target", async () => {
    const started = Date.now()
    const out = await _handleToolCallForTesting("agentx_send_agent", { agentId: "devops", text: "roll out the fix", senderAgentId: "front" })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(out.content[0].text).toMatch(/Queued for devops \(task snd-[0-9A-Z]+\)/)
  })

  it("a retry returns the existing task id instead of a second task", async () => {
    const args = { agentId: "devops", text: "check the dev session", senderAgentId: "front" }
    const first = await _handleToolCallForTesting("agentx_send_agent", args)
    const before = runs
    const again = await _handleToolCallForTesting("agentx_send_agent", args)
    const id = first.content[0].text.match(/task (snd-[0-9A-Z]+)/)![1]
    expect(again.content[0].text).toContain(`Already sent (task ${id})`)
    expect(runs).toBe(before)
  })
})

describe("sendAgentFetchError", () => {
  it("reports a timeout after the request went out as probably delivered, with a lookup hint", () => {
    const e = new DOMException("The operation was aborted due to timeout", "TimeoutError")
    const msg = sendAgentFetchError("devops", e)
    expect(msg).toMatch(/^Probably delivered to devops/)
    expect(msg).toContain("agentx trace list --agent devops")
    expect(msg).toContain("send the same message again")
    expect(msg).not.toMatch(/^Error/)
  })

  it("reports an unreachable daemon as not sent", () => {
    const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })
    expect(sendAgentFetchError("devops", e)).toMatch(/^Error: .*not sent/)
  })

  it("a hung daemon is cut off by a short client timeout", async () => {
    const hung = createServer(() => { /* never answers */ })
    await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r))
    const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}/send/agent`
    const started = Date.now()
    const msg = await fetch(url, { method: "POST", body: "{}", signal: AbortSignal.timeout(200) })
      .then(() => "answered", (e) => sendAgentFetchError("devops", e))
    expect(Date.now() - started).toBeLessThan(5000)
    expect(msg).toMatch(/^Probably delivered/)
    hung.closeAllConnections()
    hung.close()
  })
})

describe("the daemon route", () => {
  const src = readFileSync(join(__dirname, "../src/daemon/index.ts"), "utf-8")
  const route = src.slice(src.indexOf('case "POST /send/agent"'), src.indexOf('case "POST /send/contact"'))

  it("queues local and mesh sends unless the caller asked to wait", () => {
    expect(route.match(/queueSend\(/g)?.length).toBe(2)
    expect(route).toContain('const wait = body.async === false')
    expect(route.match(/if \(wait\)/g)?.length).toBe(2)
  })

  it("checks the dedupe window before starting anything", () => {
    expect(route.indexOf("this.sendAgentDedupe.get(")).toBeLessThan(route.indexOf("this.delegationGate("))
    expect(route).toContain("retro:01M4DJTC01FK0BVCMFKT5K4SRQ")
  })
})
