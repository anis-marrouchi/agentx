// --- Settings search (#2101 ST1) ---
//
// The index is made from the pane row definitions (panes.ts), never kept
// by hand (condition 1). A pane's own name is a result too, so "jobs" finds
// the Jobs pane before it is built.

import { SETTINGS_PANES, type SettingsPaneDef } from "./panes"

export interface SettingsHit {
  pane: string
  paneLabel: string
  /** Empty when the hit is the pane itself. */
  row: string
  label: string
  help?: string
  open?: string
}

interface Entry extends SettingsHit { words: string }

export function buildSettingsIndex(panes: readonly SettingsPaneDef[] = SETTINGS_PANES): Entry[] {
  const out: Entry[] = []
  for (const p of panes) {
    out.push({ pane: p.id, paneLabel: p.label, row: "", label: p.label, help: p.help, words: p.help.toLowerCase() })
    for (const r of p.rows) {
      out.push({
        pane: p.id, paneLabel: p.label, row: r.id, label: r.label, help: r.help, open: r.open,
        words: [r.help, r.words, p.label].filter(Boolean).join(" ").toLowerCase(),
      })
    }
  }
  return out
}

/** Ranked hits: label starts with the query, then a word of the label does,
 *  then the label holds it, then help or extra words. Every word typed must
 *  be found somewhere. */
export function searchSettings(index: readonly Entry[], query: string, limit = 20): SettingsHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/)
  const scored: { hit: Entry; score: number; i: number }[] = []
  index.forEach((e, i) => {
    const label = e.label.toLowerCase()
    if (!terms.every((t) => label.includes(t) || e.words.includes(t))) return
    const score = label.startsWith(q) ? 0 : label.split(/\s+/).some((w) => w.startsWith(terms[0])) ? 1 : label.includes(q) ? 2 : 3
    scored.push({ hit: e, score, i })
  })
  return scored
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .slice(0, limit)
    .map(({ hit: { words: _w, ...hit } }) => hit)
}
