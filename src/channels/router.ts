import type { DaemonConfig } from "@/daemon/config"
import type { AgentRegistry } from "@/agents/registry"
import type { A2AMesh } from "@/a2a/mesh"
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "./types"
import type { TelegramAdapter } from "./telegram"
import type { HookRegistry } from "@/hooks"
import { GroupLog } from "./group-log"
import { BlockStream } from "./block-stream"
import type { ServiceMatcher } from "@/services/matcher"

// --- Message Router ---
// Routes channel messages to agents. Supports:
// - Typing indicator while processing
// - Streaming response edits
// - Seen reaction (👀) on mention
// - Bot-to-bot: if response mentions another agent, route it
// - Correct bot account sends the reply (not always the first one)

const STREAM_EDIT_INTERVAL_MS = 1500
const TYPING_INTERVAL_MS = 4000

export class MessageRouter {
  private registry: AgentRegistry
  private config: DaemonConfig
  private channels: Map<string, ChannelAdapter> = new Map()
  private hooks?: HookRegistry
  private mesh?: A2AMesh
  private serviceMatcher?: ServiceMatcher
  private groupLog: GroupLog
  private log: (...args: unknown[]) => void

  constructor(
    registry: AgentRegistry,
    config: DaemonConfig,
    hooks?: HookRegistry,
    log: (...args: unknown[]) => void = console.error.bind(console, "[router]"),
  ) {
    this.registry = registry
    this.config = config
    this.hooks = hooks
    this.log = log
    this.groupLog = new GroupLog()
  }

  setMesh(mesh: A2AMesh): void {
    this.mesh = mesh
  }

  setServiceMatcher(matcher: ServiceMatcher): void {
    this.serviceMatcher = matcher
  }

  addChannel(adapter: ChannelAdapter): void {
    this.channels.set(adapter.name, adapter)
    adapter.onMessage((msg) => this.handleMessage(adapter, msg))
  }

  /**
   * Send an outbound message to any registered channel.
   * Used for agent-initiated messages, cron notifications, cross-channel routing.
   *
   * If accountId is not provided for Telegram, auto-resolves from agentId binding.
   */
  async sendOutbound(msg: OutgoingMessage & { accountId?: string }): Promise<string | void> {
    const adapter = this.channels.get(msg.channel)
    if (!adapter) {
      throw new Error(`Unknown channel: "${msg.channel}". Available: ${[...this.channels.keys()].join(", ")}`)
    }

    // Auto-resolve Telegram accountId from agentId if not provided
    let accountId = msg.accountId
    if (adapter.name === "telegram" && !accountId && msg.agentId) {
      accountId = this.getAccountForAgent(msg.agentId)
    }

    this.log(`Outbound [${msg.channel}] -> ${msg.chatId}: ${msg.text.slice(0, 80)}`)

    if (adapter.name === "telegram" && accountId) {
      return this.adapterSend(adapter, { ...msg, accountId })
    }

    return adapter.send(msg)
  }

  /** List registered channel names. */
  getChannelNames(): string[] {
    return [...this.channels.keys()]
  }

  async startAll(): Promise<void> {
    for (const [name, adapter] of this.channels) {
      this.log(`Starting channel: ${name}`)
      await adapter.start()
    }
  }

  async stopAll(): Promise<void> {
    for (const [name, adapter] of this.channels) {
      this.log(`Stopping channel: ${name}`)
      await adapter.stop()
    }
  }

  private async handleMessage(
    adapter: ChannelAdapter,
    msg: IncomingMessage,
  ): Promise<void> {
    // Pre-hook
    if (this.hooks?.has("pre:channel-message" as any)) {
      const hookResult = await this.hooks.execute("pre:channel-message" as any, {
        event: "pre:channel-message" as any,
        channel: msg.channel,
        sender: msg.sender.name,
        text: msg.text,
        group: msg.group?.name,
      })

      if (hookResult.blocked) {
        this.log(`Message blocked by hook: ${hookResult.message}`)
        return
      }

      if (hookResult.modified?.text) {
        msg = { ...msg, text: hookResult.modified.text as string }
      }
    }

    // Log ALL group messages for conversation context (before agent resolution)
    if (msg.group) {
      const chatId = msg.group.id
      this.groupLog.add(chatId, msg.sender.name, msg.text)
    }

    // Check if message matches a defined service (before agent routing)
    if (this.serviceMatcher) {
      const chatId = msg.group?.id || msg.sender.id
      const matched = this.serviceMatcher.match(msg.text, msg.sender.id, msg.channel)
      if (matched) {
        this.log(`Service matched: "${matched.service.name}" for ${msg.sender.name} (trigger: ${matched.trigger})`)
        const replyAccountId = msg.accountId
        this.adapterReact(adapter, chatId, msg.id, "👀", replyAccountId)
        const typingTimer = this.startTypingLoop(adapter, chatId, replyAccountId)

        await this.serviceMatcher.execute(
          matched.service,
          this.registry,
          { channel: msg.channel, sender: msg.sender.name, chatId },
          async (text) => {
            clearInterval(typingTimer)
            await this.adapterSend(adapter, {
              channel: msg.channel, chatId, text, replyTo: msg.id, accountId: replyAccountId,
            })
          },
        )
        return
      }
    }

    // Resolve agent — check local first, then mesh peers
    const agentId = this.resolveAgent(msg)

    if (!agentId) {
      return
    }

    // Dedup: in groups, multiple bot accounts receive the same message.
    // Only the account BOUND to this agent should handle it.
    if (msg.group && msg.channel === "telegram") {
      const boundAccount = this.getAccountForAgent(agentId)
      if (boundAccount && boundAccount !== msg.accountId) {
        return
      }
    }

    const chatId = msg.group?.id || msg.sender.id
    const agentDef = this.registry.getAgent(agentId)
    const agentName = agentDef?.name || agentId

    // Determine which bot account should send the response
    const replyAccountId = this.getAccountForAgent(agentId) || msg.accountId

    this.log(
      `Routing [${msg.channel}/${msg.sender.name}] -> "${agentName}": ${msg.text.slice(0, 80)}`,
    )

    // React with 👀 to acknowledge
    this.adapterReact(adapter, chatId, msg.id, "👀", replyAccountId)

    // Start typing indicator loop (from the correct bot)
    const typingTimer = this.startTypingLoop(adapter, chatId, replyAccountId)

    // Streaming setup with smart block streaming
    const canStream = typeof adapter.editMessage === "function"
    let sentMessageId: string | undefined
    let fullStreamText = ""

    // Smart block streamer handles chunking, code fence protection, and pacing
    const blockStream = canStream
      ? new BlockStream(
          async (block: string) => {
            fullStreamText += block
            if (!sentMessageId) {
              const preview = fullStreamText.length > 20
                ? fullStreamText
                : `_${agentName} is writing..._\n\n${fullStreamText}`
              try {
                sentMessageId = await this.adapterSend(adapter, {
                  channel: msg.channel,
                  chatId,
                  text: preview,
                  replyTo: msg.id,
                  accountId: replyAccountId,
                })
              } catch { /* retry next block */ }
            } else {
              try {
                await this.adapterEdit(adapter, chatId, sentMessageId, fullStreamText, undefined, replyAccountId)
              } catch { /* retry next block */ }
            }
          },
          undefined,
          msg.channel,
        )
      : undefined

    const onDelta = blockStream
      ? (_delta: string, _fullText: string) => {
          blockStream.push(_delta)
        }
      : undefined

    // Enrich channelMeta agents with handles from config
    if (msg.channelMeta?.agents) {
      for (const agent of msg.channelMeta.agents) {
        if (!agent.handle) {
          const def = this.registry.getAgent(agent.id)
          if (def) {
            agent.handle = def.mentions.find((m: string) => m.startsWith("@"))
            agent.name = def.name
          }
        }
      }
    }

    // Build group conversation context (recent messages from the group)
    const groupContext = msg.group ? this.groupLog.buildContext(chatId) : ""
    const messageWithContext = groupContext
      ? `${groupContext}\n\n${msg.sender.name}: ${msg.text}`
      : msg.text

    // Execute agent task
    const response = await this.registry.execute(
      {
        message: messageWithContext,
        agentId,
        context: {
          channel: msg.channel,
          sender: msg.sender.name,
          senderId: msg.sender.id,
          senderUsername: msg.sender.username,
          group: msg.group?.name,
          chatId,  // stable ID for session keying (issue path for GitLab, group ID for Telegram)
          mediaPath: msg.media?.path,
          mediaType: msg.media?.type,
          replyToText: msg.replyToText,
          channelMeta: msg.channelMeta,
        },
      },
      onDelta,
    )

    clearInterval(typingTimer)

    // Flush any remaining streamed content
    blockStream?.flush()

    if (response.error) {
      // Queued messages are not errors — the message will be processed later
      if (response.error.startsWith("__queued__")) {
        clearInterval(typingTimer)
        this.log(`Message queued for ${agentName}`)
        return
      }

      this.log(`Agent error: ${response.error}`)
      const errorText = `Error: ${response.error}`
      if (sentMessageId) {
        await this.adapterEdit(adapter, chatId, sentMessageId, errorText, "plain", replyAccountId)
      } else {
        await this.adapterSend(adapter, {
          channel: msg.channel,
          chatId,
          text: errorText,
          replyTo: msg.id,
          parseMode: "plain",
          accountId: replyAccountId,
        })
      }
      return
    }

    // Post-hook
    let responseText = response.content
    if (this.hooks?.has("post:channel-message" as any)) {
      const hookResult = await this.hooks.execute("post:channel-message" as any, {
        event: "post:channel-message" as any,
        channel: msg.channel,
        sender: msg.sender.name,
        response: responseText,
        agentId,
      })

      if (hookResult.blocked) {
        this.log(`Response blocked by hook: ${hookResult.message}`)
        return
      }

      if (hookResult.modified?.response) {
        responseText = hookResult.modified.response as string
      }
    }

    // Prefix response with agent identity on shared-identity channels.
    // GitLab: when no per-agent token (all share one user)
    // WhatsApp: always (single phone number, all agents share it)
    if (msg.channel === "gitlab" && responseText) {
      const gitlabAdapter = this.channels.get("gitlab") as any
      const hasOwnToken = gitlabAdapter?.getAgentToken?.(agentId)
      if (!hasOwnToken) {
        responseText = `> **${agentName}** (${agentId})\n\n${responseText}`
      }
    }
    if (msg.channel === "whatsapp" && responseText) {
      responseText = `*${agentName}*\n\n${responseText}`
    }

    // Final message
    let sentResponseId: string | undefined
    if (responseText) {
      if (sentMessageId) {
        await this.adapterEdit(adapter, chatId, sentMessageId, responseText, undefined, replyAccountId)
        sentResponseId = sentMessageId
      } else {
        sentResponseId = await this.adapterSend(adapter, {
          channel: msg.channel,
          chatId,
          text: responseText,
          replyTo: msg.id,
          accountId: replyAccountId,
          agentId,
        })
      }
    }

    // Log bot response in group conversation
    if (msg.group && responseText) {
      this.groupLog.add(chatId, agentName, responseText)
    }

    // Bot-to-bot delegation: if response mentions another agent, route to them.
    // Works on Telegram, WhatsApp, and Discord. Not GitLab (uses its own @mention webhook flow).
    const delegationChannels = ["telegram", "whatsapp", "discord"]
    if (responseText && sentResponseId && delegationChannels.includes(msg.channel)) {
      this.handleBotToBotChain(adapter, msg, agentId, responseText, sentResponseId, 0).catch((e) => {
        this.log(`Bot-to-bot error: ${e.message}`)
      })
    }
  }

  private static readonly MAX_BOT_CHAIN_DEPTH = 3

  /**
   * Bot-to-bot conversation chain.
   * Guards:
   * 1. Max depth (default 3)
   * 2. No agent called twice in the same chain (prevents A→B→A→B loops)
   * Works on Telegram (multi-account), WhatsApp (shared number), Discord.
   */
  private async handleBotToBotChain(
    adapter: ChannelAdapter,
    originalMsg: IncomingMessage,
    sourceAgentId: string,
    responseText: string,
    responseMessageId: string,
    depth: number,
    visited: Set<string> = new Set(),
  ): Promise<void> {
    if (depth >= MessageRouter.MAX_BOT_CHAIN_DEPTH) {
      this.log(`Bot-to-bot: max depth (${depth}) reached, stopping`)
      return
    }

    // Track who's been in this chain
    visited.add(sourceAgentId)

    for (const [id, def] of Object.entries(this.config.agents)) {
      if (id === sourceAgentId) continue

      // Stop if this agent was already in the chain (prevents A→B→A loop)
      if (visited.has(id)) {
        this.log(`Bot-to-bot: "${id}" already participated, stopping chain`)
        continue
      }

      // Only trigger bot-to-bot on explicit @-handle mentions (e.g. @my_bot),
      // not bare keywords which appear in normal conversation text.
      const atMentions = def.mentions.filter((m: string) => m.startsWith("@"))
      const mentioned = atMentions.some((m: string) =>
        responseText.toLowerCase().includes(m.toLowerCase()),
      )
      if (!mentioned) continue

      this.log(`Bot-to-bot [${depth + 1}]: "${sourceAgentId}" -> "${id}"`)

      const chatId = originalMsg.group?.id || originalMsg.sender.id
      const targetAccountId = this.getAccountForAgent(id)
      const sourceAccountId = this.getAccountForAgent(sourceAgentId)

      try {
        // Target bot reacts 👀 to the source bot's message
        this.adapterReact(adapter, chatId, responseMessageId, "👀", targetAccountId)

        // Target bot shows typing
        const typingTimer = this.startTypingLoop(adapter, chatId, targetAccountId)

        // Include original user message as context so target bot knows the full picture
        const contextMessage = depth === 0
          ? `[Original from ${originalMsg.sender.name}]: ${originalMsg.text}\n\n[${sourceAgentId} said]: ${responseText}`
          : responseText

        const response = await this.registry.execute({
          message: contextMessage,
          agentId: id,
          context: {
            channel: originalMsg.channel,
            sender: `agent:${sourceAgentId}`,
            group: originalMsg.group?.name,
          },
        })

        clearInterval(typingTimer)

        if (response.content && !response.error) {
          // Prefix with agent identity on shared-number channels
          let replyText = response.content
          if (originalMsg.channel === "whatsapp") {
            replyText = `*${def.name}*\n\n${replyText}`
          }

          const sentId = await this.adapterSend(adapter, {
            channel: originalMsg.channel,
            chatId,
            text: replyText,
            accountId: targetAccountId,
          })

          // Chain: check if this response also mentions another agent
          if (sentId && response.content) {
            await this.handleBotToBotChain(
              adapter, originalMsg, id, response.content, sentId as string, depth + 1, visited,
            )
          }
        } else if (response.error) {
          this.log(`Bot-to-bot "${id}" error: ${response.error}`)
        }
      } catch (e: any) {
        this.log(`Bot-to-bot "${id}" failed: ${e.message}`)
      }

      break // Route to first mentioned agent per level
    }
  }

  // --- Adapter helpers that pass accountId for Telegram ---

  private async adapterSend(
    adapter: ChannelAdapter,
    msg: { channel: string; chatId: string; text: string; replyTo?: string; parseMode?: string; accountId?: string; agentId?: string },
  ): Promise<string> {
    // For Telegram, pass accountId so the correct bot sends the message
    if (adapter.name === "telegram" && msg.accountId) {
      return (adapter as unknown as TelegramAdapter).send({
        ...msg,
        parseMode: msg.parseMode as any,
        accountId: msg.accountId,
      }) as Promise<string>
    }
    return (adapter.send(msg as any) || "") as Promise<string>
  }

  private async adapterEdit(
    adapter: ChannelAdapter,
    chatId: string,
    messageId: string,
    text: string,
    parseMode?: string,
    accountId?: string,
  ): Promise<boolean> {
    if (adapter.name === "telegram" && accountId) {
      return (adapter as unknown as TelegramAdapter).editMessage(chatId, messageId, text, parseMode, accountId)
    }
    return adapter.editMessage?.(chatId, messageId, text, parseMode) ?? false
  }

  private adapterReact(
    adapter: ChannelAdapter,
    chatId: string,
    messageId: string,
    emoji: string,
    accountId?: string,
  ): void {
    if (adapter.name === "telegram" && accountId) {
      (adapter as unknown as TelegramAdapter).react(chatId, messageId, emoji, accountId)
    } else {
      adapter.react?.(chatId, messageId, emoji)
    }
  }

  private startTypingLoop(
    adapter: ChannelAdapter,
    chatId: string,
    accountId?: string,
  ): ReturnType<typeof setInterval> {
    const sendTyping = () => {
      if (adapter.name === "telegram" && accountId) {
        (adapter as unknown as TelegramAdapter).sendTyping(chatId, accountId)
      } else {
        adapter.sendTyping?.(chatId)
      }
    }

    sendTyping()
    return setInterval(sendTyping, TYPING_INTERVAL_MS)
  }

  // --- Agent resolution ---

  /**
   * Handle a message by routing to a mesh peer's agent.
   * Searches peer agent cards for mention matches.
   */
  private async handleViaMesh(
    adapter: ChannelAdapter,
    msg: IncomingMessage,
  ): Promise<boolean> {
    if (!this.mesh) return false

    const textLower = msg.text.toLowerCase()
    const directory = this.mesh.directory()

    for (const peer of directory) {
      if (!peer.healthy) continue

      for (const skill of peer.skills) {
        // Check if the message mentions this remote agent by name or ID
        if (
          textLower.includes(skill.id.toLowerCase()) ||
          textLower.includes(skill.name.toLowerCase())
        ) {
          this.log(`Mesh routing [${msg.channel}/${msg.sender.name}] -> peer "${peer.peer}" agent "${skill.id}"`)

          const chatId = msg.group?.id || msg.sender.id
          const replyAccountId = msg.accountId

          // React + typing
          this.adapterReact(adapter, chatId, msg.id, "👀", replyAccountId)
          const typingTimer = this.startTypingLoop(adapter, chatId, replyAccountId)

          try {
            const response = await this.mesh.sendTask(peer.peer, msg.text, skill.id)

            clearInterval(typingTimer)

            if (response) {
              // Prefix with remote agent name so user knows who's responding
              const header = `**${skill.name}** _(${peer.peer})_:\n\n`
              await this.adapterSend(adapter, {
                channel: msg.channel,
                chatId,
                text: header + response,
                replyTo: msg.id,
                accountId: replyAccountId,
              })
            }

            return true
          } catch (e: any) {
            clearInterval(typingTimer)
            this.log(`Mesh routing error: ${e.message}`)

            await this.adapterSend(adapter, {
              channel: msg.channel,
              chatId,
              text: `Error from ${peer.peer}/${skill.name}: ${e.message}`,
              replyTo: msg.id,
              parseMode: "plain",
              accountId: replyAccountId,
            })
            return true
          }
        }
      }
    }

    return false
  }

  private getAccountForAgent(agentId: string): string | undefined {
    for (const [accountId, account] of Object.entries(this.config.channels.telegram.accounts)) {
      if (account.agentBinding === agentId) {
        return accountId
      }
    }
    return undefined
  }

  private resolveAgent(msg: IncomingMessage): string | undefined {
    // For GitLab: the adapter resolves agents deterministically via agentMappings
    // (GitLab @username -> agentId). Don't use registry.findByMention() here
    // because that matches Telegram handles, not GitLab usernames.
    if (msg.channel === "gitlab") {
      if (msg.resolvedAgent) {
        this.log(`GitLab agent resolved by adapter: ${msg.resolvedAgent}`)
        return msg.resolvedAgent
      }
      return undefined
    }

    // Pre-resolved by channel adapter (WhatsApp route-based, etc.)
    if (msg.resolvedAgent) {
      return msg.resolvedAgent
    }

    // DM: route to the account's bound agent
    if (!msg.group) {
      if (msg.channel === "telegram") {
        const account = this.config.channels.telegram.accounts[msg.accountId]
        return account?.agentBinding
      }
      if (msg.channel === "whatsapp") {
        return this.config.channels.whatsapp.defaultAgent
      }
      return undefined
    }

    // Group: check policy
    if (msg.channel === "telegram") {
      const policy = this.config.channels.telegram.policy
      if (policy.group === "mention-required") {
        const agentId = this.registry.findByMention(msg.text)
        if (!agentId) return undefined
        return agentId
      }
    }

    // Default: mention matching, then account binding
    const mentionAgent = this.registry.findByMention(msg.text)
    if (mentionAgent) return mentionAgent

    if (msg.channel === "telegram") {
      const account = this.config.channels.telegram.accounts[msg.accountId]
      return account?.agentBinding
    }

    return this.config.channels.whatsapp.defaultAgent
  }
}
