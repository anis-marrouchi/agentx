#!/usr/bin/env node
// Docs gate: keeps docs/ in step with the code. Three checks, all driven by
// scripts/docs-gate.config.json; the checks themselves are in
// scripts/docs-gate-lib.mjs.
//
//   node scripts/docs-gate.mjs impact --base <ref> --head <ref> \
//        [--base-surface <json>] [--head-surface <json>]
//     A user-facing change needs a docs change (or the exemption label plus
//     a reason); removed commands, flags and settings must leave the docs.
//     Reads PR_TITLE, PR_BODY and PR_LABELS (one per line) from the env.
//   node scripts/docs-gate.mjs coverage --surface <json>
//     Every command, flag and setting is mentioned somewhere in docs/.
//   node scripts/docs-gate.mjs rules (--base <ref> --head <ref> | --all)
//     Changed (or all) pages follow the docs rule in CONTRIBUTING.md.
//
// Surface JSON comes from scripts/docs-surface.mts. Exit 1 on errors.
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { applyBaseline, checkImpact, checkPage, coverageGaps, matchesAny, parseDiff } from "./docs-gate-lib.mjs"

const [mode, ...rest] = process.argv.slice(2)
const opt = (name) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : undefined
}
const configPath = opt("config") ?? new URL("./docs-gate.config.json", import.meta.url)
const config = JSON.parse(readFileSync(configPath, "utf8"))
const inActions = process.env.GITHUB_ACTIONS === "true"

function report(level, { file, line, message }) {
  if (inActions) {
    const where = file ? ` file=${file}${line ? `,line=${line}` : ""}` : ""
    console.log(`::${level}${where}::${message.replace(/\n/g, "%0A")}`)
  } else console.log(`${level}: ${file ? `${file}${line ? `:${line}` : ""}: ` : ""}${message}`)
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
const changedFiles = (base, head) => parseDiff(git("diff", "--no-renames", "-U0", `${base}...${head}`))

function docsPages() {
  return readdirSync(config.docsDir, { recursive: true })
    .map((p) => `${config.docsDir}/${p}`)
    .filter((p) => p.endsWith(".md") && !p.includes("node_modules/") && !p.includes("/.vitepress/"))
    .map((path) => ({ path, text: readFileSync(path, "utf8") }))
}

function readSurface(path) {
  if (!path || !existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    report("warning", { message: `Could not read surface ${path}: ${e.message}` })
    return null
  }
}

function need(...names) {
  const missing = names.filter((n) => !opt(n))
  if (missing.length) {
    console.error(`docs-gate ${mode}: missing ${missing.map((n) => `--${n}`).join(", ")}`)
    process.exit(2)
  }
}

function impact() {
  need("base", "head")
  const pr = {
    title: process.env.PR_TITLE ?? "",
    body: process.env.PR_BODY ?? "",
    labels: (process.env.PR_LABELS ?? "").split(/[,\n]/).map((l) => l.trim()).filter(Boolean),
  }
  const { errors, notes } = checkImpact({
    files: changedFiles(opt("base"), opt("head")),
    pr,
    config,
    base: readSurface(opt("base-surface")),
    head: readSurface(opt("head-surface")),
    pages: docsPages(),
  })
  for (const n of notes) console.log(n)
  for (const e of errors) report("error", e)
  return errors.length
}

function coverage() {
  need("surface")
  const surface = readSurface(opt("surface"))
  if (!surface) {
    report("error", { message: `No surface at ${opt("surface")}` })
    return 1
  }
  const gaps = coverageGaps(surface, docsPages(), config.coverage)
  const blocking = config.coverage.mode === "error"
  const byKind = Object.entries(Object.groupBy(gaps, (g) => g.split(":")[0]))
    .map(([k, v]) => `${v.length} ${k}(s)`)
    .join(", ")
  console.log(`${gaps.length} item(s) are not mentioned in ${config.docsDir}/${gaps.length ? `: ${byKind}` : ""}.`)
  if (gaps.length)
    report(blocking ? "error" : "warning", {
      message: `Not in the docs (${gaps.length}); ${blocking ? "document them" : "warning only for now"}. Full list in the log.`,
    })
  for (const g of gaps) console.log(`  ${g}`)
  return blocking ? gaps.length : 0
}

function rules() {
  const r = config.rules
  const all = rest.includes("--all") || r.scope === "all"
  if (!all) need("base", "head")
  const paths = all
    ? docsPages().map((p) => p.path)
    : changedFiles(opt("base"), opt("head")).filter((f) => f.status !== "deleted").map((f) => f.path)
  const pages = paths.filter((p) => matchesAny(p, r.include) && !matchesAny(p, r.exclude))
  const checks = { ...r, forbidden: [...r.forbidden, ...extraForbidden()] }
  let errorCount = 0
  let warningCount = 0
  for (const path of pages) {
    const problems = checkPage(path, readFileSync(path, "utf8"), checks, existsSync)
    const { errors, warnings } = applyBaseline(path, problems, r.baseline)
    for (const w of warnings) report("warning", { ...w, message: `${w.message} (older page on the baseline: fix it when you can)` })
    for (const e of errors) report("error", e)
    errorCount += errors.length
    warningCount += warnings.length
  }
  console.log(`Checked ${pages.length} page(s) against the docs rule: ${errorCount} error(s), ${warningCount} warning(s).`)
  return errorCount
}

// Organisation-specific names (hosts, agent names) do not belong in this
// public config. CI passes them as a JSON array of { pattern, why } in the
// DOCS_GATE_EXTRA_FORBIDDEN secret; locally the variable is usually unset.
function extraForbidden() {
  const raw = process.env.DOCS_GATE_EXTRA_FORBIDDEN
  if (!raw?.trim()) return []
  try {
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) throw new Error("not an array")
    return list.filter((f) => typeof f?.pattern === "string").map((f) => ({ pattern: f.pattern, why: f.why ?? "organisation-specific name" }))
  } catch (e) {
    report("warning", { message: `DOCS_GATE_EXTRA_FORBIDDEN is not a JSON array of { pattern, why }; ignored (${e.message}).` })
    return []
  }
}

const run = { impact, coverage, rules }[mode]
if (!run) {
  console.error("usage: docs-gate.mjs impact|coverage|rules [options]  (see the header of this file)")
  process.exit(2)
}
process.exit(run() > 0 ? 1 : 0)
