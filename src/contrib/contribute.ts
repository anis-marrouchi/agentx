// `agentx contribute` (#281): the deterministic half of assisted issue filing.
//
// The contributor's own agent writes the words (skills/agentx-contribute);
// this module checks the model against contrib/models.json, finds likely
// duplicates, and turns the draft into a pre-filled GitHub issue form link.
// The person opens the link, reviews it and submits it themselves, so nothing
// is ever posted on their behalf and no GitHub token is needed.

export const REPO = "anis-marrouchi/agentx"
export const MODELS_URL = `https://raw.githubusercontent.com/${REPO}/main/contrib/models.json`
export const NEW_ISSUE_URL = `https://github.com/${REPO}/issues/new/choose`
export const VOTE_URL = `https://github.com/${REPO}/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc`

/** GitHub rejects very long pre-filled URLs; stay well under its limit. */
export const MAX_URL_LENGTH = 8000

export interface Category {
  template: string
  titlePrefix: string
  /** Field ids from the issue form, in form order. */
  fields: { id: string; required: boolean }[]
  /** Textarea that gets the "prepared with" footer. */
  footerField: string
}

// Mirrors .github/ISSUE_TEMPLATE/*.yml; test/contribute.test.ts keeps them in sync.
export const CATEGORIES: Record<string, Category> = {
  bug: {
    template: "bug_report.yml",
    titlePrefix: "Bug: ",
    fields: [
      { id: "what-happened", required: true },
      { id: "environment", required: true },
      { id: "config", required: false },
      { id: "logs", required: false },
    ],
    footerField: "environment",
  },
  enhancement: {
    template: "enhancement.yml",
    titlePrefix: "Enh: ",
    fields: [
      { id: "area", required: true },
      { id: "today", required: true },
      { id: "better", required: true },
    ],
    footerField: "better",
  },
  feature: {
    template: "feature_request.yml",
    titlePrefix: "Feat: ",
    fields: [
      { id: "problem", required: true },
      { id: "proposal", required: true },
      { id: "alternatives", required: false },
    ],
    footerField: "proposal",
  },
  integration: {
    template: "integration.yml",
    titlePrefix: "Integration: ",
    fields: [
      { id: "kind", required: true },
      { id: "name", required: true },
      { id: "use-case", required: true },
      { id: "notes", required: false },
    ],
    footerField: "use-case",
  },
  idea: {
    template: "idea.yml",
    titlePrefix: "Idea: ",
    fields: [
      { id: "idea", required: true },
      { id: "why", required: true },
    ],
    footerField: "why",
  },
  docs: {
    template: "docs.yml",
    titlePrefix: "Docs: ",
    fields: [
      { id: "page", required: true },
      { id: "problem", required: true },
      { id: "suggestion", required: false },
    ],
    footerField: "problem",
  },
}

export interface ModelList {
  models: { id: string; aliases?: string[] }[]
}

/** True when `model` is an entry, a dated snapshot of one (`<id>-…`), or an alias. */
export function isRecommended(model: string, list: ModelList): boolean {
  const m = model.trim().toLowerCase()
  if (!m) return false
  return list.models.some((e) => {
    const id = e.id.toLowerCase()
    return m === id || m.startsWith(`${id}-`) || (e.aliases ?? []).some((a) => a.toLowerCase() === m)
  })
}

/** Kind explanation shown when the model is not on the list. */
export function notRecommendedMessage(model: string, list: ModelList): string {
  return [
    `The model "${model}" is not on the recommended list for drafting AgentX issues.`,
    `The list (${list.models.map((e) => e.id).join(", ")}) keeps drafts clear and consistent; it says nothing about you or your idea.`,
    `Please write the issue yourself with the web form, which is always available: ${NEW_ISSUE_URL}`,
  ].join("\n")
}

export function footer(meta: { model: string; version: string; category: string }): string {
  return `---\n_Prepared with \`agentx contribute\` · model: ${meta.model} · AgentX ${meta.version} · category: ${meta.category}_`
}

export interface Draft {
  category: string
  title: string
  fields: Record<string, string>
}

/** Validate a draft and build the pre-filled issue form URL. Throws with a readable message. */
export function buildIssueUrl(draft: Draft, meta: { model: string; version: string }): string {
  const cat = CATEGORIES[draft.category]
  if (!cat) throw new Error(`Unknown category "${draft.category}". Use one of: ${Object.keys(CATEGORIES).join(", ")}`)

  const known = new Set(cat.fields.map((f) => f.id))
  const unknown = Object.keys(draft.fields).filter((k) => !known.has(k))
  if (unknown.length) throw new Error(`Unknown field(s) for ${draft.category}: ${unknown.join(", ")}. Expected: ${[...known].join(", ")}`)
  const missing = cat.fields.filter((f) => f.required && !draft.fields[f.id]?.trim()).map((f) => f.id)
  if (missing.length) throw new Error(`Missing required field(s) for ${draft.category}: ${missing.join(", ")}`)

  let title = draft.title.trim()
  if (!title) throw new Error("The issue needs a title")
  if (!title.toLowerCase().startsWith(cat.titlePrefix.toLowerCase())) title = cat.titlePrefix + title

  const params = new URLSearchParams({ template: cat.template, title })
  for (const f of cat.fields) {
    let value = draft.fields[f.id]?.trim() ?? ""
    if (f.id === cat.footerField) value = `${value}\n\n${footer({ ...meta, category: draft.category })}`
    if (value) params.set(f.id, value)
  }
  const url = `https://github.com/${REPO}/issues/new?${params.toString()}`
  if (url.length > MAX_URL_LENGTH) {
    throw new Error(`The draft is too long for a pre-filled link (${url.length} characters, limit ${MAX_URL_LENGTH}). Shorten it, or paste it into the web form.`)
  }
  return url
}

export interface SearchHit {
  number: number
  title: string
  url: string
  votes: number
}

/** Open issues that match `query`, most-voted first. Uses the unauthenticated GitHub search API. */
export async function searchIssues(query: string, fetchFn: typeof fetch = fetch): Promise<SearchHit[]> {
  const q = `repo:${REPO} is:issue is:open ${query}`
  const res = await fetchFn(`https://api.github.com/search/issues?per_page=10&q=${encodeURIComponent(q)}`, {
    headers: { accept: "application/vnd.github+json" },
  })
  if (!res.ok) throw new Error(`GitHub search failed (HTTP ${res.status}). Search by hand: https://github.com/${REPO}/issues`)
  const body = (await res.json()) as { items?: any[] }
  return (body.items ?? [])
    .map((i) => ({ number: i.number, title: i.title, url: i.html_url, votes: i.reactions?.["+1"] ?? 0 }))
    .sort((a, b) => b.votes - a.votes)
}

/** Read the model list from a local file path or a URL. */
export async function loadModels(source: string, fetchFn: typeof fetch = fetch): Promise<ModelList> {
  let raw: string
  if (/^https?:\/\//.test(source)) {
    const res = await fetchFn(source, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`Could not read the model list (HTTP ${res.status}) from ${source}`)
    raw = await res.text()
  } else {
    const { readFile } = await import("node:fs/promises")
    raw = await readFile(source, "utf8")
  }
  const list = JSON.parse(raw) as ModelList
  if (!Array.isArray(list.models)) throw new Error(`The model list at ${source} has no "models" array`)
  return list
}
