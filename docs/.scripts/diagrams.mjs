#!/usr/bin/env node
// Builds every diagram spec in docs/.scripts/diagrams/ into docs/public/diagrams/.
// `--check` writes nothing and fails when a committed file is out of date.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const specs = join(here, "diagrams")
const target = resolve(here, "..", "public", "diagrams")
const check = process.argv.includes("--check")

const names = readdirSync(specs)
  .filter(file => file.endsWith(".mjs") && file !== "kit.mjs")
  .map(file => file.slice(0, -4))
  .sort()
if (!names.length) throw new Error(`No diagram specs found in ${specs}`)

const stale = []
if (!check) mkdirSync(target, { recursive: true })
for (const name of names) {
  const { default: svg } = await import(pathToFileURL(join(specs, `${name}.mjs`)).href)
  if (typeof svg !== "string" || !svg.startsWith("<svg")) throw new Error(`${name}.mjs must export the SVG text as its default export`)
  const file = join(target, `${name}.svg`)
  const current = existsSync(file) ? readFileSync(file, "utf8") : null
  if (current === svg) continue
  if (check) stale.push(`docs/public/diagrams/${name}.svg`)
  else {
    writeFileSync(file, svg)
    console.log(`Wrote docs/public/diagrams/${name}.svg`)
  }
}

if (stale.length) {
  console.error(`Out of date: ${stale.join(", ")}. Run \`pnpm docs:diagrams\` and commit the result.`)
  process.exitCode = 1
} else console.log(`${check ? "Checked" : "Built"} ${names.length} diagram${names.length === 1 ? "" : "s"}.`)
