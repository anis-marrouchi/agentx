// `wiki.query` from agentx.json, resolved into what a query runs with
// (#855). The CLI and the `agentx_wiki_query` tool both ask here, so one
// setting reaches both.

import { readFileSync } from "fs"
import { resolve } from "path"
import { AgentMemory } from "@/agents/agent-memory"
import type { DaemonConfig } from "@/daemon/config"
import type { LiveRepo, LiveSource } from "./live-read"
import type { NoteSource } from "./query-notes"
import { DEFAULT_SUMMARIES_QUERY, type SummariesQuerySettings } from "./query-summaries"

export type QueryMethod = "auto" | "summaries" | "catalog"

export interface WikiQuerySettings {
  /** Also search other agents' readable pages. */
  shared: boolean
  method: QueryMethod
  summaries: SummariesQuerySettings
  /** The asking agent's own notes in the pool (#862). */
  notes: {
    enabled: boolean
    types: string[]
    /** `agents.<id>.wiki.notes.dir` of each agent that sets one. */
    dirs: Record<string, string>
  }
}

export const DEFAULT_QUERY_SETTINGS: WikiQuerySettings = {
  shared: true, method: "auto", summaries: DEFAULT_SUMMARIES_QUERY,
  notes: { enabled: false, types: ["project", "reference"], dirs: {} },
}

/** The notes `agentId`'s queries search, or undefined when notes are off.
 *  Its configured folder, else its folder in the AgentX note store. */
export function noteSourceFor(settings: WikiQuerySettings, agentId: string, cwd = process.cwd()): NoteSource | undefined {
  if (!settings.notes.enabled || !agentId) return undefined
  const dir = settings.notes.dirs[agentId]
  return {
    owner: agentId,
    dir: dir ? resolve(cwd, dir) : new AgentMemory({ baseDir: resolve(cwd, ".agentx") }).dirOf(agentId),
    types: settings.notes.types,
  }
}

type Env = Record<string, string | undefined>

/** The notes the `agentx_wiki_query` tool may search. The tool takes the
 *  agent from its caller (`agent`), so naming another agent must not open
 *  that agent's notes: notes join only when the agent is the one this
 *  runtime runs as (`AGENTX_AGENT_ID`). */
export function toolNoteSourceFor(settings: WikiQuerySettings, agentId: string, env: Env = process.env, cwd = process.cwd()): NoteSource | undefined {
  const runtimeAgent = env.AGENTX_AGENT_ID
  if (!runtimeAgent || runtimeAgent !== agentId) return undefined
  return noteSourceFor(settings, agentId, cwd)
}

function fileToken(path: string | undefined): string | undefined {
  if (!path) return undefined
  try {
    return readFileSync(path, "utf-8").trim().split("\n")[0].trim() || undefined
  } catch {
    return undefined
  }
}

/** Whether a channel's token may go to `url`: same origin as the
 *  channel (scheme, host and port), and over https only, so a token is
 *  never sent in clear or to a port it was not set for. */
export function mayLendToken(url: string, channel: string): boolean {
  try {
    const a = new URL(url)
    return a.protocol === "https:" && a.origin === new URL(channel).origin
  } catch {
    return false
  }
}

const repos = (list: Array<string | { repo: string; about?: string }>): LiveRepo[] =>
  list.map((r) => (typeof r === "string" ? { repo: r } : { repo: r.repo, about: r.about }))

/**
 * Turn the configured sources into hosts and tokens. A source that names
 * its own token (`tokenEnv`, `tokenFile`) uses it. One that names none
 * uses the matching channel's token, and only when the source points at
 * that channel's https origin: a token never goes to a host it was not
 * set for, nor over plain http.
 */
export function resolveLiveSources(config: DaemonConfig, env: Env = process.env): LiveSource[] {
  const out: LiveSource[] = []
  for (const s of config.wiki.query.live.sources) {
    if (s.type === "agentx") {
      const bind = config.node.bind.replace(/^0\.0\.0\.0:/, "127.0.0.1:")
      out.push({ type: "agentx", url: s.url ?? `http://${bind}`, peers: s.peers })
      continue
    }
    const own = (s.tokenEnv ? env[s.tokenEnv] : undefined) || fileToken(s.tokenFile)
    if (s.type === "github") {
      const gh = config.channels.github
      const channel = mayLendToken(s.apiUrl, "https://api.github.com") ? gh?.token || fileToken(gh?.tokenFile) : undefined
      out.push({ type: "github", apiUrl: s.apiUrl, token: own || channel || undefined, repos: repos(s.repos) })
    } else {
      const gl = config.channels.gitlab
      const url = s.url ?? gl?.host
      if (!url) continue
      // Unset url: the channel's own host, so the token goes where the
      // channel already sends it.
      const channel = gl?.host && (!s.url || mayLendToken(url, gl.host)) ? gl.token : undefined
      out.push({ type: "gitlab", url, token: own || channel || undefined, repos: repos(s.repos) })
    }
  }
  return out
}

export function resolveQuerySettings(config: DaemonConfig, env: Env = process.env): WikiQuerySettings {
  const q = config.wiki.query
  return {
    shared: q.shared,
    method: q.method,
    summaries: {
      candidates: q.candidates,
      sharedCandidates: q.sharedCandidates,
      noteCandidates: q.notes.candidates,
      maxPages: q.maxPages,
      linkedPages: q.linkedPages,
      pageChars: q.pageChars,
      navigatorModel: q.navigatorModel,
      answerModel: q.answerModel,
      live: {
        enabled: q.live.enabled,
        maxReads: q.live.maxReads,
        timeoutMs: q.live.timeoutMs,
        plannerModel: q.live.plannerModel,
        sources: resolveLiveSources(config, env),
      },
    },
    notes: {
      enabled: q.notes.enabled,
      types: q.notes.types,
      dirs: Object.fromEntries(Object.entries(config.agents).flatMap(([id, a]) => (a.wiki?.notes?.dir ? [[id, a.wiki.notes.dir]] : []))),
    },
  }
}

/** The settings of the config in the working directory; the defaults
 *  (shared on, no live source) when there is none to read. */
export async function loadQuerySettings(configPath?: string): Promise<WikiQuerySettings> {
  try {
    const { loadDaemonConfig } = await import("@/daemon/config")
    return resolveQuerySettings(loadDaemonConfig(configPath))
  } catch {
    return DEFAULT_QUERY_SETTINGS
  }
}
