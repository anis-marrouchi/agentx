import type { Direction, Rhythm } from "./model"
import { parseNumberInput } from "./input"
import type { NumberStore } from "./store"

// --- Sample sets of numbers to start from (#1826, N3) ---
//
// `agentx numbers template <name>` adds one set, recorded by hand, with
// the owner given. Numbers that already exist are left as they are, so
// running it twice changes nothing. Edit or archive each one afterwards
// like any other number.

export interface TemplateNumber {
  id: string
  name: string
  unit: string
  target?: number
  direction?: Direction
  rhythm: Rhythm
  tags: string[]
}

export interface NumberTemplate {
  name: string
  description: string
  numbers: TemplateNumber[]
}

export const NUMBER_TEMPLATES: Record<string, NumberTemplate> = {
  "client-journey": {
    name: "Client journey",
    description: "Each step a client takes, from first contact to a paid order, so you see where people drop off.",
    numbers: [
      { id: "journey-enquiries", name: "New enquiries", unit: "clients", rhythm: "weekly", tags: ["journey:client", "step:1-enquiry"] },
      { id: "journey-calls", name: "First calls held", unit: "clients", rhythm: "weekly", tags: ["journey:client", "step:2-call"] },
      { id: "journey-proposals", name: "Proposals sent", unit: "clients", rhythm: "weekly", tags: ["journey:client", "step:3-proposal"] },
      { id: "journey-signed", name: "Clients signed", unit: "clients", rhythm: "weekly", tags: ["journey:client", "step:4-signed"] },
      { id: "journey-reply-hours", name: "Hours to answer an enquiry", unit: "h", target: 24, direction: "down", rhythm: "weekly", tags: ["journey:client"] },
    ],
  },
  "content-distribution": {
    name: "Content distribution",
    description: "How far what you publish travels, per channel.",
    numbers: [
      { id: "content-posts", name: "Posts published", unit: "posts", target: 3, rhythm: "weekly", tags: ["content:distribution"] },
      { id: "content-video-views", name: "Video views", unit: "views", rhythm: "weekly", tags: ["content:distribution", "channel:video"] },
      { id: "content-social-reach", name: "Social reach", unit: "people", rhythm: "weekly", tags: ["content:distribution", "channel:social"] },
      { id: "content-newsletter-opens", name: "Newsletter opens", unit: "%", rhythm: "weekly", tags: ["content:distribution", "channel:newsletter"] },
      { id: "content-site-visits", name: "Visits from content", unit: "visits", rhythm: "weekly", tags: ["content:distribution", "channel:site"] },
    ],
  },
}

/** Add a template's numbers, owned by `owner` (or no one). Ids already
 *  taken are left as they are, archived ones too. */
export function installTemplate(store: NumberStore, name: string, owner: string | null, now: number): { added: string[]; kept: string[] } | { error: string } {
  const t = NUMBER_TEMPLATES[name]
  if (!t) return { error: `no template "${name}": use ${Object.keys(NUMBER_TEMPLATES).join(" or ")}` }
  const added: string[] = []
  const kept: string[] = []
  for (const n of t.numbers) {
    if (store.get(n.id)) { kept.push(n.id); continue }
    const input = parseNumberInput({ ...n, owner: owner ?? undefined }, "cli")
    if ("error" in input) return { error: `${n.id}: ${input.error}` }
    store.upsert(input, now)
    added.push(n.id)
  }
  return { added, kept }
}
