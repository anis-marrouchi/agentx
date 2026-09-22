#!/usr/bin/env node
// VitePress checks Markdown links, but does not validate theme navigation.
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { resolveConfig } from "vitepress"

const docs = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const config = await resolveConfig(docs, "build")
const links = []
function walk(value) {
  if (!value || typeof value !== "object") return
  if (typeof value.link === "string" && value.link.startsWith("/") && !value.link.startsWith("//")) links.push(value.link)
  for (const child of Object.values(value)) walk(child)
}
walk(config.site.themeConfig.nav)
walk(config.site.themeConfig.sidebar)
if (!links.length) throw new Error("No internal navigation links were checked")
const missing = [...new Set(links)].filter(link => {
  const clean = link.split(/[?#]/)[0]
  const path = clean.endsWith("/") ? `${clean}index.md` : `${clean.replace(/\.html$/, "")}.md`
  return !existsSync(resolve(docs, `.${path}`))
})
if (missing.length) {
  console.error(`Missing documentation pages: ${missing.join(", ")}`)
  process.exitCode = 1
} else console.log(`Checked ${links.length} navigation links.`)
