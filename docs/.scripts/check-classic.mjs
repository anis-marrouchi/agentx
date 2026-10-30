#!/usr/bin/env node
// Lists what in docs/ still shows or describes the classic dashboard (#1448):
// classic screenshots, classic tab names (and the top bar) and classic page
// addresses. A report for now: it exits 0 unless run with --strict, which the
// epic's last child (#1447) turns on in CI. --table prints the audit table,
// one row per page, with the epic #1449 child each page waits on.
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const docs = resolve(here, "..")
const repo = resolve(docs, "..")
const cfg = JSON.parse(readFileSync(join(here, "classic-guard.json"), "utf8"))
const args = new Set(process.argv.slice(2))

const glob = pattern => new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*") + "$")
const outOfScope = cfg.outOfScope.map(glob)

function pages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name.startsWith(".") || e.name === "public" || e.name === "node_modules") return []
    const full = join(dir, e.name)
    return e.isDirectory() ? pages(full) : e.name.endsWith(".md") ? [full] : []
  })
}

const tabNames = cfg.tabs.names.join("|")
// "the Live tab", "**Settings** tab", "Settings › Schedules", "the top bar".
const tabRe = new RegExp(`\\*{0,2}\\b(${tabNames})\\b\\*{0,2}\\s+tabs?\\b|\\*{0,2}\\b(Settings)\\b\\*{0,2}\\s*›|(?<!\\bno (?:dashboard )?|column's )\\b(top bar)\\b`, "gi")
const shotRe = /(?:\]\(|src=["'])\/screenshots\/([^)"'\s]+)/g
// A classic address in inline code or after a dashboard host.
const urlRe = /`(?:https?:\/\/[^`\s/]+|<dashboard>)?(\/[a-z][^`\s]*)`|(?:127\.0\.0\.1|localhost):\d+(\/[a-z][^\s)`'"]*)/gi

function classifyShot(path) {
  if (cfg.notDashboard.some(n => path.startsWith(n.shots))) return null
  const hit = cfg.classic.find(c => path.startsWith(c.shots))
  return hit ? { feature: hit.feature, child: hit.child } : { feature: "unclassified screenshot: add it to classic-guard.json", child: "?" }
}
function classifyUrl(path) {
  const clean = path.split(/[?#]/)[0]
  const hit = cfg.urls.find(u => (clean === u.path || clean.startsWith(u.path.endsWith("/") ? u.path : u.path + "/")) && !(u.except || []).some(x => clean.startsWith(x)))
  return hit ? { child: hit.child } : null
}

const findings = []
let scanned = 0
for (const file of pages(docs)) {
  const rel = relative(docs, file)
  if (outOfScope.some(re => re.test(rel))) continue
  scanned++
  let fence = false
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    const at = { page: rel, line: i + 1 }
    for (const m of line.matchAll(shotRe)) {
      const c = classifyShot(m[1])
      if (c) findings.push({ ...at, kind: "screenshot", what: m[1], ...c })
    }
    // Code blocks hold commands and config, not dashboard steps.
    if (/^\s*```/.test(line)) { fence = !fence; return }
    if (fence) return
    for (const m of line.matchAll(tabRe)) {
      const name = m[1] || m[2] || "top bar"
      const key = cfg.tabs.names.find(n => n.toLowerCase() === name.toLowerCase()) || "top bar"
      findings.push({ ...at, kind: "tab", what: m[0].replace(/\*/g, "").trim(), feature: key === "top bar" ? "Classic top bar" : `Classic ${key} tab`, child: cfg.tabs.children[key] || "?" })
    }
    for (const m of line.matchAll(urlRe)) {
      const path = m[1] || m[2]
      const c = classifyUrl(path)
      if (c) findings.push({ ...at, kind: "url", what: path, feature: "Classic page address", ...c })
    }
  })
}

const byPage = new Map()
for (const f of findings) {
  if (!byPage.has(f.page)) byPage.set(f.page, [])
  byPage.get(f.page).push(f)
}
const count = kind => findings.filter(f => f.kind === kind).length

if (args.has("--json")) {
  console.log(JSON.stringify({ scanned, findings }, null, 2))
} else if (args.has("--table")) {
  // One row per page: what it shows, then the children it waits on.
  console.log("| Page | Classic screenshots | Classic tabs | Classic addresses | Waits on |")
  console.log("|---|---|---|---|---|")
  for (const [page, list] of [...byPage].sort()) {
    const n = kind => list.filter(f => f.kind === kind).length || ""
    const children = [...new Set(list.map(f => f.child))].sort()
    const waits = children.filter(c => c !== "fix now")
    console.log(`| \`${page}\` | ${n("screenshot")} | ${n("tab")} | ${n("url")} | ${waits.length ? waits.join(", ") : "fix now"} |`)
  }
} else {
  const gh = !!process.env.GITHUB_ACTIONS
  for (const [page, list] of [...byPage].sort()) {
    console.log(`\n${page}`)
    for (const f of list) {
      console.log(`  ${String(f.line).padStart(4)}  ${f.kind.padEnd(10)} ${f.what}  →  ${f.child} (${f.feature})`)
      if (gh) console.log(`::warning file=${relative(repo, join(docs, f.page))},line=${f.line},title=Classic dashboard (${f.child})::${f.kind}: ${f.what}`)
    }
  }
  console.log(`\nScanned ${scanned} page(s): ${count("screenshot")} classic screenshot(s), ${count("tab")} classic tab name(s), ${count("url")} classic address(es) on ${byPage.size} page(s).`)
}
if (args.has("--strict") && findings.length) process.exitCode = 1
