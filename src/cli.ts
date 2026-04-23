#!/usr/bin/env node
import { buildProgram } from "@/program"

process.on("SIGINT", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))

async function main() {
  const program = await buildProgram()

  const args = process.argv.slice(2)
  if (args.length === 0) {
    program.outputHelp()
    return
  }

  program.parse()
}

main()
