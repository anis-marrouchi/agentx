---
title: "Plugin authoring"
---

# Plugin authoring

Plugins are npm packages that hook into the agentx daemon at startup. They register channel adapters, subscribe to bus events, and read the agent registry. The contract is small (one default export, two methods) but the plugin runs in-process with full daemon access — only install plugins you trust.

## What a plugin can do

| Capability | API |
|---|---|
| Add a custom channel adapter | `ctx.addChannel(adapter)` — participates in routing alongside Telegram / Discord / GitLab |
| Subscribe to bus events | `ctx.on("task:completed", fn)` etc. |
| Read agent registry + config | `ctx.agents`, `ctx.config` (read-only) |
| Namespaced logging | `ctx.log(...)` — output is prefixed with the plugin name |

What plugins **cannot** do in v1:

- Mutate the agent registry at runtime (`agentx.json` stays the source of truth)
- Register MCP tools (MCP is per-agent file sync today)
- Run sandboxed (no isolation — full daemon process access)
- Hot-reload (plugin changes require a daemon restart)

## Scaffold a plugin

```bash
agentx plugin init agentx-plugin-mattermost
```

That creates:

```
agentx-plugin-mattermost/
├── package.json       # type=cjs, main=dist/index.js, agentx-plugin keyword
├── tsconfig.json      # CommonJS, declarations on
├── src/
│   └── index.ts       # default export with manifest + setup
├── README.md
└── .gitignore
```

For scoped packages: `agentx plugin init @your-org/plugin-foo`. The directory is the unscoped tail; the manifest is the full name.

## Manifest fields

```ts
{
  manifest: {
    name: "agentx-plugin-mattermost",   // matches package.json
    version: "0.1.0",                    // semver
    agentxRange: "0.x",                  // optional — gate against major.minor
  },
  setup(ctx) { /* ... */ },
  teardown() { /* optional */ }
}
```

`agentxRange` is a major.minor match in v1 — if the daemon is `0.18.x` and the plugin claims `agentxRange: "0.17"`, the plugin is skipped with a clear log line. Omit when you don't care.

## The `ctx` API

`setup(ctx)` is called once at daemon boot. Capture only what you need; the context is closed-over.

```ts
setup(ctx: AgentXPluginContext) {
  // Logging — output is prefixed [<plugin-name>]
  ctx.log("hello, world")

  // Subscribe to bus events. The disposer is tracked by the loader,
  // so you don't need to remove subscriptions in teardown.
  const off = ctx.on("task:completed", (payload) => {
    ctx.log("task done:", payload.agentId, payload.durationMs + "ms")
  })

  // Register a custom channel adapter.
  ctx.addChannel({
    name: "mattermost",
    start: async () => { /* connect */ },
    stop:  async () => { /* disconnect */ },
    send:  async (out) => { /* deliver to Mattermost */ },
    // optional: receive: subscribe to inbound + emit IncomingMessage
  })

  // Read-only access to agents and config.
  for (const [id, def] of ctx.agents) {
    if (def.tier === "claude-code") ctx.log("claude-code agent:", id)
  }
  if (ctx.config.mesh.enabled) ctx.log("mesh is on")
}
```

Bus events worth subscribing to (full list in `src/events/bus.ts`):

| Event | Payload | Common use |
|---|---|---|
| `message:matched` | inbound + matched agent | Audit logging |
| `task:completed` | agentId, durationMs, tokens | Cost dashboards |
| `session:rotated` | agentId, reason (`stale`/`tier-2`/`max-turns`) | Tier-2 alerts |
| `webhook:received` | source, agentId, payload | Per-source metrics |
| `mesh:peer:status` | peer, status | Multi-node observability |

## Distributing

Public:

```bash
pnpm publish --access public
```

Private (operator pulls via `pnpm install` against your registry):

```bash
pnpm publish --access restricted --registry https://your-registry.example.com
```

Or distribute as a tarball (`pnpm pack`) and have operators install from the file.

## Versioning

The plugin's `version` (in both `package.json` and the manifest) is independent of agentx's version. Use `agentxRange` to gate against breaking changes in the host:

```ts
manifest: {
  name: "agentx-plugin-mattermost",
  version: "1.2.0",
  agentxRange: "0.18", // works on 0.18.x — won't load on 0.19+
}
```

When you publish a v2 of agentx that breaks the `addChannel` shape, the plugin's `agentxRange` keeps it from loading (and from spamming errors) until you ship a compatible plugin version.

## Plugin doctor

After installing on the operator side:

```json
"plugins": ["agentx-plugin-mattermost"]
```

…run:

```bash
agentx plugin doctor
```

The doctor dynamically imports each configured plugin, validates the manifest, and reports status. Exits non-zero on any failure — wire into CI to catch a broken plugin install before the daemon picks it up.

## Local testing

```bash
cd agentx-plugin-mattermost
pnpm install && pnpm build
pnpm link --global

# in your agentx project:
pnpm link --global agentx-plugin-mattermost
agentx config set 'plugins[0]' agentx-plugin-mattermost
agentx plugin doctor
```

Restart the daemon. Logs should show `[agentx-plugin-mattermost] hello, world` if you kept the scaffold's sample setup.

## Troubleshooting

- **"no default AgentXPlugin export."** Your `index.ts` doesn't `export default` an object with `{manifest, setup}`. Re-check; CJS interop sometimes wraps the export — the loader unwraps `mod.default.default` defensively, but a malformed default still fails.
- **"manifest invalid: ..."** Zod rejection — the error names the field. Common: missing `version` (required), `agentxRange` not a string.
- **Plugin loads but channel doesn't receive messages.** The adapter's `name` collides with a built-in. The loader logs a warning; rename your channel.
- **`ctx.on` works but my callback never fires.** Check spelling — events are typed in `src/events/bus.ts` but the API uses string keys, so a typo silently does nothing. Cross-reference against `bus.ts`.

## Next

- [Plugin types reference](https://github.com/anis-marrouchi/agentx/blob/master/src/plugins/types.ts) — the full `AgentXPluginContext` interface
- [`agentx plugin` CLI reference](/reference/cli#plugins)
- [Architecture: plugins design](/architecture/plugins) — boundaries the contract deliberately doesn't cross
