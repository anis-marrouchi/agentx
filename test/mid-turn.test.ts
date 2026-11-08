import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import http from "http"
import { execFile } from "child_process"
import { MidTurnInbox, midTurnKey, midTurnContext, hookOutput, midTurnChannel, midTurnChat, MID_TURN_MARKER } from "../src/agents/mid-turn"
import { MessageQueue } from "../src/agents/message-queue"
import { midTurnHookCommand, patchGuardrails } from "../src/agents/workspace-setup"

const KEY = midTurnKey("coder", "app", "chat-1")

describe("MidTurnInbox", () => {
  it("hands every waiting message of a chat once, oldest first, and remembers they were taken", () => {
    const inbox = new MidTurnInbox()
    const a = inbox.offer(KEY, "run-1", "not that file, the other one", "owner")
    const b = inbox.offer(KEY, "run-1", "and keep the old name", "owner")
    inbox.offer(midTurnKey("coder", "app", "chat-2"), "run-2", "other chat", "owner")
    expect(inbox.take(KEY).map((e) => e.id)).toEqual([a.id, b.id])
    expect(inbox.take(KEY)).toEqual([])
    expect(inbox.isTaken(a.id)).toBe(true)
    expect(inbox.pending(midTurnKey("coder", "app", "chat-2"))).toBe(1)
  })

  it("drops what a run never took when its chat's run ends", () => {
    const inbox = new MidTurnInbox()
    const a = inbox.offer(KEY, "run-1", "late", "owner")
    inbox.endChat(KEY)
    expect(inbox.take(KEY)).toEqual([])
    expect(inbox.isTaken(a.id)).toBe(false)
  })

  it("never offers internal turns", () => {
    expect(midTurnChannel("app")).toBe(true)
    expect(midTurnChannel("telegram")).toBe(true)
    for (const c of ["requests", "cron", "workflow", "events", undefined]) expect(midTurnChannel(c)).toBe(false)
  })

  it("never offers a sender-less agent send to the run in the shared a2a chat", () => {
    // /send/agent with no senderAgentId uses chatId "a2a": two such sends
    // are unrelated, so the second must run as its own turn.
    expect(midTurnChat("a2a", "a2a")).toBe(false)
    expect(midTurnChat("a2a", "planner")).toBe(true)
    expect(midTurnChat("app", "a2a")).toBe(true)
    expect(midTurnChat("app", "chat-1")).toBe(true)
    expect(midTurnChat("cron", "chat-1")).toBe(false)
    expect(midTurnChat("app", undefined)).toBe(false)
  })

  it("tells the model what arrived and to say what it did about it", () => {
    const inbox = new MidTurnInbox({ now: () => Date.parse("2026-11-08T10:05:00Z") })
    inbox.offer(KEY, "r", "stop, use the staging database", "Owner")
    const text = midTurnContext(inbox.take(KEY))
    expect(text.startsWith(MID_TURN_MARKER)).toBe(true)
    expect(text).toContain("10:05Z, Owner: stop, use the staging database")
    expect(text).toContain("say that you saw it")
    expect(hookOutput([])).toBe("")
    const out = JSON.parse(hookOutput([{ id: "x", key: KEY, runId: "r", text: "hi", from: "Owner", at: 0 }]))
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse")
    expect(out.hookSpecificOutput.additionalContext).toContain("hi")
  })
})

describe("the queue and mid-turn messages", () => {
  it("does not run again a message the running turn took, and runs the others", async () => {
    const q = new MessageQueue()
    const taken = new Set(["mt-1"])
    q.wasTaken = (id) => taken.has(id)
    q.markRunning("coder", "app", "chat-1")
    q.enqueue("coder", "app", "chat-1", { text: "read already", sender: "o", timestamp: 1, channel: "app", chatId: "chat-1", midTurnId: "mt-1" })
    q.enqueue("coder", "app", "chat-1", { text: "not read", sender: "o", timestamp: 2, channel: "app", chatId: "chat-1", midTurnId: "mt-2" })
    const out = await q.markDone("coder", "app", "chat-1")
    expect(out.map((m) => m.text)).toEqual(["not read"])
  })

  it("runs nothing when every queued message was taken", async () => {
    const q = new MessageQueue()
    q.wasTaken = () => true
    q.markRunning("coder", "app", "chat-1")
    q.enqueue("coder", "app", "chat-1", { text: "x", sender: "o", timestamp: 1, channel: "app", chatId: "chat-1", midTurnId: "mt-1" })
    expect(await q.markDone("coder", "app", "chat-1")).toEqual([])
  })
})

describe("the workspace hook", () => {
  let dir: string | null = null
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null })

  it("is added to an existing workspace once, beside the hooks already there", () => {
    dir = mkdtempSync(path.join(tmpdir(), "agentx-midturn-"))
    mkdirSync(path.join(dir, ".claude"))
    const settings = path.join(dir, ".claude/settings.json")
    writeFileSync(settings, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } }))
    patchGuardrails(dir, "coder", "18800")
    expect(patchGuardrails(dir, "coder", "18800")).toBe(false)
    const post = JSON.parse(readFileSync(settings, "utf8")).hooks.PostToolUse
    expect(post).toHaveLength(2)
    expect(post[0].hooks[0].command).toBe("echo mine")
    expect(post[1].hooks[0].command).toContain("http://127.0.0.1:18800/runs/inbox")
  })

  it("asks the daemon with the run's chat, passes its answer through, and stays silent without one", async () => {
    const seen: string[] = []
    const server = http.createServer((req, res) => { seen.push(req.url ?? ""); res.end('{"hookSpecificOutput":{"additionalContext":"x"}}') })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = String((server.address() as any).port)
    const run = (env: Record<string, string>, input = '{"hook_event_name":"PostToolUse","tool_name":"Bash"}', p = port) => new Promise<string>((resolve) => {
      const child = execFile("/bin/sh", ["-c", midTurnHookCommand(p)], { env: { PATH: process.env.PATH ?? "", ...env } }, (e, out) => resolve(e ? "exit-error" : out))
      child.stdin?.on("error", () => {}).end(input)
    })
    const env = { AGENTX_AGENT_ID: "coder", AGENTX_QUEUE_CHANNEL: "gitlab", AGENTX_QUEUE_CHAT: "team/app:issue:7 #a" }
    const out = await run(env)
    expect(out).toContain("additionalContext")
    const q = new URL(seen[0], "http://x")
    expect(q.pathname).toBe("/runs/inbox")
    expect(Object.fromEntries(q.searchParams)).toEqual({ agent: "coder", channel: "gitlab", chat: "team/app:issue:7 #a" })
    expect(await run({})).toBe("")
    server.close()
    expect(await run({ AGENTX_AGENT_ID: "c", AGENTX_QUEUE_CHAT: "x" }, "{}", "1")).toBe("")
  })

  it("leaves the message for the main model when a Task subagent's tool call fires it", async () => {
    const seen: string[] = []
    const server = http.createServer((req, res) => { seen.push(req.url ?? ""); res.end('{"hookSpecificOutput":{"additionalContext":"x"}}') })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = String((server.address() as any).port)
    const run = (input: string) => new Promise<string>((resolve) => {
      const child = execFile("/bin/sh", ["-c", midTurnHookCommand(port)], { env: { PATH: process.env.PATH ?? "", AGENTX_AGENT_ID: "coder", AGENTX_QUEUE_CHANNEL: "a2a", AGENTX_QUEUE_CHAT: "lead" } }, (e, out) => resolve(e ? "exit-error" : out))
      child.stdin?.on("error", () => {}).end(input)
    })
    // Subagent payloads (compact and spaced JSON): no daemon call, no output, exit 0.
    expect(await run('{"session_id":"s","agent_id":"a6a2b6fb6f3bdd3bc","agent_type":"general-purpose","hook_event_name":"PostToolUse","tool_name":"Bash"}')).toBe("")
    expect(await run('{ "agent_id": "a1", "tool_name": "Read" }')).toBe("")
    expect(seen).toEqual([])
    // Main thread whose tool input only mentions "agent_id" in a string: still asks.
    expect(await run(JSON.stringify({ session_id: "s", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: 'jq ".agent_id" x.json' } }))).toContain("additionalContext")
    expect(seen).toHaveLength(1)
    server.close()
  })
})
