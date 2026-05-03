# Actions registry

Reusable, parameterized invocations the agentx daemon can run on demand. Two kinds in v1:

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
