// --- Ctrl-C / SIGTERM for CLI commands ---
//
// Short commands should exit at once when stopped. Long-running ones (the
// daemon above all) install their own handler to finish in-flight work first.
// The CLI's quick exit used to be registered unconditionally, before the
// daemon's, and Node runs listeners in registration order — so every stop
// exited the process before the daemon's drain began and killed in-flight
// agent tasks mid-turn (#103). Now the quick exit only fires when nobody
// else handles the signal. It exits 128 + signo (130, 143), the shell
// convention, so a script can tell "stopped" from "done" (#1388).

type SignalTarget = Pick<NodeJS.Process, "on" | "listenerCount" | "exit"> & { stderr?: { write(s: string): unknown } }

export const CLI_EXIT_SIGNALS = ["SIGINT", "SIGTERM"] as const

const SIGNO = { SIGINT: 2, SIGTERM: 15 } as const

export function installCliSignalExit(proc: SignalTarget = process): void {
  for (const sig of CLI_EXIT_SIGNALS) {
    proc.on(sig, () => {
      // This listener is always one of them; anything more means a command
      // is handling the stop itself.
      if (proc.listenerCount(sig) > 1) return
      proc.stderr?.write(`Stopped by ${sig}.\n`)
      proc.exit(128 + SIGNO[sig])
    })
  }
}
