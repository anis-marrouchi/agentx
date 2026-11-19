import { existsSync, opendirSync, realpathSync, statSync, type Dir } from "fs"
import { homedir } from "os"
import { basename, isAbsolute, join, resolve } from "path"

// --- Which files a tool call reads or writes the content of (#1979) ---
//
// For rules with `match.file_access_regex`: they judge the files a call
// touches, not the words in its command. A Bash command is split into its
// simple commands (quotes removed, `$(...)` and backticks looked into,
// heredoc bodies skipped). A command counts only when it is one of the
// content tools below (cat, cp, curl, an interpreter's code...) or
// redirects a file in or out; then each of its arguments is resolved
// against the working folder (following `cd`), globs are expanded, and
// symlinks are resolved. So `git commit -m ".agentx/operator.key"` or
// `ls -la .agentx/operator.key` touch nothing, while
// `cat .agentx/./operator.k*` does.
//
// It is a second lock, not a wall: a shell offers more ways to read a file
// than any list (an unquoted heredoc that runs `$(...)`, a script written
// first and run later, `grep -r` over a whole folder).

/** Commands whose file arguments are read or written. */
const CONTENT_TOOLS = new Set([
  "cat", "tac", "nl", "less", "more", "most", "head", "tail", "xxd", "od", "hexdump", "hd",
  "base64", "base32", "strings", "cp", "mv", "scp", "rsync", "tar", "zip", "gzip", "bzip2",
  "xz", "zstd", "7z", "dd", "tee", "sed", "awk", "gawk", "cut", "sort", "uniq", "paste",
  "diff", "cmp", "comm", "jq", "yq", "iconv", "fold", "fmt", "rev", "split", "source", ".",
  "openssl", "gpg", "vi", "vim", "nvim", "nano", "emacs", "curl", "wget", "grep", "egrep",
  "fgrep", "rg", "ag", "install", "ln",
  // Interpreters: a script file, or code given with -c / -e.
  "python", "python2", "python3", "node", "perl", "ruby", "php", "bun", "deno",
  "sh", "bash", "zsh", "dash",
])

/** Of those, the ones that take a whole folder: its files count too. */
const FOLDER_TOOLS = new Set(["cp", "scp", "rsync", "tar", "zip", "7z"])

const SHELLS = new Set(["sh", "bash", "zsh", "dash"])
const INTERPRETERS = new Set(["python", "python2", "python3", "node", "perl", "ruby", "php", "bun", "deno"])
const CODE_FLAGS = new Set(["-c", "-e", "-p", "-r", "--eval", "--print", "-E"])
/** Words that run the next word as the command. */
const WRAPPERS = new Set(["sudo", "env", "command", "nice", "nohup", "time", "exec", "builtin", "doas"])

const MAX_PATHS = 2000

interface Simple { words: string[]; files: string[] }

/** Split a shell command into simple commands. Never throws. */
export function parseShell(src: string): Simple[] {
  const out: Simple[] = []
  try {
    parseInto(src, out, 0)
  } catch {
    /* best effort */
  }
  return out
}

function parseInto(src: string, out: Simple[], depth: number): void {
  if (depth > 4) return
  let words: string[] = []
  let files: string[] = []
  let word = ""
  let inWord = false
  let redirect: "file" | "skip" | null = null
  const heredocs: { delim: string; strip: boolean }[] = []

  const endWord = () => {
    if (!inWord) return
    if (redirect === "file") files.push(word)
    else if (redirect !== "skip") words.push(word)
    redirect = null
    word = ""
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length || files.length) out.push({ words, files })
    words = []
    files = []
  }
  // The text of a `$(...)` starting at i (just after the "("): to its
  // matching parenthesis.
  const subst = (i: number): number => {
    let level = 1
    let j = i
    for (; j < src.length && level > 0; j++) {
      if (src[j] === "(") level++
      else if (src[j] === ")") level--
    }
    parseInto(src.slice(i, j - 1), out, depth + 1)
    return j
  }

  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === "'") {
      const j = src.indexOf("'", i + 1)
      const end = j < 0 ? src.length : j
      word += src.slice(i + 1, end)
      inWord = true
      i = end + 1
      continue
    }
    if (ch === '"') {
      inWord = true
      i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) { word += src[i + 1]; i += 2; continue }
        if (src[i] === "$" && src[i + 1] === "(") { i = subst(i + 2); continue }
        if (src[i] === "`") {
          const j = src.indexOf("`", i + 1)
          const end = j < 0 ? src.length : j
          parseInto(src.slice(i + 1, end), out, depth + 1)
          i = end + 1
          continue
        }
        word += src[i++]
      }
      i++
      continue
    }
    if (ch === "\\") { word += src[i + 1] ?? ""; inWord = true; i += 2; continue }
    if (ch === "$" && src[i + 1] === "(") { inWord = true; i = subst(i + 2); continue }
    if (ch === "`") {
      const j = src.indexOf("`", i + 1)
      const end = j < 0 ? src.length : j
      parseInto(src.slice(i + 1, end), out, depth + 1)
      inWord = true
      i = end + 1
      continue
    }
    if (ch === " " || ch === "\t") { endWord(); i++; continue }
    if (ch === "\n") {
      endCommand()
      i++
      // Skip the bodies of the heredocs opened on the line that just ended.
      for (const h of heredocs) {
        while (i < src.length) {
          const nl = src.indexOf("\n", i)
          const line = src.slice(i, nl < 0 ? src.length : nl)
          i = nl < 0 ? src.length : nl + 1
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break
        }
      }
      heredocs.length = 0
      continue
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
      // `&>` and `>&` are redirections, handled below.
      if (ch === "&" && src[i + 1] === ">") { endWord(); i++; continue }
      endCommand()
      i++
      continue
    }
    if (ch === "<") {
      endWord()
      if (src.startsWith("<<<", i)) { redirect = "skip"; i += 3; continue }
      if (src.startsWith("<<", i)) {
        i += 2
        const strip = src[i] === "-"
        if (strip) i++
        while (src[i] === " " || src[i] === "\t") i++
        const m = /^(['"]?)([^\s'";&|<>()]+)\1/.exec(src.slice(i))
        if (m) { heredocs.push({ delim: m[2], strip }); i += m[0].length }
        continue
      }
      redirect = "file"
      i += src[i + 1] === ">" ? 2 : 1
      continue
    }
    if (ch === ">") {
      // A bare fd number before it ("2>") is not a word.
      if (inWord && /^\d+$/.test(word)) { word = ""; inWord = false }
      endWord()
      i++
      if (src[i] === ">" || src[i] === "|") i++
      if (src[i] === "&") {
        i++
        while (/[0-9-]/.test(src[i] ?? "")) i++
        continue
      }
      redirect = "file"
      continue
    }
    word += ch
    inWord = true
    i++
  }
  endCommand()
}

const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p)

/** How much folder listing one call may do (#1979). The guard answers on
 *  the daemon's one thread, so a glob like `~/*\/*\/*\/*` must not stall
 *  it: past the budget, listing stops and the paths found so far are
 *  judged (fail open for the rest). Literal paths are always judged. */
export interface AccessBudget {
  /** Milliseconds of folder listing (default 100). */
  budgetMs?: number
  /** Folder entries read in all (default 5000). */
  maxEntries?: number
}

interface Budget { until: number; entries: number; spent: boolean }

let budgetLogged = false

function newBudget(o: AccessBudget = {}): Budget {
  return { until: Date.now() + (o.budgetMs ?? 100), entries: o.maxEntries ?? 5000, spent: false }
}

function spend(b: Budget): boolean {
  if (b.spent) return false
  if (b.entries <= 0 || Date.now() >= b.until) {
    b.spent = true
    if (!budgetLogged) {
      budgetLogged = true
      process.stderr.write("[agentx-guard] file access: folder listing budget spent; judging the paths found so far\n")
    }
    return false
  }
  b.entries--
  return true
}

/** A folder's entry names, read one at a time within the budget. */
function listDir(dir: string, b: Budget): string[] {
  return listEntries(dir, b).map((e) => e.name)
}

/** Like listDir, with whether each entry is a folder (no stat call). */
function listEntries(dir: string, b: Budget): { name: string; folder: boolean }[] {
  const names: { name: string; folder: boolean }[] = []
  let d: Dir | null = null
  try {
    d = opendirSync(dir)
    for (let e = d.readSync(); e; e = d.readSync()) {
      if (!spend(b)) break
      names.push({ name: e.name, folder: e.isDirectory() })
    }
  } catch {
    /* unreadable */
  } finally {
    try { d?.closeSync() } catch { /* closed */ }
  }
  return names
}

/** A glob segment as a regex; an invalid pattern (`[z-a]`) matches only
 *  its own literal text, as a shell would leave it. */
function globToRegex(seg: string): RegExp {
  const literal = new RegExp(`^${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)
  let r = ""
  for (let k = 0; k < seg.length; k++) {
    const c = seg[k]
    if (c === "*") r += "[^/]*"
    else if (c === "?") r += "[^/]"
    else if (c === "[") {
      const j = seg.indexOf("]", k + 1)
      if (j < 0) { r += "\\["; continue }
      r += `[${seg.slice(k + 1, j).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`
      k = j
    } else r += c.replace(/[.+^${}()|\\]/g, "\\$&")
  }
  try {
    return new RegExp(`^${r}$`)
  } catch {
    return literal
  }
}

const hasGlob = (s: string) => /[*?[]/.test(s)

/** Expand a glob over the file system, as a shell would (dot files only
 *  for a segment that starts with a dot). At most 200 matches. */
function expandGlob(abs: string, b: Budget): string[] {
  const parts = abs.split("/").filter(Boolean)
  let paths = ["/"]
  for (const seg of parts) {
    if (!hasGlob(seg)) { paths = paths.map((p) => join(p, seg)); continue }
    const re = globToRegex(seg)
    const next: string[] = []
    for (const p of paths) {
      if (b.spent) break
      for (const n of listDir(p, b)) {
        if (n.startsWith(".") && !seg.startsWith(".")) continue
        if (re.test(n)) next.push(join(p, n))
        if (next.length >= 200) break
      }
    }
    paths = next
    if (!paths.length) break
  }
  return paths
}

/** A folder's files, two levels down (`tar czf a.tgz .` holds `.agentx/operator.key`). */
/** This folder's entries first, then its sub-folders', dot folders (where
 *  settings and secrets live, and which are small) before the others, so a
 *  budget spent on a big build folder never hides `.agentx/operator.key`. */
function folderFiles(dir: string, out: string[], b: Budget, level = 0): void {
  if (level >= 2 || out.length >= MAX_PATHS) return
  const subs: string[] = []
  for (const e of listEntries(dir, b)) {
    if (e.name === "node_modules" || e.name === ".git") continue
    const p = join(dir, e.name)
    out.push(p)
    if (out.length >= MAX_PATHS) return
    if (e.folder) subs.push(p)
  }
  subs.sort((x, y) => Number(!basename(x).startsWith(".")) - Number(!basename(y).startsWith(".")))
  for (const p of subs) folderFiles(p, out, b, level + 1)
}

/** Resolve one argument to the paths it names: normalised, globs expanded,
 *  symlinks followed, and with `folders`, a folder's files. Never throws:
 *  one odd argument must not clear the others. */
function pathsOf(arg: string, cwd: string, out: string[], folders: boolean, b: Budget): void {
  try {
    if (!arg || arg.length > 4096) return
    const abs = resolve(cwd, expandHome(arg))
    const found = hasGlob(arg) ? [abs, ...expandGlob(abs, b)] : [abs]
    for (const p of found) {
      out.push(p)
      if (!existsSync(p)) continue
      try { out.push(realpathSync(p)) } catch { /* unreadable */ }
      if (folders) {
        try { if (statSync(p).isDirectory()) folderFiles(p, out, b) } catch { /* gone */ }
      }
    }
  } catch {
    /* judged on what was found */
  }
}

/** Options that take the next word as their value, per folder tool. */
const VALUE_OPTS: Record<string, Set<string>> = {
  tar: new Set(["-C", "--directory", "-f", "--file", "-T", "--files-from", "-X", "--exclude-from", "-b", "--blocking-factor", "--exclude", "-K", "-N", "-g", "-L", "-V", "--transform", "--owner", "--group", "--mode", "--mtime"]),
  cp: new Set(["-t", "--target-directory", "-S", "--suffix", "--backup", "--reflink", "--sparse"]),
  scp: new Set(["-i", "-P", "-o", "-F", "-c", "-l", "-S", "-J", "-D", "-X"]),
  rsync: new Set(["-e", "--rsh", "--exclude", "--include", "--filter", "-f", "--exclude-from", "--include-from", "--files-from", "--rsync-path", "-T", "--temp-dir", "--log-file", "--password-file", "-B", "--block-size", "--chmod", "--chown", "--partial-dir", "--backup-dir", "--suffix"]),
  zip: new Set(["-b", "-n", "-t", "-tt", "-O", "-P", "-Z", "-s", "-sp"]),
  "7z": new Set([]),
}
/** Short letters of a tar cluster (`-czf`, `czf`) that take a value, in order. */
const TAR_VALUE_LETTERS = new Set(["f", "C", "T", "X", "b", "K", "N", "g", "L", "V"])

interface Planned { arg: string; dir: string; walk: boolean }

/** Which arguments of a folder tool are read (walked) and which are only
 *  its destination or archive (checked, not walked). tar's -C changes the
 *  folder the arguments after it are read from. */
function planFolderTool(prog: string, args: string[], here: string): Planned[] {
  const values = VALUE_OPTS[prog] ?? new Set<string>()
  const planned: Planned[] = []
  const positional: { arg: string; dir: string }[] = []
  let dir = here
  let target: string | null = null
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    // tar's letter clusters: `-czf x`, or the old form `czf x` first.
    const cluster = prog === "tar" && (/^-[A-Za-z]{2,}$/.test(a) || (k === 0 && /^[A-Za-z]+$/.test(a)))
    if (cluster) {
      for (const letter of a.replace(/^-/, "")) {
        if (!TAR_VALUE_LETTERS.has(letter) || k + 1 >= args.length) continue
        const v = args[++k]
        if (letter === "C") dir = resolve(dir, expandHome(v))
        else planned.push({ arg: v, dir: here, walk: false })
      }
      continue
    }
    if (a.startsWith("-") && a.length > 1) {
      const eq = a.indexOf("=")
      const name = eq > 0 ? a.slice(0, eq) : a
      const inline = eq > 0 ? a.slice(eq + 1) : null
      if (!values.has(name)) continue
      const v = inline ?? (k + 1 < args.length ? args[++k] : null)
      if (v === null) continue
      if (prog === "tar" && (name === "-C" || name === "--directory")) dir = resolve(dir, expandHome(v))
      else if (prog === "cp" && (name === "-t" || name === "--target-directory")) target = v
      else planned.push({ arg: v, dir: here, walk: false })
      continue
    }
    positional.push({ arg: a, dir })
  }
  if (prog === "tar") {
    for (const p of positional) planned.push({ ...p, walk: true })
  } else if (prog === "zip") {
    positional.forEach((p, i) => planned.push({ ...p, walk: i > 0 }))
  } else if (prog === "7z") {
    positional.forEach((p, i) => planned.push({ ...p, walk: i > 1 }))
  } else {
    // cp, scp, rsync: the last word is the destination, unless cp -t names it.
    if (target !== null) planned.push({ arg: target, dir: here, walk: false })
    const last = target === null && positional.length > 1 ? positional.length - 1 : -1
    positional.forEach((p, i) => planned.push({ ...p, walk: i !== last }))
  }
  return planned
}

/** The paths a Bash command reads or writes the content of. */
export function bashFileAccesses(command: string, cwd: string = process.cwd(), budget: AccessBudget = {}): string[] {
  const b = newBudget(budget)
  const out: string[] = []
  accessesInto(command, cwd, out, b)
  return out
}

function accessesInto(command: string, cwd: string, out: string[], b: Budget): void {
  let here = cwd
  for (const cmd of parseShell(command)) {
    for (const f of cmd.files) pathsOf(f, here, out, false, b)
    let words = cmd.words
    // Leading VAR=value and wrappers (sudo, env...).
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || WRAPPERS.has(basename(words[0])))) {
      words = words.slice(1)
      while (words.length && words[0].startsWith("-")) words = words.slice(1)
    }
    if (!words.length) continue
    const prog = basename(words[0])
    const args = words.slice(1)
    if (prog === "cd") {
      here = resolve(here, expandHome(args.find((a) => !a.startsWith("-")) ?? "~"))
      continue
    }
    if (!CONTENT_TOOLS.has(prog)) continue
    if (FOLDER_TOOLS.has(prog)) {
      for (const p of planFolderTool(prog, args, here)) pathsOf(p.arg, p.dir, out, p.walk, b)
      if (out.length >= MAX_PATHS) return
      continue
    }
    for (let k = 0; k < args.length; k++) {
      const a = args[k]
      if (CODE_FLAGS.has(a) && k + 1 < args.length && (SHELLS.has(prog) || INTERPRETERS.has(prog))) {
        const code = args[++k]
        if (SHELLS.has(prog)) accessesInto(code, here, out, b)
        // Every path-like piece of the code: quoted strings, words.
        else for (const piece of code.split(/[\s'"`(),;+\[\]{}]+/)) if (piece.includes("/") || piece.includes(".")) pathsOf(piece, here, out, false, b)
        continue
      }
      if (a.startsWith("-") && !a.includes("=")) continue
      // `@file` (curl -d @file), `name=@file` (curl -F), `--opt=file`, `if=file` (dd).
      const at = a.lastIndexOf("@")
      const eq = a.indexOf("=")
      const candidates = [a]
      if (at >= 0) candidates.push(a.slice(at + 1))
      if (eq >= 0) candidates.push(a.slice(eq + 1))
      for (const c of candidates) pathsOf(c, here, out, false, b)
      if (out.length >= MAX_PATHS) return
    }
  }
}

/** The paths a file tool (Read, Write, Edit, Grep) touches: the path itself,
 *  normalised and with symlinks followed; for a Grep over a folder, its
 *  files one level down. */
export function toolFileAccesses(tool: string, filePath: string, cwd: string = process.cwd(), budget: AccessBudget = {}): string[] {
  const b = newBudget(budget)
  const out: string[] = []
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, expandHome(filePath))
  pathsOf(abs, cwd, out, false, b)
  if (tool === "Grep") {
    try {
      if (statSync(abs).isDirectory()) for (const n of listDir(abs, b)) pathsOf(join(abs, n), cwd, out, false, b)
    } catch { /* not there */ }
  }
  return out
}
