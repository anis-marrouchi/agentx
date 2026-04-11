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

  /**
   * Build landscape strings for all agents. Call at startup.
   */
  build(meshPeers?: MeshPeerInfo[]): void {
    if (meshPeers) this.meshPeers = meshPeers
    this.cache.clear()

    for (const agentId of Object.keys(this.config.agents)) {
      this.cache.set(agentId, this.renderForAgent(agentId))
    }
  }

  /**
   * Get the cached landscape string for a specific agent.
   */
  getForAgent(agentId: string): string | undefined {
    return this.cache.get(agentId)
  }

  /**
   * Rebuild after mesh topology changes.
   */
  refresh(meshPeers: MeshPeerInfo[]): void {
    this.build(meshPeers)
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

    // Remote mesh agents
    const healthyPeers = this.meshPeers.filter(p => p.healthy && p.skills.length > 0)
    if (healthyPeers.length) {
      lines.push("Remote:")
      for (const peer of healthyPeers) {
        for (const skill of peer.skills) {
          lines.push(`• ${skill.name} [${peer.peer}] — ${skill.description.slice(0, 60)}`)
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
