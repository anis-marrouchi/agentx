#!/usr/bin/env node
// UI evidence check: a PR that changes UI paths shows a screenshot or a
// recording under "## Evidence" in its description. Paths and patterns live
// in scripts/ui-evidence.config.json; the checks are in
// scripts/ui-evidence-lib.mjs.
//
//   node scripts/ui-evidence.mjs --base <ref> --head <ref>
//     Changed files from git (for a local run).
//   node scripts/ui-evidence.mjs --pr <number> [--post-check <sha>]
//     Changed files from the GitHub API (in CI). With --post-check, also
//     posts the verdict as a "ui-evidence" check run on that commit.
//
// Reads PR_BODY and PR_LABELS (comma or newline separated) from the env.
// UI_EVIDENCE_MODE is "advisory" (default: a failure is reported as
// neutral and exits 0), "required" (a failure exits 1) or "false"/"off".
// --json prints the verdict as JSON. Exit 2 on bad usage or API errors.
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { evaluate } from "./ui-evidence-lib.mjs"

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const config = JSON.parse(readFileSync(opt("config") ?? new URL("./ui-evidence.config.json", import.meta.url), "utf8"))
const inActions = process.env.GITHUB_ACTIONS === "true"
const rawMode = (process.env.UI_EVIDENCE_MODE ?? "").trim().toLowerCase()
const mode = ["false", "off", "0"].includes(rawMode) ? "off" : rawMode === "required" ? "required" : "advisory"

function report(level, message) {
  if (inActions) console.log(`::${level}::${message.replace(/\n/g, "%0A")}`)
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

async function changedFiles() {
  const pr = opt("pr")
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

if (mode === "off") {
  console.log("UI evidence check is switched off (QUALITY_UI_EVIDENCE_ENABLED=false).")
  process.exit(0)
}

const verdict = evaluate({
  files: await changedFiles(),
  pr: { body: process.env.PR_BODY ?? "", labels: (process.env.PR_LABELS ?? "").split(/[,\n]/).map((l) => l.trim()).filter(Boolean) },
  config,
})
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
if (sha) {
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
