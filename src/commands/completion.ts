import { Command, Option } from "commander"
import chalk from "chalk"
import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from "fs"
import { resolve, dirname } from "path"
import { homedir } from "os"

// --- agentx completion: generate shell completion scripts ---
//
// Walks the commander tree built in src/program.ts and emits a static
// completion script. Pattern modelled after the openclaw zsh completion:
//   - one `_agentx_<path>` function per (sub)command,
//   - root `_agentx_root_completion` dispatches on $line[1],
//   - `compdef _agentx_root_completion agentx` at the bottom.
//
// Regenerate + reinstall whenever a command or flag is added:
//   agentx completion --install
//
// Shipped with the global install so `npm i -g agentix-cli && agentx
// completion --install` is the full setup path for end users.

export const completion = new Command()
  .name("completion")
  .description("generate a shell completion script for agentx")
  .option("-s, --shell <shell>", "shell to generate completion for: zsh|bash|fish", "zsh")
  .option("-i, --install", "install the completion script to a default path for the shell")
  .option("-o, --output <path>", "write the script to this path (overrides default install path)")
  .option("-y, --yes", "skip confirmation prompts (non-interactive)")
  .action(async (opts) => {
    const { buildProgram } = await import("@/program")
    const program = await buildProgram()
    const shell = String(opts.shell || "zsh").toLowerCase()

    let script: string
    switch (shell) {
      case "zsh":
        script = generateZsh(program)
        break
      case "bash":
        script = generateBash(program)
        break
      case "fish":
        script = generateFish(program)
        break
      default:
        console.error(chalk.red(`unsupported shell: ${shell}`))
        console.error(chalk.dim(`supported: zsh, bash, fish`))
        process.exit(1)
    }

    // Plain print mode: stream to stdout so users can pipe/redirect.
    if (!opts.install && !opts.output) {
      process.stdout.write(script)
      return
    }

    const dest = opts.output ? resolve(String(opts.output)) : defaultInstallPath(shell)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, script)

    console.log(chalk.green(`✓ Wrote ${shell} completion to:`))
    console.log(`  ${dest}`)
    console.log()
    printShellHookInstructions(shell, dest, !!opts.yes)
  })

function defaultInstallPath(shell: string): string {
  const home = homedir()
  switch (shell) {
    case "zsh":
      return resolve(home, ".zsh", "completions", "_agentx")
    case "bash":
      return resolve(home, ".bash_completion.d", "agentx.bash")
    case "fish":
      return resolve(home, ".config", "fish", "completions", "agentx.fish")
    default:
      throw new Error(`unsupported shell: ${shell}`)
  }
}

function printShellHookInstructions(shell: string, dest: string, autoPatch: boolean): void {
  if (shell === "zsh") {
    const rc = resolve(homedir(), ".zshrc")
    const fpathDir = dirname(dest)
    const fpathLine = `fpath=(${fpathDir} $fpath)`
    const compinitLine = `autoload -U compinit && compinit`
    const rcExisting = existsSync(rc) ? readFileSync(rc, "utf-8") : ""
    const needsFpath = !rcExisting.includes(fpathDir)
    const needsCompinit = !/autoload\s+-U\s+compinit/.test(rcExisting)

    if (!needsFpath && !needsCompinit) {
      console.log(chalk.dim("~/.zshrc already has fpath + compinit wired up. Run `exec zsh` to pick up the new script."))
      return
    }

    if (autoPatch && existsSync(rc)) {
      const block: string[] = ["", "# agentx completion"]
      if (needsFpath) block.push(fpathLine)
      if (needsCompinit) block.push(compinitLine)
      appendFileSync(rc, block.join("\n") + "\n")
      console.log(chalk.green(`✓ Patched ~/.zshrc`))
      console.log(chalk.dim("Reload your shell: exec zsh"))
      return
    }

    console.log(chalk.dim("Add this to ~/.zshrc if not already present:"))
    if (needsFpath) console.log(chalk.cyan(`  ${fpathLine}`))
    if (needsCompinit) console.log(chalk.cyan(`  ${compinitLine}`))
    console.log()
    console.log(chalk.dim("Then reload: exec zsh"))
    console.log(chalk.dim("Or rerun with --yes to auto-patch ~/.zshrc"))
    return
  }

  if (shell === "bash") {
    const rc = resolve(homedir(), ".bashrc")
    const sourceLine = `[ -f "${dest}" ] && source "${dest}"`
    const rcExisting = existsSync(rc) ? readFileSync(rc, "utf-8") : ""
    const already = rcExisting.includes(dest)

    if (already) {
      console.log(chalk.dim("~/.bashrc already sources this file. Start a new shell to pick it up."))
      return
    }

    if (autoPatch && existsSync(rc)) {
      appendFileSync(rc, `\n# agentx completion\n${sourceLine}\n`)
      console.log(chalk.green(`✓ Patched ~/.bashrc`))
      console.log(chalk.dim("Reload your shell: exec bash"))
      return
    }

    console.log(chalk.dim("Add this to ~/.bashrc:"))
    console.log(chalk.cyan(`  ${sourceLine}`))
    console.log()
    console.log(chalk.dim("Or rerun with --yes to auto-patch ~/.bashrc"))
    return
  }

  if (shell === "fish") {
    console.log(chalk.dim("Fish auto-loads completions from this directory — start a new shell to pick it up."))
    return
  }
}

// ---------------------------------------------------------------------------
// Commander tree helpers
// ---------------------------------------------------------------------------

function cmdName(cmd: Command): string {
  // commander stores the registered name on _name; fall back to .name()
  return (cmd as any)._name || cmd.name() || ""
}

function subcommandsOf(cmd: Command): Command[] {
  return cmd.commands.filter((c) => {
    const n = cmdName(c)
    if (!n) return false
    if (n === "help") return false
    if ((c as any)._hidden) return false
    return true
  })
}

function optionsOf(cmd: Command): Option[] {
  return (cmd.options as Option[]).filter((o) => !(o as any).hidden)
}

// ---------------------------------------------------------------------------
// zsh generator
// ---------------------------------------------------------------------------

function generateZsh(program: Command): string {
  const out: string[] = []
  out.push(`#compdef agentx`)
  out.push(``)
  emitZshFn(program, [], out)
  out.push(`compdef _agentx_root_completion agentx`)
  out.push(``)
  return out.join("\n")
}

function zshFnName(path: string[]): string {
  if (path.length === 0) return `_agentx_root_completion`
  return `_agentx_${path.join("_").replace(/[^a-z0-9_]/gi, "_")}`
}

function emitZshFn(cmd: Command, path: string[], out: string[]): void {
  const subs = subcommandsOf(cmd)
  const opts = optionsOf(cmd)
  const optLines = opts.map(zshOptionLine).filter((s): s is string => !!s)
  const name = zshFnName(path)

  out.push(`${name}() {`)
  out.push(`  local -a commands`)
  out.push(`  local -a options`)
  out.push(`  `)

  // Nothing to complete: emit an empty-but-valid function.
  if (optLines.length === 0 && subs.length === 0) {
    out.push(`  return 0`)
    out.push(`}`)
    out.push(``)
    return
  }

  const argLines: string[] = []
  for (const line of optLines) argLines.push(line)

  if (subs.length > 0) {
    const entries = subs.map(zshCommandEntry).join(" ")
    argLines.push(`    "1: :_values 'command' ${entries}"`)
    argLines.push(`    "*::arg:->args"`)
  }

  out.push(`  _arguments -C \\`)
  for (let i = 0; i < argLines.length; i++) {
    const last = i === argLines.length - 1
    out.push(`${argLines[i]}${last ? "" : " \\"}`)
  }

  if (subs.length > 0) {
    out.push(``)
    out.push(`  case $state in`)
    out.push(`    (args)`)
    out.push(`      case $line[1] in`)
    for (const sub of subs) {
      const subFn = zshFnName([...path, cmdName(sub)])
      out.push(`        (${cmdName(sub)}) ${subFn} ;;`)
    }
    out.push(`      esac`)
    out.push(`      ;;`)
    out.push(`  esac`)
  }

  out.push(`}`)
  out.push(``)

  for (const sub of subs) {
    emitZshFn(sub, [...path, cmdName(sub)], out)
  }
}

function escapeZshDesc(s: string): string {
  return String(s || "")
    .replace(/\r?\n/g, " ")
    .replace(/"/g, '\\"')
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
}

function escapeZshValue(s: string): string {
  return String(s || "")
    .replace(/\r?\n/g, " ")
    .replace(/'/g, "'\\''")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
}

function zshOptionLine(opt: Option): string | null {
  const short = opt.short || undefined
  const long = opt.long || undefined
  if (!short && !long) return null
  const desc = escapeZshDesc(opt.description || "")
  if (short && long) {
    return `    "(${long} ${short})"{${long},${short}}"[${desc}]"`
  }
  return `    "${long || short}[${desc}]"`
}

function zshCommandEntry(cmd: Command): string {
  const desc = escapeZshValue(cmd.description() || "")
  return `'${cmdName(cmd)}[${desc}]'`
}

// ---------------------------------------------------------------------------
// bash generator (flat: root + first level)
// ---------------------------------------------------------------------------

function generateBash(program: Command): string {
  const tops = subcommandsOf(program)
  const lines: string[] = []
  lines.push(`# bash completion for agentx`)
  lines.push(`_agentx_complete() {`)
  lines.push(`  local cur prev words cword`)
  lines.push(`  COMPREPLY=()`)
  lines.push(`  cur="\${COMP_WORDS[COMP_CWORD]}"`)
  lines.push(`  prev="\${COMP_WORDS[COMP_CWORD-1]}"`)
  lines.push(``)
  lines.push(`  local top="${tops.map(cmdName).join(" ")}"`)
  lines.push(``)
  lines.push(`  if [[ $COMP_CWORD -eq 1 ]]; then`)
  lines.push(`    COMPREPLY=( $(compgen -W "$top" -- "$cur") )`)
  lines.push(`    return 0`)
  lines.push(`  fi`)
  lines.push(``)
  lines.push(`  local cmd="\${COMP_WORDS[1]}"`)
  lines.push(`  local sub2="\${COMP_WORDS[2]:-}"`)
  lines.push(`  case "$cmd" in`)
  for (const sub of tops) {
    const subsubs = subcommandsOf(sub).map(cmdName)
    const subOpts = collectBashFlags(sub)
    lines.push(`    ${cmdName(sub)})`)
    if (subsubs.length > 0) {
      lines.push(`      if [[ $COMP_CWORD -eq 2 ]]; then`)
      lines.push(`        COMPREPLY=( $(compgen -W "${subsubs.join(" ")} ${subOpts}" -- "$cur") )`)
      lines.push(`        return 0`)
      lines.push(`      fi`)
      lines.push(`      case "$sub2" in`)
      for (const ss of subcommandsOf(sub)) {
        const ssOpts = collectBashFlags(ss)
        lines.push(`        ${cmdName(ss)})`)
        lines.push(`          COMPREPLY=( $(compgen -W "${ssOpts}" -- "$cur") )`)
        lines.push(`          return 0`)
        lines.push(`          ;;`)
      }
      lines.push(`      esac`)
    } else {
      lines.push(`      COMPREPLY=( $(compgen -W "${subOpts}" -- "$cur") )`)
    }
    lines.push(`      ;;`)
  }
  lines.push(`  esac`)
  lines.push(`}`)
  lines.push(``)
  lines.push(`complete -F _agentx_complete agentx`)
  lines.push(``)
  return lines.join("\n")
}

function collectBashFlags(cmd: Command): string {
  const flags: string[] = []
  for (const opt of optionsOf(cmd)) {
    if (opt.long) flags.push(opt.long)
    if (opt.short) flags.push(opt.short)
  }
  return flags.join(" ")
}

// ---------------------------------------------------------------------------
// fish generator
// ---------------------------------------------------------------------------

function generateFish(program: Command): string {
  const lines: string[] = []
  lines.push(`# fish completion for agentx`)
  lines.push(``)
  lines.push(`complete -c agentx -f`)
  lines.push(``)

  // Top-level subcommands: only when no subcommand entered.
  lines.push(`# top-level commands`)
  for (const sub of subcommandsOf(program)) {
    const desc = escapeFish(sub.description() || "")
    lines.push(`complete -c agentx -n "__fish_use_subcommand" -a "${cmdName(sub)}" -d "${desc}"`)
  }
  lines.push(``)

  // Root options (gated on no-subcommand to avoid polluting subcommand suggestions).
  for (const opt of optionsOf(program)) {
    const line = fishOptionLine(opt, [`__fish_use_subcommand`])
    if (line) lines.push(line)
  }
  lines.push(``)

  // Per-top-level: options + second-level subcommands.
  for (const sub of subcommandsOf(program)) {
    const name = cmdName(sub)
    lines.push(`# ${name}`)
    for (const opt of optionsOf(sub)) {
      const line = fishOptionLine(opt, [`__fish_seen_subcommand_from ${name}`])
      if (line) lines.push(line)
    }
    for (const subsub of subcommandsOf(sub)) {
      const desc = escapeFish(subsub.description() || "")
      lines.push(
        `complete -c agentx -n "__fish_seen_subcommand_from ${name}; and not __fish_seen_subcommand_from ${subcommandsOf(sub).map(cmdName).join(" ")}" -a "${cmdName(subsub)}" -d "${desc}"`
      )
      for (const opt of optionsOf(subsub)) {
        const line = fishOptionLine(opt, [`__fish_seen_subcommand_from ${cmdName(subsub)}`])
        if (line) lines.push(line)
      }
    }
    lines.push(``)
  }
  return lines.join("\n")
}

function escapeFish(s: string): string {
  return String(s || "")
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
}

function fishOptionLine(opt: Option, conditions: string[]): string | null {
  const shortRaw = opt.short ? opt.short.replace(/^-/, "") : ""
  const longRaw = opt.long ? opt.long.replace(/^--/, "") : ""
  if (!shortRaw && !longRaw) return null
  const desc = escapeFish(opt.description || "")
  const cond = conditions.map((c) => `-n "${c}"`).join(" ")
  const parts: string[] = [`complete -c agentx`, cond]
  if (shortRaw) parts.push(`-s ${shortRaw}`)
  if (longRaw) parts.push(`-l ${longRaw}`)
  parts.push(`-d "${desc}"`)
  return parts.join(" ")
}
