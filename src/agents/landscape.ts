import type { DaemonConfig, AgentDef } from "@/daemon/config"

// --- Landscape Builder ---
//
// Generates a cached "world model" string for each agent.
// Built once at daemon startup from config + mesh discovery.
// Gives every agent awareness of the full system: team, channels, rules.

export interface MeshPeerInfo {
  peer: string
  healthy: boolean
  skills: Array<{ id: string; name: string; description: string }>
}

/**
 * Build and cache per-agent landscape strings.
 */
export class LandscapeBuilder {
  private cache: Map<string, string> = new Map()
  private config: DaemonConfig
  private meshPeers: MeshPeerInfo[] = []

  constructor(config: DaemonConfig) {
    this.config = config
  }

  /** Fingerprint of the peer set that produced the current cache. A rebuild
   *  is skipped when `refresh()` gets a topologically-identical set — this
   *  is the common case on every mesh heartbeat and rebuilding would
   *  needlessly invalidate every agent's cached prompt prefix. */
  private fingerprint = ""

  /**
   * Build landscape strings for all agents. Call at startup.
   */
  build(meshPeers?: MeshPeerInfo[]): void {
    if (meshPeers) this.meshPeers = meshPeers
    this.cache.clear()
    this.fingerprint = this.computeFingerprint()

    for (const agentId of Object.keys(this.config.agents)) {
      this.cache.set(agentId, this.renderForAgent(agentId))
    }
  }

  /** Set-only signature of peers + their skill IDs. Health is excluded on
   *  purpose — we don't want a flapping heartbeat to rebuild the cache. */
  private computeFingerprint(): string {
    const parts = [...this.meshPeers]
      .sort((a, b) => a.peer.localeCompare(b.peer))
      .map(p => `${p.peer}:${p.skills.map(s => s.id).sort().join(",")}`)
    return parts.join("|")
  }

  /**
   * Get the cached landscape string for a specific agent.
   */
  getForAgent(agentId: string): string | undefined {
    return this.cache.get(agentId)
  }

  /**
   * Rebuild after mesh topology changes. Skipped when the peer set is
   * unchanged so a flapping health heartbeat doesn't invalidate every
   * agent's cached prompt prefix.
   */
  refresh(meshPeers: MeshPeerInfo[]): void {
    this.meshPeers = meshPeers
    const next = this.computeFingerprint()
    if (next === this.fingerprint && this.cache.size > 0) return
    this.build()
  }

  private renderForAgent(selfId: string): string {
    const lines: string[] = ["[Landscape]"]
    const selfDef = this.config.agents[selfId]

    // Node identity
    lines.push(`Node: ${this.config.node.name} (${this.config.node.id})`)

    // Self
    const selfHandle = this.getPrimaryHandle(selfId)
    const selfCap = this.extractCapability(selfDef)
    const handleStr = selfHandle ? ` (${selfHandle})` : ""
    lines.push(`You: ${selfDef.name}${handleStr} — ${selfCap}`)
    lines.push("")

    // Local team
    const localAgents = Object.entries(this.config.agents).filter(([id]) => id !== selfId)
    lines.push(`Available agents on this node (${localAgents.length} — not all may be in the current group):`)
    for (const [id, def] of localAgents) {
      const handle = this.getPrimaryHandle(id)
      const cap = this.extractCapability(def)
      const h = handle ? ` (${handle})` : ""
      lines.push(`• ${def.name}${h} — ${cap}`)
    }

    // Remote mesh agents. Deliberately NOT filtered by `healthy` — a transient
    // heartbeat flap would otherwise rebuild the landscape and bust every
    // agent's prompt cache. Listing a peer that's momentarily unreachable
    // costs nothing (the A2A call will fail cleanly and the agent will
    // surface that to the user); filtering them out costs us a cache-create
    // on every flap. Health shows up in /health and /live, not here.
    const remotePeers = this.meshPeers.filter(p => p.skills.length > 0)
    if (remotePeers.length) {
      lines.push("")
      lines.push("Remote agents (on mesh peers — address by id via /mesh/task or A2A):")
      // Stable ordering so the peer list doesn't shuffle between builds and
      // invalidate the cache even when the set is unchanged.
      const sortedPeers = [...remotePeers].sort((a, b) => a.peer.localeCompare(b.peer))
      for (const peer of sortedPeers) {
        const sortedSkills = [...peer.skills].sort((a, b) => a.id.localeCompare(b.id))
        for (const skill of sortedSkills) {
          // Surface the agent id (skill.id) — that's what /mesh/task and
          // A2A endpoints take as the routing key. Render the friendly
          // name in parens, then the description. Without the id, the
          // calling agent has to guess the routing key from the name.
          const desc = (skill.description || "").slice(0, 80)
          const nameSuffix = skill.name && skill.name !== skill.id ? ` (${skill.name})` : ""
          lines.push(`• ${skill.id}${nameSuffix} [${peer.peer}] — ${desc}`)
        }
      }
    }

    // Channels
    lines.push("")
    lines.push(this.renderChannels())

    // Rules
    lines.push("")
    lines.push("[Rules]")
    const handles = [selfHandle, selfId].filter(Boolean).join(" / ")
    lines.push(`- Only respond when YOU (${handles}) are mentioned or this is a DM to you`)
    lines.push("- If another agent was mentioned and you were NOT, stay silent — they will handle it")
    lines.push("- The agent list above shows all agents on the node — do NOT assume they are all in the current chat group")
    lines.push("- When asked about group members, only mention agents you have seen in the conversation history")
    lines.push("- To delegate on Telegram: mention the agent's handle in your response")
    lines.push("- On GitLab: reply directly, no Telegram handles. To send to other channels, use the /send API below")
    lines.push("- On WhatsApp: mention another agent's handle to delegate (shared number — name prefixed automatically). To send to other channels, use /send API")

    // Cross-channel outbound messaging
    const [, portStr] = this.config.node.bind.split(":")
    const port = portStr || "19900"
    lines.push("")
    lines.push("[Cross-Channel Messaging]")
    lines.push(`You can send messages to ANY channel proactively (not just reply):`)
    lines.push(`  curl -X POST http://localhost:${port}/send -H "Content-Type: application/json" -d '{"channel":"<channel>","chatId":"<id>","text":"<message>"}'`)
    lines.push("Channels: telegram, whatsapp, gitlab, discord")
    lines.push("ChatId formats:")
    lines.push('  telegram: numeric (e.g. "-1001234567890" for group, "123456" for DM)')
    lines.push('  gitlab: "group/project:issue:123" or "group/project:merge_request:45"')
    lines.push('  whatsapp: JID (e.g. "+21612345678@s.whatsapp.net")')
    lines.push("Use this when asked to notify someone on a different channel, post to an issue, or broadcast updates.")

    // Conversation recall — short vs long memory model. Short memory
    // (today, current chat) is the default and what 90% of recall calls
    // need. Long memory (older windows, broader scope) is opt-in via
    // explicit cues from the user message.
    lines.push("")
    lines.push("[Conversation Recall — short/long memory]")
    lines.push("If a message references prior context you don't have (\"that\", \"it\", \"yes please\", \"continue\", \"correct me if I'm wrong\", \"as discussed\"), recall the actual prior turns BEFORE replying — do not guess, do not invent context from other tools, and do not ask the user to repeat themselves.")
    lines.push("")
    lines.push("ALWAYS pass `channel` and `chatId` from the [Current Conversation] block above so you scope to the right thread:")
    lines.push(`  curl -s -X POST http://localhost:${port}/recall -H "Content-Type: application/json" -d '{"agent":"<your-agent-id>","channel":"<from prompt>","chatId":"<from prompt>","limit":10}'`)
    lines.push("")
    lines.push("Short memory (default — today only): omit `lookbackDays`. Returns last ~10 turns of THIS chat from today UTC.")
    lines.push("Long memory (opt-in): set `lookbackDays` only when the user message has a clear long-memory cue:")
    lines.push("  - \"yesterday\" / \"أمس\"           → lookbackDays: 2")
    lines.push("  - \"few days ago\" / \"couple of days\"  → lookbackDays: 4")
    lines.push("  - \"last week\" / \"week ago\"      → lookbackDays: 8")
    lines.push("  - \"remember when …\" / \"we discussed …\" → lookbackDays: 3")
    lines.push("If unsure, start short and paginate backward using `oldestTs` from the previous response as the next call's `before`.")
    lines.push("")
    lines.push("Other optional fields: `query` (substring filter, e.g. an issue number or name), `participants` (filter by sender username), `after`/`before` (ISO ts overrides). Response shape: { turns: [{ ts, role, senderName, content, channel, chatId }], oldestTs, hasMore, totalScanned }.")
    lines.push("Scope rule: omit chatId to span all of YOUR chats on the channel; omit channel to span all channels. Store is per-agent — you cannot read another agent's chats.")

    // Background monitoring capability
    lines.push("")
    lines.push("[Background Monitoring]")
    lines.push("You can watch things in the background while continuing to work:")
    lines.push("- Tail log files and react to errors as they appear")
    lines.push("- Poll CI/CD pipelines and report when status changes")
    lines.push("- Watch directories for file changes")
    lines.push("Use the Monitor tool for this — it runs a script in the background and streams output to you.")

    // Agent Teams capability
    lines.push("")
    lines.push("[Agent Teams]")
    lines.push("For complex tasks that benefit from parallel work, you can spawn an agent team:")
    lines.push("- Tell Claude Code to 'create an agent team' with specialized teammates")
    lines.push("- Each teammate works independently with its own context window")
    lines.push("- Teammates coordinate via shared task list and direct messaging")
    lines.push("- Best for: code review (security + performance + tests), debugging with competing hypotheses, multi-module features")
    lines.push("- Use teams when work can be parallelized. Use single session for sequential/simple tasks.")

    return lines.join("\n")
  }

  private renderChannels(): string {
    const parts: string[] = []
    const ch = this.config.channels

    if (ch.telegram.enabled) {
      const pol = ch.telegram.policy
      parts.push(`telegram(groups:${pol.group}, DMs:${pol.dm}, delegation:yes)`)
    }
    if (ch.gitlab?.enabled) {
      parts.push("gitlab(webhooks, no delegation)")
    }
    if (ch.whatsapp.enabled) {
      parts.push("whatsapp(DMs only, no delegation)")
    }
    if (ch.discord?.enabled) {
      parts.push("discord(enabled)")
    }

    return `Channels: ${parts.join(", ")}`
  }

  /**
   * Get the primary Telegram handle for an agent (the @username).
   */
  private getPrimaryHandle(agentId: string): string | undefined {
    const def = this.config.agents[agentId]
    if (!def) return undefined
    return def.mentions.find(m => m.startsWith("@"))
  }

  /**
   * Extract a short capability description from systemPrompt.
   * Takes the first sentence, max 80 chars.
   */
  private extractCapability(def: AgentDef): string {
    if (!def.systemPrompt) return def.name

    // Take first sentence (up to period, max 80 chars)
    const first = def.systemPrompt.split(/[.\n]/)[0]?.trim() || def.name
    return first.length > 80 ? first.slice(0, 77) + "..." : first
  }
}
