// --- Running a short PowerShell script safely (#1594) ---
//
// Windows PowerShell 5.1 ships with every Windows 10 and 11, so the adapter
// needs nothing installed. Values never travel on a command line that cmd
// or PowerShell would parse: the script goes as -EncodedCommand (base64
// UTF-16LE), and every value inside it is a single-quoted literal.

export const POWERSHELL = "powershell.exe"

/** A PowerShell single-quoted string literal. Inside one only a quote is
 *  special, and PowerShell treats the curly quotes as quotes too, so each
 *  is doubled. Nothing in it is expanded. */
export function psString(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (q) => q + q)}'`
}

/** Arguments that run `script` with no profile and no prompt. */
export function psArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
}
