import { execFile } from "child_process"

/** Runs a program; resolves true when it exited 0. Never rejects. */
export type Run = (file: string, args: string[]) => Promise<boolean>

/** Runs a program; resolves its stdout, or rejects with its stderr. */
export type Output = (file: string, args: string[]) => Promise<string>

/** Runs a program; resolves its stdout, or null when it failed. */
export type Capture = (file: string, args: string[]) => Promise<string | null>

/** A banner or a sound may not hold a caller hostage: afplay on a long
 *  custom sound, or osascript stuck on a permission prompt, is cut off. */
const STEP_TIMEOUT_MS = 5_000

export const run: Run = (file, args) =>
  new Promise((done) => {
    try {
      execFile(file, args, { timeout: STEP_TIMEOUT_MS }, (err) => done(!err))
    } catch {
      done(false) // the program is not on this machine: not worth reporting
    }
  })

export const capture: Capture = (file, args) =>
  new Promise((done) => {
    try {
      execFile(file, args, { timeout: STEP_TIMEOUT_MS }, (err, stdout) => done(err ? null : String(stdout)))
    } catch {
      done(null)
    }
  })

export const output: Output = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file} ${args[0]}: ${(stderr || err.message).trim()}`))
      else resolve(stdout)
    })
  })
