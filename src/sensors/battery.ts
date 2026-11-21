import { execFile } from "child_process"

// --- The battery reader (#863) ---
//
// `pmset -g batt`, fixed arguments, no shell. Its output on a laptop:
//
//   Now drawing from 'Battery Power'
//    -InternalBattery-0 (id=1234567)	52%; discharging; 3:10 remaining present: true
//
// A desktop Mac has no battery line ("No batteries available" on some
// models), a Linux node has no pmset. Each of those is `ok: false` with
// the reason, never a reading: a reader failure is never a crossing.

export type BatteryReading =
  | { ok: true; percent: number; onBattery: boolean; onAC: boolean }
  | { ok: false; why: string }

/** Read `pmset -g batt` output. Pure. */
export function parsePmset(out: string): BatteryReading {
  const text = out.trim()
  if (!text) return { ok: false, why: "pmset printed nothing" }
  if (/no batter/i.test(text)) return { ok: false, why: "no battery on this machine" }
  const source = /drawing from '([^']+)'/.exec(text)
  // The internal battery's line, not a UPS that pmset may list too.
  const line = text.split("\n").find((l) => /InternalBattery/i.test(l))
  const pct = line ? /\b(\d{1,3})%/.exec(line) : null
  if (!source || (line && !pct)) return { ok: false, why: `pmset output not understood: ${text.replace(/\s+/g, " ").slice(0, 80)}` }
  // A desktop Mac prints the source line and no battery line.
  if (!pct) return { ok: false, why: "no battery on this machine" }
  const percent = Number(pct[1])
  if (percent > 100) return { ok: false, why: `pmset output not understood: ${percent}%` }
  return { ok: true, percent, onBattery: source[1] === "Battery Power", onAC: source[1] === "AC Power" }
}

export type RunPmset = () => Promise<string>

/** pmset itself, with a time limit. Rejects when it is missing or fails. */
export const runPmset: RunPmset = () => new Promise((resolve, reject) => {
  execFile("pmset", ["-g", "batt"], { timeout: 10_000, encoding: "utf8" }, (err, stdout) => {
    if (err) reject(err)
    else resolve(stdout)
  })
})

/** One reading. Never throws. */
export async function readBattery(run: RunPmset = runPmset): Promise<BatteryReading> {
  let out: string
  try {
    out = await run()
  } catch (e: any) {
    if (e?.code === "ENOENT") return { ok: false, why: "pmset not found (not macOS)" }
    return { ok: false, why: `pmset failed: ${String(e?.message ?? e).slice(0, 120)}` }
  }
  return parsePmset(out)
}
