import type { Command } from "commander"
import chalk from "chalk"
import { resolve } from "path"

// --- agentx wiki ontology: the types, relations and lenses the wiki uses (#811) ---
//
// `init` writes the built-in defaults to <wiki>/ontology.yaml so the owner
// can edit them; `check` reports problems in that file; `show` prints how
// many pages each type has.

const wikiDir = (dir?: string) => dir || resolve(process.cwd(), ".agentx/wiki")

export function registerWikiOntology(wiki: Command): void {
  const ontology = wiki
    .command("ontology")
    .description("the wiki's pillars, types, typed relations and page lenses (show, init, check)")

  ontology
    .command("init")
    .description("write the default ontology to ontology.yaml in the wiki, to edit")
    .option("--dir <path>", "wiki directory (default .agentx/wiki)")
    .action(async (opts: { dir?: string }) => {
      const { writeDefaultOntology } = await import("@/wiki/ontology/load")
      try {
        const file = writeDefaultOntology(wikiDir(opts.dir))
        console.log(chalk.green(`  wrote ${file}`))
      } catch (e) {
        console.error(chalk.red(`  ${(e as Error).message}`))
        process.exitCode = 1
      }
    })

  ontology
    .command("check")
    .description("report problems in ontology.yaml")
    .option("--dir <path>", "wiki directory (default .agentx/wiki)")
    .action(async (opts: { dir?: string }) => {
      const { loadOntology } = await import("@/wiki/ontology/load")
      const { file, errors } = loadOntology(wikiDir(opts.dir))
      if (!file) { console.log(chalk.dim("  no ontology.yaml: the built-in defaults are in use")); return }
      if (errors.length === 0) { console.log(chalk.green(`  ${file}: no problems`)); return }
      console.log(chalk.yellow(`  ${file}: ${errors.length} problem(s)`))
      for (const e of errors) console.log(`  - ${e}`)
      process.exitCode = 1
    })

  ontology
    .command("show")
    .description("pages per pillar and type, as the wiki view groups them")
    .option("--dir <path>", "wiki directory (default .agentx/wiki)")
    .option("--json", "print JSON")
    .action(async (opts: { dir?: string; json?: boolean }) => {
      const { loadOntology } = await import("@/wiki/ontology/load")
      const { GraphCache } = await import("@/wiki/ontology/graph")
      const { WikiHub } = await import("@/wiki/hub")
      const dir = wikiDir(opts.dir)
      const { ontology: o, errors } = loadOntology(dir)
      const { registeredAgentNames } = await import("@/wiki/ontology/agent-names")
      const g = new GraphCache().get(new WikiHub(dir, () => {}), o, registeredAgentNames())
      const counts = new Map<string, number>()
      for (const e of g.entities.values()) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
      if (opts.json) {
        console.log(JSON.stringify({ entities: g.entities.size, types: Object.fromEntries(counts), errors }, null, 2))
        return
      }
      console.log(chalk.bold(`  ${g.entities.size} entities`))
      for (const p of o.pillars) {
        const types = o.types.filter(t => t.pillar === p.id)
        const total = types.reduce((n, t) => n + (counts.get(t.id) ?? 0), 0)
        console.log(`  ${p.label.padEnd(26)} ${String(total).padStart(6)}  ${chalk.dim(types.map(t => `${t.id} ${counts.get(t.id) ?? 0}`).join(" · "))}`)
      }
      if (errors.length) console.log(chalk.yellow(`  ontology.yaml has ${errors.length} problem(s): agentx wiki ontology check`))
    })
}
