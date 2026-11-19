import { existsSync, readdirSync, realpathSync, statSync } from "fs"
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

function globToRegex(seg: string): RegExp {
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
  return new RegExp(`^${r}$`)
}

const hasGlob = (s: string) => /[*?[]/.test(s)

/** Expand a glob over the file system, as a shell would (dot files only
 *  for a segment that starts with a dot). At most 200 matches. */
function expandGlob(abs: string): string[] {
  const parts = abs.split("/").filter(Boolean)
  let paths = ["/"]
  for (const seg of parts) {
    if (!hasGlob(seg)) { paths = paths.map((p) => join(p, seg)); continue }
    const re = globToRegex(seg)
    const next: string[] = []
    for (const p of paths) {
      let names: string[] = []
      try { names = readdirSync(p) } catch { continue }
      for (const n of names) {
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
function folderFiles(dir: string, out: string[], level = 0): void {
  if (level >= 2 || out.length >= MAX_PATHS) return
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return }
  for (const n of names) {
    if (n === "node_modules" || n === ".git") continue
    const p = join(dir, n)
    out.push(p)
    if (out.length >= MAX_PATHS) return
    try { if (statSync(p).isDirectory()) folderFiles(p, out, level + 1) } catch { /* gone */ }
  }
}

/** Resolve one argument to the paths it names: normalised, globs expanded,
 *  symlinks followed, and with `folders`, a folder's files. */
function pathsOf(arg: string, cwd: string, out: string[], folders: boolean): void {
  if (!arg || arg.length > 4096) return
  const abs = resolve(cwd, expandHome(arg))
  const found = hasGlob(arg) ? expandGlob(abs) : [abs]
  for (const p of found) {
    out.push(p)
    if (!existsSync(p)) continue
    try { out.push(realpathSync(p)) } catch { /* unreadable */ }
    if (folders) {
      try { if (statSync(p).isDirectory()) folderFiles(p, out) } catch { /* gone */ }
    }
  }
}

/** The paths a Bash command reads or writes the content of. */
export function bashFileAccesses(command: string, cwd: string = process.cwd()): string[] {
  const out: string[] = []
  let here = cwd
  for (const cmd of parseShell(command)) {
    for (const f of cmd.files) pathsOf(f, here, out, false)
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
    for (let k = 0; k < args.length; k++) {
      const a = args[k]
      if (CODE_FLAGS.has(a) && k + 1 < args.length && (SHELLS.has(prog) || INTERPRETERS.has(prog))) {
        const code = args[++k]
        if (SHELLS.has(prog)) out.push(...bashFileAccesses(code, here))
        // Every path-like piece of the code: quoted strings, words.
        else for (const piece of code.split(/[\s'"`(),;+\[\]{}]+/)) if (piece.includes("/") || piece.includes(".")) pathsOf(piece, here, out, false)
        continue
      }
      if (a.startsWith("-") && !a.includes("=")) continue
      // `@file` (curl -d @file), `name=@file` (curl -F), `--opt=file`, `if=file` (dd).
      const at = a.lastIndexOf("@")
      const eq = a.indexOf("=")
      const candidates = [a]
      if (at >= 0) candidates.push(a.slice(at + 1))
      if (eq >= 0) candidates.push(a.slice(eq + 1))
      for (const c of candidates) pathsOf(c, here, out, FOLDER_TOOLS.has(prog))
      if (out.length >= MAX_PATHS) return out
    }
  }
  return out
}

/** The paths a file tool (Read, Write, Edit, Grep) touches: the path itself,
 *  normalised and with symlinks followed; for a Grep over a folder, its
 *  files one level down. */
export function toolFileAccesses(tool: string, filePath: string, cwd: string = process.cwd()): string[] {
  const out: string[] = []
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, expandHome(filePath))
  pathsOf(abs, cwd, out, false)
  if (tool === "Grep") {
    try {
      if (statSync(abs).isDirectory()) for (const n of readdirSync(abs)) pathsOf(join(abs, n), cwd, out, false)
    } catch { /* not there */ }
  }
  return out
}
