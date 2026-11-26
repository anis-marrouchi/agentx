// --- The Machines fold of the Hub's side menu (#2101, Machines tree, option A) ---
//
// Anis, 2026-11-26: bring back the machines view the side menu lost in
// #2278 (R26), without listing the agents twice. The agent list stays the
// one list of *who* (hub-agents.ts); this fold is *where the work runs*:
//
//   Machines (folded)
//     mesh: "Your mesh", machines that answer of all, agents working
//       machine: agents working (runs, when more)
//         one row per run going now, with the hand-offs and workflows it
//         started under it (wall-tree-workers.ts)
//
// The Idle, Done in the last hour, Project and Work item levels of the old
// tree (#2138) are gone: idle agents are in the agent list, finished work
// is on Activity. Every mesh and machine shows even when nothing runs on it
// (Hakim C1). The words follow the glossary (C4): a row is a *run*, a
// scheduled run says it is for a *job*.
//
// It reads the tree wall-tree.ts builds (liveTreeModel + ltAddWorkers), so
// an agent shows on one machine only and the machines' counts add up to the
// Hub's Working count (liveWorkCount, #2260; Hakim C2).
//
// Shipped to the browser through injectFns: each function is
// self-contained. What it needs from wall-tree.ts (ltEsc, ltFold,
// ltRowHtml) is passed in, never imported: an import would not be bound in
// the browser (../inject.ts).

import type { LtMachine, LtRow } from "./wall-tree"

export interface MtMachine {
  key: string
  id: string
  name: string
  url: string
  state: "up" | "checking" | "silent"
  error: string
  asOf: string
  /** Agents working on it (the Hub's Working rule). */
  working: number
  /** Their runs. */
  runs: number
  /** One per run going now, newest move first. */
  rows: LtRow[]
}

export interface MtMesh {
  key: string
  name: string
  /** Machines that answer (up), of all. */
  online: number
  total: number
  working: number
  runs: number
  machines: MtMachine[]
}

/** The Machines fold, from the machines wall-tree.ts built. One mesh for
 *  now: the owner's own (#1479; linked meshes are not built). */
export function mtModel(machines: LtMachine[], meshName?: string): MtMesh[] {
  const ms: MtMachine[] = (machines || []).map((m) => {
    const rows: LtRow[] = []
    for (const p of m.projects || []) for (const i of p.items || []) for (const r of i.rows || []) rows.push(r)
    rows.sort((x, y) => x.ageMs - y.ageMs)
    return { key: m.key, id: m.id, name: m.name, url: m.url, state: m.state, error: m.error, asOf: m.asOf, working: m.working, runs: m.runs, rows }
  })
  const mesh: MtMesh = { key: "own", name: meshName || "Your mesh", online: 0, total: ms.length, working: 0, runs: 0, machines: ms }
  for (const m of ms) {
    if (m.state === "up") mesh.online++
    mesh.working += m.working
    mesh.runs += m.runs
  }
  return [mesh]
}

/** "2 working" with ", 3 runs" when an agent has more than one run. */
export function mtCountWords(working: number, runs: number): string {
  return working + " working" + (runs > working ? ", " + runs + " runs" : "")
}

/** A row's own line under a scheduled run: it is for a job (glossary). */
export function mtRowTitle(r: LtRow): LtRow {
  const t = r.task
  return t && t.channel === "cron" && !/^Job\b/.test(r.title) ? { ...r, title: "Job: " + r.title } : r
}

export interface MtDeps {
  esc: (s: unknown) => string
  fold: (key: string, cls: string, head: string, body: string, closed: Record<string, boolean>, startFolded?: boolean) => string
  row: (r: LtRow, href: string, icon?: (provider: string) => string) => string
  /** What goes under a row: its workers (wall-tree-workers.ts). */
  under?: (r: LtRow, m: MtMachine) => string
  icon?: (provider: string) => string
}

/** The fold's body: each mesh, each machine, each run. `hrefOf` links a
 *  run (its Task page); `closed` keeps the reader's folds across snapshots. */
export function mtTreeHtml(meshes: MtMesh[], hrefOf: (r: LtRow, m: MtMachine) => string, closed: Record<string, boolean>, d: MtDeps): string {
  if (!meshes.length || !meshes.some((x) => x.total)) return '<p class="lt__empty">Loading the machines…</p>'
  return meshes.map((mesh) => {
    const meshHead = '<span class="lt__mach">' + d.esc(mesh.name) + '</span><span class="lt__n" title="' + mesh.online + " of " + mesh.total +
      ' machines answer">' + mesh.online + "/" + mesh.total + '</span><span class="lt__badge' + (mesh.working ? " is-live" : "") + '" title="' +
      d.esc(mtCountWords(mesh.working, mesh.runs)) + '">' + mesh.working + "</span>"
    const body = mesh.machines.map((m) => {
      const badge = m.state === "silent" ? '<span class="lt__badge is-silent" title="' + d.esc(m.error || "does not answer") + '">not checked</span>'
        : m.state === "checking" ? '<span class="lt__badge">checking…</span>'
        : '<span class="lt__badge' + (m.working ? " is-live" : "") + '" title="' + d.esc(mtCountWords(m.working, m.runs)) + '">' + m.working + "</span>"
      const asOf = m.state === "checking" && m.asOf && Number.isFinite(Date.parse(m.asOf))
        ? ' <time class="lt__asof" datetime="' + d.esc(m.asOf) + '" title="Last answer at ' + d.esc(m.asOf) + '">as of ' + d.esc(m.asOf.slice(11, 16)) + "Z</time>" : ""
      const head = '<span class="lt__mach">' + d.esc(m.name) + "</span>" + badge + asOf
      const rows = m.rows.map((r) => d.row(mtRowTitle(r), hrefOf(r, m), d.icon) + (d.under ? d.under(r, m) : "")).join("")
      const none = m.state === "silent" ? "Does not answer, so its runs are not shown."
        : m.state === "checking" && !m.rows.length ? "Slow to answer; asking again."
        : m.rows.length ? "" : "Nothing running."
      return d.fold("m:" + m.key, "lt__m", head, (none ? '<p class="lt__idle">' + none + "</p>" : "") + rows, closed)
    }).join("")
    return d.fold("mesh:" + mesh.key, "lt__mesh", meshHead, body, closed)
  }).join("")
}
