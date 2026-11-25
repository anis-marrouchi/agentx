#!/usr/bin/env node
// The React Hub's first-load budget (#2218 condition C4): the entry script,
// the chunks it imports statically and its CSS, gzipped, must stay at or
// under 250 kB. Lazy pages are not counted: they load when opened.
//
//   node scripts/hub-budget.mjs [--max-kb 250] [--dir dist/web/hub]
import { readFileSync } from "fs"
import { join } from "path"
import { gzipSync } from "zlib"

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt }
const dir = arg("--dir", "dist/web/hub")
const maxKb = Number(arg("--max-kb", "250"))

let manifest
try { manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) }
catch { console.error(`No ${dir}/manifest.json: run pnpm build:hub first.`); process.exit(1) }

const files = new Set()
const walk = (key, seen = new Set()) => {
  if (seen.has(key) || !manifest[key]) return
  seen.add(key)
  const c = manifest[key]
  files.add(c.file)
  for (const css of c.css ?? []) files.add(css)
  for (const imp of c.imports ?? []) walk(imp, seen)
}
for (const [key, c] of Object.entries(manifest)) if (c.isEntry) walk(key)

let total = 0
for (const f of files) {
  const gz = gzipSync(readFileSync(join(dir, f)), { level: 9 }).length
  total += gz
  console.log(`${(gz / 1000).toFixed(1).padStart(8)} kB  ${f}`)
}
console.log(`${(total / 1000).toFixed(1).padStart(8)} kB  first load, gzip (budget ${maxKb} kB)`)
if (total > maxKb * 1000) { console.error(`Over budget by ${((total - maxKb * 1000) / 1000).toFixed(1)} kB.`); process.exit(1) }
