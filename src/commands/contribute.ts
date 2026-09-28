import { Command } from "commander"
import chalk from "chalk"
import { readFile } from "node:fs/promises"
import { getPackageInfo } from "@/utils/get-package-info"
import {
  CATEGORIES, MODELS_URL, NEW_ISSUE_URL, VOTE_URL,
  buildIssueUrl, isRecommended, loadModels, notRecommendedMessage, searchIssues, type Draft,
} from "@/contrib/contribute"

// --- agentx contribute: help a person file a clear issue (#281) ---

export const contribute = new Command()
  .name("contribute")
  .description("help you file a clear AgentX issue — check the model, find duplicates, build a pre-filled form link")
  .action(() => {
    console.log()
    console.log(chalk.bold("  Two equally welcome ways to contribute"))
    console.log()
    console.log(`  1. Write it yourself: ${NEW_ISSUE_URL}`)
    console.log("  2. Let your agent help: install the skill with")
    console.log(chalk.cyan("       agentx skill install anis-marrouchi/agentx/agentx-contribute"))
    console.log("     then ask your agent to help you file an AgentX issue.")
    console.log()
    console.log(`  Before posting, please 👍 the open requests you care about: ${VOTE_URL}`)
    console.log(`  Categories: ${Object.keys(CATEGORIES).join(", ")}`)
    console.log()
  })

contribute
  .command("check-model <model>")
  .description("check whether a model is on the recommended list (contrib/models.json)")
  .option("--models <pathOrUrl>", "model list to read", MODELS_URL)
  .action(async (model: string, opts) => {
    try {
      const list = await loadModels(opts.models)
      if (isRecommended(model, list)) {
        console.log(chalk.green(`  "${model}" is on the recommended list.`))
        return
      }
      console.log(notRecommendedMessage(model, list))
      process.exitCode = 1
    } catch (e: any) {
      console.error(chalk.red(`  ${e.message}`))
      console.error(`  You can always write the issue yourself: ${NEW_ISSUE_URL}`)
      process.exitCode = 1
    }
  })

contribute
  .command("search <words...>")
  .description("list open issues that match, most-voted first — check for duplicates before drafting")
  .action(async (words: string[]) => {
    try {
      const hits = await searchIssues(words.join(" "))
      if (!hits.length) {
        console.log("  No open issue matches. It looks new.")
        return
      }
      for (const h of hits) console.log(`  #${h.number}  👍 ${h.votes}  ${h.title}\n        ${h.url}`)
    } catch (e: any) {
      console.error(chalk.red(`  ${e.message}`))
      process.exitCode = 1
    }
  })

contribute
  .command("draft <file>")
  .description("turn a draft JSON file ({category, title, fields}) into a pre-filled issue form link; '-' reads stdin")
  .requiredOption("--model <model>", "the model that wrote the draft")
  .option("--models <pathOrUrl>", "model list to read", MODELS_URL)
  .action(async (file: string, opts) => {
    try {
      const list = await loadModels(opts.models)
      if (!isRecommended(opts.model, list)) {
        console.log(notRecommendedMessage(opts.model, list))
        process.exitCode = 1
        return
      }
      const raw = file === "-" ? await readStdin() : await readFile(file, "utf8")
      const draft = JSON.parse(raw) as Draft
      const { version } = await getPackageInfo()
      const url = buildIssueUrl({ ...draft, fields: draft.fields ?? {} }, { model: opts.model, version: version ?? "unknown" })
      console.log(url)
    } catch (e: any) {
      console.error(chalk.red(`  ${e.message}`))
      process.exitCode = 1
    }
  })

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}
