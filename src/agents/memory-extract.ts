import type { MemoryStore } from "./memory-store"
import { shouldCaptureEntry } from "@/wiki/capture-filter"
import { containsSecret, trustForChannel } from "./memory-trust"

// --- Haiku-powered memory extraction ---
// Fire-and-forget after each agent response.
// Extracts memorable facts and writes them to the persistent store.

const EXTRACTION_MODEL = "claude-haiku-4-20250514"

const EXTRACTION_PROMPT = `You are a memory extraction system for an AI agent. Given a conversation exchange, extract facts worth remembering for future conversations across different chat sessions.

Extract ONLY facts that would help the agent in FUTURE, DIFFERENT conversations:
- User preferences and instructions ("never do X", "always use Y")
- Commitments the agent made ("I will deploy by Friday")
- Relationships ("Alex is the admin", "Marketing handles content")
- Task state ("GitLab tokens need deploying to peer-server")
- Important facts about infrastructure, config, or processes

SKIP:
- Credentials of any kind: passwords, tokens, API keys, private keys, connection strings. Never repeat one, not even partly. At most note that a credential exists and where it is kept, without its value.
- Routine greetings, acknowledgments, status updates
- Information derivable from code or config files
- Transient conversation flow ("let me check", "here's what I found")
- Facts already obvious from the agent's system prompt

For each fact, output a JSON array:
[{"category":"fact|preference|commitment|task-state","content":"concise fact, 1-2 sentences","keywords":["keyword1","keyword2"]}]

If nothing worth remembering, output: []`

export async function extractMemories(
  agentId: string,
  userMessage: string,
  agentResponse: string,
  source: { channel: string; chatId: string; sender: string },
  store: MemoryStore,
): Promise<void> {
  // Skip very short exchanges (unlikely to contain memorable facts)
  if (userMessage.length < 20 && agentResponse.length < 50) return

  // Same gate as wiki capture: machine channels (cron, a2a, workflow) and
  // prompt-shaped messages hold configuration, not facts about the world.
  const gate = shouldCaptureEntry({
    channel: source.channel,
    content: `User: ${userMessage}`,
    responseLength: agentResponse.length,
  })
  if (!gate.capture) return

  const { createProvider } = await import("@/agent/providers")
  const provider = createProvider("claude")

  const result = await provider.generate(
    [
      { role: "system", content: EXTRACTION_PROMPT },
      {
        role: "user",
        content: `${source.sender} (via ${source.channel}): ${userMessage}\n\nAgent: ${agentResponse}`,
      },
    ],
    { model: EXTRACTION_MODEL, maxTokens: 512 },
  )

  // Parse JSON array from response
  const content = result.content.trim()
  const jsonMatch = content.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return

  const facts = JSON.parse(jsonMatch[0]) as Array<{
    category: string
    content: string
    keywords: string[]
  }>

  if (!Array.isArray(facts) || facts.length === 0) return

  const date = new Date().toISOString().slice(0, 10)
  const trust = trustForChannel(source.channel)

  for (const fact of facts) {
    if (typeof fact?.content !== "string") continue
    // The prompt says never to extract credentials; this holds when the
    // model does it anyway. addMemory refuses them too.
    if (fact.category === "secret" || containsSecret(fact.content)) continue
    // Skip duplicates
    if (store.hasSimilar(agentId, fact.content)) continue

    store.addMemory(agentId, {
      agentId,
      category: fact.category as any,
      content: fact.content,
      keywords: fact.keywords || [],
      source: { ...source, date, trust },
      expiresAt: fact.category === "task-state"
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        : undefined,
    })
  }

  // Prune occasionally (every ~50 calls, probabilistic)
  if (Math.random() < 0.02) {
    store.prune(agentId)
  }
}
