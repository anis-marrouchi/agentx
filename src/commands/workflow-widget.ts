import type { Command } from "commander"
import chalk from "chalk"
import { applyConfigMutation } from "@/daemon/config-mutator"
import { loadDaemonConfig } from "@/daemon/config"
import { openBrowser } from "@/utils/open-browser"
import { DEFAULT_WIDGET_SETTINGS, WIDGET_CORNERS, type WidgetSettings } from "@/workflows/widget"
import { cleanTags } from "@/workflows/follow-up"

// --- agentx workflow widget (#796) ---
//
// Opens the floating progress widget in the browser, or changes its
// settings (workflows.widget in agentx.json).

export interface WidgetFlags {
  enabled?: string
  position?: string
  tags?: string
  size?: string
  refreshSeconds?: string
}

/** The settings change the flags ask for, or what is wrong with them. */
export function widgetPatch(flags: WidgetFlags): { ok: true; patch: Partial<WidgetSettings> } | { ok: false; error: string } {
  const patch: Partial<WidgetSettings> = {}
  if (flags.enabled !== undefined) {
    if (flags.enabled !== "on" && flags.enabled !== "off") return { ok: false, error: "--enabled takes on or off" }
    patch.enabled = flags.enabled === "on"
  }
  if (flags.position !== undefined) {
    if (!WIDGET_CORNERS.includes(flags.position as never)) return { ok: false, error: `--position takes ${WIDGET_CORNERS.join(", ")}` }
    patch.position = flags.position as WidgetSettings["position"]
  }
  // An empty value clears the list: every followed run shows again.
  if (flags.tags !== undefined) patch.tags = cleanTags(flags.tags)
  if (flags.size !== undefined) {
    const m = flags.size.match(/^(\d+)x(\d+)$/i)
    const w = m ? Number(m[1]) : 0
    const h = m ? Number(m[2]) : 0
    if (!m || w < 240 || w > 1200 || h < 160 || h > 1600) return { ok: false, error: "--size takes WIDTHxHEIGHT in pixels, e.g. 360x420 (width 240-1200, height 160-1600)" }
    patch.width = w
    patch.height = h
  }
  if (flags.refreshSeconds !== undefined) {
    const n = Number(flags.refreshSeconds)
    if (!Number.isInteger(n) || n < 3 || n > 600) return { ok: false, error: "--refresh-seconds takes a whole number from 3 to 600" }
    patch.refreshSeconds = n
  }
  return { ok: true, patch }
}

/** The widget's address on this computer's dashboard. */
export function widgetUrl(port: number, tag?: string): string {
  return `http://127.0.0.1:${port}/workflows/widget${tag ? `?tag=${encodeURIComponent(tag.trim().toLowerCase())}` : ""}`
}

export function registerWidgetCommand(workflow: Command): void {
  workflow
    .command("widget")
    .description("open the floating progress widget, or change its settings")
    .option("--enabled <on|off>", "turn the widget on or off (desktop and phone app)")
    .option("--position <corner>", `where its small window opens: ${WIDGET_CORNERS.join(", ")}`)
    .option("--tags <list>", "only runs with one of these tags, comma separated (empty: all)")
    .option("--size <WxH>", "window size in pixels, e.g. 360x420")
    .option("--refresh-seconds <n>", "how often it reads again when no live update arrives")
    .option("--tag <kind:name>", "open it showing only this tag, e.g. client:acme")
    .option("--no-open", "print the address instead of opening the browser")
    .action(async (opts: WidgetFlags & { tag?: string; open: boolean }) => {
      const parsed = widgetPatch(opts)
      if (!parsed.ok) { console.error(chalk.red(`  ${parsed.error}`)); process.exitCode = 1; return }
      const changed = Object.keys(parsed.patch).length > 0
      if (changed) {
        const r = await applyConfigMutation((cfg: any) => {
          const wf = (cfg.workflows ??= {})
          wf.widget = { ...(wf.widget ?? {}), ...parsed.patch }
        })
        if (!r.success) { console.error(chalk.red(`  ${r.error}`)); process.exitCode = 1; return }
        console.log(chalk.green("  ✓ saved") + (r.reloaded ? chalk.dim(" (daemon reloaded)") : ""))
      }
      let s: WidgetSettings = DEFAULT_WIDGET_SETTINGS
      let port = 4202
      try {
        const cfg = loadDaemonConfig()
        s = { ...DEFAULT_WIDGET_SETTINGS, ...cfg.workflows.widget }
        port = cfg.dashboard.port || 4202
      } catch { /* no config yet: defaults */ }
      console.log(`  Progress widget  ${s.enabled ? "on" : "off"}`)
      console.log(`  Shows            ${s.tags.length ? `runs tagged ${s.tags.join(", ")}` : "every followed run"}`)
      console.log(`  Window           ${s.width}x${s.height}, ${s.position}, reads again every ${s.refreshSeconds}s`)
      if (!s.enabled) { console.log(chalk.yellow("  Turn it on with: agentx workflow widget --enabled on")); return }
      if (changed) return
      const url = widgetUrl(port, opts.tag)
      if (!opts.open) { console.log(`  ${url}`); return }
      console.log(chalk.dim(`  Opening ${url}`))
      console.log(chalk.dim("  Click \"Keep on top\" to keep it above your other windows."))
      openBrowser(url)
    })
}
