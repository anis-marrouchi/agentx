import { listInbox, requestStoreFor, type InboxContext, type InboxItem } from "@/approvals/inbox"
import { ownerCards, type DeskCard, type DeskInboxItem, type DeskRequest } from "./board"

// --- The owner's one list (#1138 step C) ---
//
// The Approvals inbox and the Desk were two lists with two counts: the
// inbox left out the requests whose agent asked the owner a question, the
// Desk left out what the owner put off, and the digest counted the put-off
// ones as waiting. This is the one list, read in one place:
//
//   items   what waits on the owner on this node, in the Desk's card shape
//           (desk/board.ts ownerCards): every pending inbox item, then the
//           requests waiting on the owner that have no card of their own
//   count   items.length: the number every surface shows
//   later   what the owner put off: still waiting, not in items or count
//
// Read by the dashboard's Approvals page (/api/admin/approvals `desk`),
// the phone app's Desk tab (/api/app/desk, the "yours" column), the daily
// digest (approvals/sweep.ts) and the Desk routing (desk/route.ts). A
// read model, like the inbox: nothing here writes.

export interface OwnerList {
  count: number
  later: number
  /** The oldest item's ask time. */
  oldest?: string
  items: DeskCard[]
  /** Sources that could not be read, so a short list is not taken for an empty one. */
  errors: string[]
}

/** An inbox item as a node reports it to the Desk. */
export function inboxToDesk(i: InboxItem): DeskInboxItem {
  return {
    key: i.key,
    title: i.title,
    ask: i.ask,
    recommend: i.recommend,
    yes: i.yes,
    no: i.no,
    raisedBy: i.raised_by,
    expires: i.expires,
    ...(i.if_silent ? { ifSilent: i.if_silent } : {}),
    ...(i.choices ? { choices: i.choices } : {}),
    ...(i.draft ? { draft: i.draft } : {}),
    ...(i.detail ? { detail: i.detail } : {}),
    ...(i.created_at ? { createdAt: i.created_at } : {}),
  }
}

/** The list over cards already built: one count, the oldest, and what was put off. */
export function ownerList(items: DeskCard[], later: number, errors: string[]): OwnerList {
  const times = items.map((c) => c.askedAt).filter((s): s is string => !!s && !!Date.parse(s)).sort((a, b) => Date.parse(a) - Date.parse(b))
  return { count: items.length, later, ...(times[0] ? { oldest: times[0] } : {}), items, errors }
}

/** This node's list, read from its sources now. `node` is how this node
 *  is named on the cards (its URL, as the phone app posts answers back). */
export function readOwnerList(ctx: InboxContext, node: { url: string; name: string }): OwnerList {
  const now = ctx.now ?? Date.now()
  const errors: string[] = []
  // Put-off items are read too: they are counted as "later", never lost.
  const listing = listInbox(ctx, { includeSnoozed: true })
  for (const e of listing.errors) errors.push(`What waits (${e.kind}) could not be read: ${e.error}`)
  const shown = listing.items.filter((i) => !i.snoozed_until)
  const deferred = new Set(listing.items.filter((i) => i.snoozed_until).map((i) => i.key))

  let requests: DeskRequest[] | null = null
  try {
    const store = requestStoreFor(ctx)
    if (store) requests = store.listByState("waiting_owner").map((record) => ({ record, links: store.links(record.id) }))
  } catch (e: any) { errors.push(`Requests could not be read: ${e?.message ?? e}`) }

  const { cards, errors: more } = ownerCards({
    now,
    node: node.url,
    nodeName: node.name,
    inbox: [{ node: node.url, nodeName: node.name, items: shown.map(inboxToDesk) }],
    requests,
    deferred,
  })
  return ownerList(cards, deferred.size, [...errors, ...more])
}
