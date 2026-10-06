// Writes every AgentX icon file from the AX symbol (src/brand/ax-symbol.ts).
//
//   pnpm icons           rewrite the files that changed
//   pnpm icons --check   list the files that are out of date, exit 1 if any

import { existsSync, readFileSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import { iconFiles, sameIcon } from "../src/brand/icon-files"

const root = resolve(import.meta.dirname, "..")
const check = process.argv.includes("--check")
let stale = 0

for (const file of iconFiles(root)) {
  const abs = join(root, file.path)
  const want = file.render()
  if (existsSync(abs) && sameIcon(readFileSync(abs), want)) continue
  stale++
  if (check) console.log(`out of date: ${file.path}`)
  else {
    writeFileSync(abs, want)
    console.log(`wrote ${file.path}`)
  }
}

if (check && stale) {
  console.log(`\n${stale} icon file(s) out of date. Run: pnpm icons`)
  process.exit(1)
}
if (!stale) console.log("All icons up to date.")
