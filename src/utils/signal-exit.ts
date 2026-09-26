// --- Ctrl-C / SIGTERM for CLI commands ---
//
// Short commands should exit at once when stopped. Long-running ones (the
// daemon above all) install their own handler to finish in-flight work first.
// The CLI's quick exit used to be registered unconditionally, before the
// daemon's, and Node runs listeners in registration order — so every stop
// exited the process before the daemon's drain began and killed in-flight
// agent tasks mid-turn (#103). Now the quick exit only fires when nobody
// else handles the signal.

type SignalTarget = Pick<NodeJS.Process, "on" | "listenerCount" | "exit">

export const CLI_EXIT_SIGNALS = ["SIGINT", "SIGTERM"] as const

export function installCliSignalExit(proc: SignalTarget = process): void {
  for (const sig of CLI_EXIT_SIGNALS) {
    proc.on(sig, () => {
      // This listener is always one of them; anything more means a command
      // is handling the stop itself.
      if (proc.listenerCount(sig) <= 1) proc.exit(0)
    })
  }
}
