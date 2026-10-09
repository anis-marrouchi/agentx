import type { SignalService } from "./service"

// Process-wide handle, set by the daemon once the service exists, so the
// `signal.resume` built-in action (workflow steps) can reach it.

let instance: SignalService | undefined

export function setSignalService(s: SignalService | undefined): void {
  instance = s
}

export function getSignalService(): SignalService | undefined {
  return instance
}
