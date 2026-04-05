import type { MeshPeer, DaemonConfig } from "@/daemon/config"
import type { AgentCard, AgentSkill } from "./types"
import { A2AClient } from "./client"

// --- A2A Mesh: peer discovery, health checks, agent directory ---

export interface PeerState {
  peer: MeshPeer
  client: A2AClient
  healthy: boolean
  lastCheck?: Date
  agentCard?: AgentCard
  agents: AgentSkill[]
}

export class A2AMesh {
  private peers: Map<string, PeerState> = new Map()
  private healthTimer?: ReturnType<typeof setInterval>
  private config: DaemonConfig
  private log: (...args: unknown[]) => void

  constructor(
    config: DaemonConfig,
    log: (...args: unknown[]) => void = console.error.bind(console, "[mesh]"),
  ) {
    this.config = config
    this.log = log

    for (const peer of config.mesh.peers) {
      this.peers.set(peer.name, {
        peer,
        client: new A2AClient(peer.url, peer.token),
        healthy: false,
        agents: [],
      })
    }
  }

  /**
   * Start the mesh: discover peers and begin health checks.
   */
  async start(): Promise<void> {
    this.log(`Mesh starting with ${this.peers.size} peer(s)`)

    // Initial discovery
    await this.discoverAll()

    // Periodic health checks
    const interval = this.config.mesh.healthCheck.interval * 1000
    this.healthTimer = setInterval(() => this.discoverAll(), interval)
  }

  async stop(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
    }
  }

  /**
   * Discover agent cards from all peers.
   */
  async discoverAll(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.peers.entries()).map(([name, state]) =>
        this.discoverPeer(name, state),
      ),
    )

    const healthy = Array.from(this.peers.values()).filter((p) => p.healthy).length
    this.log(`Discovery complete: ${healthy}/${this.peers.size} peers healthy`)
  }

  private async discoverPeer(name: string, state: PeerState): Promise<void> {
    const timeout = this.config.mesh.healthCheck.timeout * 1000

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)

      const card = await state.client.getAgentCard()
      clearTimeout(timer)

      state.healthy = true
      state.lastCheck = new Date()
      state.agentCard = card
      state.agents = card.skills || []

      this.log(`Peer "${name}" healthy: ${card.name} (${state.agents.length} skills)`)
    } catch (e: any) {
      state.healthy = false
      state.lastCheck = new Date()
      this.log(`Peer "${name}" unreachable: ${e.message}`)
    }
  }

  /**
   * Send a task to a remote peer by name.
   * Uses the peer's /task HTTP endpoint (agentx daemon API).
   * If no agent specified, uses the first available agent on the peer.
   */
  async sendTask(peerName: string, text: string, agentId?: string): Promise<string> {
    const state = this.peers.get(peerName)
    if (!state) throw new Error(`Unknown peer: ${peerName}`)
    if (!state.healthy) throw new Error(`Peer "${peerName}" is not healthy`)

    // Default to first agent on the peer
    const agent = agentId || state.agents[0]?.id
    if (!agent) throw new Error(`Peer "${peerName}" has no agents`)

    const url = `${state.peer.url}/task`
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (state.peer.token) {
      headers["Authorization"] = `Bearer ${state.peer.token}`
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent, message: text }),
    })

    if (!res.ok) {
      throw new Error(`Peer "${peerName}" /task error: ${res.status}`)
    }

    const data = await res.json() as { content?: string; error?: string }
    if (data.error) throw new Error(`Peer "${peerName}" agent error: ${data.error}`)
    return data.content || "No response"
  }

  /**
   * Find a peer that has a specific skill.
   */
  findPeerWithSkill(skillId: string): PeerState | undefined {
    for (const state of this.peers.values()) {
      if (state.healthy && state.agents.some((a) => a.id === skillId)) {
        return state
      }
    }
    return undefined
  }

  /**
   * Get the combined agent directory across all healthy peers.
   */
  directory(): Array<{
    peer: string
    peerUrl: string
    healthy: boolean
    skills: AgentSkill[]
    lastCheck?: Date
  }> {
    return Array.from(this.peers.entries()).map(([name, state]) => ({
      peer: name,
      peerUrl: state.peer.url,
      healthy: state.healthy,
      skills: state.agents,
      lastCheck: state.lastCheck,
    }))
  }
}
