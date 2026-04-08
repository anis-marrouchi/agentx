import type { DaemonConfig } from "@/daemon/config"
import type { AgentRegistry } from "@/agents/registry"
import type { A2AMesh } from "@/a2a/mesh"
import type { ChannelAdapter, IncomingMessage } from "./types"
import type { TelegramAdapter } from "./telegram"
import type { HookRegistry } from "@/hooks"
import { GroupLog } from "./group-log"

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

  addChannel(adapter: ChannelAdapter): void {
    this.channels.set(adapter.name, adapter)
    adapter.onMessage((msg) => this.handleMessage(adapter, msg))
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

    // Streaming setup
    const canStream = typeof adapter.editMessage === "function"
    let sentMessageId: string | undefined
    let lastEditTime = 0

    const onDelta = canStream
      ? async (_delta: string, fullText: string) => {
          const now = Date.now()
          if (now - lastEditTime < STREAM_EDIT_INTERVAL_MS) return

          if (!sentMessageId) {
            const preview = fullText.length > 20
              ? fullText
              : `_${agentName} is writing..._\n\n${fullText}`
            try {
              sentMessageId = await this.adapterSend(adapter, {
                channel: msg.channel,
                chatId,
                text: preview,
                replyTo: msg.id,
                accountId: replyAccountId,
              })
              lastEditTime = now
            } catch { /* retry next delta */ }
          } else {
            try {
              await this.adapterEdit(adapter, chatId, sentMessageId, fullText, undefined, replyAccountId)
              lastEditTime = now
            } catch { /* retry next delta */ }
          }
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
          group: msg.group?.name,
          mediaPath: msg.media?.path,
          mediaType: msg.media?.type,
          replyToText: msg.replyToText,
          channelMeta: msg.channelMeta,
        },
      },
      onDelta,
    )

    clearInterval(typingTimer)

    if (response.error) {
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
        })
      }
    }

    // Log bot response in group conversation
    if (msg.group && responseText) {
      this.groupLog.add(chatId, agentName, responseText)
    }

    // Bot-to-bot: only for Telegram (not GitLab/WhatsApp/Discord — would cause loops)
    if (responseText && sentResponseId && msg.channel === "telegram") {
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
   * 3. Only on channels that support it (Telegram)
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
          const sentId = await this.adapterSend(adapter, {
            channel: originalMsg.channel,
            chatId,
            text: response.content,
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
    msg: { channel: string; chatId: string; text: string; replyTo?: string; parseMode?: string; accountId?: string },
  ): Promise<string> {
    // For Telegram, pass accountId so the correct bot sends the message
    if (adapter.name === "telegram" && msg.accountId) {
      return (adapter as TelegramAdapter).send({
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
      return (adapter as TelegramAdapter).editMessage(chatId, messageId, text, parseMode, accountId)
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
      (adapter as TelegramAdapter).react(chatId, messageId, emoji, accountId)
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
        (adapter as TelegramAdapter).sendTyping(chatId, accountId)
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
