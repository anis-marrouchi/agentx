import type { AgentRegistry } from "@/agents/registry"
import { debug } from "@/observability/debug"

// --- Service Matcher: pattern-based interception for automated services ---
//
// Sits before agent routing in the message flow. If an incoming message
// matches a defined service trigger, the service prompt is executed
// instead of routing to the default agent.
//
// Use case: predictable client requests ("send me the monthly report")
// that don't need the full LLM reasoning — just execute a known prompt.

export interface ServiceTrigger {
  pattern: string
  channel?: string  // limit to specific channel (e.g. "whatsapp")
}

export interface ServiceNotify {
  channel: string
  chatId: string
  accountId?: string
}

export interface ServiceDef {
  id: string
  name: string
  triggers: ServiceTrigger[]
  allowedContacts?: string[]
  agent: string
  prompt: string
  schedule?: string
  timezone?: string
  notify?: ServiceNotify
}

interface CompiledService {
  def: ServiceDef
  patterns: Array<{ regex: RegExp; channel?: string }>
}

export interface ServiceMatch {
  service: ServiceDef
  trigger: string   // which pattern matched
  captured: string  // what text matched
}

export class ServiceMatcher {
  private services: CompiledService[] = []
  private log: (...args: unknown[]) => void

  constructor(
    serviceDefs: Record<string, Omit<ServiceDef, "id">>,
    log: (...args: unknown[]) => void = console.error.bind(console, "[services]"),
  ) {
    this.log = log

    for (const [id, def] of Object.entries(serviceDefs)) {
      const compiled: CompiledService = {
        def: { ...def, id },
        patterns: [],
      }

      for (const trigger of def.triggers) {
        try {
          compiled.patterns.push({
            regex: new RegExp(trigger.pattern, "i"),
            channel: trigger.channel,
          })
        } catch (e: any) {
          this.log(`Invalid regex in service "${id}": ${trigger.pattern} — ${e.message}`)
        }
      }

      if (compiled.patterns.length > 0) {
        this.services.push(compiled)
      }
    }

    this.log(`${this.services.length} service(s) loaded`)
  }

  /**
   * Match an incoming message against all service triggers.
   * Returns the first matching service or null.
   */
  match(text: string, senderId: string, channel: string): ServiceMatch | null {
    for (const svc of this.services) {
      // Check contact allowlist (if set)
      if (svc.def.allowedContacts?.length) {
        const senderNorm = senderId.replace(/[^0-9]/g, "")
        const allowed = svc.def.allowedContacts.some(c => {
          const contactNorm = c.replace(/[^0-9]/g, "")
          return senderNorm.includes(contactNorm) || contactNorm.includes(senderNorm)
        })
        if (!allowed) continue
      }

      // Check triggers
      for (const pattern of svc.patterns) {
        // Channel filter
        if (pattern.channel && pattern.channel !== channel) continue

        const match = text.match(pattern.regex)
        if (match) {
          debug.cat("agent", `Service match: "${svc.def.name}" (trigger: ${pattern.regex.source})`)
          return {
            service: svc.def,
            trigger: pattern.regex.source,
            captured: match[0],
          }
        }
      }
    }

    return null
  }

  /**
   * Execute a matched service.
   * Sends the service's predefined prompt to the agent, returns the response.
   */
  async execute(
    service: ServiceDef,
    registry: AgentRegistry,
    context: { channel: string; sender: string; chatId: string },
    replyFn: (text: string) => Promise<void>,
  ): Promise<void> {
    this.log(`Executing service "${service.name}" -> agent "${service.agent}"`)

    try {
      const response = await registry.execute({
        message: service.prompt,
        agentId: service.agent,
        context: {
          channel: context.channel,
          sender: context.sender,
          chatId: `service:${service.id}:${context.chatId}`,
        },
      })

      if (response.error) {
        this.log(`Service "${service.name}" failed: ${response.error}`)
        await replyFn(`Service "${service.name}" encountered an error: ${response.error}`)
        return
      }

      // Reply on the same channel
      if (response.content) {
        await replyFn(response.content)
      }

      this.log(`Service "${service.name}" completed in ${response.duration}ms`)
    } catch (e: any) {
      this.log(`Service "${service.name}" threw: ${e.message}`)
      await replyFn(`Service error: ${e.message}`)
    }
  }

  /**
   * Get all services that have a schedule (for cron registration).
   */
  getScheduledServices(): ServiceDef[] {
    return this.services
      .filter(s => s.def.schedule)
      .map(s => s.def)
  }

  /**
   * List all registered services.
   */
  list(): Array<{ id: string; name: string; triggers: number; agent: string; scheduled: boolean }> {
    return this.services.map(s => ({
      id: s.def.id,
      name: s.def.name,
      triggers: s.patterns.length,
      agent: s.def.agent,
      scheduled: !!s.def.schedule,
    }))
  }
}
