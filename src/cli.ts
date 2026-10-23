#!/usr/bin/env node
import { unsupportedNodeMessage } from "@/utils/node-version"

// Static imports load before any code here runs, and a dependency fails to
// load on an old Node. So the check comes first and the rest is imported after.
const refusal = unsupportedNodeMessage(process.versions.node)
if (refusal) {
  console.error(refusal)
  process.exit(1)
}

const { buildProgram } = await import("@/program")
const { installCliSignalExit } = await import("@/utils/signal-exit")
const { applyConnectAttemptTimeout, configPathFromArgv, readConnectAttemptTimeout } = await import("@/daemon/net-family")

installCliSignalExit()
// CLI commands that call out on their own need the same connect attempt
// timeout as the daemon, or they fail on a slow dual-stack link (#930).
// Read the file the command was pointed at, so a daemon started with
// --config gets its own value and not the default first.
applyConnectAttemptTimeout(readConnectAttemptTimeout(process.cwd(), configPathFromArgv(process.argv.slice(2))))

const program = await buildProgram()

if (process.argv.slice(2).length === 0) {
  program.outputHelp()
} else {
  program.parse()
}
