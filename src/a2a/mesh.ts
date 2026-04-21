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
  /** Count of back-to-back failed health probes since the last successful one.
   *  Used to suppress transient flaps: the `healthy` flag only flips to false
   *  after N consecutive failures (see UNHEALTHY_AFTER). Reset to 0 on success. */
  consecutiveFailures: number
  /** Last probe error message — surfaced for debugging via /mesh. */
  lastError?: string
}

/** Number of consecutive failed probes required before we mark a peer
 *  unhealthy. A busy remote daemon whose event loop stalls for one probe
 *  cycle (e.g. during a 200K-token tier-2 agent turn) used to flip to
 *  "unreachable" and back on the next tick, which was visible in the
 *  dashboard as a cycling peer. With hysteresis, a single slow probe is
 *  tolerated; only sustained unreachability actually flips the flag. */
const UNHEALTHY_AFTER = 3

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
        consecutiveFailures: 0,
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

  /** Hot-reload the peer set from a fresh config. Adds new peers (kicks off
   *  immediate discovery), removes vanished ones, and rebuilds the A2AClient
   *  for peers whose url or token changed. Health-check interval is honored
   *  on the next tick — we don't reset the timer just for peer-set edits.
   *  Returns the diff for the caller to log. */
  async reloadPeers(next: DaemonConfig): Promise<{ added: string[]; removed: string[]; updated: string[] }> {
    this.config = next
    const oldIds = new Set(this.peers.keys())
    const newPeers = new Map(next.mesh.peers.map((p) => [p.name, p] as const))
    const added: string[] = []
    const removed: string[] = []
    const updated: string[] = []

    // Remove vanished peers.
    for (const id of oldIds) {
      if (!newPeers.has(id)) {
        this.peers.delete(id)
        removed.push(id)
      }
    }

    // Add or update the rest.
    const rediscover: Array<[string, PeerState]> = []
    for (const [id, peer] of newPeers) {
      const existing = this.peers.get(id)
      if (!existing) {
        const state: PeerState = {
          peer,
          client: new A2AClient(peer.url, peer.token),
          healthy: false,
          agents: [],
          consecutiveFailures: 0,
        }
        this.peers.set(id, state)
        added.push(id)
        rediscover.push([id, state])
        continue
      }
      // URL or token changed — rebuild the client and redo discovery.
      if (existing.peer.url !== peer.url || existing.peer.token !== peer.token) {
        existing.peer = peer
        existing.client = new A2AClient(peer.url, peer.token)
        existing.healthy = false
        existing.consecutiveFailures = 0  // fresh client; old counter is stale
        updated.push(id)
        rediscover.push([id, existing])
      } else {
        existing.peer = peer // pick up tag/other metadata edits
      }
    }

    // Immediate discovery for changed/new peers — don't wait for the next
    // interval tick since the whole point of /reload is instant feedback.
    if (rediscover.length) {
      await Promise.allSettled(rediscover.map(([id, state]) => this.discoverPeer(id, state)))
    }

    return { added, removed, updated }
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

      // Success — clear failure counter, flip healthy on if it was off.
      const wasDown = !state.healthy
      state.healthy = true
      state.lastCheck = new Date()
      state.agentCard = card
      state.agents = card.skills || []
      state.consecutiveFailures = 0
      state.lastError = undefined

      // Only log on state transition (healthy→healthy is spammy when the
      // health check interval is 60s). Still log "recovered" transitions
      // so operators see a peer coming back.
      if (wasDown) {
        this.log(`Peer "${name}" recovered: ${card.name} (${state.agents.length} skills)`)
      } else {
        this.log(`Peer "${name}" healthy: ${card.name} (${state.agents.length} skills)`)
      }
    } catch (e: any) {
      state.lastCheck = new Date()
      state.lastError = e.message
      state.consecutiveFailures++
      // Hysteresis: require UNHEALTHY_AFTER consecutive failures before
      // flipping the flag. Prevents transient event-loop stalls on the
      // remote daemon from cycling the peer as seen from the dashboard.
      if (state.consecutiveFailures >= UNHEALTHY_AFTER && state.healthy) {
        state.healthy = false
        this.log(`Peer "${name}" unreachable (${state.consecutiveFailures} consecutive failures): ${e.message}`)
      } else if (state.consecutiveFailures < UNHEALTHY_AFTER) {
        this.log(`Peer "${name}" probe failed (${state.consecutiveFailures}/${UNHEALTHY_AFTER}): ${e.message}`)
      }
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
