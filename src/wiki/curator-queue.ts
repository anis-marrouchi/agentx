// --- The curator's wiki changes wait in the held queue (noqta#910) ---
//
// The Sales curator (wa-crm-pipeline `sales-curate`, design noqta#906)
// proposes wiki patches with `wiki contribute --work <bundle> --hold`.
// Each patch goes straight into _contributions/held.json with a reason
// starting "curator:", so nothing reaches a page before a person says yes
// in the popup. Before each ask, `wiki contributions refresh` re-reads
// every waiting page, saves the fingerprint and the changed lines the
// person will see, and drops a change that no longer applies.
//
// One waiting change per key: page + attribute + value (for a removal:
// page + the text it removes). A key already held, approved or rejected is
// never held again.

import { lineDiff, pageFingerprint } from "./curate"
import {
  factLineValue, heldChange, listHeld, pageKey, pageTargets, saveHeld, withHeldLock,
  type ContributionPatch, type HeldPatch,
} from "./contributions"
import type { WikiHub } from "./hub"

export const CURATOR_REASON = "curator: waits for the approver"

export function isCuratorHeld(h: Pick<HeldPatch, "reason">): boolean {
  return h.reason.startsWith("curator:")
}

/** The key that makes two proposals the same change. */
export function heldKey(p: ContributionPatch): string {
  const norm = (s?: string) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ")
  return p.kind === "remove"
    ? `${pageKey(p.page)}|remove|${norm(p.attribute)}|${norm(p.previous)}`
    : `${pageKey(p.page)}|${norm(p.attribute)}|${norm(p.value ?? p.summary)}`
}

export interface HoldResult {
  held: HeldPatch[]
  skipped: Array<{ patch: ContributionPatch; why: string }>
}

/** Queue patches as held for a person, skipping known keys and pages the
 *  proposing agent cannot read. */
export function holdPatches(
  hub: WikiHub, wikiDir: string, patches: ContributionPatch[],
  opts: { reason?: string; now?: number } = {},
): HoldResult {
  const reason = opts.reason ?? CURATOR_REASON
  const nowIso = new Date(opts.now ?? Date.now()).toISOString()
  const targets = pageTargets(hub)
  return withHeldLock(wikiDir, () => {
    const all = listHeld(wikiDir, { all: true })
    const known = new Set(all.map((h) => heldKey(h.patch)))
    const out: HoldResult = { held: [], skipped: [] }
    for (const p of patches) {
      const key = heldKey(p)
      if (known.has(key)) { out.skipped.push({ patch: p, why: "the same change is already held, approved or rejected" }); continue }
      const target = targets.get(pageKey(p.page))?.[0]
      if (target && !target.store.canRead(target.article.meta, p.agentId)) {
        out.skipped.push({ patch: p, why: "the proposing agent cannot read this page" })
        continue
      }
      const id = `h-${p.id}`
      if (all.some((h) => h.id === id)) { out.skipped.push({ patch: p, why: "already queued" }); continue }
      const entry: HeldPatch = {
        id, patch: p, reason, heldAt: nowIso, status: "held",
        ...(target ? { pageFingerprint: pageFingerprint(target.article) } : {}),
      }
      all.push(entry)
      known.add(key)
      out.held.push(entry)
    }
    if (out.held.length) saveHeld(wikiDir, all)
    return out
  })
}

export interface RefreshResult {
  refreshed: Array<{ id: string; page: string; fingerprint?: string; before: string; after: string }>
  dropped: Array<{ id: string; page: string; why: string }>
}

/**
 * Re-read the page of every waiting change whose reason starts with
 * `reasonPrefix`, rebuild the change with approveHeld's own code, and save
 * the new fingerprint and changed lines on it. A change that no longer
 * builds (its old text is gone, the line is already there, the page is
 * gone) is marked rejected with `by` and listed as dropped.
 */
export function refreshHeld(
  hub: WikiHub, wikiDir: string,
  opts: { reasonPrefix: string; by?: string; now?: number },
): RefreshResult {
  const by = opts.by ?? "curator: no longer applies"
  const nowIso = new Date(opts.now ?? Date.now()).toISOString()
  const targets = pageTargets(hub)
  return withHeldLock(wikiDir, () => {
    const all = listHeld(wikiDir, { all: true })
    const out: RefreshResult = { refreshed: [], dropped: [] }
    const next = all.map((h): HeldPatch => {
      if (h.status !== "held" || !h.reason.startsWith(opts.reasonPrefix)) return h
      const p = h.patch
      const target = targets.get(pageKey(p.page))?.[0]
      if (!target) {
        if (p.kind === "create" || p.kind === "add") {
          const after = p.kind === "create" ? (p.summary ?? p.page) : `${p.attribute}: ${p.value}`
          out.refreshed.push({ id: h.id, page: p.page, before: "", after })
          return { ...h, before: "", after }
        }
        return drop(h, "the page is gone")
      }
      const body = target.article.content
      const why = noLongerApplies(body, p)
      if (why) return drop(h, why)
      const changed = lineDiff(body.trim(), heldChange(body, p).trim())
      const before = changed.filter((d) => d.op === "-").map((d) => d.text).join("\n")
      const after = changed.filter((d) => d.op === "+").map((d) => d.text).join("\n")
      const fingerprint = pageFingerprint(target.article)
      out.refreshed.push({ id: h.id, page: p.page, fingerprint, before, after })
      return { ...h, pageFingerprint: fingerprint, before, after }
    })
    if (out.refreshed.length || out.dropped.length) saveHeld(wikiDir, next)
    return out

    function drop(h: HeldPatch, why: string): HeldPatch {
      out.dropped.push({ id: h.id, page: h.patch.page, why })
      return { ...h, status: "rejected", decidedBy: by, decidedAt: nowIso }
    }
  })
}

function noLongerApplies(body: string, p: ContributionPatch): string | undefined {
  if (p.kind === "create") return "the page exists now"
  if ((p.kind === "correct" || p.kind === "remove") && p.previous) {
    const inProse = heldChange(body, { ...p, kind: "remove", attribute: undefined }) !== body
    const inLine = !!p.attribute && factLineValue(body, p.attribute)?.trim().toLowerCase() === p.previous.trim().toLowerCase()
    if (!inProse && !inLine) return "the text it changes is no longer on the page"
  }
  if (p.kind !== "remove" && p.attribute && p.value) {
    const now = factLineValue(body, p.attribute)
    if (now !== undefined && now.trim().toLowerCase() === p.value.trim().toLowerCase()) return "the page already says this"
  }
  if (heldChange(body, p).trim() === body.trim()) return "it changes nothing on the page"
  return undefined
}
