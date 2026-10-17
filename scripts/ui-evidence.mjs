#!/usr/bin/env node
// UI evidence check: a PR that changes UI paths shows a screenshot or a
// recording under "## Evidence" in its description. Paths and patterns live
// in scripts/ui-evidence.config.json; the checks are in
// scripts/ui-evidence-lib.mjs.
//
//   node scripts/ui-evidence.mjs --base <ref> --head <ref>
//     Changed files from git (for a local run).
//   node scripts/ui-evidence.mjs --pr <number> [--post-check <sha>]
//     Changed files, description and labels from the GitHub API (in CI),
//     read when the run starts, so a run that finishes after a newer one
//     still judges the latest description. With --post-check, also posts the
//     verdict as a "ui-evidence" check run on that commit, unless the PR has
//     moved on to a newer commit (whose own run gives the verdict).
//
// A local run reads PR_BODY and PR_LABELS (comma or newline separated) from
// the env. UI_EVIDENCE_MODE is parsed by parseMode(): "advisory" (default: a
// failure is reported as neutral and exits 0), "required" (a failure exits 1)
// or "false"/"off"/"0" (the check run is posted as a success saying the
// check is switched off).
// --json prints the verdict as JSON. Exit 2 on bad usage or API errors.
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { evaluate, parseMode } from "./ui-evidence-lib.mjs"

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const config = JSON.parse(readFileSync(opt("config") ?? new URL("./ui-evidence.config.json", import.meta.url), "utf8"))
const inActions = process.env.GITHUB_ACTIONS === "true"
const mode = parseMode(process.env.UI_EVIDENCE_MODE)

// Workflow commands treat %, \r and \n as special; escape % first.
const escapeCommand = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")

function report(level, message) {
  if (inActions) console.log(`::${level}::${escapeCommand(message)}`)
  else console.log(`${level}: ${message}`)
}

function fail(message) {
  console.error(`ui-evidence: ${message}`)
  process.exit(2)
}

async function api(path, init = {}) {
  const token = process.env.GITHUB_TOKEN
  if (!token) fail("GITHUB_TOKEN is not set")
  const res = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...init.headers },
  })
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

const repo = () => process.env.GITHUB_REPOSITORY ?? fail("GITHUB_REPOSITORY is not set")

async function changedFiles(pr) {
  if (pr) {
    // The API lists at most 3000 files per PR, 100 per page. A rename
    // counts for both its old and its new path.
    const paths = []
    for (let page = 1; page <= 30; page++) {
      const batch = await api(`/repos/${repo()}/pulls/${pr}/files?per_page=100&page=${page}`)
      for (const f of batch) paths.push(f.filename, ...(f.previous_filename ? [f.previous_filename] : []))
      if (batch.length < 100) break
    }
    return paths
  }
  const base = opt("base")
  const head = opt("head")
  if (!base || !head) fail("pass --pr <number>, or --base <ref> --head <ref>")
  return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean)
}

/** Description and labels: live from the API in CI, from the env locally. */
async function prDetails(pr) {
  if (pr) {
    const live = await api(`/repos/${repo()}/pulls/${pr}`)
    return { body: live.body ?? "", labels: (live.labels ?? []).map((l) => l.name), headSha: live.head?.sha }
  }
  return { body: process.env.PR_BODY ?? "", labels: (process.env.PR_LABELS ?? "").split(/[,\n]/).map((l) => l.trim()).filter(Boolean) }
}

const prNumber = opt("pr")
let verdict
let details = {}
if (mode === "off") {
  // Still posts a check run, so a required ui-evidence check never waits forever.
  verdict = { status: "off", title: "Switched off", summary: "The UI evidence check is switched off (QUALITY_UI_EVIDENCE_ENABLED is false, off or 0).", uiFiles: [], media: [], reason: null }
} else {
  try {
    details = await prDetails(prNumber)
    verdict = evaluate({ files: await changedFiles(prNumber), pr: details, config })
  } catch (e) {
    fail(e.message)
  }
}
const blocking = verdict.status === "failed" && mode === "required"
const conclusion = verdict.status !== "failed" ? "success" : blocking ? "failure" : "neutral"
const title = verdict.status === "failed" && !blocking ? `${verdict.title} (advisory)` : verdict.title

if (args.includes("--json")) console.log(JSON.stringify({ ...verdict, mode, conclusion }, null, 2))
else console.log(`${title}\n\n${verdict.summary}`)
if (verdict.status === "failed") report(blocking ? "error" : "warning", `${title}: ${verdict.summary.split("\n\n")[0]}`)
if (verdict.status === "overridden") report("notice", `UI evidence overridden: ${verdict.reason}`)

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ui-evidence: ${title}\n\nMode: ${mode}. Result: \`${verdict.status}\`.\n\n${verdict.summary}\n`)
}

const sha = opt("post-check")
if (sha && details.headSha && details.headSha !== sha) {
  console.log(`The PR has moved on to ${details.headSha}; that commit's own run posts the ui-evidence check.`)
} else if (sha) {
  try {
    await api(`/repos/${repo()}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: "ui-evidence",
        head_sha: sha,
        status: "completed",
        conclusion,
        output: { title, summary: `Mode: ${mode}. Result: \`${verdict.status}\`.\n\n${verdict.summary}`.slice(0, 65000) },
      }),
    })
  } catch (e) {
    // Fork PRs get a read-only token; the job result and log still apply.
    report("warning", `Could not post the ui-evidence check run: ${e.message}`)
  }
}

process.exit(blocking ? 1 : 0)
