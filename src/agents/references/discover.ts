import type { Skill } from "@/agent/skills/types"
import type { ReferenceCard, ReferenceKind } from "./types"

// --- References discovery ---
//
// Pure extractor: given a namespace and a bag of source skills, walk their
// markdown bodies and pull out structured facts (SSH hosts, GitLab project
// IDs, filesystem paths, contacts) as ReferenceCard[]. Deterministic regex —
// no LLM in the loop. Operator reviews the output and edits before flipping
// `contextReferences: true` on the agents.

const SSH_LINE_RE = /\bssh\s+(?:-i\s+(\S+)\s+)?([a-z_][a-z0-9_-]*)@([a-z0-9][a-z0-9.-]+|\d{1,3}(?:\.\d{1,3}){3})/gi
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const EMAIL_RE = /\b([a-z0-9][a-z0-9._-]*)@([a-z0-9][a-z0-9.-]+\.[a-z]{2,})\b/gi
const GITLAB_PROJECT_LINE_RE = /([a-z0-9][a-z0-9._-]+)\/([a-z0-9][a-z0-9._-]+)[^\n|]*\(?\s*ID:?\s*(\d+)\s*\)?/gi
const GITLAB_GROUP_RE = /groups\/([a-z0-9][a-z0-9._-]+)[^\n|]*\(?\s*ID:?\s*(\d+)\s*\)?/gi
const PATH_RE = /(\/Users\/[^\s)`'"\]]+|\/home\/[^\s)`'"\]]+|\/var\/www\/[^\s)`'"\]]+|\/etc\/[^\s)`'"\]]+)/g
const PHONE_RE = /(\+\d{1,3}[\s.-]?(?:\(\d+\)[\s.-]?)?\d[\s.\d-]{6,}\d)/g
const PRIVATE_IP_RE = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/

export interface DiscoveryResult {
  /** Cards keyed by kind (ssh, gitlab, path, contact). */
  byKind: Record<string, ReferenceCard[]>
  /** Skills that were scanned. */
  scannedSkills: string[]
  /** Per-source diagnostics — what was found in which skill. */
  diagnostics: Array<{ skill: string; kind: string; id: string }>
}

export interface DiscoveryOptions {
  /** Namespace prefix applied to every generated card id. */
  namespace: string
  /** Include only skills whose name OR tags contain any of these substrings.
   *  Empty = scan every skill. */
  filter?: string[]
  /** Optional GitLab host to validate project URLs against (e.g.
   *  https://gitlab.noqta.tn). When set, project URLs from other hosts are
   *  ignored — keeps stray GitHub mentions out of a self-hosted registry. */
  gitlabHost?: string
}

export function discoverFromSkills(skills: Skill[], opts: DiscoveryOptions): DiscoveryResult {
  const result: DiscoveryResult = {
    byKind: { ssh: [], gitlab: [], path: [], contact: [] },
    scannedSkills: [],
    diagnostics: [],
  }
  const seen = new Set<string>() // id de-dup across skills

  for (const skill of skills) {
    const fm = skill.frontmatter
    const body = skill.instructions ?? ""
    if (opts.filter?.length) {
      const hay = [
        fm.name,
        fm.description,
        ...(fm.tags ?? []),
        (fm as any).category ?? "",
        skill.path ?? "",
        body.slice(0, 500), // first ~125 tokens of body, enough for a "MTGL Odoo Server" header
      ].join(" ").toLowerCase()
      const hit = opts.filter.some(f => hay.includes(f.toLowerCase()))
      if (!hit) continue
    }
    result.scannedSkills.push(fm.name)

    const ownerHint = fm.name

    for (const card of extractSshCards(body, opts.namespace, ownerHint)) {
      if (push(result, card, "ssh", seen)) result.diagnostics.push({ skill: fm.name, kind: "ssh", id: card.id })
    }
    for (const card of extractGitlabCards(body, opts.namespace, opts.gitlabHost)) {
      if (push(result, card, "gitlab", seen)) result.diagnostics.push({ skill: fm.name, kind: "gitlab", id: card.id })
    }
    for (const card of extractPathCards(body, opts.namespace)) {
      if (push(result, card, "path", seen)) result.diagnostics.push({ skill: fm.name, kind: "path", id: card.id })
    }
    for (const card of extractContactCards(body, opts.namespace)) {
      if (push(result, card, "contact", seen)) result.diagnostics.push({ skill: fm.name, kind: "contact", id: card.id })
    }
  }

  return result
}

function push(
  result: DiscoveryResult,
  card: ReferenceCard,
  kind: ReferenceKind,
  seen: Set<string>,
): boolean {
  if (seen.has(card.id)) return false
  seen.add(card.id)
  result.byKind[kind].push(card)
  return true
}

// ---- Extractors ----

function extractSshCards(body: string, ns: string, owner: string): ReferenceCard[] {
  const cards: ReferenceCard[] = []
  for (const m of body.matchAll(SSH_LINE_RE)) {
    const [, key, user, host] = m
    if (!user || !host) continue
    const slug = slugify(`${user}-${host.replace(/[^a-z0-9-]/gi, "-")}`)
    cards.push({
      id: `${ns}.ssh.${slug}`,
      kind: "ssh",
      summary: `SSH ${user}@${host}`,
      fields: cleanFields({ user, host, key }),
      tags: ["discovered"],
      ownerAgent: owner,
    })
  }
  // Catch IPs not already paired with a user
  const claimed = new Set(cards.flatMap(c => Object.values(c.fields)))
  for (const m of body.matchAll(IP_RE)) {
    const ip = m[0]
    if (claimed.has(ip)) continue
    if (PRIVATE_IP_RE.test(ip)) continue
    const slug = slugify(`host-${ip.replace(/\./g, "-")}`)
    cards.push({
      id: `${ns}.ssh.${slug}`,
      kind: "ssh",
      summary: `Host ${ip} (user not detected — fill in)`,
      fields: { host: ip },
      tags: ["discovered", "needs-review"],
      ownerAgent: owner,
    })
    claimed.add(ip)
  }
  return cards
}

const PROJECT_LINE_RE = /\b([a-z0-9][a-z0-9._-]{1,40})\/([a-z0-9][a-z0-9._-]{1,40})\b/i
const ID_NUM_RE = /\b(\d{1,8})\b/g

function extractGitlabCards(body: string, ns: string, gitlabHost?: string): ReferenceCard[] {
  const cards: ReferenceCard[] = []
  if (gitlabHost && !body.includes(gitlabHost.replace(/^https?:\/\//, ""))) return cards
  // Group lines anywhere
  for (const m of body.matchAll(GITLAB_GROUP_RE)) {
    const [, slug, id] = m
    if (!slug || !id) continue
    cards.push({
      id: `${ns}.gitlab.group.${slugify(slug)}`,
      kind: "gitlab",
      summary: `GitLab group ${slug}`,
      fields: { groupId: Number(id), path: slug },
      tags: ["discovered"],
    })
  }
  // Project lines: walk line-by-line so table rows ("| g/p | 269 |") are
  // handled the same way as prose ("g/p (ID: 269)"). For each line that
  // mentions <group>/<project>, take the rightmost plausible numeric ID.
  const projectGlobalRe = new RegExp(PROJECT_LINE_RE.source, "gi")
  for (const line of body.split(/\r?\n/)) {
    // Skip lines that look like prose mentioning a path, not a GitLab project.
    // Real GitLab callouts almost always include "ID:" or a gitlab.* hostname
    // in the same line, or appear inside a markdown table row. Without one of
    // those, the noise rate is too high.
    const isTableRow = /^\s*\|.+\|/.test(line)
    if (!isTableRow && !/\bID[:\s]/i.test(line) && !/gitlab/i.test(line)) continue
    // Two-pass: prefer a GitLab URL (https://gitlab.<host>/<group>/<repo>)
    // when present on the line, otherwise fall back to the rightmost
    // <group>/<repo> token that doesn't have a hostname-shaped group.
    let group: string | undefined
    let repo: string | undefined
    const urlMatch = line.match(/https?:\/\/[^\s)]*gitlab[^\s)]*?\/([a-z0-9][a-z0-9._-]+)\/([a-z0-9][a-z0-9._-]+)/i)
    if (urlMatch && urlMatch[1] && urlMatch[2]) {
      group = urlMatch[1]
      repo = urlMatch[2].replace(/[).,;:]+$/, "")
    } else {
      // Walk every <a>/<b> on the line and keep the last one that looks like
      // a real group/repo (no dots in group, not a wp-content path, not a file).
      for (const m of line.matchAll(projectGlobalRe)) {
        const g = m[1]
        const r = m[2]
        if (!g || !r) continue
        if (g === "wp-content" || r === "wp-content") continue
        if (g.includes(".")) continue
        if (looksLikeFile(r)) continue
        group = g
        repo = r
      }
    }
    if (!group || !repo) continue
    const ids = [...line.matchAll(ID_NUM_RE)].map(m => Number(m[1]))
    const id = ids.find(n => n >= 10 && n <= 9_999_999)
    if (!id) continue
    cards.push({
      id: `${ns}.gitlab.project.${slugify(repo)}`,
      kind: "gitlab",
      summary: `GitLab project ${group}/${repo}`,
      fields: { projectId: id, path: `${group}/${repo}` },
      tags: ["discovered"],
    })
  }
  return cards
}

function looksLikeFile(s: string): boolean {
  return /\.(md|ya?ml|json|ts|tsx|js|jsx|py|sh|conf|env)$/i.test(s)
}

function extractPathCards(body: string, ns: string): ReferenceCard[] {
  const cards: ReferenceCard[] = []
  for (const m of body.matchAll(PATH_RE)) {
    let p = m[1].replace(/[.,;:)]+$/, "") // strip trailing punctuation
    if (p.length < 4) continue
    const slug = slugify(p.replace(/^\//, "").replace(/[/.]/g, "-"))
    cards.push({
      id: `${ns}.paths.${slug}`,
      kind: "path",
      summary: p,
      fields: { path: p },
      tags: ["discovered"],
    })
  }
  return cards
}

function extractContactCards(body: string, ns: string): ReferenceCard[] {
  const cards: ReferenceCard[] = []
  for (const m of body.matchAll(EMAIL_RE)) {
    const [, local, domain] = m
    if (domain.endsWith(".png") || domain.endsWith(".jpg")) continue // junk filter
    const slug = slugify(local)
    cards.push({
      id: `${ns}.contacts.${slug}`,
      kind: "contact",
      summary: `${local}@${domain}`,
      fields: { email: `${local}@${domain}` },
      tags: ["discovered"],
    })
  }
  // Best-effort: if a phone appears on the same line as a known contact email
  // we already picked, attach it. Otherwise drop a standalone phone card.
  const phones = [...body.matchAll(PHONE_RE)].map(m => m[1].trim())
  for (const phone of phones) {
    const slug = slugify(`phone-${phone.replace(/\D+/g, "")}`)
    cards.push({
      id: `${ns}.contacts.${slug}`,
      kind: "contact",
      summary: `Phone ${phone}`,
      fields: { mobile: phone },
      tags: ["discovered", "needs-review"],
    })
  }
  return cards
}

// ---- Helpers ----

function cleanFields(fields: Record<string, string | number | boolean | undefined>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === "") continue
    out[k] = v
  }
  return out
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "x"
}

/**
 * Render a discovery result as YAML-ready file contents, one per kind.
 * Output is a complete `ReferenceFile`-shaped payload, ready to write to
 * `.agentx/references/<ns>/{ssh,gitlab,paths,contacts}.yaml`.
 */
export function renderDiscovery(result: DiscoveryResult, namespace: string): Record<string, string> {
  const out: Record<string, string> = {}
  const fileMap: Record<string, string> = {
    ssh: "ssh.yaml",
    gitlab: "gitlab.yaml",
    path: "paths.yaml",
    contact: "contacts.yaml",
  }
  for (const [kind, cards] of Object.entries(result.byKind)) {
    if (cards.length === 0) continue
    const ns = `${namespace}.${kind === "path" ? "paths" : kind === "contact" ? "contacts" : kind}`
    const lines = [
      `# Discovered automatically by 'agentx references discover'.`,
      `# Review every card — flagged ones (tags include "needs-review") are`,
      `# best-effort guesses. Set lastVerified once you've confirmed.`,
      `namespace: ${ns}`,
      `cards:`,
    ]
    for (const card of cards) {
      // Strip the namespace from the id so the file's `namespace:` doesn't
      // double-apply it on load.
      const localId = card.id.startsWith(`${ns}.`) ? card.id.slice(ns.length + 1) : card.id
      lines.push(`  - id: ${localId}`)
      lines.push(`    kind: ${card.kind}`)
      lines.push(`    summary: ${quote(card.summary)}`)
      lines.push(`    fields:`)
      for (const [k, v] of Object.entries(card.fields)) {
        lines.push(`      ${k}: ${typeof v === "number" || typeof v === "boolean" ? v : quote(String(v))}`)
      }
      lines.push(`    tags: [${card.tags.join(", ")}]`)
      if (card.ownerAgent) lines.push(`    ownerAgent: ${card.ownerAgent}`)
    }
    out[fileMap[kind]] = lines.join("\n") + "\n"
  }
  return out
}

function quote(s: string): string {
  if (/^[A-Za-z0-9_./@+:-]+$/.test(s) && !/^\d/.test(s)) return s
  return `"${s.replace(/"/g, '\\"')}"`
}
