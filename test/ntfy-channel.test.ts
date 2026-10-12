import { describe, it, expect, vi, afterEach } from "vitest"
import { NtfyAdapter } from "../src/channels/ntfy"

function mockFetch(status = 200, body: unknown = { id: "msg-1" }) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }))
  ;(globalThis as any).fetch = fn
  return fn
}

const quiet = () => {}

afterEach(() => { vi.restoreAllMocks() })

describe("NtfyAdapter", () => {
  it("posts to the default topic and returns the message id", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "secret-topic" }, quiet)

    const id = await a.send({ channel: "ntfy", chatId: "", text: "something broke" })

    expect(id).toBe("msg-1")
    const [url, init] = fetchMock.mock.calls[0] as any
    expect(url).toBe("https://ntfy.sh/secret-topic")
    expect(init.method).toBe("POST")
    expect(init.body).toBe("something broke")
  })

  it("treats the \"default\" sentinel as the configured topic, so agents never carry it", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "secret-topic" }, quiet)

    await a.send({ channel: "ntfy", chatId: "default", text: "hi" })

    expect((fetchMock.mock.calls[0] as any)[0]).toBe("https://ntfy.sh/secret-topic")
  })

  it("routes to an explicit topic when chatId is set", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "fallback", server: "https://ntfy.example.com/" }, quiet)

    await a.send({ channel: "ntfy", chatId: "urgent", text: "hi" })

    expect((fetchMock.mock.calls[0] as any)[0]).toBe("https://ntfy.example.com/urgent")
  })

  it("promotes a short first line to the notification title", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "t" }, quiet)

    await a.send({ channel: "ntfy", chatId: "", text: "MR 214 needs review\nBlocked since Tuesday." })

    const init = (fetchMock.mock.calls[0] as any)[1]
    expect(init.headers["Title"]).toBe("MR 214 needs review")
    expect(init.body).toBe("Blocked since Tuesday.")
  })

  it("keeps a single-line message whole and falls back to the default title", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "t", defaultTitle: "Secretary" }, quiet)

    await a.send({ channel: "ntfy", chatId: "", text: "just one line" })

    const init = (fetchMock.mock.calls[0] as any)[1]
    expect(init.headers["Title"]).toBe("Secretary")
    expect(init.body).toBe("just one line")
  })

  it("does not steal a long first line as a title", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "t" }, quiet)
    const long = "x".repeat(100)

    await a.send({ channel: "ntfy", chatId: "", text: `${long}\nrest` })

    const init = (fetchMock.mock.calls[0] as any)[1]
    expect(init.headers["Title"]).toBe("AgentX")
    expect(init.body).toBe(`${long}\nrest`)
  })

  it("RFC 2047-encodes non-ASCII titles, which ntfy headers cannot carry raw", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "t" }, quiet)

    await a.send({ channel: "ntfy", chatId: "", text: "Échéance dépassée\nbody" })

    const title = (fetchMock.mock.calls[0] as any)[1].headers["Title"]
    expect(title).toMatch(/^=\?UTF-8\?B\?/)
    const b64 = title.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "")
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("Échéance dépassée")
  })

  it("maps url buttons onto ntfy view actions, capped at three", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "t" }, quiet)

    await a.send({
      channel: "ntfy", chatId: "", text: "check this",
      buttons: [
        { label: "Open MR", url: "https://gitlab.example.com/a/b/-/merge_requests/1" },
        { label: "Issue", url: "https://gitlab.example.com/a/b/-/issues/2" },
        { label: "Pipeline", url: "https://gitlab.example.com/a/b/-/pipelines/3" },
        { label: "Dropped", url: "https://example.com" },
      ],
    })

    const actions = (fetchMock.mock.calls[0] as any)[1].headers["Actions"]
    expect(actions.split(";")).toHaveLength(3)
    expect(actions).toContain("view, Open MR, https://gitlab.example.com/a/b/-/merge_requests/1")
    expect(actions).not.toContain("Dropped")
  })

  it("sends the access token for protected topics", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "t", token: "tk_123" }, quiet)

    await a.send({ channel: "ntfy", chatId: "", text: "hi" })

    expect((fetchMock.mock.calls[0] as any)[1].headers["Authorization"]).toBe("Bearer tk_123")
  })

  it("throws with the server's detail when ntfy rejects the publish", async () => {
    mockFetch(403, { error: "forbidden" })
    const a = new NtfyAdapter({ topic: "t" }, quiet)

    await expect(a.send({ channel: "ntfy", chatId: "", text: "hi" })).rejects.toThrow(/403/)
  })

  it("refuses to send when no topic is resolvable", async () => {
    mockFetch()
    const a = new NtfyAdapter({ topic: "" }, quiet)

    await expect(a.send({ channel: "ntfy", chatId: "", text: "hi" })).rejects.toThrow(/no topic/)
  })

  it("retries a network failure and logs its cause code (#930)", async () => {
    const timeout = Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } })
    const fn = vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "late" }), text: async () => "" })
    ;(globalThis as any).fetch = fn
    const lines: string[] = []
    const a = new NtfyAdapter({ topic: "t", retryDelaysMs: [0, 0] }, (m) => lines.push(String(m)))

    expect(await a.send({ channel: "ntfy", chatId: "", text: "hi" })).toBe("late")
    expect(fn).toHaveBeenCalledTimes(2)
    expect(lines.join("\n")).toMatch(/attempt 1\/3 failed \(ntfy: fetch failed code=ETIMEDOUT\)/)
  })

  it("gives up after the last retry, logs it and throws with the cause code", async () => {
    const timeout = Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } })
    const fn = vi.fn().mockRejectedValue(timeout)
    ;(globalThis as any).fetch = fn
    const lines: string[] = []
    const a = new NtfyAdapter({ topic: "t", retryDelaysMs: [0, 0] }, (m) => lines.push(String(m)))

    await expect(a.send({ channel: "ntfy", chatId: "", text: "hi" })).rejects.toThrow(/ETIMEDOUT/)
    expect(fn).toHaveBeenCalledTimes(3)
    expect(lines.some(l => /failed after 3 attempt/.test(l))).toBe(true)
  })

  it("retries a 503 or 429, but not a 500 or 4xx the server may have stored", async () => {
    const fn = mockFetch(503, { error: "busy" })
    const a = new NtfyAdapter({ topic: "t", retryDelaysMs: [0] }, quiet)
    await expect(a.send({ channel: "ntfy", chatId: "", text: "hi" })).rejects.toThrow(/503/)
    expect(fn).toHaveBeenCalledTimes(2)

    const fn429 = mockFetch(429, { error: "slow down" })
    const b = new NtfyAdapter({ topic: "t", retryDelaysMs: [0] }, quiet)
    await expect(b.send({ channel: "ntfy", chatId: "", text: "hi" })).rejects.toThrow(/429/)
    expect(fn429).toHaveBeenCalledTimes(2)

    for (const status of [500, 502, 403]) {
      const once = mockFetch(status, { error: "no" })
      const c = new NtfyAdapter({ topic: "t", retryDelaysMs: [0] }, quiet)
      await expect(c.send({ channel: "ntfy", chatId: "", text: "hi" })).rejects.toThrow(String(status))
      expect(once).toHaveBeenCalledTimes(1)
    }
  })

  it("does not re-post after the connection broke mid-request, so the phone never gets it twice", async () => {
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })
    const fn = vi.fn().mockRejectedValue(reset)
    ;(globalThis as any).fetch = fn
    const a = new NtfyAdapter({ topic: "t", retryDelaysMs: [0, 0] }, quiet)

    await expect(a.send({ channel: "ntfy", chatId: "", text: "hi" })).rejects.toThrow(/ECONNRESET/)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("stops retrying once the next wait would pass the send time limit", async () => {
    const timeout = Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } })
    const fn = vi.fn().mockRejectedValue(timeout)
    ;(globalThis as any).fetch = fn
    const lines: string[] = []
    const a = new NtfyAdapter({ topic: "t", retryDelaysMs: [0, 60_000], sendTimeoutMs: 1000 }, (m) => lines.push(String(m)))

    await expect(a.send({ channel: "ntfy", chatId: "", text: "hi" })).rejects.toThrow(/ETIMEDOUT/)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(lines.some(l => /failed after 2 attempt/.test(l))).toBe(true)
  })

  it("gives each request an abort signal bounded by the send time limit", async () => {
    const fn = mockFetch()
    const a = new NtfyAdapter({ topic: "t", sendTimeoutMs: 1000 }, quiet)

    await a.send({ channel: "ntfy", chatId: "", text: "hi" })

    expect((fn.mock.calls[0] as any)[1].signal).toBeInstanceOf(AbortSignal)
  })
})
