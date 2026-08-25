import { describe, it, expect, beforeEach } from "vitest"
import { getAttachRegistry, resetAttachRegistry } from "../../src/attach"
import { onSessionStart, onPrompt, onStop, onSessionEnd } from "../../src/attach/service"

// These exercise the four hook handlers as Claude Code actually calls them:
// a JSON payload in, a decision string out. The string is piped verbatim to
// Claude Code, so "" (the no-op) vs a decision object is load-bearing — an
// accidental "null" or "{}" in the wrong place changes what the human's
// session does next.

const SID = "sess-abc"

function parse(out: string): any {
  return out === "" ? null : JSON.parse(out)
}

function attach(mode: "manual" | "notify" | "auto" = "notify", agentId = "cx-agent") {
  const reg = getAttachRegistry()
  reg.register(SID, { cwd: "/tmp/w" })
  reg.bind(SID, agentId, mode)
  return reg
}

function queue(reg: ReturnType<typeof getAttachRegistry>, text: string, agentId = "cx-agent") {
  return reg.offer({ agentId, text, channel: "telegram", chatId: "c1", sender: "bob" })
}

beforeEach(() => {
  resetAttachRegistry()
})

describe("unattached sessions stay untouched", () => {
  it("every handler is a no-op for a session with no bindings", () => {
    const payload = { session_id: "someone-elses-session", cwd: "/x" }
    expect(onSessionStart(payload)).toBe("")
    expect(onPrompt(payload)).toBe("")
    expect(onStop(payload)).toBe("")
    expect(onSessionEnd(payload)).toBe("")
  })

  it("a missing session_id never throws", () => {
    expect(onStop({})).toBe("")
    expect(onSessionStart({})).toBe("")
  })
})

describe("SessionStart", () => {
  it("briefs a bound session on the identity it is wearing", () => {
    attach("notify")
    const out = parse(onSessionStart({ session_id: SID, cwd: "/tmp/w" }))
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart")
    expect(out.hookSpecificOutput.additionalContext).toContain("cx-agent")
    expect(out.hookSpecificOutput.additionalContext).toContain("notify")
  })

  it("mentions a backlog that arrived before the session restarted", () => {
    const reg = attach("notify")
    queue(reg, "are you there?")
    const out = parse(onSessionStart({ session_id: SID }))
    expect(out.hookSpecificOutput.additionalContext).toContain("1 message is already waiting")
  })
})

describe("UserPromptSubmit", () => {
  it("never blocks the human's own prompt", () => {
    const reg = attach("notify")
    queue(reg, "deploy status?")
    const out = parse(onPrompt({ session_id: SID, user_input: "fix the parser" }))
    expect(out.decision).toBeUndefined()
    expect(out.hookSpecificOutput.additionalContext).toContain("1 message")
  })

  it("says nothing when the inbox is empty", () => {
    attach("notify")
    expect(onPrompt({ session_id: SID })).toBe("")
  })

  it("stays silent in manual mode", () => {
    const reg = attach("manual")
    queue(reg, "ping")
    expect(onPrompt({ session_id: SID })).toBe("")
  })
})

describe("Stop — delivery modes", () => {
  it("manual: silent even with a backlog", () => {
    const reg = attach("manual")
    queue(reg, "ping")
    expect(onStop({ session_id: SID })).toBe("")
  })

  it("notify: mentions the backlog but does not take the turn", () => {
    const reg = attach("notify")
    queue(reg, "ping")
    const out = parse(onStop({ session_id: SID }))
    expect(out.decision).toBeUndefined()
    expect(out.systemMessage).toContain("1 message waiting")
    expect(out.systemMessage).toContain("/inbox")
  })

  it("auto: blocks the stop and feeds the message in", () => {
    const reg = attach("auto")
    queue(reg, "deploy status?")
    const out = parse(onStop({ session_id: SID }))
    expect(out.decision).toBe("block")
    expect(out.reason).toContain("deploy status?")
    expect(out.reason).toContain("cx-agent")
    expect(out.reason).toContain("telegram")
  })

  it("says nothing when there is nothing queued", () => {
    attach("auto")
    expect(onStop({ session_id: SID })).toBe("")
  })
})

describe("Stop — harvesting the reply", () => {
  it("captures last_assistant_message as the answer to the claimed item", async () => {
    const reg = attach("auto")
    const offered = queue(reg, "deploy status?")!

    // Turn 1: the session is handed the message.
    const first = parse(onStop({ session_id: SID }))
    expect(first.decision).toBe("block")

    // Turn 2: whatever it said is the answer — no tool call involved.
    const second = onStop({
      session_id: SID,
      last_assistant_message: "All green, deployed 10 minutes ago.",
      stop_hook_active: true,
    })
    expect(second).toBe("")

    await expect(offered).resolves.toEqual({
      kind: "answered",
      text: "All green, deployed 10 minutes ago.",
      sessionId: SID,
    })
  })

  it("an empty reply requeues the item and lets the session stop", () => {
    const reg = attach("auto")
    queue(reg, "ping")
    onStop({ session_id: SID })
    const out = parse(
      onStop({ session_id: SID, last_assistant_message: "   ", stop_hook_active: true }),
    )
    // Back in the queue, not silently resolved with "".
    expect(reg.pendingCount(SID)).toBe(1)
    // And crucially NOT handed straight back — that would spin until the
    // per-turn budget ran out, re-asking a question that produced no answer.
    expect(out.decision).toBeUndefined()
    expect(out.systemMessage).toContain("no reply captured")
  })

  it("drains a queue of messages across successive stops", async () => {
    const reg = attach("auto")
    const a = queue(reg, "first")!
    const b = queue(reg, "second")!

    expect(parse(onStop({ session_id: SID })).reason).toContain("first")
    expect(
      parse(onStop({ session_id: SID, last_assistant_message: "A1", stop_hook_active: true })).reason,
    ).toContain("second")
    expect(onStop({ session_id: SID, last_assistant_message: "A2", stop_hook_active: true })).toBe("")

    await expect(a).resolves.toMatchObject({ text: "A1" })
    await expect(b).resolves.toMatchObject({ text: "A2" })
  })
})

describe("Stop — runaway guard", () => {
  it("stops taking the turn after maxDrainPerTurn and says how many are left", () => {
    const reg = attach("auto")
    const max = reg.options().maxDrainPerTurn
    for (let i = 0; i < max + 2; i++) queue(reg, `msg ${i}`)

    let out = parse(onStop({ session_id: SID }))
    let drained = 0
    while (out?.decision === "block") {
      drained++
      out = parse(
        onStop({ session_id: SID, last_assistant_message: `answer ${drained}`, stop_hook_active: true }),
      )
    }

    expect(drained).toBe(max)
    expect(out.systemMessage).toContain("paused after")
    expect(out.systemMessage).toContain("still queued")
  })

  it("resets the per-turn budget once the session actually stops", () => {
    const reg = attach("auto")
    for (let i = 0; i < reg.options().maxDrainPerTurn + 1; i++) queue(reg, `m${i}`)
    let out = parse(onStop({ session_id: SID }))
    while (out?.decision === "block") {
      out = parse(onStop({ session_id: SID, last_assistant_message: "x", stop_hook_active: true }))
    }
    // The non-block return above closed the turn; the next one starts fresh.
    expect(reg.get(SID)!.drainedThisTurn).toBe(0)
    expect(parse(onStop({ session_id: SID })).decision).toBe("block")
  })
})

describe("SessionEnd", () => {
  it("releases queued work back to the spawn path", async () => {
    const reg = attach("notify")
    const offered = queue(reg, "still waiting")!
    expect(onSessionEnd({ session_id: SID, reason: "prompt_input_exit" })).toBe("")
    await expect(offered).resolves.toMatchObject({ kind: "expired", reason: "session ended" })
    expect(reg.get(SID)).toBeUndefined()
  })
})
