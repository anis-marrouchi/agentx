// --- The right panel's Files tab (#2101 R17) ---
//
// What a selected run or chat touched: the files its runs read, edited or
// wrote, the files it declared as artifacts and the files the owner
// attached. Read from what the Hub already loads, nothing new is stored:
//   - a run's record (GET /api/task/history?node&agent&task): its
//     transcript has one line per tool call, `→ Name({json})`, with the
//     input clipped (registry.ts makeStreamEventFormatter: 400 characters,
//     8000 for the edit tools), and its answer has the
//     <agentx-artifact>{filename, mime}</agentx-artifact> tags;
//   - a chat's thread: its messages' runs, and the "Attached: a, b" line a
//     message with files ends with (assistant-upload.ts attachedLine).
// Each item opens in the panel: an edit shows the run's own before and
// after (the clipped input), a write its content, a read the path only
// (the run's log keeps no file content).
//
// Shipped to the page as their own text (injectFns, wall-context.client.ts),
// so no imports are used inside the functions; filesTabHtml calls wflIcon
// and the workspace parts call wflLoader, which are injected with them.

export type FileOp = "read" | "edited" | "wrote"

export interface FileChange { before: string; after: string; isNew: boolean }

export interface RunFile {
  path: string
  /** The strongest thing a run did to it: wrote > edited > read. */
  op: FileOp
  /** How many calls did what `op` says: the changing calls of a changed
   *  file, the reads of a file only read. A read before an edit is not
   *  counted, so "edited in 2 calls" means two edits. */
  n: number
  /** The edits and writes, in order, when their input was whole enough. */
  changes: FileChange[]
}

export interface RunFiles {
  files: RunFile[]
  artifacts: Array<{ filename: string; mime: string }>
  attached: string[]
}

/** A tool's name to what it does to a file. Null: not a file tool. */
export function fileOpOf(name: string): FileOp | null {
  const n = String(name || "")
  if (n === "Read" || n === "read_file" || n === "NotebookRead") return "read"
  if (n === "Edit" || n === "MultiEdit" || n === "NotebookEdit" || n === "edit_file") return "edited"
  if (n === "Write" || n === "create_files" || n === "write_file") return "wrote"
  return null
}

/** The files a run's transcript and answer name, most changed first. */
export function runFilesOf(transcript: string, answer: string): RunFiles {
  const rank: Record<string, number> = { read: 0, edited: 1, wrote: 2 }
  const changes = (o: string) => (o === "read" ? 0 : 1)
  const field = (input: string, key: string): string => {
    const m = input.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))
    if (!m) return ""
    try { return JSON.parse(`"${m[1]}"`) } catch { return m[1] }
  }
  const byPath = new Map<string, RunFile>()
  const add = (path: string, op: FileOp, change: FileChange | null) => {
    const p = String(path || "").trim()
    if (!p) return
    let f = byPath.get(p)
    if (!f) byPath.set(p, f = { path: p, op, n: 0, changes: [] })
    if (changes(op) > changes(f.op)) f.n = 0
    if (changes(op) >= changes(f.op)) f.n++
    if (rank[op] > rank[f.op]) f.op = op
    if (change && f.changes.length < 20) f.changes.push(change)
  }
  for (const line of String(transcript || "").split("\n")) {
    const m = line.match(/^→ ([^\s(]+)\((.*?)\)?\s*$/)
    if (!m) continue
    const op = fileOpOf(m[1])
    if (!op) continue
    const input = m[2]
    let obj: any = null
    try { obj = JSON.parse(input) } catch { obj = null }
    if (m[1] === "create_files" && obj && Array.isArray(obj.files)) {
      for (const f of obj.files) add(String(f && f.path || ""), "wrote", typeof (f && f.content) === "string" ? { before: "", after: f.content, isNew: true } : null)
      continue
    }
    if (m[1] === "create_files") {
      // Clipped: every path that made it in.
      const re = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/g
      let x: RegExpExecArray | null
      while ((x = re.exec(input))) { let p = x[1]; try { p = JSON.parse(`"${p}"`) } catch { /* as written */ } add(p, "wrote", null) }
      continue
    }
    const path = field(input, "file_path") || field(input, "notebook_path") || field(input, "path")
    let change: FileChange | null = null
    if (obj && typeof obj === "object") {
      if (typeof obj.old_string === "string" && typeof obj.new_string === "string") change = { before: obj.old_string, after: obj.new_string, isNew: false }
      else if (Array.isArray(obj.edits)) change = { before: obj.edits.map((e: any) => String(e && e.old_string || "")).join("\n⋯\n"), after: obj.edits.map((e: any) => String(e && e.new_string || "")).join("\n⋯\n"), isNew: false }
      else if (typeof obj.content === "string") change = { before: "", after: obj.content, isNew: op === "wrote" }
      else if (typeof obj.new_source === "string") change = { before: "", after: obj.new_source, isNew: false }
    }
    add(path, op, op === "read" ? null : change)
  }
  const artifacts: Array<{ filename: string; mime: string }> = []
  const tag = /<agentx-artifact>([\s\S]*?)<\/agentx-artifact>/gi
  let t: RegExpExecArray | null
  while ((t = tag.exec(String(answer || "")))) {
    try {
      const a = JSON.parse(t[1].trim())
      if (a && typeof a.filename === "string") artifacts.push({ filename: a.filename, mime: typeof a.mime === "string" ? a.mime : "" })
    } catch { /* a broken tag is no artifact */ }
  }
  const files = [...byPath.values()].sort((a, b) => rank[b.op] - rank[a.op] || a.path.localeCompare(b.path))
  return { files, artifacts, attached: [] }
}

/** The file names an "Attached: a, b" line lists, from a thread's messages. */
export function attachedOf(texts: string[]): string[] {
  const out: string[] = []
  for (const t of texts || []) {
    const m = String(t || "").match(/(?:^|\n)Attached: ([^\n]+)\s*$/)
    if (m) for (const n of m[1].split(", ")) if (n.trim() && out.indexOf(n.trim()) < 0) out.push(n.trim())
  }
  return out
}

/** Several runs' files as one list (a chat): ops and changes add up. */
export function mergeRunFiles(all: RunFiles[]): RunFiles {
  const rank: Record<string, number> = { read: 0, edited: 1, wrote: 2 }
  const changes = (o: string) => (o === "read" ? 0 : 1)
  const byPath = new Map<string, RunFile>()
  const artifacts: Array<{ filename: string; mime: string }> = []
  const attached: string[] = []
  for (const r of all || []) {
    for (const f of r.files) {
      const g = byPath.get(f.path)
      if (!g) { byPath.set(f.path, { path: f.path, op: f.op, n: f.n, changes: f.changes.slice() }); continue }
      if (changes(f.op) > changes(g.op)) g.n = f.n
      else if (changes(f.op) === changes(g.op)) g.n += f.n
      if (rank[f.op] > rank[g.op]) g.op = f.op
      g.changes = g.changes.concat(f.changes).slice(0, 20)
    }
    for (const a of r.artifacts) if (!artifacts.some((x) => x.filename === a.filename)) artifacts.push(a)
    for (const a of r.attached) if (attached.indexOf(a) < 0) attached.push(a)
  }
  const files = [...byPath.values()].sort((a, b) => rank[b.op] - rank[a.op] || a.path.localeCompare(b.path))
  return { files, artifacts, attached }
}

/** A small line icon (lucide-style, stroke = currentColor) for a file row or button (U1). */
export function wflIcon(kind: string): string {
  const paths: Record<string, string> = {
    files: '<path d="M15 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    wrote: '<path d="M15 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
    edited: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    read: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5V21M18 15.5V9a3 3 0 0 0-3-3h-4M13 3l-2 3 2 3"/>',
    art: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    dir: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    att: '<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  }
  return `<svg class="wfl__ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind] || paths.files}</svg>`
}

/** The shared eight-ray loader (#2152): the markup of afLoaderHtml
 *  (../affect.css.ts), here as its own function so it ships with these. */
export function wflLoader(label: string): string {
  let rays = ""
  for (let i = 0; i < 8; i++) rays += `<span style="rotate:${i * 45}deg;animation-delay:${((i - 8) * 0.1).toFixed(1)}s"></span>`
  return `<span class="ax-af-loader" role="status"><span class="ax-af-loader__rays" aria-hidden="true">${rays}</span>${label}</span>`
}

/** The Files tab: changed files, then read ones, artifacts, attachments, and the PR when there is one. */
export function filesTabHtml(r: RunFiles, o: { key: string; changes?: { id: string; ref: string } | null }): string {
  const esc = (s: unknown) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
  const word: Record<string, string> = { wrote: "wrote", edited: "edited", read: "read" }
  const name = (p: string) => p.replace(/^.*\//, "")
  const dir = (p: string) => (p.indexOf("/") >= 0 ? p.replace(/\/[^/]*$/, "") : "")
  const rows: string[] = []
  if (o.changes) rows.push(`<li><button type="button" class="wfl__i" data-cx="open" data-kind="changes" data-id="${esc(o.changes.id)}"><span class="wfl__op is-pr">${wflIcon("pr")}PR</span><b>${esc(o.changes.ref)}</b><small>its changes</small></button></li>`)
  r.files.forEach((f, i) => {
    rows.push(`<li><button type="button" class="wfl__i" data-cx="wfile" data-src="${esc(o.key)}" data-i="${i}" title="${esc(f.path)}"><span class="wfl__op is-${esc(f.op)}">${wflIcon(f.op)}${esc(word[f.op])}</span><b>${esc(name(f.path))}</b><small>${esc(dir(f.path))}${f.n > 1 ? ` · ${f.n}×` : ""}</small></button></li>`)
  })
  for (const a of r.artifacts) rows.push(`<li><span class="wfl__i"><span class="wfl__op is-art">${wflIcon("art")}file</span><b>${esc(a.filename)}</b><small>${a.mime ? `${esc(a.mime)} · ` : ""}sent with the answer</small></span></li>`)
  for (const a of r.attached) rows.push(`<li><span class="wfl__i"><span class="wfl__op is-att">${wflIcon("att")}attached</span><b>${esc(a)}</b><small>you attached it</small></span></li>`)
  if (!rows.length) return `<div class="ax-af-empty"><strong>No files yet</strong>The runs here read, wrote or attached none.<button type="button" class="wcx__re" data-cx="freload" data-src="${esc(o.key)}">Reload</button></div>`
  const changed = r.files.filter((f) => f.op !== "read").length
  const sum = [`${changed} changed`, `${r.files.length - changed} read`]
  if (r.artifacts.length) sum.push(`${r.artifacts.length} sent`)
  if (r.attached.length) sum.push(`${r.attached.length} attached`)
  return `<p class="wcx__at">${sum.join(" · ")}</p><ul class="wfl">${rows.join("")}</ul>`
}

/** One file from the list, in the panel: what the runs did to it. */
export function runFileHtml(f: RunFile | null | undefined): string {
  const esc = (s: unknown) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
  if (!f) return `<p class="ax-wall__empty">This file is not in the list any more.</p>`
  const head = `<p class="wcx__at"><code>${esc(f.path)}</code> · ${esc(f.op)}${f.n > 1 ? ` in ${f.n} calls` : ""}</p>`
  if (!f.changes.length) {
    return head + `<p class="ax-wall__empty">${f.op === "read" ? "Read by the run. Its log keeps the path, not the content." : "The change was too long to keep in the run's log."}</p>`
  }
  const lines = (s: string, cls: string) => s.split("\n").map((l) => `<tr class="${cls}"><td class="wdf__c">${esc(l)}</td></tr>`).join("")
  return head + f.changes.map((c, i) =>
    `<div class="wfl__ch"><div class="wfl__chh">${c.isNew ? "New file" : `Change ${i + 1}`}</div><div class="wdf__w"><table class="wdf__t wcx__file"><tbody>` +
    (c.before ? lines(c.before, "is-del") : "") + lines(c.after, "is-add") + `</tbody></table></div></div>`).join("")
}

/** What the panel knows of the agent's workspace (GET /api/task/workspace). */
export interface WorkspaceView {
  /** The folder in view, relative to the workspace ("" is its top). */
  dir: string
  /** Its list, once read. */
  list: { root: string; entries: Array<{ name: string; kind: "dir" | "file"; size: number }>; more: boolean } | null
  loading: boolean
  error: string
}

/** The Files tab's Workspace part: the folder in view, its parents as a path to climb, its folders and files. */
export function workspaceHtml(w: WorkspaceView | null | undefined, key: string): string {
  const esc = (s: unknown) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
  if (!w) return ""
  const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
  const parts = w.dir ? w.dir.split("/") : []
  const crumbs = [`<button type="button" class="wfl__cr" data-cx="wsdir" data-src="${esc(key)}" data-path="">workspace</button>`]
  parts.forEach((p, i) => crumbs.push(`<button type="button" class="wfl__cr" data-cx="wsdir" data-src="${esc(key)}" data-path="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</button>`))
  const head = `<h4 class="wfl__h">${wflIcon("dir")}Workspace</h4><nav class="wfl__crs" aria-label="Folder">${crumbs.join('<span aria-hidden="true">/</span>')}</nav>`
  if (w.error) return head + `<p class="ax-wall__empty">Workspace not available: ${esc(w.error)}.</p>`
  if (!w.list) return head + wflLoader("Reading the workspace…")
  const at = (n: string) => (w.dir ? `${w.dir}/${n}` : n)
  const rows = (w.list.entries || []).map((e) => e.kind === "dir"
    ? `<li><button type="button" class="wfl__i wfl__ws" data-cx="wsdir" data-src="${esc(key)}" data-path="${esc(at(e.name))}"><span class="wfl__op is-dir">${wflIcon("dir")}folder</span><b>${esc(e.name)}</b></button></li>`
    : `<li><button type="button" class="wfl__i wfl__ws" data-cx="wsfile" data-src="${esc(key)}" data-path="${esc(at(e.name))}"><span class="wfl__op">${wflIcon("files")}file</span><b>${esc(e.name)}</b><small>${kb(e.size)}</small></button></li>`)
  if (!rows.length) return head + `<p class="ax-wall__empty">This folder is empty.</p>`
  return head + `<ul class="wfl">${rows.join("")}</ul>` + (w.list.more ? `<p class="wcx__at">Only the first 500 are listed.</p>` : "")
}

/** One workspace file, as it is now, in the panel. */
export function workspaceFileHtml(f: { path: string; content?: string; size?: number; error?: string; loading?: boolean } | null | undefined): string {
  const esc = (s: unknown) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
  if (!f) return `<p class="ax-wall__empty">Nothing to show here any more.</p>`
  const head = `<p class="wcx__at"><code>${esc(f.path)}</code> · as it is now in the workspace</p>`
  if (f.error) return head + `<p class="ax-wall__empty">Not shown: ${esc(f.error)}.</p>`
  if (f.loading || typeof f.content !== "string") return head + wflLoader("Reading the file…")
  const lines = f.content.split("\n").map((l, i) => `<tr><td class="wdf__n">${i + 1}</td><td class="wdf__c">${esc(l)}</td></tr>`).join("")
  return head + `<div class="wdf__w"><table class="wdf__t wcx__file"><tbody>${lines}</tbody></table></div>`
}

/** A run's path as the workspace knows it: relative, or absolute under its root. Null when it is elsewhere. */
export function workspaceRel(path: string, root: string): string | null {
  const p = String(path || "")
  if (!p) return null
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {
    const r = String(root || "").replace(/\/+$/, "")
    return r && p.startsWith(r + "/") ? p.slice(r.length + 1) : null
  }
  return p.split("/").indexOf("..") >= 0 ? null : p.replace(/^\.\//, "")
}

export const WALL_FILES_CSS = `
/* The right panel's Files tab (#2101 R17). */
.wfl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.wfl > li { animation: wfl-in .22s cubic-bezier(.2, .7, .2, 1) both; }
.wfl > li:nth-child(2) { animation-delay: 20ms; } .wfl > li:nth-child(3) { animation-delay: 40ms; } .wfl > li:nth-child(4) { animation-delay: 60ms; } .wfl > li:nth-child(n+5) { animation-delay: 80ms; }
@keyframes wfl-in { from { opacity: 0; transform: translateY(4px); } }
.wfl__i { display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto; column-gap: 10px; align-items: center; width: 100%; text-align: left; background: none; border: 0; border-radius: var(--ax-radius-sm); padding: 6px 8px; font: inherit; color: var(--ax-text); transition: background-color .15s ease; }
button.wfl__i { cursor: pointer; }
button.wfl__i:hover, button.wfl__i:focus-visible { background: var(--ax-surface-2); }
button.wfl__i:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: -2px; }
.wfl__i b { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wfl__i small { grid-column: 2; color: var(--ax-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wfl__op { grid-row: 1 / span 2; display: inline-flex; align-items: center; justify-content: center; gap: 4px; font-size: 11px; font-weight: 600; border-radius: var(--ax-radius-sm); padding: 3px 7px; min-width: 66px; background: var(--ax-surface-2); color: var(--ax-muted); }
.wfl__ic { flex: none; }
.wfl__op.is-wrote, .wfl__op.is-edited { background: color-mix(in srgb, var(--ax-green) 14%, transparent); color: var(--ax-green); }
.wfl__op.is-pr { background: var(--ax-blue-t); color: var(--ax-accent); }
.wfl__h { display: flex; align-items: center; gap: 6px; margin: 16px 0 4px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ax-muted); }
.wfl__crs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; margin: 0 0 6px; font-size: 12px; color: var(--ax-muted); }
.wfl__cr { font: inherit; color: var(--ax-accent); background: none; border: 0; border-radius: var(--ax-radius-sm); padding: 1px 4px; cursor: pointer; }
.wfl__cr:hover, .wfl__cr:focus-visible { background: var(--ax-surface-2); }
.wfl__ws { grid-template-rows: auto; }
.wcx__now { margin: 0 0 10px; }
.wfl__ch { margin: 0 0 12px; } .wfl__chh { font-size: 12px; color: var(--ax-muted); margin: 0 0 4px; }
.wcx__file tr.is-del { background: color-mix(in srgb, var(--ax-red) 12%, transparent); }
.wcx__src { display: flex; flex-direction: row; align-items: center; gap: 8px; }
.wcx__src a { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wcx__re { flex: none; font: inherit; font-size: var(--ax-fs-xs); color: var(--ax-muted); background: none; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-pill); padding: 2px 9px; cursor: pointer; }
.wcx__re:hover { color: var(--ax-text); border-color: var(--ax-text-2); }
.wcx__tab .wfl__ic { vertical-align: -2px; margin-right: 4px; }
/* The Files buttons on the Task page and in the chat header. */
.wtask__files, .hc__files { display: inline-flex; align-items: center; gap: 5px; }
.wtask__files { font: inherit; font-size: var(--ax-fs-xs); font-weight: 600; color: var(--ax-text-2); background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-pill); padding: 2px 10px; cursor: pointer; transition: background-color .15s ease, border-color .15s ease, color .15s ease; }
.wtask__files:hover, .wtask__files[aria-pressed="true"], .hc__files[aria-pressed="true"] { background: var(--ax-blue-t); border-color: var(--ax-accent); color: var(--ax-accent); }
/* The panel slides in when a tab opens it, the tab's body fades in. */
.wcx:not([hidden]) { animation: wcx-in .22s cubic-bezier(.2, .7, .2, 1); }
@keyframes wcx-in { from { opacity: 0; transform: translateX(12px); } }
@media (prefers-reduced-motion: reduce) { .wfl > li, .wcx:not([hidden]) { animation: none; } .wfl__i, .wtask__files { transition: none; } }
`
