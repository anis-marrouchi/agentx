import type { EntityHint, FactRecord, FactSource } from "../types"

// Emails, handles and profile URLs, from the GitLab instance.
//
// 3,011 of the fleet's raw entries come from GitLab, so for most of the
// people in the wiki this is the system that knows who they are. The
// user search returns `organization` and `job_title` fields too; they
// are usually blank on this instance, which is worth knowing — the
// source reports what it has and stays quiet about the rest, so a blank
// job title never reaches the prompt as a fact.

export interface GitlabSourceOptions {
  baseUrl?: string
  token?: string
}

interface GitlabUser {
  username?: string
  name?: string
  email?: string
  public_email?: string
  organization?: string
  job_title?: string
  web_url?: string
  state?: string
}

export function createGitlabSource(opts: GitlabSourceOptions = {}): FactSource {
  const baseUrl = (opts.baseUrl ?? process.env.GITLAB_URL ?? "https://gitlab.noqta.tn").replace(/\/+$/, "")
  const token = opts.token ?? process.env.GITLAB_ADMIN_TOKEN ?? process.env.GITLAB_TOKEN

  return {
    name: "gitlab",
    provides: ["email", "handle", "profile URL"],
    async available() {
      if (!token) {
        return { kind: "not-configured", hint: "export GITLAB_ADMIN_TOKEN=<admin PAT>  (read_api scope is enough)" }
      }
      return null
    },
    async lookup(hints: EntityHint[], signal?: AbortSignal) {
      if (!token) return []
      const records: FactRecord[] = []
      const seen = new Set<string>()
      for (const h of hints) {
        const url = `${baseUrl}/api/v4/users?search=${encodeURIComponent(h.name)}&per_page=5`
        let users: GitlabUser[]
        try {
          const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token }, signal })
          if (!res.ok) continue
          users = (await res.json()) as GitlabUser[]
        } catch {
          continue
        }
        if (!Array.isArray(users)) continue
        for (const u of users) {
          const key = u.username ?? u.web_url ?? ""
          if (!key || seen.has(key)) continue
          seen.add(key)
          const fields: Record<string, string> = {}
          const email = u.email || u.public_email
          if (email) fields.email = email
          if (u.username) fields.gitlab = `@${u.username}`
          if (u.web_url) fields.profile = u.web_url
          // Blank strings are the instance's default, not a stated fact.
          if (u.organization) fields.organisation = u.organization
          if (u.job_title) fields.role = u.job_title
          if (u.state && u.state !== "active") fields.accountState = u.state
          if (Object.keys(fields).length === 0) continue
          records.push({
            name: u.name ?? h.name,
            source: "gitlab",
            fields,
            fuzzy: (u.name ?? "").toLowerCase() !== h.name.toLowerCase(),
          })
        }
      }
      return records
    },
  }
}
