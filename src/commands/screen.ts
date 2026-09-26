import { Command } from "commander"
import chalk from "chalk"
import { spawn } from "child_process"
import { loadDaemonConfig } from "@/daemon/config"
import { mutateAgentxConfig } from "@/daemon/config-mutate"
import { configuredDaemonPort } from "@/attach/install"
import { captureAround, captureShot, resolveRegion, type Shot } from "@/computer-use/capture"
import { patchScreen, screenSettings, type ScreenSettings } from "@/computer-use/capture-settings"

// --- agentx screen — capture the screen at the right moment ---
//
//   agentx screen capture --region notifications --until-changed -- <command>
//       arm, run the command, and return the first frame after the region
//       changed and settled: proof of what the command put on screen.
//   agentx screen capture --until-stable
//       wait for the focused window to stop moving, then capture it.
//   agentx screen recent --seconds 5
//       the daemon's in-memory buffer (screen.buffer), for a late arrival.
//   agentx screen config
//       show or change the `screen` block of agentx.json.
//
// Frames are PNG paths, cropped to the region and downscaled to
// screen.maxPixels, so an agent can read the one image that matters.

function readSettings(config?: string): ScreenSettings {
  try { return screenSettings(loadDaemonConfig(config).screen) } catch { return screenSettings(undefined) }
}

function fail(message: string): never {
  console.log(chalk.red(`  ${message}`))
  process.exit(1)
}

function printShot(shot: Shot, json: boolean, extra: Record<string, unknown> = {}): void {
  if (json) { console.log(JSON.stringify({ ...shot, ...extra }, null, 2)); return }
  const waited = shot.waitedMs === undefined ? ""
    : ` · ${shot.timedOut ? chalk.yellow("timed out") : [shot.changed && "changed", shot.stable && "stable"].filter(Boolean).join(", ")} after ${shot.waitedMs}ms`
  console.log(`  ${shot.path}`)
  console.log(chalk.dim(`  ${shot.region.width}×${shot.region.height} at ${shot.region.x},${shot.region.y} · ${Math.round(shot.bytes / 1024)}KB${waited}`))
}

/** Runs a command with inherited stdio; resolves its exit code. */
function runCommand(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" })
    child.on("error", () => resolve(127))
    child.on("close", (code) => resolve(code ?? 1))
  })
}

export const screen = new Command("screen").description("capture the screen at the right moment: after an action, a change, or once it settles")

screen.command("capture")
  .description("capture a region, optionally waiting for it to change or settle, or around a command")
  .argument("[command...]", "run this after arming; capture what it changes (put it after --)")
  .option("--region <name|x,y,w,h>", "window, screen, menubar, notifications, a name from screen.regions, or x,y,w,h", "window")
  .option("--until-changed", "wait for the region to change first")
  .option("--until-stable", "wait for the region to stop changing")
  .option("--max-pixels <n>", "pixel budget for this capture (default screen.maxPixels)")
  .option("--out <path>", "where to write the PNG")
  .option("-c, --config <path>", "agentx.json to read screen settings from")
  .option("--json", "print the result as JSON")
  .action(async (command: string[], opts) => {
    const settings = readSettings(opts.config)
    let region
    try { region = resolveRegion(opts.region, settings) } catch (e: any) { fail(e.message) }
    const maxPixels = opts.maxPixels === undefined ? undefined : Number(opts.maxPixels)
    if (maxPixels !== undefined && !(Number.isInteger(maxPixels) && maxPixels > 0)) fail("--max-pixels must be a whole number above 0")
    const deps = { settings, maxPixels }
    try {
      if (command.length) {
        // An action is always waited on for a change; --until-stable is on
        // unless only --until-changed was asked for.
        const untilStable = opts.untilStable || !opts.untilChanged
        const { result: code, shot, error } = await captureAround(() => runCommand(command), region, { out: opts.out, untilStable }, deps)
        if (!shot) fail(`command exited ${code}; no capture: ${error}`)
        printShot(shot, opts.json, { exitCode: code })
        if (code !== 0) process.exit(code)
        return
      }
      printShot(await captureShot(region, { untilChanged: opts.untilChanged, untilStable: opts.untilStable, out: opts.out }, deps), opts.json)
    } catch (e: any) {
      fail(e?.message ?? String(e))
    }
  })

screen.command("recent")
  .description("frames from the daemon's in-memory screen buffer (screen.buffer must be on)")
  .option("--seconds <n>", "how far back (default screen.buffer.seconds)")
  .option("--url <url>", "daemon URL", process.env.AGENTX_DAEMON_URL || `http://127.0.0.1:${configuredDaemonPort()}`)
  .option("--json", "print the result as JSON")
  .action(async (opts) => {
    const token = process.env.MESH_TOKEN
    const q = opts.seconds ? `?seconds=${encodeURIComponent(opts.seconds)}` : ""
    try {
      const res = await fetch(`${String(opts.url).replace(/\/$/, "")}/screen/recent${q}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15_000),
      })
      const body: any = await res.json().catch(() => ({}))
      if (!res.ok) fail(body.error ?? `daemon ${res.status}`)
      if (opts.json) { console.log(JSON.stringify(body, null, 2)); return }
      if (!body.frames.length) { console.log(chalk.dim("  no frames yet")); return }
      for (const f of body.frames) console.log(`  ${f.path} ${chalk.dim(`${(f.ageMs / 1000).toFixed(1)}s ago · ${f.width}×${f.height}`)}`)
    } catch (e: any) {
      fail(`could not reach the daemon: ${e?.message ?? e}`)
    }
  })

screen.command("config")
  .description("show or change screen capture settings (agentx.json `screen`)")
  .option("--max-pixels <n>", "pixel budget for a captured frame")
  .option("--timeout <ms>", "longest a capture waits")
  .option("--interval <ms>", "time between samples while waiting")
  .option("--threshold <0-1>", "difference that counts as a change")
  .option("--stable-ms <ms>", "how long a region must hold still to be stable")
  .option("--region <name=x,y,w,h>", "add or change a named region", (v: string, all: string[]) => [...all, v], [] as string[])
  .option("--remove-region <name>", "remove a named region", (v: string, all: string[]) => [...all, v], [] as string[])
  .option("--buffer <state>", "on | off: keep recent frames in memory")
  .option("--buffer-seconds <n>", "how many seconds the buffer keeps")
  .option("--buffer-fps <n>", "samples per second")
  .option("--buffer-region <name|x,y,w,h>", "region the buffer watches")
  .option("--buffer-max-pixels <n>", "pixel budget per buffered frame")
  .action((opts) => {
    const patch: Record<string, any> = {}
    if (opts.maxPixels !== undefined) patch.maxPixels = opts.maxPixels
    if (opts.timeout !== undefined) patch.timeoutMs = opts.timeout
    if (opts.interval !== undefined) patch.intervalMs = opts.interval
    if (opts.threshold !== undefined) patch.changeThreshold = opts.threshold
    if (opts.stableMs !== undefined) patch.stableMs = opts.stableMs
    const regions: Record<string, unknown> = {}
    for (const r of opts.region) {
      const at = r.indexOf("=")
      if (at < 1) fail(`--region wants name=x,y,w,h, got "${r}"`)
      regions[r.slice(0, at)] = r.slice(at + 1)
    }
    for (const name of opts.removeRegion) regions[name] = null
    if (Object.keys(regions).length) patch.regions = regions
    const buffer: Record<string, unknown> = {}
    if (opts.buffer !== undefined) {
      const s = String(opts.buffer).toLowerCase()
      if (!["on", "off"].includes(s)) fail("--buffer must be on|off")
      buffer.enabled = s === "on"
    }
    if (opts.bufferSeconds !== undefined) buffer.seconds = opts.bufferSeconds
    if (opts.bufferFps !== undefined) buffer.fps = opts.bufferFps
    if (opts.bufferRegion !== undefined) buffer.region = opts.bufferRegion
    if (opts.bufferMaxPixels !== undefined) buffer.maxPixels = opts.bufferMaxPixels
    if (Object.keys(buffer).length) patch.buffer = buffer

    if (Object.keys(patch).length === 0) {
      const s = readSettings()
      console.log(`\n  maxPixels        ${s.maxPixels}`)
      console.log(`  wait             timeout ${s.timeoutMs}ms · every ${s.intervalMs}ms · change > ${s.changeThreshold} · stable ${s.stableMs}ms`)
      const names = Object.entries(s.regions).map(([n, r]) => `${n}=${r.x},${r.y},${r.width},${r.height}`)
      console.log(`  regions          ${names.length ? names.join("  ") : chalk.dim("built-in only")}`)
      const b = s.buffer
      console.log(`  buffer           ${b.enabled ? "on" : chalk.dim("off")} ${chalk.dim(`${b.region} · ${b.seconds}s · ${b.fps} fps · ${b.maxPixels} px`)}\n`)
      return
    }
    try {
      const { summary, backupPath } = mutateAgentxConfig((cfg) => {
        const next = patchScreen(cfg.screen, patch)
        cfg.screen = next
        return `screen = ${JSON.stringify(next)}`
      })
      console.log(chalk.green(`\n  ✓ ${summary}`))
      if (backupPath) console.log(chalk.dim(`  Backup: ${backupPath}`))
      console.log()
    } catch (e: any) {
      fail(e?.message ?? String(e))
    }
  })
