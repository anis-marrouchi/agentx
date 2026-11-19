import { situationKey } from "../key"
import type { Signal, SignalSource } from "./types"

// --- "Who left" on WhatsApp groups (#1892 phase 3) ---
//
// Baileys emits `group-participants.update` { id: group jid, participants,
// action: add | remove | promote | demote | modify, author? }. A participant
// who leaves, or is removed, is `remove` (newer versions may say `leave`).
// Participants are jids, or objects with an `id` in newer versions.
//
// The adapter (channels/whatsapp.ts) asks `wantsSignal` first, then reads
// the group once (live, throttled) to count who is still there, then
// publishes what this function returns. Pure: no I/O here.

export const WHATSAPP_GROUPS_SOURCE: SignalSource = {
  id: "whatsapp-groups", kind: "left", sensitivity: "open", platforms: ["any"], mode: "push",
}

const user = (jid: string) => jid.replace(/:.*$/, "").replace(/@.*$/, "")

function jidOf(p: unknown): string {
  if (typeof p === "string") return p
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>
    for (const k of ["id", "phoneNumber", "jid", "lid"]) if (typeof o[k] === "string") return o[k] as string
  }
  return ""
}

export interface WhatsAppParticipantsUpdate {
  id: string
  participants: unknown[]
  action: string
  author?: string
}

/** Is this jid one of ours (the paired account, by phone or by LID)? */
export function isOwnJid(jid: string, me: { id?: string; lid?: string } | undefined): boolean {
  const u = user(jid)
  return !!u && (u === user(me?.id ?? "") || u === user(me?.lid ?? ""))
}

/** The participants of a leave update who are not us; empty when the
 *  update is not a leave in a group. */
export function whatsappLeavers(u: WhatsAppParticipantsUpdate | null | undefined, me: { id?: string; lid?: string } | undefined): string[] {
  if (!u || typeof u.id !== "string" || !u.id.endsWith("@g.us")) return []
  if (u.action !== "remove" && u.action !== "leave") return []
  return (Array.isArray(u.participants) ? u.participants : []).map(jidOf).filter((j) => j && !isOwnJid(j, me))
}

/** Others still in the group, not us and not the leavers. */
export function othersRemaining(participants: unknown, me: { id?: string; lid?: string } | undefined, leavers: string[]): number | null {
  if (!Array.isArray(participants)) return null
  const gone = new Set(leavers.map(user))
  return participants.map(jidOf).filter((j) => j && !isOwnJid(j, me) && !gone.has(user(j))).length
}

export function whatsappLeaveSignals(
  u: WhatsAppParticipantsUpdate | null | undefined,
  opts: { me: { id?: string; lid?: string } | undefined; remaining: number | null; now: number },
): Signal[] {
  const leavers = whatsappLeavers(u, opts.me)
  if (!leavers.length) return []
  const scope = situationKey("whatsapp", "default", u!.id)
  return leavers.map((j) => ({
    source: WHATSAPP_GROUPS_SOURCE.id, kind: "left", subject: user(j), value: true,
    checkedAt: opts.now, expiresAt: null, reason: `${u!.action} in the group`, scope, remaining: opts.remaining,
  }))
}
