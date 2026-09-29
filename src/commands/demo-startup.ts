// --- agentx demo: how long each startup step may take ---
//
// Three daemons plus a dashboard boot at once. On an idle machine that
// takes a few seconds; under heavy load and swap it can take minutes, so
// the limit is a setting with a load-aware default (#315).

import { existsSync, readFileSync } from "fs"
import { cpus, loadavg } from "os"
import { resolve } from "path"
import { daemonConfigSchema } from "@/daemon/config"

export const STARTUP_TIMEOUT_ENV = "AGENTX_DEMO_STARTUP_TIMEOUT"
export const BASE_STARTUP_TIMEOUT_S = 60
export const MAX_ADAPTIVE_TIMEOUT_S = 300

/** 60 s, stretched by how far the 1-minute load average exceeds the CPU
 *  count, capped at 300 s. Windows reports a load of 0: the base applies. */
export function adaptiveStartupTimeout(load1: number, cpuCount: number): number {
  const factor = Math.max(1, load1 / Math.max(1, cpuCount))
  return Math.min(MAX_ADAPTIVE_TIMEOUT_S, Math.ceil(BASE_STARTUP_TIMEOUT_S * factor))
}

function seconds(value: string | undefined, source: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${source} must be a positive number of seconds, got "${value}"`)
  return n
}

/** demo.startupTimeoutSeconds from ./agentx.json, if the folder has one.
 *  The demo needs no config, so a missing file is fine; a present but
 *  invalid value is an error rather than silently ignored. */
export function configStartupTimeout(dir: string): number | undefined {
  const path = resolve(dir, "agentx.json")
  if (!existsSync(path)) return undefined
  let raw: any
  try { raw = JSON.parse(readFileSync(path, "utf8")) } catch { return undefined }
  const parsed = daemonConfigSchema.shape.demo.safeParse(raw?.demo)
  if (!parsed.success) throw new Error(`${path}: demo.startupTimeoutSeconds must be a whole number of seconds (1–3600)`)
  return parsed.data.startupTimeoutSeconds
}

export interface StartupTimeoutInput {
  flag?: string
  env?: string
  config?: number
  load1?: number
  cpuCount?: number
}

/** Flag > env > config > adaptive default. Returns seconds and where they came from. */
export function resolveStartupTimeout(input: StartupTimeoutInput): { seconds: number; source: string } {
  const flag = seconds(input.flag, "--startup-timeout")
  if (flag !== undefined) return { seconds: flag, source: "--startup-timeout" }
  const env = seconds(input.env, STARTUP_TIMEOUT_ENV)
  if (env !== undefined) return { seconds: env, source: STARTUP_TIMEOUT_ENV }
  if (input.config !== undefined) return { seconds: input.config, source: "demo.startupTimeoutSeconds" }
  const load1 = input.load1 ?? loadavg()[0]
  const cpuCount = input.cpuCount ?? cpus().length
  return { seconds: adaptiveStartupTimeout(load1, cpuCount), source: `default for load ${load1.toFixed(1)} on ${cpuCount} CPUs` }
}
