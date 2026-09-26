#!/usr/bin/env node
import { buildProgram } from "@/program"
import { installCliSignalExit } from "@/utils/signal-exit"

installCliSignalExit()

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
