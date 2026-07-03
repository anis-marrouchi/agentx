import type { ActivityEpisode } from "./load"

// --- Clustering ---
// The cluster key describes a recurring USER activity, not an agent tool
// pattern: `<channel>:<intentShape>:<actionSkeleton>`. intentShape normalizes
// the user's message so "process the June invoice" and "process the July
// invoice" collide; actionSkeleton reduces the tool sequence to coarse
// activity classes so incidental tool-choice differences don't split a
// cluster. Tool names are fine HERE — the black-box rule applies only to
// what the LLM is allowed to emit (see prompts.ts / distill.ts).

const PLACEHOLDERS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, " <email> "],
  [/https?:\/\/\S+/g, " <url> "],
  [/(?:[\w~.-]*\/)+[\w.-]+/g, " <file> "],
  [/\b\d{4}-\d{2}-\d{2}\b/g, " <date> "],
  [/\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/gi, " <date> "],
  [/\b\d+(?:[.,]\d+)*\b/g, " <n> "],
]

/** Normalize a user message to its stable intent tokens. */
export function intentShape(message: string): string {
  let text = message.toLowerCase()
  for (const [re, sub] of PLACEHOLDERS) text = text.replace(re, sub)
  const words = text
    .replace(/[^a-z0-9<>\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 || w.startsWith("<"))
    .slice(0, 6)
  return words.join("-") || "task"
}

/** Coarse activity class per tool name. Unknown tools map to "other" so a
 *  new tool never crashes clustering — it just clusters more loosely. */
export function actionClass(tool: string): string {
  const t = tool.toLowerCase()
  if (/mail|gmail|gog|outlook|hotmail|smtp|imap/.test(t)) return "email"
  if (/wacli|whatsapp|telegram|slack|discord|send_message|sendmessage/.test(t)) return "message"
  if (/webfetch|websearch|browser|puppeteer|playwright/.test(t)) return "web"
  if (/^(read|write|edit|multiedit|notebookedit|glob|grep|ls)$/.test(t)) return "file"
  if (/^(bash|bashoutput|killshell|shell)$/.test(t)) return "shell"
  if (/^(task|agent)$/.test(t)) return "delegate"
  if (t.startsWith("mcp__")) {
    const server = t.split("__")[1] ?? ""
    if (/gitlab|github/.test(server)) return "tracker"
    return server || "other"
  }
  return "other"
}

/** Reduce an ordered tool sequence to its activity skeleton:
 *  classes, consecutive duplicates collapsed, first 8, ">"-joined. */
export function actionSkeleton(actions: string[]): string {
  const classes: string[] = []
  for (const action of actions) {
    const cls = actionClass(action)
    if (classes[classes.length - 1] !== cls) classes.push(cls)
  }
  return classes.slice(0, 8).join(">") || "none"
}

export function clusterKey(ep: ActivityEpisode): string {
  return `${ep.channel}:${intentShape(ep.userMessage)}:${actionSkeleton(ep.actions)}`
}

export interface EpisodeCluster {
  key: string
  episodes: ActivityEpisode[]
}

export function clusterEpisodes(episodes: ActivityEpisode[]): EpisodeCluster[] {
  const groups = new Map<string, ActivityEpisode[]>()
  for (const ep of episodes) {
    const key = clusterKey(ep)
    const list = groups.get(key) ?? []
    list.push(ep)
    groups.set(key, list)
  }
  return Array.from(groups.entries())
    .map(([key, grouped]) => ({ key, episodes: grouped.sort((a, b) => b.startedAt - a.startedAt) }))
    .sort((a, b) => b.episodes.length - a.episodes.length)
}

/** Keys sharing an intentShape but split by skeleton — printed on dry runs
 *  so under-clustering is visible and the class map can be tuned. */
export function nearMisses(clusters: EpisodeCluster[]): Array<{ intent: string; keys: string[] }> {
  const byIntent = new Map<string, string[]>()
  for (const c of clusters) {
    const parts = c.key.split(":")
    const intent = parts.slice(0, 2).join(":")
    const list = byIntent.get(intent) ?? []
    list.push(c.key)
    byIntent.set(intent, list)
  }
  return Array.from(byIntent.entries())
    .filter(([, keys]) => keys.length > 1)
    .map(([intent, keys]) => ({ intent, keys }))
}
