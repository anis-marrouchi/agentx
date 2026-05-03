import { Command } from "commander"
import chalk from "chalk"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join, resolve } from "path"
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
  .command("init <name>")
  .description("scaffold a new plugin package (npm-publishable, with manifest + setup hook)")
  .option("--cwd <cwd>", "directory to create the package under", process.cwd())
  .option("--description <text>", "short package description")
  .option("--force", "overwrite an existing directory")
  .action((name: string, opts) => {
    if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      console.log(chalk.red(`  invalid package name "${name}". Use lowercase letters, digits, hyphens; optional @scope/ prefix.`))
      process.exit(1)
    }
    const dirName = name.startsWith("@") ? name.split("/")[1] : name
    const target = resolve(opts.cwd, dirName)
    if (existsSync(target) && !opts.force) {
      console.log(chalk.red(`  ${target} already exists. Use --force to overwrite.`))
      process.exit(1)
    }
    mkdirSync(target, { recursive: true })
    mkdirSync(join(target, "src"), { recursive: true })

    const description = opts.description || `AgentX plugin: ${name}`
    writeFileSync(join(target, "package.json"), packageJson(name, description))
    writeFileSync(join(target, "tsconfig.json"), tsconfig())
    writeFileSync(join(target, "src/index.ts"), pluginSource(name))
    writeFileSync(join(target, "README.md"), readme(name, description))
    writeFileSync(join(target, ".gitignore"), gitignore())

    console.log()
    console.log(chalk.green(`  ✓ scaffolded plugin at ${target}`))
    console.log()
    console.log(chalk.bold("  Next steps:"))
    console.log(chalk.dim(`    cd ${dirName}`))
    console.log(chalk.dim(`    pnpm install`))
    console.log(chalk.dim(`    pnpm build`))
    console.log(chalk.dim(`    pnpm link --global  # for local testing`))
    console.log(chalk.dim(`    # then in your agentx project:`))
    console.log(chalk.dim(`    pnpm link --global ${name}`))
    console.log(chalk.dim(`    agentx config set plugins[0] "${name}"`))
    console.log(chalk.dim(`    agentx plugin doctor`))
    console.log()
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

// --- Scaffolding templates for `agentx plugin init` ---

function packageJson(name: string, description: string): string {
  return JSON.stringify({
    name,
    version: "0.1.0",
    description,
    main: "dist/index.js",
    types: "dist/index.d.ts",
    files: ["dist"],
    scripts: {
      build: "tsc",
      prepublishOnly: "pnpm build",
    },
    keywords: ["agentx", "agentx-plugin"],
    license: "MIT",
    devDependencies: {
      typescript: "^5.4.0",
      "@types/node": "^20.0.0",
    },
  }, null, 2) + "\n"
}

function tsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      lib: ["es2020"],
      declaration: true,
      outDir: "dist",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      moduleResolution: "node",
    },
    include: ["src/**/*.ts"],
  }, null, 2) + "\n"
}

function pluginSource(name: string): string {
  return `// ${name} — AgentX plugin
//
// A plugin's default export is { manifest, setup }. The daemon calls
// setup(ctx) once at boot. ctx.on() subscribes to the bus; ctx.addChannel()
// registers a custom channel adapter; ctx.log() namespaces output.

const plugin = {
  manifest: {
    name: ${JSON.stringify(name)},
    version: "0.1.0",
    // agentxRange: "0.x", // optional — gate against the daemon's major.minor
  },

  setup(ctx: any) {
    ctx.log("hello from", ${JSON.stringify(name)})

    // Example: log every completed task.
    ctx.on("task:completed", (payload: any) => {
      ctx.log("task done:", payload.agentId, payload.durationMs + "ms")
    })

    // Example: register a no-op channel adapter.
    // ctx.addChannel({
    //   name: "my-channel",
    //   start: async () => {},
    //   stop:  async () => {},
    //   send:  async (out) => { ctx.log("send:", out) },
    // })
  },

  // Optional — only needed for resources you own (timers, sockets).
  // Bus subscriptions are removed automatically.
  // teardown() {},
}

export default plugin
`
}

function readme(name: string, description: string): string {
  return `# ${name}

${description}

## Install

\`\`\`bash
pnpm install ${name}
\`\`\`

## Use

Add to \`agentx.json\`:

\`\`\`json
{
  "plugins": ["${name}"]
}
\`\`\`

Then verify the load:

\`\`\`bash
agentx plugin doctor
\`\`\`

Restart the daemon to activate.
`
}

function gitignore(): string {
  return "node_modules/\ndist/\n*.log\n.env\n"
}
