import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"
import { agentXPluginManifestSchema, type AgentXPlugin } from "@/plugins/types"

// `agentx plugin` — surface the plugin loader's view from outside the
// daemon. `list` shows the configured packages; `doctor` actually
// imports them and reports whether the manifest validates without
// starting the daemon. Useful for operators to validate before
// restarting and useful in CI to catch a broken plugin install.

export const plugin = new Command()
  .name("plugin")
  .description("manage agentx plugins (Move B)")

plugin
  .command("list", { isDefault: true })
  .description("list plugins configured in agentx.json")
  .action(() => {
    try {
      const config = loadDaemonConfig()
      const names = config.plugins ?? []
      console.log()
      if (names.length === 0) {
        console.log(chalk.dim("  No plugins configured."))
        console.log(chalk.dim("  Add a plugin: edit agentx.json's `plugins: [\"your-package\"]` and pnpm install it."))
        console.log()
        return
      }
      console.log(chalk.bold(`  Plugins configured: ${names.length}`))
      console.log()
      for (const n of names) {
        console.log(`    ${chalk.cyan(n)}`)
      }
      console.log()
      console.log(chalk.dim("  Run `agentx plugin doctor` to verify each plugin loads."))
      console.log()
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exitCode = 1
    }
  })

plugin
  .command("doctor")
  .description("dynamic-import each configured plugin and report status")
  .action(async () => {
    try {
      const config = loadDaemonConfig()
      const names = config.plugins ?? []
      console.log()
      if (names.length === 0) {
        console.log(chalk.dim("  No plugins configured. Nothing to check."))
        console.log()
        return
      }
      let bad = 0
      for (const name of names) {
        const status = await checkOne(name)
        if (status.kind === "ok") {
          console.log(`  ${chalk.green("✓")} ${chalk.cyan(name)} — ${status.manifestName} v${status.manifestVersion}`)
        } else {
          bad++
          console.log(`  ${chalk.red("✗")} ${chalk.cyan(name)} — ${status.reason}`)
        }
      }
      console.log()
      if (bad > 0) {
        console.log(chalk.red(`  ${bad}/${names.length} plugin(s) failed`))
        process.exitCode = 1
      }
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exitCode = 1
    }
  })

type DoctorStatus =
  | { kind: "ok"; manifestName: string; manifestVersion: string }
  | { kind: "fail"; reason: string }

async function checkOne(packageName: string): Promise<DoctorStatus> {
  let mod: unknown
  try {
    mod = await import(packageName)
  } catch (e: any) {
    return { kind: "fail", reason: `import failed: ${e?.message ?? e}` }
  }

  const candidate = pickDefault(mod)
  if (!isPlugin(candidate)) {
    return { kind: "fail", reason: "no default AgentXPlugin export (manifest/setup pair not found)" }
  }
  const parsed = agentXPluginManifestSchema.safeParse(candidate.manifest)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join("; ")
    return { kind: "fail", reason: `manifest invalid: ${issues}` }
  }
  return { kind: "ok", manifestName: parsed.data.name, manifestVersion: parsed.data.version }
}

// Same ESM/CJS interop logic the loader uses — duplicated here so the CLI
// can run without the daemon's dependency tree. Two ~10-line functions
// don't justify a shared module yet.
function pickDefault(mod: unknown): unknown {
  if (mod == null) return mod
  if (typeof mod !== "object") return mod
  const m = mod as Record<string, unknown>
  if (m.default && typeof m.default === "object") {
    const d = m.default as Record<string, unknown>
    if (d.manifest && typeof d.setup === "function") return d
    if (d.default && typeof d.default === "object") {
      const dd = d.default as Record<string, unknown>
      if (dd.manifest && typeof dd.setup === "function") return dd
    }
  }
  if (m.manifest && typeof m.setup === "function") return m
  return m.default ?? m
}

function isPlugin(c: unknown): c is AgentXPlugin {
  return (
    !!c &&
    typeof c === "object" &&
    "manifest" in (c as object) &&
    "setup" in (c as object) &&
    typeof (c as { setup: unknown }).setup === "function"
  )
}
