import type { Resumer } from "./coordinator"
import type { MeshOrigin } from "./origin"

// --- Resume a run another node forwarded here (#311) ---
//
// A GitLab webhook lands on the server, which forwards the task to the
// agent's home node and posts the answer it gets back. After a restart
// here nobody is waiting on that forward any more, so the answer (and any
// "cut off" notice) is sent to the forwarding node's /channel/send, which
// posts it with its own adapter — the same place a live reply goes.

export interface MeshPeerRef {
  peer: string
  peerUrl: string
  healthy: boolean
  channels: string[]
  /** The node's own name, from its agent card. */
  node?: string
}

export interface MeshResumerDeps {
  peers(): MeshPeerRef[]
  /** POST a /channel/send body to the peer. */
  send(peer: MeshPeerRef, body: Record<string, unknown>): Promise<void>
  /** Run the agent turn; resolves with its answer. */
  execute(input: { agentId: string; message: string; origin: MeshOrigin; attempt: number; resumedFrom: string }): Promise<{ content: string; error?: string }>
  log(msg: string): void
}

/** The forwarding node when it is known and up, else any healthy peer that
 *  hosts the channel; null when no peer can deliver. */
export function findReplyPeer(origin: MeshOrigin, peers: MeshPeerRef[]): MeshPeerRef | null {
  const up = peers.filter((p) => p.healthy)
  if (origin.node) {
    const want = origin.node.toLowerCase()
    const named = up.find((p) => p.node?.toLowerCase() === want || p.peer.toLowerCase() === want)
    if (named) return named
  }
  return up.find((p) => p.channels.includes(origin.channel)) ?? null
}

export function createMeshResumer(deps: MeshResumerDeps): Resumer {
  const route = (origin: MeshOrigin) => {
    const peer = findReplyPeer(origin, deps.peers())
    if (!peer) throw new Error(`no healthy mesh peer can deliver to "${origin.channel}"`)
    return peer
  }
  const body = (origin: MeshOrigin, text: string) => ({
    channel: origin.channel,
    chatId: origin.chatId,
    text,
    replyTo: origin.replyTo,
    accountId: origin.accountId,
    agentId: origin.agentId,
  })

  return {
    resume: async ({ origin, note, attempt, run }) => {
      if (origin.kind !== "mesh") throw new Error("not a mesh run")
      // Check the way back before starting, so a run nobody could hear is
      // reported to the operator instead of answered into the void.
      route(origin)
      // Handed over, not awaited, like the router resumer.
      void deps.execute({
        agentId: run.agentId,
        message: `${note}\n${run.originalMessage ?? ""}`,
        origin,
        attempt,
        resumedFrom: run.taskId,
      })
        .then(async (resp) => {
          if (resp.error || !resp.content) {
            deps.log(`[resume] ${run.taskId} finished without an answer: ${resp.error ?? "empty"}`)
            return
          }
          await deps.send(route(origin), body(origin, resp.content))
        })
        .catch((e: any) => deps.log(`[resume] ${run.taskId} failed: ${e?.message ?? e}`))
    },
    tell: async (origin, text) => {
      if (origin.kind !== "mesh") return
      await deps.send(route(origin), body(origin, text))
    },
  }
}

/** The origin to record for a /task a peer forwarded with `replyVia`, or
 *  undefined for any other caller (they keep the default direct origin). */
export function meshOriginFromTask(body: Record<string, unknown>, agentId: string): MeshOrigin | undefined {
  const via = body.replyVia as Record<string, unknown> | undefined
  const ctx = body.context as Record<string, unknown> | undefined
  if (!via || typeof via !== "object" || !ctx) return undefined
  if (typeof ctx.channel !== "string" || typeof ctx.chatId !== "string") return undefined
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)
  return {
    kind: "mesh",
    node: str(via.node),
    channel: ctx.channel,
    chatId: ctx.chatId,
    agentId,
    replyTo: str(via.messageId),
    accountId: str(via.accountId),
    context: ctx,
  }
}
