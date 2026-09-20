import { execFile } from "child_process"

// --- Out-of-band confirmation for a destructive operation ---
//
// WHY THIS IS NOT VOICE, AND MUST NEVER BECOME VOICE.
//
// The agent asking for confirmation may have been instructed by voice, and
// speech-to-text mishears. "Delete the draft" and "delete the drive" differ
// by one phoneme. A spoken "yes" is a transcription away from a spoken
// "no", and the same misrecognition that produced a dangerous command can
// produce its approval — the check and the thing being checked would share
// a failure mode, which makes the check worthless.
//
// So confirmation is a native dialog requiring a deliberate click, on a
// different input channel from the one that asked. That is the entire
// point. Do not add a voice path here, however convenient it looks.
//
// DEFAULTS FAVOUR NOT ACTING. The default button is Abort, a timeout is
// Abort, a missing display is Abort, and any error is Abort. The only
// thing that proceeds is an explicit click on Confirm.

export interface ConfirmRequest {
  tool: string
  command: string
  reason: string
  target?: string | null
  agentId?: string | null
  timeoutSeconds?: number
}

export type ConfirmOutcome = "confirmed" | "aborted" | "unavailable"

/**
 * Ask the human at the machine. Resolves to "confirmed" only on a real
 * click; everything else is "aborted" or "unavailable", both of which the
 * caller must treat as do-not-run.
 */
export async function confirmDestructive(req: ConfirmRequest): Promise<ConfirmOutcome> {
  // A confirmation nobody can answer is a hang, not a safeguard. 60s is
  // long enough to read the command and short enough that an unattended
  // machine fails closed rather than pinning an agent forever.
  const timeout = req.timeoutSeconds ?? 60

  const detail = [
    `Agent: ${req.agentId ?? "unknown"}`,
    req.target ? `Target: ${req.target}` : null,
    `Why: ${req.reason}`,
    "",
    truncate(req.command || req.tool, 400),
  ].filter(Boolean).join("\n")

  // AppleScript string literals: backslashes first, then quotes, or the
  // escaping of the escapes eats the quotes.
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  const script = [
    `display dialog "${esc(detail)}"`,
    `with title "agentx — confirm destructive action"`,
    `buttons {"Abort", "Confirm"}`,
    `default button "Abort"`,
    `cancel button "Abort"`,
    `with icon caution`,
    `giving up after ${timeout}`,
  ].join(" ")

  return new Promise<ConfirmOutcome>((resolve) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: (timeout + 10) * 1000 }, (err, stdout) => {
      if (err) {
        // Non-zero also means the user hit Abort/Escape, which osascript
        // reports as an error. Either way: do not run.
        resolve("aborted")
        return
      }
      const out = String(stdout)
      // `giving up after` returns gave up:true with no button pressed.
      if (/gave up:true/i.test(out)) resolve("aborted")
      else if (/button returned:Confirm/i.test(out)) resolve("confirmed")
      else resolve("aborted")
    })
  }).catch(() => "aborted" as ConfirmOutcome)
}

function truncate(s: string, n: number): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim()
  return flat.length > n ? flat.slice(0, n) + "…" : flat
}
