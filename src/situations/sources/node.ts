import type { CallStore } from "@/calls/store"
import type { SituationsConfig } from "../config"
import type { SituationStore } from "../store"
import { applySignal } from "./apply"
import { callsSource } from "./calls"
import { onSignal, setSignalInterest } from "./hub"
import { ownerBusySources } from "./owner-busy"
import { SignalSources, type ConsentCheck } from "./registry"
import { TELEGRAM_MEMBERS_SOURCE } from "./telegram-members"
import { isUnknown } from "./types"
import { WHATSAPP_GROUPS_SOURCE } from "./whatsapp-groups"

// --- This node's signal sources, wired to the situation record (#1892 phase 3) ---
//
// Called once at daemon start, next to the courtesy gate. It loads the
// adapters that fit the node, says which chats want signals (those in
// `during`), and applies each accepted signal to the record. No timer,
// no poll: push sources publish from events they already handle.

export interface AttachedSources {
  sources: SignalSources
  detach(): void
}

export function attachSignalSources(opts: {
  store: SituationStore
  settings: () => SituationsConfig
  calls: () => Pick<CallStore, "list"> | undefined
  consent?: ConsentCheck
  log?: (m: string) => void
}): AttachedSources {
  const sources = new SignalSources({ settings: () => opts.settings().sources, consent: opts.consent })
  for (const s of ownerBusySources()) sources.register(s)
  sources.register(callsSource(opts.calls))
  sources.register(WHATSAPP_GROUPS_SOURCE)
  sources.register(TELEGRAM_MEMBERS_SOURCE)

  setSignalInterest((key) => opts.settings().mode !== "off" && opts.store.get(key)?.phase === "during")
  const off = onSignal((s) => {
    if (!sources.accepts(s)) return
    if (applySignal(opts.store, opts.settings, s).moved) opts.log?.(`[situation] ${s.source}: the last other party left; talk → ending`)
  })
  return {
    sources,
    detach: () => { off(); setSignalInterest(null) },
  }
}

/** For `GET /situations/sources` and `agentx situation sources`: what is
 *  loaded on this node, what is not and why, and each read source's
 *  answer now (unknown with its reason when it cannot tell). */
export function sourcesView(sources: SignalSources) {
  return {
    loaded: sources.loaded().map((s) => {
      const answer = s.mode === "read" ? sources.read(s.id, {})[0] : undefined
      return {
        id: s.id, kind: s.kind, sensitivity: s.sensitivity, mode: s.mode,
        ...(answer ? { value: isUnknown(answer) ? "unknown" : answer.value, reason: answer.reason } : {}),
      }
    }),
    notLoaded: sources.skipped(),
  }
}
