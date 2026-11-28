// --- Which folds and tabs are open after a search hit or a row link (#2101 ST3b F1) ---
//
// A row's `open` is one id or a comma list (a tab, then its Advanced). A
// tab id is `<pane>-tab-<name>` (dg-tab-errors, jobs-tab-hooks, ch-tab-slack):
// a pane shows the first open tab in its own order, so opening one tab must
// close its siblings, or the tab open before wins (Hakim, review of #2450).

const TAB = /^(.+-tab-)[^,]+$/

/** The open set after opening `open`: its ids added, the other tabs of the same pane closed. */
export function openIds(now: ReadonlySet<string>, open: string): Set<string> {
  const ids = open.split(",").map((s) => s.trim()).filter(Boolean)
  const next = new Set(now)
  for (const id of ids) {
    const tab = TAB.exec(id)
    if (tab) for (const o of now) if (o !== id && o.startsWith(tab[1])) next.delete(o)
    next.add(id)
  }
  return next
}
