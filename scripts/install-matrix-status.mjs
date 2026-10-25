#!/usr/bin/env node
// Records one install-matrix run on the install-matrix-status branch (#1294):
// history.json (the last runs) and badge.json (the README's pass-rate badge).
// Run by .github/workflows/install-matrix.yml; never touches main.
//
// Env: VERSION, OK ("true"/"false"), RUN_URL, CELLS (JSON: cell → result).
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { badgeJson, passRate, recordRun } from "./install-matrix-lib.mjs"

const BRANCH = "install-matrix-status"
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim()

const dir = mkdtempSync(join(tmpdir(), "install-matrix-"))
const exists = git(["ls-remote", "--heads", "origin", BRANCH]) !== ""
if (exists) {
  git(["fetch", "--depth=1", "origin", BRANCH])
  git(["worktree", "add", "--detach", dir, "FETCH_HEAD"])
} else {
  // First run: an empty branch with only the two files.
  git(["worktree", "add", "--detach", dir])
  git(["checkout", "--orphan", BRANCH], dir)
  git(["rm", "-rf", "--quiet", "."], dir)
}

const historyPath = join(dir, "history.json")
const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : []
let cells = {}
try { cells = JSON.parse(process.env.CELLS || "{}") } catch { /* recorded without cells */ }
const next = recordRun(history, {
  at: new Date().toISOString(),
  version: process.env.VERSION,
  ok: process.env.OK === "true",
  run: process.env.RUN_URL,
  cells,
})
writeFileSync(historyPath, JSON.stringify(next, null, 2) + "\n")
writeFileSync(join(dir, "badge.json"), JSON.stringify(badgeJson(next)) + "\n")

const { passed, runs, percent } = passRate(next)
git(["add", "history.json", "badge.json"], dir)
git(["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
  "commit", "--quiet", "-m", `install matrix: ${process.env.VERSION} ${process.env.OK === "true" ? "passed" : "failed"} (${percent}% of last ${runs})`], dir)
git(["push", "origin", `HEAD:refs/heads/${BRANCH}`], dir)
console.log(`Recorded ${process.env.VERSION}: ${process.env.OK === "true" ? "passed" : "failed"}. Pass rate ${passed}/${runs}.`)
