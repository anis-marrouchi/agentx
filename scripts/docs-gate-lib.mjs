// Pure checks behind the docs gate (scripts/docs-gate.mjs). No I/O here:
// callers pass file lists, diffs, page text and surfaces in, and get
// problems back as { file?, line?, message }. Unit-tested in
// test/docs-gate.test.ts.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** `**` matches any depth, `*` and `?` stay inside one path segment. */
export function globToRegExp(glob) {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/"
      re += slash ? "(?:.*/)?" : ".*"
      i += slash ? 2 : 1
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else re += escapeRe(c)
  }
  return new RegExp(`^${re}$`)
}

export const matchesAny = (path, globs) => globs.some((g) => globToRegExp(g).test(path))

/** Parse `git diff --no-renames -U0` output into per-file added/removed lines. */
export function parseDiff(patch) {
  const files = []
  let file = null
  let newLine = 0
  let oldLine = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/)
      file = { path: m ? m[2] : "", status: "modified", added: [], removed: [] }
      files.push(file)
    } else if (!file) continue
    else if (line.startsWith("new file mode")) file.status = "added"
    else if (line.startsWith("deleted file mode")) file.status = "deleted"
    else if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/)
      oldLine = Number(m?.[1] ?? 0)
      newLine = Number(m?.[2] ?? 0)
    } else if (line.startsWith("+++") || line.startsWith("---")) continue
    else if (line.startsWith("+")) file.added.push({ line: newLine++, text: line.slice(1) })
    else if (line.startsWith("-")) file.removed.push({ line: oldLine++, text: line.slice(1) })
  }
  return files
}

/** "feat(cli): x" → "feat"; anything else → "". */
export const titleType = (title = "") => title.match(/^(\w+)(?:\([^)]*\))?!?:/)?.[1]?.toLowerCase() ?? ""

// ---- Mentions --------------------------------------------------------------

const lineOf = (text, re) => {
  const lines = text.split("\n")
  const i = lines.findIndex((l) => re.test(l))
  return i < 0 ? 0 : i + 1
}

const commandRe = (bin, path) => new RegExp(`(^|[^\\w-])${escapeRe(`${bin} ${path}`)}(?![\\w-])`)
const flagRe = (flag) => new RegExp(`(^|[^\\w-])${escapeRe(flag)}(?![\\w-])`)

/**
 * How a config key can appear in the docs: as a dotted path (the part after
 * the last "*", or its last two segments), or, when `leafOk`, as its last
 * segment written as code (`"leaf":`, `` `leaf` ``, or a YAML `leaf:`).
 */
export function keyPatterns(key, { leafOk }) {
  const segs = key.split(".")
  const tail = segs.slice(segs.lastIndexOf("*") + 1)
  const leaf = segs[segs.length - 1]
  const dotted = new Set()
  if (tail.length >= 2) {
    dotted.add(tail.join("."))
    dotted.add(tail.slice(-2).join("."))
  }
  const res = [...dotted].map((d) => new RegExp(`(^|[^\\w.])${escapeRe(d)}(?![\\w])`))
  if (leafOk && leaf !== "*") {
    const l = escapeRe(leaf)
    res.push(new RegExp(`"${l}"\\s*:|\`${l}\`|^\\s*${l}:`, "m"))
  }
  return res
}

/** Where each removed command, flag or config key is still mentioned. */
export function staleMentions(base, head, pages) {
  const bin = head.binName
  const headCmds = new Map(head.commands.map((c) => [c.path, c]))
  const headKeys = new Set(head.configKeys)
  const headLeaves = new Set(head.configKeys.map((k) => k.split(".").pop()))
  const found = []
  const hit = (kind, name, re, onPage = () => true) => {
    for (const p of pages) {
      if (!onPage(p) || !re.test(p.text)) continue
      found.push({ file: p.path, line: lineOf(p.text, re), message: `${kind} "${name}" was removed but is still mentioned here` })
    }
  }
  for (const c of base.commands) {
    const now = headCmds.get(c.path)
    if (!now) {
      hit("Command", `${bin} ${c.path}`, commandRe(bin, c.path))
      continue
    }
    for (const flag of c.flags) {
      if (now.flags.includes(flag)) continue
      // Only pages about this command, and not where another command on
      // the same page still has a flag of that name.
      const onPage = (p) =>
        commandRe(bin, c.path).test(p.text) &&
        !head.commands.some((o) => o.path !== c.path && o.flags.includes(flag) && commandRe(bin, o.path).test(p.text))
      hit("Flag", `${bin} ${c.path} ${flag}`, flagRe(flag), onPage)
    }
  }
  for (const key of base.configKeys) {
    if (headKeys.has(key)) continue
    const leafOk = !headLeaves.has(key.split(".").pop())
    for (const re of keyPatterns(key, { leafOk })) hit("Setting", key, re)
  }
  // One problem per file and item, even if several patterns matched.
  const seen = new Set()
  return found.filter((f) => !seen.has(f.file + f.message) && seen.add(f.file + f.message))
}

// ---- Impact ----------------------------------------------------------------

/**
 * Does this PR change what users see without changing the docs?
 * `files` comes from parseDiff; `pr` is { title, body, labels }.
 */
export function checkImpact({ files, pr, config, base, head, pages }) {
  const { surface, exempt, docsDir } = config
  const errors = []
  const notes = []
  const counted = files.filter((f) => !matchesAny(f.path, surface.ignorePaths))
  const reasons = counted.filter((f) => matchesAny(f.path, surface.paths)).map((f) => `${f.path} (${f.status})`)
  for (const p of surface.addedLinePatterns) {
    const re = new RegExp(p.pattern, "g")
    const names = (lines) => new Set(lines.flatMap((l) => [...l.text.matchAll(re)].map((m) => m[1] ?? m[0])))
    for (const f of counted.filter((f) => matchesAny(f.path, p.paths))) {
      const before = names(f.removed)
      for (const n of names(f.added)) if (!before.has(n)) reasons.push(`new ${p.name} ${n} in ${f.path}`)
    }
  }
  // A docs change means an added or edited page, not only a screenshot or a
  // site-config tweak.
  const docsTouched = files.some(
    (f) => f.path.startsWith(`${docsDir}/`) && f.path.endsWith(".md") && f.status !== "deleted" && !f.path.includes("/.vitepress/"),
  )

  if (base && head) errors.push(...staleMentions(base, head, pages))
  else notes.push("Removal check skipped: the surface of the base or this PR could not be read.")

  if (reasons.length === 0) notes.push("No user-facing change found; docs not required.")
  else if (docsTouched) notes.push(`User-facing change with docs updated: ${reasons.join(", ")}`)
  else if (exempt.titleTypes.includes(titleType(pr.title)))
    notes.push(`"${titleType(pr.title)}" PRs do not need docs.`)
  else {
    const labelled = pr.labels.includes(exempt.label)
    // Lines inside HTML comments (the PR template's hint) do not count.
    const body = (pr.body ?? "").replace(/<!--[\s\S]*?-->/g, "")
    const reason = body.split(/\r?\n/).find((l) => new RegExp(exempt.reasonPattern).test(l))
    if (labelled && reason) notes.push(`Docs skipped with "${exempt.label}": ${reason.trim()}`)
    else if (labelled)
      errors.push({ message: `The "${exempt.label}" label needs a reason in the PR body, on its own line: "Docs: not needed because …"` })
    else
      errors.push({
        message:
          `This PR changes what users see but nothing under ${docsDir}/. Update the docs, or add the ` +
          `"${exempt.label}" label and a line "Docs: not needed because …" to the PR body. Changed: ${reasons.join(", ")}`,
      })
  }
  return { errors, notes }
}

// ---- Coverage --------------------------------------------------------------

/** Commands, flags and config keys that no docs page mentions. */
export function coverageGaps(surface, pages, coverage) {
  const bin = surface.binName
  const text = pages.map((p) => p.text).join("\n")
  const gaps = []
  for (const c of surface.commands) {
    if (c.hidden && !coverage.includeHiddenCommands) continue
    if (coverage.ignoreCommands.includes(c.path)) continue
    const re = commandRe(bin, c.path)
    const about = pages.filter((p) => re.test(p.text))
    if (about.length === 0) gaps.push(`command: ${bin} ${c.path}`)
    for (const flag of c.flags) {
      if (coverage.ignoreFlags.includes(flag)) continue
      if (!about.some((p) => flagRe(flag).test(p.text))) gaps.push(`flag: ${bin} ${c.path} ${flag}`)
    }
  }
  for (const key of surface.configKeys) {
    if (key.endsWith(".*") || coverage.ignoreConfigKeys.some((g) => globToRegExp(g).test(key))) continue
    if (!keyPatterns(key, { leafOk: true }).some((re) => re.test(text))) gaps.push(`setting: ${key}`)
  }
  return gaps
}

// ---- Docs rule (#110) ------------------------------------------------------

const norm = (s) => s.replace(/\{#[^}]*\}/g, "").replace(/[*_`]/g, "").replace(/[.:!?\s]+$/, "").trim().toLowerCase()

/** Lines of prose with their numbers; front matter and code fences dropped. */
function proseLines(text) {
  const lines = text.split("\n")
  const out = []
  let fence = null
  let i = 0
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1)
    if (end > 0) i = end + 1
  }
  for (; i < lines.length; i++) {
    const l = lines[i]
    const f = l.match(/^\s*(```|~~~)/)
    if (f) fence = fence ? (fence === f[1] ? null : fence) : f[1]
    else if (!fence) out.push({ n: i + 1, text: l })
  }
  return out
}

/**
 * Split one page's problems into errors and warnings. Pages on the baseline
 * (written before the gate existed) get their "structure" problems as
 * warnings; a baseline page with none left must come off the list, so the
 * list only ever shrinks. "content" problems are always errors.
 */
export function applyBaseline(path, problems, baseline = []) {
  if (!baseline.includes(path)) return { errors: problems, warnings: [] }
  const warnings = problems.filter((p) => p.kind === "structure")
  const errors = problems.filter((p) => p.kind !== "structure")
  if (warnings.length === 0)
    errors.push({
      file: path,
      line: 0,
      kind: "baseline",
      message: `This page now follows the docs rule. Remove "${path}" from rules.baseline in scripts/docs-gate.config.json.`,
    })
  return { errors, warnings }
}

/**
 * Check one page against the docs rule. `exists(repoPath)` answers whether
 * an image file is in the repo. Each problem has a `kind`: "structure"
 * (sections, numbered steps) or "content" (images, private data).
 */
export function checkPage(path, text, rules, exists) {
  const errors = []
  const err = (line, message, kind = "structure") => errors.push({ file: path, line, message, kind })
  const prose = proseLines(text)

  // Ends with "Check it worked" then "If something is wrong".
  const headings = prose.flatMap((l) => {
    const m = l.text.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
    return m ? [{ n: l.n, level: m[1].length, text: norm(m[2]) }] : []
  })
  const want = rules.endingHeadings.map(norm)
  const idx = want.map((w) => headings.findIndex((h) => h.text === w))
  want.forEach((w, i) => idx[i] < 0 && err(0, `Missing the "${rules.endingHeadings[i]}" section; every page ends with ${rules.endingHeadings.map((h) => `"${h}"`).join(" then ")}.`))
  if (idx.every((i) => i >= 0)) {
    const inOrder = idx.every((v, i) => i === 0 || v > idx[i - 1])
    const last = headings[idx[idx.length - 1]]
    const after = headings.slice(idx[idx.length - 1] + 1).find((h) => h.level <= last.level)
    if (!inOrder) err(last.n, `Sections must come in this order: ${rules.endingHeadings.join(", then ")}.`)
    else if (after) err(after.n, `"${rules.endingHeadings.at(-1)}" must be the last section; move this section above it.`)
  }

  // Procedures are numbered: flag bullet lists whose items read as steps.
  const verbRe = new RegExp(`^(?:\\*\\*[^*]+\\*\\*:?\\s*)?(?:${rules.stepVerbs.map(escapeRe).join("|")})\\b`)
  let list = []
  const flush = () => {
    const steps = list.filter((it) => verbRe.test(it.text))
    if (steps.length >= rules.minUnnumberedSteps)
      err(list[0].n, `These look like steps (${steps.length} start with an action); write them as a numbered list.`)
    list = []
  }
  for (const l of prose) {
    const b = l.text.match(/^ {0,3}[-*+]\s+(.*)$/)
    if (b) list.push({ n: l.n, text: b[1] })
    else if (l.text.trim() !== "" && !/^\s{2,}\S/.test(l.text)) flush()
  }
  flush()

  // Images resolve to a file in the repo.
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "."
  for (const l of prose) {
    const srcs = [
      ...[...l.text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)].map((m) => m[1]),
      ...[...l.text.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/g)].map((m) => m[1]),
    ]
    for (const src of srcs) {
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue
      const clean = decodeURI(src.split(/[?#]/)[0])
      const target = clean.startsWith("/") ? `${rules.publicDir}${clean}` : joinPath(dir, clean)
      if (!exists(target)) err(l.n, `Image not found: ${src} (looked for ${target})`, "content")
    }
  }

  // Neutral examples: no org-specific hosts, names or tokens, code included.
  const lines = text.split("\n")
  for (const f of rules.forbidden) {
    const re = new RegExp(f.pattern)
    lines.forEach((l, i) => re.test(l) && err(i + 1, `Not allowed in docs: ${f.why}.`, "content"))
  }
  return errors
}

function joinPath(dir, rel) {
  const out = dir === "." ? [] : dir.split("/")
  for (const seg of rel.split("/")) {
    if (seg === "..") out.pop()
    else if (seg !== "." && seg !== "") out.push(seg)
  }
  return out.join("/")
}
