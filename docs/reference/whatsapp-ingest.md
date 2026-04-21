# WhatsApp as a data source

AgentX's WhatsApp channel is, by default, a messaging surface — incoming messages route to agents, agent replies flow back. Agent conversations get raw-captured into the wiki like any other channel. **WhatsApp ingest** extends that path so the WhatsApp side itself — contact profiles, group rosters, and optionally bounded message windows — becomes a first-class **data source** the wiki absorbs into typed articles (people, projects, events, decisions).

Source: [`src/wiki/ingest-whatsapp.ts`](https://github.com/anis-marrouchi/agentx/blob/master/src/wiki/ingest-whatsapp.ts) (pure transforms + sweep) and the read API on [`src/channels/whatsapp.ts`](https://github.com/anis-marrouchi/agentx/blob/master/src/channels/whatsapp.ts). No `@whiskeysockets/baileys` imports leak out of the adapter.

## TL;DR

- **Default is off.** `channels.whatsapp.ingest.enabled = false` and empty allowlists mean nothing is ingested.
- **Metadata only by default.** Contact name/phone/status, group roster/description — no message content unless you opt in per chat (`mode: "messages"`).
- **Operator-driven for now.** Phase 1 ships only with CLI commands; no automatic periodic sweep. Scheduled cron is planned for phase 2 once the pull path is proven.
- **Entries land in the wiki as `source: whatsapp:*` raw entries.** The existing `agentx wiki absorb` pipeline (unchanged) promotes them into typed articles using the Farzapedia-style prompt.

## Why this exists

Agent-routed conversations are already absorbed. Everything else WhatsApp knows is invisible — the contact profiles on the linked device, group members the agent never speaks with, chats that predate the agent. The ingestor closes that gap without touching the absorb pipeline.

## Architecture

```
┌─────────────────────────────────────────┐
│  CLI: agentx whatsapp …                 │  src/commands/whatsapp.ts
└────────────┬────────────────────────────┘
             │  HTTP
┌────────────▼────────────────────────────┐
│  Daemon endpoints                       │  src/daemon/index.ts
│   GET  /whatsapp/chats                  │
│   GET  /whatsapp/contacts               │
│   POST /whatsapp/ingest                 │
└────────────┬────────────────────────────┘
             │
┌────────────▼────────────────────────────┐
│  Ingestor (pure transform + sweep)      │  src/wiki/ingest-whatsapp.ts
└────────────┬────────────────────────────┘
             │  read-only
┌────────────▼────────────────────────────┐
│  Read API on WhatsAppAdapter            │  src/channels/whatsapp.ts
│   • listChats / listContacts / …        │
│   • cache-first, throttled live fallback│
│   • passive cache from Baileys events   │  src/channels/whatsapp-cache.ts
└─────────────────────────────────────────┘
```

The passive cache (`src/channels/whatsapp-cache.ts`) hydrates from Baileys events that were previously ignored (`contacts.update`, `contacts.upsert`, `chats.upsert`, `chats.update`, `groups.update`, plus the chat/contact arrays inside `messaging-history.set`). Message bodies are **not** cached — they're pulled on demand by the ingestor when a chat opts into `mode: "messages"`.

Live Baileys reads go through a token-bucket throttle (`minMsBetweenCalls` + `maxCallsPerMinute`) to stay clear of personal-account rate limits.

## Config

All settings live under `channels.whatsapp.ingest` in `agentx.json`:

```json
{
  "channels": {
    "whatsapp": {
      "enabled": true,
      "sessionDir": ".agentx/whatsapp-sessions",
      "defaultAgent": "devops-agent",
      "ingest": {
        "enabled": true,
        "mode": "metadata-only",
        "allowContacts": ["+21624XXXXXXX"],
        "allowGroups": ["120363000000000001@g.us"],
        "denyContacts": [],
        "denyGroups": [],
        "messageCap": 50,
        "historyDays": 30,
        "contactRefreshDays": 7,
        "throttle": {
          "minMsBetweenCalls": 1500,
          "maxCallsPerMinute": 20,
          "maxChatsPerSweep": 25
        },
        "retentionDays": 0
      }
    }
  }
}
```

See [Config schema → `channels.whatsapp.ingest`](/reference/config-schema#channelswhatsappingest) for the field-by-field reference.

### Scope resolution

1. `enabled: false` → nothing is ingested (master switch).
2. `denyContacts` / `denyGroups` match wins over allow (drop).
3. Empty allowlist + `enabled: true` → ingest nothing. **Defensive default** so turning the feature on without scoping isn't catastrophic.
4. Phone / JID matching is substring-based (same semantics as the existing `allowFrom` at `src/channels/whatsapp.ts:307-313`). `+`-prefixes are normalized.

## Entry shapes

Each WhatsApp primitive becomes one raw wiki entry via `WikiStore.addEntry`:

| Primitive | `source` | Stable ID | Content |
|---|---|---|---|
| Contact profile | `whatsapp:contact` | `wa-contact-<jidHash>-<yyyymmdd>` | Name, phone, push name, status — **no messages** |
| Group metadata | `whatsapp:group-meta` | `wa-group-meta-<jidHash>-<yyyymmdd>` | Subject, description, up to 50 members (with "…and N more" summary) |
| DM window (opt-in) | `whatsapp:dm` | `wa-dm-<jidHash>-<yyyymmdd>-<lastMsgId>` | Header + bounded message log (default 50 newest) |
| Group messages (opt-in) | `whatsapp:group` | `wa-group-<jidHash>-<yyyymmdd>-<lastMsgId>` | Group header + bounded window |

IDs are stable by design: re-running an ingest on unchanged data produces the same filename, so repeated sweeps are near-free (filesystem = database, no sidecar dedup store). New messages → new `lastMsgId` → new entry → `agentx wiki absorb` picks it up.

## CLI

All commands talk to the running daemon via HTTP (same pattern as `agentx usage`). Agent ownership defaults to `channels.whatsapp.defaultAgent`.

| Command | Description |
|---|---|
| `agentx whatsapp list-chats [--format json] [--group] [--dm]` | List cached chats (no live fetch) |
| `agentx whatsapp list-contacts [--format json]` | List cached contacts |
| `agentx whatsapp ingest-all [--dry-run] [--agent <id>] [--force]` | Run a full sweep against the configured allowlist |
| `agentx whatsapp ingest-contact <jid> [--dry-run] [--agent <id>]` | Ingest one contact by JID (bypasses allowlist) |
| `agentx whatsapp ingest-chat <jid> [--dry-run] [--messages] [--agent <id>]` | Ingest one DM or group (bypasses allowlist); `--messages` forces `mode: "messages"` for this pass |
| `agentx whatsapp status` | Connection + cache counts |

::: tip First-time walkthrough
1. Pair WhatsApp: `agentx connect whatsapp` (existing flow, opens QR).
2. Let the daemon observe some events for a minute so the cache populates. Verify: `agentx whatsapp list-contacts`.
3. Allowlist one contact in `agentx.json` → `channels.whatsapp.ingest.allowContacts: ["+21624XXXXXXX"]` and set `ingest.enabled: true`.
4. Reload: `agentx config check` then the daemon picks it up (hot-reload).
5. **Dry-run first**: `agentx whatsapp ingest-all --dry-run`. Inspect the would-be entries.
6. Run for real: `agentx whatsapp ingest-all`.
7. Check `.agentx/wiki/raw/entries/wa-contact-*.md` on disk.
8. `agentx wiki absorb --agent <defaultAgent>` — this creates `people/<slug>.md` and/or `projects/<group-slug>.md` articles via the existing prompt.
:::

## Safety on personal accounts

Baileys talks to WhatsApp as if you were a linked device on a personal number. WhatsApp actively detects and throttles automated activity; aggressive reads can trigger a ban.

Mitigations that are on by default:
- **Default-deny allowlist.** You must explicitly opt each contact/group in.
- **`maxChatsPerSweep = 25`.** A first-run backfill of a large account spreads across multiple operator invocations (or cron ticks in phase 2).
- **Throttle queue.** Every live Baileys call (`getGroupMetadata`, `getHistory`, …) goes through a single token bucket; cache hits are free.
- **Passive cache over live fetch.** Read API returns cached data first; live calls are the exception.
- **No bulk `fetchMessagesFromWA` loops.** History pulls are opt-in per chat and bounded by `messageCap`.

What to avoid:
- Turning on `mode: "messages"` for dozens of chats at once.
- Lowering `minMsBetweenCalls` below ~1 second.
- Re-running `ingest-all` in a tight loop — the sweep is idempotent, but there's no upside.

## Failure modes

| Failure | Behaviour |
|---|---|
| Socket not connected | Sweep aborts, returns one error in `report.errors`. No partial writes. |
| One chat fails mid-sweep | Per-target try/catch. Other targets continue. The failed target appears in `report.errors` and is retried next sweep. |
| Rate limit hit | Throttle queue paces subsequent calls. The existing reconnect backoff at `src/channels/whatsapp.ts:198-220` handles disconnects. |
| Absorb fails on a WhatsApp entry | Entry stays in `raw/entries/` until the next `wiki absorb`. Same semantics as every other source. |

## Idempotency

Re-running an ingest is **cheap and safe**:

- Same day + unchanged contact profile → same filename → overwrite is a no-op.
- New messages arrived → new `lastMsgId` → new entry file created.
- `getUnabsorbedEntries` (`src/wiki/store.ts:1028-1046`) already skips entries referenced in any article's `sources:` list, so absorb doesn't re-process them.

No sidecar database. The filesystem is the dedup store.

## What's not in phase 1

These land in phase 2 (scheduled cron) and phase 3 (agent tool), depending on demand:

- **Scheduled sweep.** Will use the existing `src/crons/scheduler.ts` — operators declare `crons.whatsapp-sweep` in `agentx.json`, no new cron plumbing.
- **Retention purge.** `retentionDays > 0` would delete absorbed raw entries older than N days, keeping unused ones untouched.
- **Agent-invoked lookup tool** (`whatsapp.lookup(contact, topic)`). Deferred — the wiki already is the agent's lookup surface via BM25 + graph retrieval. A live tool adds a second retrieval path and multiplies ban-risk surface.

## FAQ

**What if a contact I talk to isn't in my device's address book?**
They'll still show up in the cache — Baileys tracks `pushName` (the name the other side set on their device) even without a saved contact. The ingestor falls back to `pushName` → phone → JID for display.

**Do group messages include the sender's name?**
The transform uses the sender's JID. After absorb runs, the existing prompt tends to resolve JIDs to the right `people/` article when those people are already catalogued.

**Can I ingest without running a full AgentX daemon?**
No — the daemon owns the Baileys socket, and the CLI is a thin HTTP client. Keeps auth state on the daemon and avoids re-pairing on every CLI run.

**Does ingest affect the existing agent-messaging path?**
No. Ingest is additive and doesn't modify `messages.upsert` routing.
