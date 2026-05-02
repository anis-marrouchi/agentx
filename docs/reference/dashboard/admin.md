# Admin panel

Path: `/admin`

Single-file settings surface with seven tabs rendered in-place via a client-side data-tab switcher. Every tab is a typed view over a slice of `agentx.json` — saves go through `applyConfigMutation`, so the daemon hot-reloads on every successful write.

Each tab is also reachable directly via `#fragment`: `/admin#channels`, `/admin#tokens`, etc. Many empty-state links across the dashboard deep-link here.

## Tabs

### Agents

List view + create/edit/delete. Same fields the [per-agent page](./agent) exposes, but compact for adding many at once. Click any row to open the per-agent page.

### Channels

The biggest tab. One section per channel kind (Telegram, WhatsApp, Discord, Slack, GitLab, GitHub, WebRTC). Each lets you:

- Toggle `enabled`
- Add accounts/routes/agentMappings inline (no JSON editing)
- Verify tokens (Telegram `getMe`, GitLab/`api/v4/user`, GitHub `/user`)
- Open the channel-specific [reference page](/reference/cli#channels) with one click

### Schedules

Cron + natural-language scheduler in one tab. Mirrors `agentx schedule` and `agentx cron`. Add a job by typing English ("every weekday at 9am") and the parser fills in the cron expression preview. `--on-error` and `--notify` are dropdown chips.

### Webhooks

Inventory of inbound webhooks. Each row binds an `(agent, source)` to an optional signing secret env var. The dashboard auto-generates the public URL (`<bind>/webhook/<agentId>/<source>`). Per-event-type **triggers** (`triggers: { "issues.opened": "triage-bug" }`) and a **defaultWorkflow** dropdown live here too — see [config schema](../config-schema#webhooks).

### Mesh

List of peers + health. Add a peer via paste-an-invite-link (resolves to `MESH_TOKEN` + URL automatically) or manually. Mirrors `agentx mesh`/`agentx connect mesh`.

### Team

Actors and roles for workflow user-tasks. **Actors** are humans with channel handles (Telegram/WhatsApp/Slack/Discord/email) — when a workflow assigns a task to `actor:alice` the form lands on Alice's preferred channel. **Roles** group actors with an assignment strategy (`first-available`, `round-robin`, `all`) so a `role:on-call` task picks the right person automatically. Mirrors `agentx actor` + `agentx role`. See [Team](./team) for the full guide.

### Business

The org chart, projects, and contact map that drive PM-gating and activity-graph attribution. Three sections — **Org chart** (agentId → role + reportsTo + schedule), **Projects** (id → optional pm + client), **Contact map** (chatId/username → client/project for free-text channels). Mirrors `agentx business`. See [Business](./business) for the full guide.

### Boards

Configure the boards rendered on the home page. Add/edit/remove a board, set its GitLab projects, primary tool label, time windows, and column flow (drag-drop → scoped label). Mirrors `agentx board` + `agentx board column`. The actual kanban view lives at `/` — this tab is the configuration surface.

### Tokens

Mint, list, revoke API tokens. Same surface as `agentx token`. Each row shows: id, name, scope, prefix, status (active/expired/revoked), last-used. Secrets show **once** at creation — stored hashed.

### Advanced

Raw JSON editor for `agentx.json` with Zod validation on save. Use this when the form-based tabs don't expose what you need (e.g. `boards[].columns`, `graph.retrievalWeights`, `webrtc.bot`). Also exposes:

- **Plugins**: edit `plugins[]` and run `agentx plugin doctor` from the browser
- **Governance flags read-out**: shows resolved values of `INTENT_LEDGER_MODE`, `INTENT_PM_GATE_ENABLED` (read-only — env var changes still need a restart)
- **Reload now** button: triggers `POST /reload` manually if `AGENTX_AUTO_RELOAD=false`

## Common tasks

| You want to… | Do this |
|---|---|
| Add a Telegram bot | Channels → Telegram → **Add account** → paste token → verify |
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
