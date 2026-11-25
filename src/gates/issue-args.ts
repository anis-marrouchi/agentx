/**
 * G1 (#2085 v3 R, v4 R′, v5 U″): read the arguments of an issue create
 * written as a shell command, for the guard's `issue-complete` check.
 *
 * Read: `glab issue create`, `glab api … projects/<id>/issues` (POST, or
 * fields with no -X, as glab does), and `curl` POSTs to
 * `/api/v4/projects/<id>/issues` with form or JSON bodies. A body may be a
 * plain quoted value, a `"$(cat <<'X' … X)"` heredoc, or a stdin heredoc
 * for `@-`. Parentheses and quotes inside a heredoc body are not counted.
 *
 * Anything it cannot read (a variable, `$(cat file)`, `-d @file`, a pipe
 * into `@-`, a terminator that never comes, a flag it does not know, any
 * throw) is `unchecked`: the call is allowed and the caller logs it. The
 * reader never refuses on a body it could not read.
 *
 * Its own small tokenizer: it does not touch the guard's `parseShell`.
 */

export interface IssueCreateArgs {
  /** "glab issue create", "glab api" or "curl". */
  via: string
  description: string
  hasMilestone: boolean
  /** An estimate given outside the body (glab's --time-estimate). */
  hasEstimate?: boolean
}

export interface IssueCreateReading {
  creates: IssueCreateArgs[]
  /** One reason per create that could not be read. */
  unchecked: string[]
}

interface Word { text: string; dynamic: boolean }
interface Cmd {
  words: Word[]
  /** A heredoc fed to the command's stdin. */
  stdin: string | null
  /** Stdin comes from a pipe, a file or a here-string: not readable. */
  stdinOpaque: boolean
}

class Unreadable extends Error {}

/** Could this command create an issue at all? Cheap pre-check. */
const CANDIDATE = /\b(?:glab|curl)\b[\s\S]*\bissues?\b/

/** Read every issue create in `command`. Never throws. */
export function readIssueCreates(command: string): IssueCreateReading {
  const out: IssueCreateReading = { creates: [], unchecked: [] }
  if (!CANDIDATE.test(command)) return out
  let cmds: Cmd[]
  try {
    cmds = tokenize(command)
  } catch (e) {
    out.unchecked.push(`command not read: ${e instanceof Unreadable ? e.message : "parse error"}`)
    return out
  }
  for (const cmd of cmds) {
    try {
      const read = readCmd(cmd)
      if (read) out.creates.push(read)
    } catch (e) {
      out.unchecked.push(e instanceof Unreadable ? e.message : "arguments not read")
    }
  }
  return out
}

// --- Tokenizer ---

const HEREDOC_SUBST = /^\$\(\s*cat\s*<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_][\w.-]*))[ \t]*\n/

function tokenize(src: string): Cmd[] {
  const cmds: Cmd[] = []
  let cur: Cmd = { words: [], stdin: null, stdinOpaque: false }
  let word: Word | null = null
  let redirect: "skip" | "stdin-file" | "herestring" | null = null
  const pending: Array<{ cmd: Cmd; delim: string; strip: boolean }> = []

  const add = (s: string, dynamic = false) => {
    if (!word) word = { text: "", dynamic: false }
    word.text += s
    if (dynamic) word.dynamic = true
  }
  const endWord = () => {
    if (!word) return
    if (redirect === "stdin-file" || redirect === "herestring") cur.stdinOpaque = true
    else if (redirect !== "skip") cur.words.push(word)
    redirect = null
    word = null
  }
  const endCmd = (piped = false) => {
    endWord()
    if (cur.words.length) cmds.push(cur)
    cur = { words: [], stdin: null, stdinOpaque: piped }
  }
  /** Lines from `p` up to a line that is exactly `delim`. Returns the body
   *  and the index just after the terminator line. */
  const heredocBody = (p: number, delim: string, strip: boolean): [string, number] => {
    let body = ""
    while (p <= src.length) {
      const nl = src.indexOf("\n", p)
      const line = src.slice(p, nl < 0 ? src.length : nl)
      if ((strip ? line.replace(/^\t+/, "") : line) === delim) return [body, nl < 0 ? src.length : nl + 1]
      if (nl < 0) break
      body += (strip ? line.replace(/^\t+/, "") : line) + "\n"
      p = nl + 1
    }
    throw new Unreadable(`heredoc "${delim}" has no terminator`)
  }
  /** Index just after the `)` closing a `$(` that opens at `i` ("$" at i). */
  const substEnd = (i: number): number => {
    let level = 0
    for (let j = i + 1; j < src.length; j++) {
      const c = src[j]
      if (c === "\\") { j++; continue }
      if (c === "'") { const k = src.indexOf("'", j + 1); if (k < 0) break; j = k; continue }
      if (c === '"') {
        let k = j + 1
        for (; k < src.length && src[k] !== '"'; k++) if (src[k] === "\\") k++
        j = k
        continue
      }
      if (c === "<" && src[j + 1] === "<") throw new Unreadable("heredoc inside a command substitution")
      if (c === "(") level++
      else if (c === ")" && --level === 0) return j + 1
    }
    throw new Unreadable("command substitution not closed")
  }
  /** `$…` at i: a heredoc substitution (read), or anything else (dynamic).
   *  Returns the index after it. */
  const dollar = (i: number, quoted: boolean): number => {
    const next = src[i + 1]
    if (next === "(" && src[i + 2] !== "(") {
      const m = quoted ? src.slice(i).match(HEREDOC_SUBST) : null
      if (m) {
        const delim = m[2] ?? m[3] ?? m[4]
        const [body, after] = heredocBody(i + m[0].length, delim, m[1] === "-")
        const close = src.slice(after).match(/^\s*\)/)
        if (!close) throw new Unreadable("heredoc substitution not closed")
        add(body.replace(/\n+$/, ""))
        return after + close[0].length
      }
      const end = substEnd(i)
      add(src.slice(i, end), true)
      return end
    }
    if (next === "{") {
      const end = src.indexOf("}", i)
      if (end < 0) throw new Unreadable("${ not closed")
      add(src.slice(i, end + 1), true)
      return end + 1
    }
    const name = src.slice(i + 1).match(/^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/)
    if (name) {
      add(src.slice(i, i + 1 + name[0].length), true)
      return i + 1 + name[0].length
    }
    if (next === "'" && !quoted) throw new Unreadable("$'…' quoting")
    add("$")
    return i + 1
  }

  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "\\") {
      if (src[i + 1] === "\n") { i += 2; continue }
      add(src[i + 1] ?? "")
      i += 2
      continue
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) throw new Unreadable("quote not closed")
      add(src.slice(i + 1, end))
      i = end + 1
      continue
    }
    if (c === '"') {
      add("")
      let j = i + 1
      for (;;) {
        if (j >= src.length) throw new Unreadable("quote not closed")
        const d = src[j]
        if (d === '"') { j++; break }
        if (d === "\\" && /["\\$`\n]/.test(src[j + 1] ?? "")) {
          if (src[j + 1] !== "\n") add(src[j + 1])
          j += 2
          continue
        }
        if (d === "$") { j = dollar(j, true); continue }
        if (d === "`") {
          const end = src.indexOf("`", j + 1)
          if (end < 0) throw new Unreadable("backquote not closed")
          add(src.slice(j, end + 1), true)
          j = end + 1
          continue
        }
        add(d)
        j++
      }
      i = j
      continue
    }
    if (c === "$") { i = dollar(i, false); continue }
    if (c === "`") {
      const end = src.indexOf("`", i + 1)
      if (end < 0) throw new Unreadable("backquote not closed")
      add(src.slice(i, end + 1), true)
      i = end + 1
      continue
    }
    if (c === "#" && !word) {
      const nl = src.indexOf("\n", i)
      i = nl < 0 ? src.length : nl
      continue
    }
    if (c === " " || c === "\t") { endWord(); i++; continue }
    if (c === "\n") {
      endWord()
      let p = i + 1
      for (const h of pending.splice(0)) {
        const [body, after] = heredocBody(p, h.delim, h.strip)
        h.cmd.stdin = body
        p = after
      }
      endCmd()
      i = p
      continue
    }
    if (c === ";" || c === "&" || c === "(" || c === ")" || c === "{" && !word || c === "}" && !word) {
      if (c === "&" && src[i + 1] === ">") { endWord(); redirect = "skip"; i += 2; continue }
      endCmd()
      i += c === "&" && src[i + 1] === "&" ? 2 : 1
      continue
    }
    if (c === "|") {
      if (src[i + 1] === "|") { endCmd(); i += 2; continue }
      endCmd(true)
      i++
      continue
    }
    if (c === ">") {
      // `2>` / `>&2`: the digits are part of the redirection, not a word.
      const w = word as Word | null
      if (w && /^\d+$/.test(w.text) && !w.dynamic) word = null
      endWord()
      i += src[i + 1] === ">" ? 2 : 1
      if (src[i] === "&") {
        i++
        const fd = src.slice(i).match(/^\d+|^-/)
        if (fd) { i += fd[0].length; continue }
      }
      redirect = "skip"
      continue
    }
    if (c === "<") {
      endWord()
      if (src.startsWith("<<<", i)) { redirect = "herestring"; i += 3; continue }
      if (src[i + 1] === "<") {
        let j = i + 2
        const strip = src[j] === "-"
        if (strip) j++
        while (src[j] === " " || src[j] === "\t") j++
        const m = src.slice(j).match(/^(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][\w.-]*))/)
        if (!m) throw new Unreadable("heredoc delimiter not read")
        pending.push({ cmd: cur, delim: m[1] ?? m[2] ?? m[3], strip })
        i = j + m[0].length
        continue
      }
      redirect = "stdin-file"
      i++
      continue
    }
    add(c)
    i++
  }
  if (pending.length) throw new Unreadable(`heredoc "${pending[0].delim}" has no terminator`)
  endCmd()
  return cmds
}

// --- Commands ---

function readCmd(cmd: Cmd): IssueCreateArgs | null {
  let words = cmd.words
  // Leading VAR=value assignments and `env`, `command`, `exec` wrappers.
  while (words.length && (/^[A-Za-z_]\w*=/.test(words[0].text) || /^(?:env|command|exec)$/.test(words[0].text))) words = words.slice(1)
  if (!words.length) return null
  const tool = words[0].text.split("/").pop()
  if (tool === "glab" && words[1]?.text === "issue" && (words[2]?.text === "create" || words[2]?.text === "new")) return readGlabIssue(words.slice(3))
  if (tool === "glab" && words[1]?.text === "api") return readGlabApi(words.slice(2), cmd)
  if (tool === "curl") return readCurl(words.slice(1), cmd)
  return null
}

function flagValue(args: Word[], index: number, flag: string): [Word, number] {
  const arg = args[index].text
  const eq = arg.startsWith("--") ? arg.indexOf("=") : -1
  if (eq > 0) return [{ text: arg.slice(eq + 1), dynamic: args[index].dynamic }, index]
  // `-XPOST`, `-dvalue`: a short flag with its value glued on.
  if (/^-[A-Za-z]./.test(arg) && arg.length > 2 && !arg.startsWith("--")) return [{ text: arg.slice(2), dynamic: args[index].dynamic }, index]
  const value = args[index + 1]
  if (!value) throw new Unreadable(`${flag} has no value`)
  return [value, index + 1]
}

const flagOf = (arg: string) => (arg.startsWith("--") ? arg.split("=")[0] : arg.slice(0, 2))

const GLAB_ISSUE_VALUE = new Set([
  "-t", "--title", "-a", "--assignee", "-l", "--label", "-R", "--repo",
  "--linked-issues", "--link-type", "--issue-type", "-w", "--weight", "--due-date", "--epic",
])
const GLAB_ISSUE_BOOL = new Set(["-y", "--yes", "-c", "--confidential", "--no-editor", "--web", "--recover"])

function readGlabIssue(args: Word[]): IssueCreateArgs {
  let description: Word | undefined
  let hasMilestone = false
  let hasEstimate = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i].text
    if (!arg.startsWith("-")) throw new Unreadable(`glab issue create: unexpected argument`)
    const flag = flagOf(arg)
    if (GLAB_ISSUE_BOOL.has(arg)) continue
    if (flag === "-d" || flag === "--description") { [description, i] = flagValue(args, i, flag); continue }
    if (flag === "-m" || flag === "--milestone") { const [v, j] = flagValue(args, i, flag); i = j; hasMilestone = v.dynamic || v.text.trim().length > 0; continue }
    if (flag === "-e" || flag === "--time-estimate") { const [v, j] = flagValue(args, i, flag); i = j; hasEstimate = v.dynamic || v.text.trim().length > 0; continue }
    if (GLAB_ISSUE_VALUE.has(flag)) { [, i] = flagValue(args, i, flag); continue }
    throw new Unreadable(`glab issue create: flag ${flag} not known`)
  }
  if (description?.dynamic) throw new Unreadable("glab issue create: description is not literal")
  return { via: "glab issue create", description: description?.text ?? "", hasMilestone, hasEstimate }
}

/** `projects/<id>/issues` exactly (no further segment), with an optional
 *  `/api/v4` prefix, host and query. */
const ISSUES_PATH = /^(?:https?:\/\/[^/]+)?\/?(?:api\/v4\/)?projects\/[^/?#\s]+\/issues\/?(?:\?(.*))?$/

function queryFields(path: string, fields: Map<string, Word>): void {
  const q = path.match(ISSUES_PATH)?.[1]
  if (!q) return
  for (const [k, v] of new URLSearchParams(q)) fields.set(k, { text: v, dynamic: /\$/.test(v) })
}

const GLAB_API_VALUE = new Set(["-H", "--header", "--hostname", "-R", "--repo", "--cache"])
const GLAB_API_BOOL = new Set(["-i", "--include", "--paginate", "--silent", "--output"])

function readGlabApi(args: Word[], cmd: Cmd): IssueCreateArgs | null {
  let endpoint: Word | undefined
  let method: string | undefined
  let hasFields = false
  const fields = new Map<string, Word>()
  const unknown: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i].text
    if (!arg.startsWith("-")) { if (!endpoint) endpoint = args[i]; continue }
    const flag = flagOf(arg)
    if (flag === "-X" || flag === "--method") { const [v, j] = flagValue(args, i, flag); i = j; method = v.text.toUpperCase(); continue }
    if (flag === "-f" || flag === "--raw-field" || flag === "-F" || flag === "--field") {
      const [v, j] = flagValue(args, i, flag)
      i = j
      hasFields = true
      const eq = v.text.indexOf("=")
      if (eq < 0) continue
      const key = v.text.slice(0, eq)
      let value: Word = { text: v.text.slice(eq + 1), dynamic: v.dynamic }
      if ((flag === "-F" || flag === "--field") && value.text.startsWith("@")) {
        value = value.text === "@-" && cmd.stdin !== null && !cmd.stdinOpaque
          ? { text: cmd.stdin, dynamic: false }
          : { text: value.text, dynamic: true }
      }
      fields.set(key, value)
      continue
    }
    if (flag === "--input") { [, i] = flagValue(args, i, flag); hasFields = true; fields.set("description", { text: "", dynamic: true }); continue }
    if (GLAB_API_BOOL.has(arg)) continue
    if (GLAB_API_VALUE.has(flag)) { [, i] = flagValue(args, i, flag); continue }
    unknown.push(flag)
  }
  if (!endpoint || !ISSUES_PATH.test(endpoint.text)) return null
  if ((method ?? (hasFields ? "POST" : "GET")) !== "POST") return null
  if (unknown.length) throw new Unreadable(`glab api: flag ${unknown[0]} not known`)
  queryFields(endpoint.text, fields)
  return fromFields("glab api", fields)
}

function fromFields(via: string, fields: Map<string, Word>): IssueCreateArgs {
  const description = fields.get("description")
  if (description?.dynamic) throw new Unreadable(`${via}: description is not literal`)
  const milestone = fields.get("milestone_id")
  return {
    via,
    description: description?.text ?? "",
    hasMilestone: !!milestone && (milestone.dynamic || /^[1-9]\d*$/.test(milestone.text.trim())),
  }
}

const CURL_DATA = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json"])
const CURL_FORM = new Set(["-F", "--form", "--form-string"])
const CURL_NOT_CREATE = new Set(["-G", "--get", "-I", "--head"])
const CURL_BOOL = new Set([
  "-s", "--silent", "-S", "--show-error", "-f", "--fail", "--fail-with-body", "-L", "--location", "-k", "--insecure",
  "-v", "--verbose", "-i", "--include", "--compressed", "-g", "--globoff", "-N", "--no-buffer", "-#", "--progress-bar",
])
const CURL_VALUE = new Set([
  "-o", "--output", "-w", "--write-out", "-m", "--max-time", "--connect-timeout", "-u", "--user", "-A", "--user-agent",
  "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "--retry", "--retry-delay", "--retry-max-time", "--cacert",
  "--cert", "--key", "-x", "--proxy", "--resolve", "--oauth2-bearer",
])

const CURL_ISSUES = /\/api\/v4\/projects\/[^/?#\s]+\/issues\/?(?:\?|$)/

function readCurl(args: Word[], cmd: Cmd): IssueCreateArgs | null {
  let url: Word | undefined
  let method: string | undefined
  let json = false
  let notCreate = false
  const data: Array<{ flag: string; value: Word }> = []
  const unknown: string[] = []
  // A flag it does not know may take a value: the URL is the word that
  // looks like the issues endpoint, wherever it stands.
  const positional: Word[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i].text
    if (!arg.startsWith("-")) { positional.push(args[i]); continue }
    const flag = flagOf(arg)
    if (flag === "--url") { [url, i] = flagValue(args, i, flag); continue }
    if (flag === "-X" || flag === "--request") { const [v, j] = flagValue(args, i, flag); i = j; method = v.text.toUpperCase(); continue }
    if (flag === "-H" || flag === "--header") {
      const [v, j] = flagValue(args, i, flag)
      i = j
      if (/^\s*content-type\s*:\s*application\/json\s*(?:;.*)?$/i.test(v.text)) json = true
      continue
    }
    if (CURL_DATA.has(flag) || CURL_FORM.has(flag)) {
      const [v, j] = flagValue(args, i, flag)
      i = j
      if (flag === "--json") json = true
      data.push({ flag, value: v })
      continue
    }
    if (CURL_NOT_CREATE.has(arg)) { notCreate = true; continue }
    // Glued short boolean flags: -sS, -sSfL.
    if (/^-[A-Za-z#]+$/.test(arg) && [...arg.slice(1)].every((ch) => CURL_BOOL.has(`-${ch}`))) continue
    if (CURL_BOOL.has(arg)) continue
    if (CURL_VALUE.has(flag)) { [, i] = flagValue(args, i, flag); continue }
    unknown.push(flag)
  }
  url ??= positional.find((w) => CURL_ISSUES.test(w.text.replace(/^[a-z]+:\/\/[^/]+/i, ""))) ?? positional[0]
  if (!url || notCreate) return null
  const path = url.text.replace(/^[a-z]+:\/\/[^/]+/i, "")
  if (!CURL_ISSUES.test(path)) return null
  if ((method ?? (data.length ? "POST" : "GET")) !== "POST") return null
  if (unknown.length) throw new Unreadable(`curl: flag ${unknown[0]} not known`)

  const stdinOf = (v: Word): Word => {
    if (v.text === "@-") return cmd.stdin !== null && !cmd.stdinOpaque ? { text: cmd.stdin, dynamic: false } : { text: "", dynamic: true }
    if (v.text.startsWith("@")) return { text: "", dynamic: true }
    return v
  }
  const fields = new Map<string, Word>()
  queryFields(path.replace(/^.*?(?=\/api\/v4\/)/, ""), fields)
  const isForm = data.some((d) => CURL_FORM.has(d.flag))
  if (isForm) {
    for (const { flag, value } of data) {
      if (!CURL_FORM.has(flag)) throw new Unreadable("curl: form and data mixed")
      const eq = value.text.indexOf("=")
      if (eq < 0) continue
      const v = value.text.slice(eq + 1)
      fields.set(value.text.slice(0, eq), flag !== "--form-string" && /^[@<]/.test(v) ? { text: "", dynamic: true } : { text: v, dynamic: value.dynamic })
    }
    return fromFields("curl", fields)
  }
  const bodies = data.map((d) => ({ flag: d.flag, value: stdinOf(d.value) }))
  const first = bodies[0]?.value.text.trimStart() ?? ""
  if (json || first.startsWith("{")) {
    if (!json || bodies.length !== 1) throw new Unreadable("curl: JSON body not read")
    if (bodies[0].value.dynamic) throw new Unreadable("curl: body is not literal")
    let parsed: any
    try { parsed = JSON.parse(bodies[0].value.text) } catch { throw new Unreadable("curl: JSON body not parsed") }
    if (!parsed || typeof parsed !== "object") throw new Unreadable("curl: JSON body not an object")
    for (const key of ["description", "milestone_id"]) {
      if (parsed[key] !== undefined && parsed[key] !== null) fields.set(key, { text: String(parsed[key]), dynamic: false })
    }
    return fromFields("curl", fields)
  }
  for (const { flag, value } of bodies) {
    if (flag === "--data-urlencode") {
      // `name=value`: curl encodes the value; the server reads it back as given.
      const eq = value.text.indexOf("=")
      if (eq <= 0) throw new Unreadable("curl: --data-urlencode without a name")
      fields.set(value.text.slice(0, eq), { text: safeDecode(value.text.slice(eq + 1)), dynamic: value.dynamic })
      continue
    }
    for (const part of value.text.split("&")) {
      const eq = part.indexOf("=")
      if (eq <= 0) continue
      fields.set(safeDecode(part.slice(0, eq)), { text: safeDecode(part.slice(eq + 1).replace(/\+/g, " ")), dynamic: value.dynamic })
    }
  }
  return fromFields("curl", fields)
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s) } catch { throw new Unreadable("curl: value not decoded") }
}
