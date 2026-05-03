# Admin panel

Path: `/admin`

Single-file settings surface with a row of tabs (Agents, Channels, Schedules, Webhooks, Mesh, Team, Business, Boards, Actions, Tokens, Advanced) rendered in-place via a client-side data-tab switcher. Every tab is a typed view over a slice of `agentx.json` — saves go through `applyConfigMutation`, so the daemon hot-reloads on every successful write.

Each tab is also reachable directly via `#fragment`: `/admin#channels`, `/admin#tokens`, etc. Many empty-state links across the dashboard deep-link here.

## Tabs

### Agents

Add or remove the AI agents that work for you. Each agent is one identity — its name, its model, what it can be told to do. List view + create/edit/delete. Same fields the [per-agent page](./agent) exposes, but compact for adding many at once. Click any row to open the per-agent page.

### Channels

Wire up Telegram, Slack, Discord, GitLab, WhatsApp. This is where you paste bot tokens or scan QR codes. The biggest tab — one section per channel kind (Telegram, WhatsApp, Discord, Slack, GitLab, GitHub, WebRTC). Each lets you:

- Toggle `enabled`
- Add accounts/routes/agentMappings inline (no JSON editing)
- Verify tokens (Telegram `getMe`, GitLab/`api/v4/user`, GitHub `/user`)
- Open the channel-specific [reference page](/reference/cli#channels) with one click

### Schedules

Set up cron jobs in plain English ("every weekday at 9am"). Each schedule fires a prompt at one of your agents. Mirrors `agentx schedule` and `agentx cron`. Add a job by typing English and the parser fills in the cron expression preview. `--on-error` and `--notify` are dropdown chips.

### Webhooks

Bind incoming GitHub/GitLab webhooks to agents. When a PR opens, fire a review agent. Each row binds an `(agent, source)` to an optional signing secret env var. The dashboard auto-generates the public URL (`<bind>/webhook/<agentId>/<source>`). Per-event-type **triggers** (`triggers: { "issues.opened": "triage-bug" }`) and a **defaultWorkflow** dropdown live here too — see [config schema](../config-schema#webhooks).

### Mesh

Connect this agentx machine to other agentx machines. Tasks can flow between them. List of peers + health. Add a peer via paste-an-invite-link (resolves to `MESH_TOKEN` + URL automatically) or manually. Mirrors `agentx mesh`/`agentx connect mesh`.

### Team

Actors and roles for workflow user-tasks. **Actors** are humans with channel handles (Telegram/WhatsApp/Slack/Discord/email) — when a workflow assigns a task to `actor:alice` the form lands on Alice's preferred channel. **Roles** group actors with an assignment strategy (`first-available`, `round-robin`, `all`) so a `role:on-call` task picks the right person automatically. Mirrors `agentx actor` + `agentx role`. See [Team](./team) for the full guide.

### Business

The org chart, projects, and contact map that drive PM-gating and activity-graph attribution. Three sections — **Org chart** (agentId → role + reportsTo + schedule), **Projects** (id → optional pm + client), **Contact map** (chatId/username → client/project for free-text channels). Mirrors `agentx business`. See [Business](./business) for the full guide.

### Boards

Configure the boards rendered on the home page. Add/edit/remove a board, set its GitLab projects, primary tool label, time windows, and column flow (drag-drop → scoped label). Mirrors `agentx board` + `agentx board column`. The actual kanban view lives at `/` — this tab is the configuration surface.

### Actions

The [action registry](../actions) — reusable shell or HTTP invocations (CRM webhooks, transactional email, Stripe lookups, internal scripts) you call from CLI, workflows, or here. Each row shows the action id, kind, target, and inputs; expand a row to **Run now** with a stdout/stderr panel rendered inline. Mirrors `agentx actions list/add/remove/run`. Use the `+ Add or update action` form to register a new one without leaving the browser; secrets stay in the daemon's env (templated as `${ENV_VAR}`), the action JSON only carries the shape.

### Tokens

Mint API keys for external tools that need to talk to your agentx. One token per integration; revoke any time. Same surface as `agentx token`. Each row shows: id, name, scope, prefix, status (active/expired/revoked), last-used. Secrets show **once** at creation — stored hashed.

### Advanced

**For engineers.** Don't touch this unless support tells you to. Editing the raw config can leave the daemon in a broken state. Raw JSON editor for `agentx.json` with Zod validation on save. Use this when the form-based tabs don't expose what you need (e.g. `boards[].columns`, `graph.retrievalWeights`, `webrtc.bot`). Also exposes:

- **Plugins**: edit `plugins[]` and run `agentx plugin doctor` from the browser
- **Governance flags read-out**: shows resolved values of `INTENT_LEDGER_MODE`, `INTENT_PM_GATE_ENABLED` (read-only — env var changes still need a restart)
- **Reload now** button: triggers `POST /reload` manually if `AGENTX_AUTO_RELOAD=false`

## Common tasks

| You want to… | Do this |
|---|---|
| Add a Telegram bot | Channels → Telegram → **Add account** → paste token → verify |
| Wire a CRM webhook (HubSpot / Salesforce / Pipedrive) | Actions → **+ Add** → kind `http`, paste URL, headers `Authorization: Bearer ${HUBSPOT_TOKEN}`, set inputs |
| Send transactional email from a workflow | Actions → register a SendGrid `http` action → call it from an `action.run` node |
| Mint a token for a Slack integration | Tokens → **Create** → name, scope `dashboard:read,task:write`, expires |
| Wire a GitHub webhook to a triage workflow | Webhooks → **Add** → source=github, agentId, secretEnv, triggers `issues.opened: triage-bug` |
| Add a mesh peer | Mesh → **Paste invite link** → done |
| Edit fields the form doesn't expose | Advanced → JSON editor (validates on save) |

## Troubleshooting

- **Save returns 401.** `dashboard.token` is set but the request lacks a `dashboard:admin` token. Mint one, paste it into the dashboard's token field, retry.
- **"Validation failed: …"** The Zod schema rejected the change. The error path is shown — open the field and fix.
- **Hot-reload didn't fire.** Check the response for `reloaded: true`. If `reloadSkipped` says `ECONNREFUSED`, the daemon isn't running. If it says something else (e.g. "section requires restart"), restart manually.

## Implementation pointers

- Page module: `src/daemon/ui/pages/admin.ts`
- Server API: `src/daemon/admin-panel.ts`
- Mutation pipeline: `src/daemon/config-mutator.ts` (validates + writes + reloads)
