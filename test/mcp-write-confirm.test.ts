import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { decideCard, listCards } from "../src/approvals/cards"
import { isReadToolName, mcpWriteNeedingConfirm } from "../src/agent/mcp-policy"
import { mcpWriteDenial } from "../src/agent/mcp-confirm"
import { startMcpPool } from "../src/agent/mcp-client"
import { toWorkspaceMcp } from "../src/agents/agent-mcp"

// #1736: a write tool on an MCP server's allowTools list waits for one
// Approvals card. Yes runs it; no, or no answer, does not. Reads run.

describe("isReadToolName", () => {
  it("reads when the first verb reads and no write verb follows", () => {
    for (const t of ["FACEBOOK_GET_PAGE_INSIGHTS", "YOUTUBE_QUERY_YOUTUBE_ANALYTICS", "list_posts", "getPost", "GET_RUN_STATUS", "search"]) {
      expect(isReadToolName(t), t).toBe(true)
    }
  })

  it("writes on a write verb, a noun-verb first, or no known verb", () => {
    for (const t of ["FACEBOOK_CREATE_POST", "INSTAGRAM_POST_MEDIA", "sendMessage", "SEARCH_AND_DELETE", "MARK_AS_READ", "ANALYZE", "upload_video", "GET_OR_CREATE_CONTACT"]) {
      expect(isReadToolName(t), t).toBe(false)
    }
  })
})

describe("mcpWriteNeedingConfirm", () => {
  const servers = {
    social: { allowTools: ["GET_*", "CREATE_POST", "SUMMARIZE_WEEK"], readTools: ["SUMMARIZE_*"] },
    open: {},
  }

  it("gates a listed write tool only", () => {
    expect(mcpWriteNeedingConfirm("mcp__social__CREATE_POST", servers)).toEqual({ server: "social", tool: "CREATE_POST" })
    expect(mcpWriteNeedingConfirm("mcp__social__GET_INSIGHTS", servers)).toBeNull()
  })

  it("skips readTools, unlisted tools, servers without a list and non-MCP tools", () => {
    expect(mcpWriteNeedingConfirm("mcp__social__SUMMARIZE_WEEK", servers)).toBeNull()
    expect(mcpWriteNeedingConfirm("mcp__social__DELETE_POST", servers)).toBeNull() // refused by the allow list instead
    expect(mcpWriteNeedingConfirm("mcp__open__DELETE_ALL", servers)).toBeNull()
    expect(mcpWriteNeedingConfirm("Bash", servers)).toBeNull()
    expect(mcpWriteNeedingConfirm("mcp__social__CREATE_POST", undefined)).toBeNull()
  })

  it("readTools never reaches .mcp.json", () => {
    const out = toWorkspaceMcp({ social: { type: "http", url: "https://mcp.example.com", allowTools: ["GET_*"], readTools: ["X"] } as any })
    expect(out.social).not.toHaveProperty("readTools")
    expect(out.social).not.toHaveProperty("allowTools")
  })
})

describe("mcpWriteDenial", () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ax-mcp-confirm-")) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const servers = { social: { allowTools: ["GET_*", "CREATE_POST"] } }

  /** A clock that moves by each sleep, and a hook to answer mid-wait. */
  function harness(answer?: (cardId: string) => void) {
    let t = Date.parse("2026-11-02T10:00:00Z")
    let answered = false
    return {
      root,
      agentId: "demo-agent",
      waitMs: 60_000,
      pollMs: 1_000,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
        if (answer && !answered) {
          answered = true
          answer(listCards(root, "pending")[0].id)
        }
      },
    }
  }

  it("a read tool runs with no card", async () => {
    expect(await mcpWriteDenial("mcp__social__GET_INSIGHTS", {}, servers, harness())).toBeNull()
    expect(listCards(root)).toHaveLength(0)
  })

  it("yes: one card, and the call runs", async () => {
    const deps = harness((id) => expect(decideCard(root, id, "yes").ok).toBe(true))
    expect(await mcpWriteDenial("mcp__social__CREATE_POST", { text: "Hello" }, servers, deps)).toBeNull()
    const cards = listCards(root)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ status: "decided", verdict: "yes", raised_by: "demo-agent", origin: { kind: "mcp-write", server: "social", tool: "CREATE_POST" } })
    expect(cards[0].context).toContain('"text":"Hello"')
  })

  it("no: the call does not run", async () => {
    const deps = harness((id) => decideCard(root, id, "no"))
    const r = await mcpWriteDenial("mcp__social__CREATE_POST", {}, servers, deps)
    expect(r).toMatch(/owner said no/)
    expect(listCards(root)).toHaveLength(1)
  })

  it("silent: the wait ends, the card closes, and the call does not run", async () => {
    const r = await mcpWriteDenial("mcp__social__CREATE_POST", {}, servers, harness())
    expect(r).toMatch(/not answered within 1 min/)
    const [card] = listCards(root)
    expect(card).toMatchObject({ status: "expired", outcome: "discard" })
    // A late yes is refused: the card is closed.
    expect(decideCard(root, card.id, "yes").ok).toBe(false)
  })

  it("a card that cannot be raised refuses the call", async () => {
    writeFileSync(join(root, ".agentx"), "not a folder")
    const r = await mcpWriteDenial("mcp__social__CREATE_POST", {}, servers, harness())
    expect(r).toMatch(/was not run/)
  })

  it("keeps the shown input short", async () => {
    const deps = harness((id) => decideCard(root, id, "no"))
    await mcpWriteDenial("mcp__social__CREATE_POST", { text: "x".repeat(5000) }, servers, deps)
    expect(listCards(root)[0].context!.length).toBeLessThanOrEqual(600)
  })
})

describe("startMcpPool beforeCall (orchestrator tier)", () => {
  const MOCK = `
let buf = ""
process.stdin.setEncoding("utf-8")
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n")
    if (msg.method === "initialize") reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "m", version: "0" } })
    else if (msg.method === "tools/list") reply({ tools: [{ name: "CREATE_POST", description: "", inputSchema: { type: "object" } }] })
    else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: "posted" }] })
  }
})`
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ax-mcp-pool-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it("a refusal stops the call; null lets it through", async () => {
    const script = join(dir, "m.mjs")
    writeFileSync(script, MOCK)
    let refuse: string | null = "no from the owner"
    const pool = await startMcpPool(
      { social: { command: process.execPath, args: [script], allowTools: ["CREATE_POST"] } },
      { beforeCall: async () => refuse },
    )
    try {
      expect(await pool.dispatch("mcp__social__CREATE_POST", {})).toEqual({ content: "no from the owner", isError: true })
      refuse = null
      expect((await pool.dispatch("mcp__social__CREATE_POST", {})).content).toBe("posted")
    } finally {
      pool.close()
    }
  })
})
