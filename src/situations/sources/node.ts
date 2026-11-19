import type { CallStore } from "@/calls/store"
import type { SituationsConfig } from "../config"
import type { SituationStore } from "../store"
import { applySignal } from "./apply"
import { callsSource } from "./calls"
import { onSignal, setSignalInterest } from "./hub"
import { ownerBusySources } from "./owner-busy"
import { browserTabsSource, newsSource, openAppsSource, TABS_NEED_READER, type FetchText, type RunCommand } from "./per-request"
import { SignalSources, type ConsentCheck, type ReadLogSink } from "./registry"
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
  /** Phase 7: where per-request reads are logged. Without it no
   *  per-request source is read. */
  readLog?: ReadLogSink
  /** Phase 7: runs lsappinfo for open-apps (tests inject it). */
  runCommand?: RunCommand
  /** Phase 7: a separate reader that alone holds the macOS Automation
   *  permission for Chrome and Safari. Without one, browser-tabs is not
   *  loaded (per-request.ts). The daemon passes none yet. */
  browserTabsReader?: RunCommand
  fetchText?: FetchText
  platform?: NodeJS.Platform
  log?: (m: string) => void
}): AttachedSources {
  const sources = new SignalSources({
    settings: () => opts.settings().sources, consent: opts.consent, readLog: opts.readLog,
    ...(opts.platform ? { platform: opts.platform } : {}),
  })
  for (const s of ownerBusySources()) sources.register(s)
  sources.register(callsSource(opts.calls))
  sources.register(WHATSAPP_GROUPS_SOURCE)
  sources.register(TELEGRAM_MEMBERS_SOURCE)
  // Phase 7: per-request sources. Loaded where they fit, read only when
  // switched on, for a request, with the person's yes where needed.
  sources.register(openAppsSource(opts.runCommand))
  if (opts.browserTabsReader) sources.register(browserTabsSource(opts.browserTabsReader, () => opts.settings().browserTabs?.includePaths === true))
  else sources.skip("browser-tabs", TABS_NEED_READER)
  sources.register(newsSource(() => opts.settings().news ?? { feeds: [], maxItems: 10, timeoutMs: 8_000 }, opts.fetchText))

  setSignalInterest((key) => opts.settings().mode !== "off" && opts.store.get(key)?.phase === "during")
  const off = onSignal((s) => {
    // The talk's owner decides a source limited to some agents (#1945).
    const owner = s.scope ? opts.store.get(s.scope)?.ownerAgent ?? undefined : undefined
    if (!sources.accepts(s, owner)) return
    if (applySignal(opts.store, opts.settings, s).moved) opts.log?.(`[situation] ${s.source}: the last other party left; talk → ending`)
  })
  return {
    sources,
    detach: () => { off(); setSignalInterest(null) },
  }
}

/** For `GET /situations/sources` and `agentx situation sources`: what is
 *  loaded on this node, what is not and why, and each read source's
 *  answer now (unknown with its reason when it cannot tell).
 *
 *  A read answer's value and reason can be personal (the Focus mode, "on
 *  a call with <name>"), so only a caller on this machine (`local`, the
 *  daemon checks loopback) gets them. A mesh caller gets each source's
 *  state, known or unknown, and no value or reason. */
export function sourcesView(sources: SignalSources, opts: { local: boolean }) {
  return {
    loaded: sources.loaded().map((s) => {
      const base = { id: s.id, kind: s.kind, sensitivity: s.sensitivity, mode: s.mode }
      // A per-request source is never read for this view (phase 7).
      if (s.perRequest) return { ...base, perRequest: true }
      const answer = s.mode === "read" ? sources.read(s.id, {})[0] : undefined
      if (!answer) return base
      if (!opts.local) return { ...base, state: isUnknown(answer) ? "unknown" : "known" }
      return { ...base, value: isUnknown(answer) ? "unknown" : answer.value, reason: answer.reason }
    }),
    notLoaded: sources.skipped(),
  }
}
