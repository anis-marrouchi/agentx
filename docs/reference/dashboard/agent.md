# Per-agent page

Path: `/admin/agents/<id>`

A dedicated page per agent, reachable from the [Live grid](./live) (click an agent card) or [Admin → Agents](./admin). Tabs:

| Tab | What it does |
|---|---|
| **Overview** | Editable metadata: display name, tier, model, system prompt, max-concurrent, max-execution-minutes, intents, max-delegation-depth. Hot-reloads the daemon on save |
| **Identity** | EasyMDE editor over the agent's identity files (`CLAUDE.md`, `SOUL.md`, `IDENTITY.md`, etc.) — the inline-prompt source of truth |
| **Skills** | Per-skill tree, file editor, install actions. Mirror of `agentx skill list/add/sync` plus inline editing |
| **Channels** | Read-only list of bindings — which routes deliver to this agent. Empty-state links forward to [Admin → Channels](./admin) for setup |
| **Handovers** | Manual routing. Push the current chat to another agent or take over a chat the bot is currently routing elsewhere |

## What you'll see

- **Header**: agent id, status pill (idle / busy / error), tier badge, link to the live grid.
- **Tab row**: the five tabs above.
- **Right rail**: recent tasks for this agent (live SSE) with quick filters (only errors / only this channel).

## What you can do

- Edit any agent field that's editable in `agentx.json` — the form mutations route through `applyConfigMutation`, so they validate against the Zod schema and the daemon hot-reloads.
- Create or edit identity files inline (saves to the workspace root).
- Install a skill from a path or from the catalog (uses `cpSync`); sync stale skill copies across all workspaces.
- Hand over a chat: pick a target agent, the dashboard POSTs a hand-over message into the daemon's router so the next inbound message routes to the new agent.
- Click any task in the right rail to see input/output, tokens used, duration, and any error stack.

## Common tasks

| You want to… | Do this |
|---|---|
| Change the agent's model | Overview tab → Model dropdown → Save. Daemon hot-reloads |
| Tighten what intents the agent handles | Overview tab → Intents (Phase 5) → comma-separated list. Empty = permissive |
| Cap delegation depth (Phase 8) | Overview tab → Max delegation depth → integer. 0 disables the check |
| Edit `CLAUDE.md` without leaving the browser | Identity tab → choose file → save |
| Push a chat to a different agent | Handovers tab → pick target → submit |

## Troubleshooting

- **"Failed to load identity files."** The agent's `workspace` path is wrong or unreadable. Check `agentx.json` and that the daemon process can read it.
- **Skill install grayed out.** No write token (`dashboard.token` not in `dashboard:admin` scope) or the workspace is read-only.
- **Hand-over silently no-ops.** The router only honors hand-overs for in-flight conversations. If the chat went idle, the next inbound starts a fresh routing decision.

## Implementation pointers

- Page module: `src/daemon/ui/pages/agent.ts`
- Server API: `src/daemon/agent-panel.ts`
- Hot-reload pipeline: `src/daemon/config-mutator.ts` (`applyConfigMutation`)
