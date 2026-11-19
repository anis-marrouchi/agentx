import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

// #1892 proof (j): the list of places that send into a chat, and which of
// them count as the agent's reply (`countsAsReply: true`). A goodbye that
// leaves through a path nobody marked keeps a talk in `ending` forever, so
// a new send call fails this test until someone decides its flag and adds
// it here. The rule: true only for an agent's or a workflow's message in
// the conversation itself; notices, errors, reminders, digests are false.

const SRC = resolve(__dirname, "../src")

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []
  })
}

function count(re: RegExp): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of files(SRC)) {
    const n = (readFileSync(f, "utf-8").match(re) ?? []).length
    if (n) out[relative(SRC, f)] = n
  }
  return out
}

describe("send list (#1892 j)", () => {
  it("every call that sends into a chat is listed", () => {
    // adapterSend / sendToChat / sendOutbound / deliverToChat / a direct
    // adapter.send / getChannel(…)?.send
    expect(count(/\b(adapterSend|sendToChat|sendOutbound|deliverToChat)\(|\badapter\.send\(|\?\.send\(/g)).toEqual({
      "actions/builtin/channel.ts": 1, // channel.reply: true
      "agents/registry.ts": 1, // queued reply: true unless an error
      "business/reporter.ts": 1, // report: false
      "channels/ntfy.ts": 1, // push notice: false
      "channels/push.ts": 1, // push notice: false
      // 18 adapterSend calls (each with its own flag) + its definition,
      // 2 sendToChat, 3 sendOutbound (definition and two notice paths)
      "channels/router.ts": 24,
      "situations/send-to-chat.ts": 2, // the one adapter.send, the definition
      "daemon/delegation-wiring.ts": 5, // deliverToChat: as the caller says
      // 16 sendOutbound (/send, /channel/send, mesh answers, alerts…) +
      // deliverToChat + the request-status post (a status notice, not a reply)
      // + the closing note on a forge home (#1892 phase 4: an issue comment,
      // not a chat reply)
      "daemon/index.ts": 19,
      "workflows/nodes/follow-up.ts": 1, // deliver → sendToChat
      "workflows/nodes/handlers.ts": 1, // action.send: true
    })
  })

  it("the other send helpers are listed", () => {
    expect(count(/\bdeliver\(|\bdeps\.send\(/g)).toEqual({
      "a2a/delegation.ts": 3, // callback answer: true; relay failure: false
      "agents/resume/mesh-resumer.ts": 2, // resumed answer: true; notice: false
      "channels/push-announce.ts": 1,
      "channels/streaming-message.ts": 1, // the router marks the anchor
      "channels/webrtc-signal.ts": 1,
      "crons/exceptions-digest.ts": 1,
      "daemon/push-bridge.ts": 1,
      "notify/reach-attach.ts": 1,
      "notify/reach.ts": 1,
      "reminders/daemon.ts": 3,
      "requests/plan-sweep.ts": 1,
      "workflows/dispatcher.ts": 2, // approved message: as paused; reminder: false
      "workflows/nodes/follow-up.ts": 2, // person.message: true
    })
  })

  it("the sends that count as a reply are these", () => {
    expect(count(/countsAsReply: true/g)).toEqual({
      "a2a/delegation.ts": 1,
      "actions/builtin/channel.ts": 1,
      "channels/router.ts": 6, // stream anchor, plain reply, hop reply, 3 mesh-routed replies
      "situations/send-to-chat.ts": 1, // doc comment
      "mcp/index.ts": 2, // agentx_send, agentx_send_contact
      "workflows/nodes/follow-up.ts": 2, // person.message now and after approval
      "workflows/nodes/handlers.ts": 2, // action.send, forward to the run's home
    })
  })

  it("the mesh resumer marks the resumed answer, not the notice", () => {
    const src = readFileSync(join(SRC, "agents/resume/mesh-resumer.ts"), "utf-8")
    expect(src).toMatch(/deps\.send\(route\(origin\), body\(origin, resp\.content, true\)\)/)
    expect(src).toMatch(/deps\.send\(route\(origin\), body\(origin, text, false\)\)/)
  })
})
