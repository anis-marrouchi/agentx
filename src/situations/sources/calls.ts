import type { Call, CallStore } from "@/calls/store"
import { situationKey } from "../key"
import { UNKNOWN, type Signal, type SignalSource } from "./types"

// --- Calls as a signal source (#1892 phase 3) ---
//
// The call store is the home of "a call is on or ended" (design 3.2).
//   read: is the owner on a live call with this agent now (`present`)
//   push: a call that ended publishes one `left` signal, nobody remaining.
//         Its scope is the call's own key (`call|default|<call id>`), not
//         the chat the call was asked from: that chat's talk goes on after
//         the call. No record has that key until calls get a meeting
//         record (design phase 6); then the same signal ends it.
// The call service publishes from the transitions it already makes
// (hang-up, the sweep's "no hang-up", a camera share ending): no new loop.

/** An answered call older than this is not live (calls/service.ts). */
const LIVE_MAX_MS = 2 * 3_600_000

export function callsSource(store: () => Pick<CallStore, "list"> | undefined, now: () => number = Date.now): SignalSource {
  return {
    id: "calls", kind: "present", sensitivity: "personal", platforms: ["any"], mode: "read",
    read: (scope) => {
      const at = now()
      const s = store()
      if (!s) throw new Error("no call store on this node")
      if (!scope.agentId) return [{ source: "calls", kind: "present", subject: "owner", value: UNKNOWN, checkedAt: at, expiresAt: null, reason: "no agent named: calls are between the owner and one agent" }]
      const live = s.list({ status: ["answered"], limit: 20 }).find((c) => c.agentId === scope.agentId && (c.answeredAt ?? 0) >= at - LIVE_MAX_MS)
      return [{
        source: "calls", kind: "present", subject: "owner", value: !!live, checkedAt: at, expiresAt: null,
        reason: live ? `on call ${live.id}` : "no live call with this agent",
      }]
    },
  }
}

/** The `left` signal for a call that ended; null for any other call. */
export function callEndedSignal(call: Pick<Call, "id" | "status" | "endedAt">, now: number): Signal | null {
  if (call.status !== "ended") return null
  return {
    source: "calls", kind: "left", subject: "owner", value: true, checkedAt: call.endedAt ?? now, expiresAt: null,
    reason: "the call ended", scope: situationKey("call", undefined, call.id), remaining: 0,
  }
}
