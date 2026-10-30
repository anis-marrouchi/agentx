#!/usr/bin/env node
// The Hub name check (#1485): no old name of the Hub ("Wall") where a person
// reads it, in the dashboard code or the docs. Runs in CI (ci.yml). The rules
// are in scripts/hub-name-check-lib.mjs.
//
//   node scripts/hub-name-check.mjs
//
// Reads the files git tracks under ROOTS. Exit 1 lists every line found.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { findOldNames, kindOf } from "./hub-name-check-lib.mjs"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
/** What people read: the code that draws the dashboard and the docs. The
 *  changelog and design notes are history and keep the old name. */
const ROOTS = ["src", "apps", "docs", "README.md", "CONTRIBUTING.md"]

const files = execFileSync("git", ["ls-files", "--", ...ROOTS], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean)
let found = 0
let checked = 0
for (const file of files) {
  const kind = kindOf(file)
  if (!kind) continue
  checked++
  for (const hit of findOldNames(readFileSync(resolve(repo, file), "utf8"), kind)) {
    found++
    console.log(`${file}:${hit.line}: "${hit.name}" (the Hub's old name): ${hit.text}`)
  }
}
console.log(`Checked ${checked} file(s) for the Hub's old name: ${found} found.`)
if (found) {
  console.log("Use HUB_NAME from src/daemon/ui/hub-name.ts in code, and \"Hub\" in the docs.")
  process.exit(1)
}
