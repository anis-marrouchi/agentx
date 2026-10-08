import type { Command } from "commander"
import chalk from "chalk"
import { resolve } from "path"

// --- agentx wiki ontology: the wiki's page types, links and lenses (#811) ---
//
// `show` prints the model the wiki runs on, `check` says why an edited
// ontology.yaml is not being used, and `init` writes the built-in model out
// so a person can edit it.

const wikiDir = (dir?: string) => dir || resolve(process.cwd(), ".agentx/wiki")

const list = (xs: string[]) => (xs.length ? xs.join(", ") : chalk.dim("none"))

export function registerWikiOntology(wiki: Command): void {
  const ontology = wiki
    .command("ontology")
    .description("the wiki's page types, links, importance levels and page layouts (ontology.yaml)")

  ontology
    .command("show")
    .description("print the ontology in use: pillars, types, links, importance levels, sidebar")
    .option("--dir <path>", "wiki directory")
    .option("--type <id>", "one type: its links and the panels its page opens with")
    .option("--json", "print JSON")
    .action(async (opts) => {
      const { loadOntology, lensFor, pillarOf } = await import("@/wiki/ontology")
      const { ontology: o, source, path, problems } = loadOntology(wikiDir(opts.dir))
      if (opts.json) { console.log(JSON.stringify(o, null, 2)); return }

      console.log()
      console.log(source === "file" ? chalk.dim(`  from ${path}`) : chalk.dim("  built-in defaults (no valid ontology.yaml)"))
      if (problems.length) console.log(chalk.yellow(`  ${path} is not used: ${problems.length} problem(s). Run: agentx wiki ontology check`))
      console.log()

      if (opts.type) {
        const t = o.types.find((x) => x.id === opts.type)
        if (!t) { console.error(chalk.red(`  no type "${opts.type}". Types: ${o.types.map((x) => x.id).join(", ")}`)); process.exitCode = 1; return }
        console.log(`  ${chalk.bold(t.label)} ${chalk.dim(`(${t.id})`)} in ${pillarOf(o, t.id)?.label ?? chalk.dim("no pillar (fallback)")}`)
        console.log(chalk.dim(`    schema.org: ${list(t.schema_org)} · kinds: ${list(t.kinds)}`))
        console.log()
        console.log(chalk.bold("  Links"))
        for (const p of o.properties) {
          const out = p.from.includes(t.id) || p.from.includes("*")
          const into = p.to.includes(t.id) || p.to.includes("*")
          if (!out && !into) continue
          // A link open to every type on both ends reads the same either way.
          const label = !p.from.includes(t.id) && !p.to.includes(t.id) && p.from.includes("*") && p.to.includes("*")
            ? `${p.label} ↔ any page`
            : p.to.includes(t.id) || !out
              ? `${p.inverse ?? p.label} ← ${p.from.join(", ")}`
              : `${p.label} → ${p.to.join(", ")}`
          const q = p.qualifiers.length ? chalk.dim(` {${p.qualifiers.map((x) => (p.required.includes(x) ? `${x}*` : x)).join(", ")}}`) : ""
          console.log(`    ${chalk.cyan(p.id)} ${label}${q}`)
        }
        console.log()
        console.log(chalk.bold("  Page opens with"))
        lensFor(o, t.id).forEach((panel, i) => {
          const from = panel.from === undefined ? "" : Array.isArray(panel.from) ? panel.from.join(", ") : panel.from
          const extra = [panel.show ? `top ${panel.show}` : "", panel.fold ? `${panel.fold} folded` : "", panel.access ? `${panel.access} only` : ""].filter(Boolean).join(" · ")
          console.log(`    ${i + 1}. ${panel.panel}${from ? chalk.dim(` from ${from}`) : ""}${extra ? chalk.dim(` · ${extra}`) : ""}`)
        })
        console.log()
        return
      }

      console.log(chalk.bold("  Pillars") + chalk.dim(" (sidebar order)"))
      for (const p of o.pillars) {
        console.log(`    ${p.label.padEnd(24)} ${chalk.dim(p.types.join(", "))}`)
      }
      const fallback = o.types.filter((t) => t.fallback).map((t) => t.id)
      if (fallback.length) console.log(chalk.dim(`    fallback: ${fallback.join(", ")}`))
      console.log()
      console.log(`  ${chalk.bold("Links")}       ${o.properties.length} ${chalk.dim(o.properties.map((p) => p.id).join(", "))}`)
      console.log(`  ${chalk.bold("Importance")}  ${o.importance.map((l) => (l.nav ? `${l.id} (in navigation)` : l.id)).join(" · ")}`)
      console.log(chalk.dim(`              ${o.rollup.min}+ ${o.rollup.level} events of one kind on one page in ${o.rollup.window_days} days become one ${o.rollup.raise_to} event`))
      console.log(chalk.dim(`              ${o.major.level} is set by ${o.major.set_by.join(" or ")}${o.major.agents_propose ? "; agents may propose it" : ""}`))
      console.log(`  ${chalk.bold("Legal")}       confirmed by ${o.confirm.legal.join(" or ")}`)
      console.log(`  ${chalk.bold("Sidebar")}     ${o.sidebar.show.join(" · ")} · up to ${o.sidebar.pins_max} pins`)
      console.log()
      console.log(chalk.dim("  One type in detail: agentx wiki ontology show --type <id>"))
      console.log()
    })

  ontology
    .command("check")
    .description("check ontology.yaml; lists every problem that keeps it from being used")
    .option("--dir <path>", "wiki directory")
    .action(async (opts) => {
      const { loadOntology } = await import("@/wiki/ontology")
      const { source, path, problems } = loadOntology(wikiDir(opts.dir))
      if (problems.length) {
        console.error(chalk.red(`  ${path}: ${problems.length} problem(s); the wiki uses the built-in defaults until they are fixed`))
        for (const p of problems) console.error(`    - ${p}`)
        process.exitCode = 1
        return
      }
      console.log(source === "file" ? chalk.green(`  ${path} is valid and in use`) : chalk.dim(`  no ${path}; the wiki uses the built-in defaults`))
    })

  ontology
    .command("init")
    .description("write the built-in ontology to ontology.yaml so you can edit it")
    .option("--dir <path>", "wiki directory")
    .option("--force", "replace an existing ontology.yaml")
    .action(async (opts) => {
      const { writeStarterOntology, ONTOLOGY_FILE } = await import("@/wiki/ontology")
      const dir = wikiDir(opts.dir)
      if (!writeStarterOntology(dir, opts.force)) {
        console.error(chalk.yellow(`  ${resolve(dir, ONTOLOGY_FILE)} already exists; add --force to replace it`))
        process.exitCode = 1
        return
      }
      console.log(chalk.green(`  wrote ${resolve(dir, ONTOLOGY_FILE)}`))
    })
}
