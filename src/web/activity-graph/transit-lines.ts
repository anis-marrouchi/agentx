// Transit lines: one per project, plus one per agent for its project-less
// work (voice chats, crons, A2A asks). Names and codes come from the
// project path or the agent's org-chart title; nothing is hardcoded.

/** Work with no project runs on its agent's own line. */
export const AGENT_LINE = "agent:"
export const isAgentLine = (id: string) => id.startsWith(AGENT_LINE)

const word = (w: string) => (w.length <= 4 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))

/** "acme/web" → web line; "globex/_mesh" → the client's own line. */
export function lineOf(projectId: string): { id: string; name: string; code: string; project: string | null } {
  const [head, ...rest] = projectId.split("/")
  if (head === "unmapped" || !head) return { id: "unmapped", name: "Unassigned", code: "··", project: null }
  const tail = rest.join("/")
  const own = !tail || tail.startsWith("_")
  const slug = own ? head : rest[rest.length - 1]
  const words = slug.split(/[-_\s]+/).filter(Boolean)
  const name = words.map(word).join(" ")
  const version = words.length > 1 && /^v\d+$/i.test(words[words.length - 1]) ? words[words.length - 1].toUpperCase() : null
  const consonant = slug.slice(1).match(/[bcdfghjklmnpqrstvwxz]/i)?.[0] ?? slug[1] ?? ""
  const code = version ?? (words.length > 1 ? words[0][0] + words[1][0] : slug[0] + consonant).toUpperCase()
  return { id: own ? `${head}/_` : projectId, name, code, project: own ? null : projectId }
}

/** The line for an agent's own work (voice chats, crons, A2A asks with no
 *  project): named from its org-chart role title, else its display name. */
export function agentLineOf(agent: { id: string; name?: string; title?: string } | undefined, agentId: string): ReturnType<typeof lineOf> {
  const name = agent?.title || agent?.name || agentId
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const code = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? agentId).slice(0, 2)).toUpperCase()
  return { id: AGENT_LINE + agentId, name, code, project: null }
}
