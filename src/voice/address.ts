// --- Address by name: "Writer, what's the status" goes to Writer ---
//
// The voice widget talks to one target agent. Starting a sentence with
// another agent's name sends that one utterance to that agent and leaves
// the target alone. Names come from config: the agent's id, its `name`,
// and every `mentions` entry with the `@` dropped — the names it already
// answers to in chats. No new alias setting.
//
// Only the first one or two words are looked at, so a name later in the
// sentence ("ask Writer later") never reroutes. No match, or more than one
// agent matching, keeps the target: a wrong guess is worse than none.

export interface Addressable {
  id: string
  name?: string
  mentions?: string[]
}

const norm = (s: string) =>
  s.toLowerCase().replace(/^@/, "").replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim()

/** The agent the utterance is addressed to, or `target` when none is. */
export function addressedAgent(text: string, agents: Addressable[], target: string): string {
  const words = norm(text).split(" ").filter(Boolean)
  // Two words first, so "Dev Session, …" is not read as "Dev".
  for (const lead of [words.length > 1 ? words.slice(0, 2).join(" ") : "", words[0] ?? ""]) {
    if (!lead) continue
    const matched = new Set<string>()
    for (const agent of agents) {
      const names = [agent.id, agent.name ?? "", ...(agent.mentions ?? [])].map(norm)
      if (names.includes(lead)) matched.add(agent.id)
    }
    if (matched.size === 1) return [...matched][0]
    if (matched.size > 1) return target
  }
  return target
}
