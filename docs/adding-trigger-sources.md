---
title: "Adding new webhook trigger sources"
---

# Adding new webhook trigger sources

> **TL;DR** AgentX already validates signatures and dispatches webhooks for GitHub, GitLab, Stripe, Sentry, and Vercel. Adding a new service (HubSpot, Linear, Notion, Calendly, Plausible, etc.) is a 5-step recipe — usually under 50 lines of code, no plugin required.

This page explains how to expose a new webhook-based service as a workflow trigger. It assumes you've read [Workflows — when, why, and when NOT](./llm-workflows.md) and have understood the trigger types.

## What you get out of the box

`src/daemon/webhooks.ts` ships:

- **A generic webhook endpoint**: `POST /webhook/:agentId` (or `POST /webhook/:agentId/:source`).
- **Signature verification helpers** for: GitHub HMAC-SHA256, GitLab token, Stripe timestamp+SHA256, generic `X-Webhook-Secret`. Constant-time compare via Node's `timingSafeEqual`.
- **Auto-source detection** by header sniffing (e.g., `stripe-signature` → Stripe).
- **Per-event-type workflow routing** — a webhook entry in `agentx.json` can map specific event types to specific workflows.
- **Bus emission** of `on:*` hook events so workflows with `trigger.hook` can subscribe.
- **Human-readable summary builder** — agents see a structured message, not raw JSON.

When you add a new service, you reuse all of this. You're filling in 3–4 small extension points, not building a new pipeline.

## The 5-step recipe

### Step 1 — Source detection

Add a header-sniffing rule in `src/daemon/webhooks.ts → detectSource()`:

```ts
private detectSource(headers: Record<string, string | string[] | undefined>): string {
  if (headers["x-gitlab-event"] || headers["x-gitlab-token"]) return "gitlab"
  if (headers["x-github-event"]) return "github"
  if (headers["stripe-signature"]) return "stripe"
  if (headers["sentry-hook-resource"]) return "sentry"
  if (headers["x-vercel-signature"]) return "vercel"
  // ↓ ADD YOUR SERVICE
  if (headers["x-hubspot-signature-v3"]) return "hubspot"
  if (headers["x-hub-signature-256"]) return "github"
  return "unknown"
}
```

If your service uses a unique header, this is enough. If not, users can pass the source explicitly via `/webhook/:agentId/hubspot`.

### Step 2 — Signature verification

Extend `validateSignature()` in `src/daemon/webhooks.ts`. Reuse `createHmac` + `timingSafeEqual`:

```ts
if (source === "hubspot") {
  const sig = headers["x-hubspot-signature-v3"] as string
  if (!sig) return "missing x-hubspot-signature-v3 header"
  const expected = createHmac("sha256", secret)
    .update(`${req.method}${req.url}${raw}${headers["x-hubspot-request-timestamp"]}`)
    .digest("base64")
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return "invalid hubspot signature"
  }
  return null
}
```

Each provider has a different scheme — read their docs. The constant-time compare matters; don't replace it with `===`.

### Step 3 — Event-type extraction

Add to `extractEventType()` in `src/daemon/webhooks.ts`:

```ts
if (source === "hubspot") {
  // HubSpot v3 webhooks send an array of subscription events.
  const ev = Array.isArray(body.events) && (body.events[0] as any)?.subscriptionType
  return typeof ev === "string" ? ev : undefined
}
```

This is what gets used to route different event types to different workflows in `agentx.json`.

### Step 4 — Hook event mapping

If you want workflows with `trigger.hook` to be able to subscribe, add the `on:*` event:

**a. In `src/hooks/types.ts`**, append to `HOOK_EVENTS`:

```ts
"on:hubspot-event",
```

**b. In `src/daemon/webhooks.ts → hookEventFor()`**, return your hook for the source:

```ts
if (source === "hubspot") return "on:hubspot-event"
```

That's it — `fireHookSafe()` handles the bus emission, retries, and error fallback. Workflow subscribers see this event automatically.

### Step 5 — UI catalog (auto-discoverability)

Make your service appear in the workflow editor dropdown.

**a. In `src/web/workflow-editor/Inspector.tsx → CHANNEL_SOURCES`**, add:

```ts
"hubspot-event": {
  label: "HubSpot — CRM event",
  fires: "Fires on any HubSpot subscription event (contact.creation, deal.propertyChange, etc.).",
  wired: true,
  group: "external-webhook",
  hasLabels: false,
},
```

**b. In the same file, add to `HOOK_EVENTS`** (the editor's autocomplete catalog):

```ts
{
  value: "on:hubspot-event",
  label: "on:hubspot-event",
  fires: "Fires on any HubSpot CRM webhook (contact.creation, deal.propertyChange, etc.).",
},
```

Both catalogs are flat objects — no plumbing, no schema migration.

## Optional: human-readable summary

If you want agents that handle the webhook to see a summary instead of raw JSON, extend `buildSummary()` in `src/daemon/webhooks.ts`:

```ts
case "hubspot": {
  const events = (body.events as any[]) ?? []
  lines.push(`Events: ${events.length}`)
  for (const e of events.slice(0, 3)) {
    lines.push(`  - ${e.subscriptionType} (object ${e.objectId})`)
  }
  break
}
```

Skip if your service is structured enough that the workflow handles the JSON directly.

## Putting it together — the operator flow

After you've shipped steps 1–5, an operator using your AgentX deployment:

1. Adds a webhook entry to `agentx.json`:
   ```json
   {
     "webhooks": [
       {
         "id": "hubspot-prod",
         "source": "hubspot",
         "agentId": "crm-bot",
         "secretEnv": "HUBSPOT_WEBHOOK_SECRET",
         "triggers": {
           "contact.creation": "wf-new-contact",
           "deal.propertyChange": "wf-deal-update"
         }
       }
     ]
   }
   ```
2. Sets `HUBSPOT_WEBHOOK_SECRET` in the daemon environment.
3. Configures `https://daemon.example.com/webhook/crm-bot/hubspot` in HubSpot's webhook settings.
4. Authors a workflow with `trigger.channel(source: "hubspot-event")` or `trigger.hook(event: "on:hubspot-event")`.
5. Publishes the workflow. Done.

No restart needed (`setWebhookEntries()` hot-reloads). No plugin install, no new package.

## Worked examples (already shipped)

These are the canonical references — read the diffs to see the recipe applied:

| Service | Source string | Hook event | Files |
|---|---|---|---|
| GitLab | `gitlab` (with sub-events `gitlab-issue`, `gitlab-mr`, `gitlab-note`, `gitlab-pipeline`) | `on:gitlab-*` | `src/channels/gitlab.ts`, `src/workflows/hooks.ts` |
| GitHub | `github` | `on:github-issue`, `on:github-pr`, `on:github-push` | `src/channels/github.ts`, `src/daemon/webhooks.ts` |
| Stripe | `stripe` | `on:stripe-event` | `src/daemon/webhooks.ts` |
| Sentry | `sentry` | `on:sentry-issue` | `src/daemon/webhooks.ts` |
| Vercel | `vercel` | `on:vercel-deployment` | `src/daemon/webhooks.ts` |
| Odoo | `odoo` | `on:odoo-event` | `src/daemon/webhooks.ts` (5-step recipe applied end-to-end) |

### Worked example: Odoo as a first-class source

Applies all 5 steps. End-to-end demo workflow at `examples/workflows/odoo-invoice-paid.yaml`.

**Step 1 (detectSource)** — header sniffing in `src/daemon/webhooks.ts`:
```ts
if (headers["x-odoo-database"] || headers["x-odoo-signature"]) return "odoo"
```
Falls back to URL hint (`/webhook/:agent/odoo`) when neither header is set, since Odoo's outgoing-webhook modules vary widely.

**Step 2 (validateSignature)** — accepts both common patterns:
```ts
if (source === "odoo") {
  const sig = headerStr("x-odoo-signature")
  if (sig) {
    const expected = createHmac("sha256", secret).update(raw).digest("hex")
    const sigHex = sig.startsWith("sha256=") ? sig.slice("sha256=".length) : sig
    return safeEqualOrReject(expected, sigHex)
  }
  const tok = headerStr("x-odoo-webhook-token") ?? headerStr("x-webhook-secret")
  if (!tok) return "missing X-Odoo-Signature or X-Odoo-Webhook-Token"
  return safeEqualOrReject(secret, tok)
}
```
HMAC-SHA256 over raw body for newer modules; shared-secret token for older / community setups.

**Step 3 (extractEventType)** — covers the three common payload shapes:
```ts
if (source === "odoo") {
  if (typeof body.event === "string") return body.event
  if (typeof body.subscriptionType === "string") return body.subscriptionType
  if (typeof body.model === "string") {
    return typeof body.action === "string" ? `${body.model}.${body.action}` : body.model
  }
  return undefined
}
```
Examples that resolve: `account.move.paid`, `crm.lead.create`, `sale.order.action_confirm`.

**Step 4 (hookEventFor + HOOK_EVENTS)** — single bus event:
```ts
if (source === "odoo") return "on:odoo-event"
```
And `"on:odoo-event"` added to the `HOOK_EVENTS` list in `src/hooks/types.ts`. Workflows subscribe via `trigger.hook(event: "on:odoo-event")` and filter by `start.event` inside.

**Step 5 (UI catalogs)** —
- `CHANNEL_SOURCES` in `src/web/workflow-editor/Inspector.tsx` adds `odoo-event` with the "ERP/CRM event" label.
- `HOOK_EVENTS` in the same file adds the autocomplete entry for `on:odoo-event`.
- `WEBHOOK_SOURCES` in `src/daemon/admin-panel.ts` validator accepts `odoo`.
- `VALID_SOURCES` + `WIRED_SOURCES` + `SOURCE_HINTS` in `src/commands/webhook.ts` so the CLI exposes it.
- Admin Webhooks tab dropdown in `src/daemon/ui/pages/admin.ts` plus `eventTypes` array for the trigger-map autocomplete (12 common Odoo event types pre-populated).

**Operator flow after this lands**:
```
agentx webhook add odoo-prod --source odoo --agent crm-bot \
  --secret-env ODOO_WEBHOOK_SECRET --description "Odoo CRM events"
agentx webhook triggers set odoo-prod account.move.paid odoo-invoice-paid
agentx workflow run odoo-invoice-paid --watch     # smoke test
```

Plus: in Odoo → Settings → Technical → Automation → Webhooks, point at `http://daemon:18800/webhook/crm-bot/odoo`. Done.

The same recipe (with different signature schemes) applies to **HubSpot**, **Linear**, **Notion**, **Calendly**, **Plausible**, **Segment**, **Salesforce** — each lands in <50 LOC of edits.

## When to use a channel adapter instead

The recipe above is for **inbound-only** services (Stripe / Sentry / Vercel / HubSpot / Linear / Notion). They emit events; you don't reply to them, you call their API separately when you need to act outbound.

A full **channel adapter** (`src/channels/*.ts`) is heavier — ~800–2000 LOC. You only build one when:

- The service is bidirectional (inbound + replies on the same thread): Telegram, WhatsApp, Slack, Discord, GitLab/GitHub comments
- You need to maintain chat-state (open/closed conversations, agent assignment, message threading)
- You need a "send via" target for cross-channel `/send` calls

For 90% of new services, you don't need that. The 5-step recipe is enough.

## What's NOT in the recipe (deliberately)

- **Plugin packaging.** If you want to ship your service as a reusable npm package for other AgentX users, see `docs/architecture/plugins.md` for the plugin contract. Otherwise, in-tree edits are simpler and clearer.
- **Outbound API calls.** Calling the HubSpot/Stripe/Sentry API to act on something is a separate concern — register an action in `src/actions/builtin/` or as a user-defined `agentx actions add` entry. See `docs/reference/actions.md`.
- **Mesh routing.** `meshEntry?.node` already lets you forward webhooks to a specific peer in your federation. No new code needed; configure it in `agentx.json`.

## Verification

After applying steps 1–5 for a new service:

1. Send a test webhook with `curl -X POST -H "<your-sig-header>: <sig>" -d '@payload.json' http://localhost:18800/webhook/<agent-id>/<source>`.
2. Check `agentx logs` — you should see `Webhook [<source>/<eventType>] -> ...`.
3. Open the workflow editor; the new source should appear in the trigger dropdown with its description.
4. Author a minimal workflow `trigger.hook(event: "on:<service>-...")` that just sends to a channel. Hit the test webhook; the workflow should fire.

If it doesn't fire, the most common causes are: signature mismatch (step 2), missing `secretEnv` value, or the hook event name doesn't match `HOOK_EVENTS` (step 4a).

---

**One sentence:** *Adding a new webhook trigger source is editing 3–5 small lookup tables — not building a new pipeline.* That's the whole architecture.
