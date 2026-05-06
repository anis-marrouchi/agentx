# Actions registry

Two complementary registries:

1. **Typed built-in actions** (Tier-3 procedures, see below) — TypeScript modules registered at daemon boot with strict Zod input/output schemas. Eight ship today: `agent.call`, `mesh.delegate`, `extract.structured`, `rag.lexical`, `file.read_lines`, `file.write_jsonl`, `http.fetch`, `http.post`. Adding a new built-in is a code change.
2. **Operator-defined actions** (described after the built-ins section) — file-stored `shell` or `http` invocations with template parameters. Storage is `.agentx/actions/<id>.json`.

Use built-ins when there's an exact match (HTTP fetch, file read, agent delegation, etc.); use operator-defined actions when a custom shell or HTTP recipe is needed.

## Typed built-in actions

The shipped catalog (8 actions, registered at boot via `registerAllBuiltins()`):

| Action | Purpose | Notes |
|---|---|---|
| `http.fetch` | GET a URL | 1MB cap, http/https only, returns `{status, statusText, headers, body, truncated, url}` |
| `http.post` | POST a JSON body | Same response shape |
| `file.read_lines` | Read text file as `string[]` | UTF-8, 8MB cap, scoped to `AGENTX_BUILTIN_FILE_ROOTS` (defaults to `cwd`) |
| `file.write_jsonl` | Append one record as NDJSON | Same scoping; typed schema enforces record shape |
| `extract.structured` | Single-call typed extraction via forced tool_use | Uses `ANTHROPIC_API_KEY`; `model` defaults to `claude-haiku-4-5` |
| `rag.lexical` | BM25 search over an agent's pre-built index | No embedding key required; build via `agentx rag add <agent> <globs>` |
| `agent.call` | Dispatch a task to a **local** agent on this daemon | `freshSession: true` by default; same-node sibling of `mesh.delegate` |
| `mesh.delegate` | Send a task to a **remote** mesh peer's agent | Same fresh-session default; uses configured peer auth |

### Three ways to invoke a typed action

**1. From an agent's Bash tool** (the catalog is auto-injected into every agent's CLAUDE.md):

```bash
agentx actions builtin http.fetch        --input '{"url":"https://wttr.in/Tunis?format=j1"}'
agentx actions builtin file.read_lines   --input '{"path":"prices.json"}'
agentx actions builtin file.write_jsonl  --input '{"path":"leads.jsonl","record":{"name":"...","email":"..."}}'
agentx actions builtin extract.structured --input '{"prompt":"...","schema":{"type":"object",...}}'
agentx actions builtin rag.lexical       --input '{"agentId":"info","query":"...","limit":5}'
agentx actions builtin agent.call        --input '{"agentId":"<local-agent>","message":"..."}'
agentx actions builtin mesh.delegate     --input '{"peer":"<peer-name>","agent":"<peer-agent>","message":"..."}'
```

Each call lands in `/traces` as a structured step — input + output + status — so debugging beats opaque shell text.

**2. From a workflow** via `action.builtin`:

```yaml
- id: pull
  type: action.builtin
  config:
    name: http.fetch
    input:
      url: "https://api.github.com/repos/{{trigger.input.repo}}"
```

**3. From the HTTP API** (used by the dashboard's `/procedures` page and by operator scripts):

```bash
# List the catalog
curl http://127.0.0.1:18800/api/actions/builtin

# Run one with typed input
curl -X POST http://127.0.0.1:18800/api/actions/builtin/http.fetch \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://wttr.in/Tunis?format=3"}'
```

### CLI

```bash
agentx actions builtin                      # list all built-ins
agentx actions builtin <name> --schema      # show the input/output schema
agentx actions builtin <name> --input '<json>'    # run with typed input
```

Default output is the structured `output` block as JSON. Add `--json` for the full envelope (input, output, durationMs, error if any).

### CLAUDE.md catalog injection

`workspace-setup.ts` auto-appends a "Typed actions — prefer these over free-form Bash" section to every agent's `CLAUDE.md` listing each action with a copy-paste invocation and rule-of-thumb mapping (HTTP fetch → `http.fetch`, file read → `file.read_lines`, append record → `file.write_jsonl`, extract fields → `extract.structured`, search corpus → `rag.lexical`, call local agent → `agent.call`, call peer agent → `mesh.delegate`). The catalog refreshes silently on next daemon restart via the managed-marker hash whenever the workspace template changes.

### `agent.call` vs `mesh.delegate`

Same shape, different scope:

| | `agent.call` | `mesh.delegate` |
|---|---|---|
| Target | Local agent on this daemon | Remote agent on a mesh peer |
| Transport | In-process registry call | HTTP over Tailscale / WAN |
| `freshSession` default | `true` | `true` |
| Latency | ~ same as direct task | + network roundtrip |
| Use when | Triage / router patterns on one machine | Cross-node delegation |

Both replace the legacy "compose `Bash curl` to /task" pattern, which (a) couldn't carry `freshSession`, (b) showed up in `/traces` as opaque shell text, (c) needed the model to format JSON correctly.

### Adding a new built-in

1. Create `src/actions/builtin/<name>.ts` exporting a `BuiltinAction<I, O>`:

```ts
import { z } from "zod"
import type { BuiltinAction } from "./types"

const inputSchema = z.object({ ... })
const outputSchema = z.object({ ... })

export const myAction: BuiltinAction<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
  name: "domain.myaction",
  description: "<one-line description>",
  inputSchema,
  outputSchema,
  timeoutMs: 30_000,
  handler: async (input) => { /* ... */ },
}
```

2. Import + register in `src/actions/builtin/index.ts`:

```ts
import { myAction } from "./myaction"
// ...
export function registerAllBuiltins(): void {
  // ...
  registerBuiltin(myAction)
}
```

3. Restart the daemon — the catalog refreshes. CLAUDE.md picks up the new entry on next workspace setup.

**Tier-discipline rule:** Procedures (`src/actions/builtin/`) must NOT import process/system runtime modules — see [Three-tier model](../architecture/three-tier) and `test/tier-discipline.test.ts`. Documented seams (singleton accessors like `getAgentRegistry()`, `getMesh()`) are explicitly whitelisted.

---

## Operator-defined actions

In addition to the typed built-ins, operators can register their own reusable invocations. Two kinds:

- **`shell`** — exec a templated command on the daemon host
- **`http`** — fetch a URL with templated method/headers/body

Operators register an action once, then call it from:

- the CLI (`agentx actions run <id>`)
- the dashboard (`/admin` → **Actions** tab — list, edit, run with output panel)
- a workflow (the `action.run` node — see [Workflows](./workflows#actions))
- an agent prompt (via the action's CLI surface inside a hook or skill)

Storage is a flat folder: one JSON file per action at `.agentx/actions/<id>.json`. Backup-and-version with the rest of `.agentx/`.

## Why not just call curl in a cron?

You can. Two things change once you have more than three integrations:

1. **Inputs become typed.** A bare `curl` swallows missing arguments; an action declares `email: string (required)` and refuses to run without one.
2. **Secrets are centralized.** `${SENDGRID_API_KEY}` resolves once per host; you don't sprinkle the env var through five crons and four prompts.

A registered action also gets:

- 32KB per-stream output cap (no runaway commands flooding the dashboard)
- a per-invocation timeout (default 30s, max 10min)
- structured `ActionRunResult` — `{ ok, status, output, errors, durationMs }` — that workflow nodes can branch on

## Anatomy of an action

```json
{
  "id": "hubspot-create-contact",
  "title": "Create HubSpot contact",
  "kind": "http",
  "url": "https://api.hubapi.com/crm/v3/objects/contacts",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer ${HUBSPOT_TOKEN}",
    "Content-Type": "application/json"
  },
  "body": "{\"properties\":{\"email\":\"{{email}}\",\"firstname\":\"{{firstname}}\"}}",
  "inputs": [
    { "name": "email",     "type": "string", "required": true },
    { "name": "firstname", "type": "string" }
  ],
  "timeoutMs": 30000
}
```

Two template layers:

- <code v-pre>{{name}}</code> — replaced with a typed input at run time
- **`${ENV_VAR}`** — replaced with `process.env.ENV_VAR` of the daemon (use this for tokens and base URLs)

Inputs accept `string`, `number`, or `boolean`. Use `defaultValue` for optional inputs that should still resolve to *something* (`"defaultValue": false` for a boolean opt-out, `"defaultValue": "info"` for a log level).

## Common integration recipes

The recipes below assume the relevant API key lives in the daemon environment (e.g. via `~/.config/agentx/env`, a systemd `EnvironmentFile`, or whatever you already use for `ANTHROPIC_API_KEY`).

### CRM — capture a lead

**HubSpot.** Free tier covers most SMBs.

```bash
agentx actions add hubspot-create-contact \
  --kind http --title "Create HubSpot contact" \
  --url "https://api.hubapi.com/crm/v3/objects/contacts" --method POST \
  --headers '{"Authorization":"Bearer ${HUBSPOT_TOKEN}","Content-Type":"application/json"}' \
  --body '{"properties":{"email":"{{email}}","firstname":"{{firstname}}","lastname":"{{lastname}}","company":"{{company}}"}}' \
  --inputs 'email:string!,firstname:string,lastname:string,company:string'
```

**Salesforce.** Same pattern; the URL becomes `https://<your>.my.salesforce.com/services/data/v59.0/sobjects/Contact/` and the body uses Salesforce's `Email`/`FirstName`/`LastName` fields.

**Pipedrive.** <code v-pre>https://&lt;your&gt;.pipedrive.com/api/v1/persons?api_token=${PIPEDRIVE_TOKEN}</code> with <code v-pre>{"name":"{{name}}","email":[{"value":"{{email}}"}]}</code>.

### Email — transactional send

**SendGrid.**

```bash
agentx actions add sendgrid-send \
  --kind http --title "Send transactional email" \
  --url "https://api.sendgrid.com/v3/mail/send" \
  --headers '{"Authorization":"Bearer ${SENDGRID_API_KEY}","Content-Type":"application/json"}' \
  --body '{"personalizations":[{"to":[{"email":"{{to}}"}]}],"from":{"email":"noreply@example.com"},"subject":"{{subject}}","content":[{"type":"text/plain","value":"{{body}}"}]}' \
  --inputs 'to:string!,subject:string!,body:string!'
```

**Mailgun, Postmark, Resend** all expose similar `POST /messages` shapes — substitute the URL and the auth header.

For Gmail / Outlook (OAuth-gated) prefer a thin shell wrapper around the [Google CLI](https://cloud.google.com/sdk/gcloud) or [Microsoft Graph CLI](https://learn.microsoft.com/cli/microsoftgraph/) so the OAuth dance lives outside the action.

### Billing — query Stripe

```bash
agentx actions add stripe-customer \
  --kind http --title "Look up Stripe customer by email" \
  --url "https://api.stripe.com/v1/customers?email={{email}}&limit=1" --method GET \
  --headers '{"Authorization":"Bearer ${STRIPE_API_KEY}"}' \
  --inputs 'email:string!'
```

Add a sibling `stripe-create-invoice` action with `--method POST` to close the loop.

### Support — open a ticket

**Zendesk.**

```bash
agentx actions add zendesk-create-ticket \
  --kind http --title "Open Zendesk ticket" \
  --url "https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json" --method POST \
  --headers '{"Authorization":"Basic ${ZENDESK_BASIC}","Content-Type":"application/json"}' \
  --body '{"ticket":{"subject":"{{subject}}","comment":{"body":"{{body}}"},"priority":"{{priority}}"}}' \
  --inputs 'subject:string!,body:string!,priority:string'
```

**Intercom, Freshdesk, Help Scout** are the same pattern with their tenant-specific URLs.

### ERP — touch a record

**Odoo** exposes JSON-RPC on `/web/dataset/call_kw`; **NetSuite** uses SuiteTalk REST; **SAP** speaks OData. All three boil down to a `POST` with auth + a JSON body, so the same `kind: http` action shape works. Treat the recipe above as a template — drop in the tenant URL, swap the auth header, paste the request body.

### Project tools — file an issue

**Linear.**

```bash
agentx actions add linear-create-issue \
  --kind http --title "Create Linear issue" \
  --url "https://api.linear.app/graphql" --method POST \
  --headers '{"Authorization":"${LINEAR_API_KEY}","Content-Type":"application/json"}' \
  --body '{"query":"mutation($title:String!,$desc:String!,$team:String!){issueCreate(input:{title:$title,description:$desc,teamId:$team}){success}}","variables":{"title":"{{title}}","desc":"{{description}}","team":"${LINEAR_TEAM_ID}"}}' \
  --inputs 'title:string!,description:string'
```

**Jira / GitHub Issues / GitLab issues** all have direct REST endpoints; for GitLab and GitHub, AgentX already ships a workflow `action.createIssue` node — use that when you're already in a workflow, fall back to a registered action when you need it from a cron or skill.

### Notifications — Slack incoming webhook

```bash
agentx actions add slack-notify \
  --kind http --title "Post to Slack channel" \
  --url "${SLACK_WEBHOOK_URL}" \
  --headers '{"Content-Type":"application/json"}' \
  --body '{"text":"{{text}}"}' \
  --inputs 'text:string!'
```

For Teams, swap to the channel's incoming webhook URL — same body shape with a different envelope.

### Internal — wrap a script

Sometimes you don't want a public API; you want a script the daemon can run. `kind: shell` covers it.

```bash
agentx actions add nightly-export \
  --kind shell --title "Export today's orders to S3" \
  --command "cd /srv/exports && ./run.sh --date={{date}} --bucket=${EXPORT_BUCKET}" \
  --inputs 'date:string!' --timeout 120000
```

Use `--cwd` for scripts whose `pwd` matters; pass extra env via the `env` field in JSON when you need to scope a secret to one action.

## Calling actions from a workflow

The [`action.run` node](./workflows#actions) takes an `actionId` and an `inputs` map. It resolves the action by id at run time, so you can update the action behind it without touching the workflow.

```json
{
  "id": "notify_lead",
  "type": "action.run",
  "config": {
    "actionId": "slack-notify",
    "inputs": { "text": "New lead from {{trigger.source}}: {{trigger.email}}" }
  }
}
```

Output: <code v-pre>{{ &lt;nodeId&gt;.ok / .status / .output / .errors / .durationMs }}</code> — branch on `.ok` to retry, surface `.errors` to the agent, log `.durationMs` to the activity graph.

## Operating tips

- **Test from the dashboard first.** Settings → **Actions** → expand a row → **Run now** — the output panel renders stdout/stderr inline, including the error envelope. Faster than copying `curl` into a terminal.
- **Keep secrets in the daemon's env.** Do not embed tokens directly in `body`/`headers` — the action JSON gets backed up with the rest of `.agentx/` and may end up in version control.
- **Set realistic timeouts.** A `kind: shell` action that waits on a webhook reply will hang the dashboard tab if it lacks a `timeoutMs`. Default 30s is fine for HTTP; nudge up for batch scripts.
- **Validate inputs upstream.** When an agent calls an action, the prompt should normalize the value (lowercase, trim) before passing it. The schema only enforces `required`/type, not domain semantics.

## Schema

See the JSON shape and Zod schema in [Config schema → Actions](./config-schema). The CLI flags map 1-to-1 onto the schema fields.

## Implementation pointers

- Schema + types: `src/actions/types.ts`
- Filesystem store: `src/actions/store.ts`
- Runner (templating, exec, fetch): `src/actions/runner.ts`
- CLI: `src/commands/actions.ts`
- Workflow node: `src/workflows/nodes/handlers.ts` → `actionRunHandler`
- Dashboard tab + admin API: `src/daemon/ui/pages/admin.ts`, `src/daemon/admin-panel.ts`
