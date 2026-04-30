# AgentX Plugins (Move B)

> Status: shipped 2026-04-30. Stable contract. Restart-required.

A plugin is an npm package that registers channel adapters and bus
subscribers at AgentX daemon boot. Plugins extend AgentX without
forking the daemon.

## Quick start

1. Create a TypeScript project that exports a default `AgentXPlugin`:

   ```ts
   // src/index.ts
   import type { AgentXPlugin } from "agentix-cli/plugins"

   const plugin: AgentXPlugin = {
     manifest: { name: "my-plugin", version: "0.1.0" },
     async setup(ctx) {
       ctx.log("hello from my-plugin")
       ctx.on("task:completed", (p) => {
         ctx.log("task done:", p.agentId, p.durationMs, "ms")
       })
     },
     async teardown() {
       // optional — bus subscribers are auto-removed
     },
   }

   export default plugin
   ```

2. Publish to npm or `pnpm link` for local dev.

3. List the package in your `agentx.json`:

   ```json
   {
     "plugins": ["@noqta/my-plugin"]
   }
   ```

4. `pnpm install` the package.

5. Restart the daemon. Plugin loads on boot:

   ```
     Plugins: 1 loaded — my-plugin
   ```

## The contract

```ts
export interface AgentXPluginManifest {
  name: string
  version: string
  agentxRange?: string  // optional; major.minor parity vs daemon version
}

export interface AgentXPluginContext {
  log: (...args: unknown[]) => void
  on<E extends keyof AgentXEvents>(evt: E, fn: (p: AgentXEvents[E]) => void): () => void
  addChannel(adapter: ChannelAdapter): void
  agents: ReadonlyMap<string, AgentDef>
  config: Readonly<DaemonConfig>
}

export interface AgentXPlugin {
  manifest: AgentXPluginManifest
  setup(ctx: AgentXPluginContext): void | Promise<void>
  teardown?(): void | Promise<void>
}
```

The context's surface is intentionally narrow. A plugin can:

- **Observe**: subscribe to bus events (`message:matched`,
  `message:dropped`, `task:started`, `task:completed`,
  `session:rotated`).
- **Receive**: register a `ChannelAdapter` so AgentX routes inbound
  messages from a new transport.
- **Read state**: snapshot the agents registry and the daemon config.

A plugin cannot:

- Mutate the agents registry. Agents come from `agentx.json`.
- Register MCP servers at runtime. MCP is per-agent file sync today.
- Run in a sandbox. Plugins run in-process with full daemon access.
  **Only install plugins you trust.**
- Hot-reload. Adding/removing a plugin requires restarting the daemon.

## Lifecycle

| Phase | Hook |
|---|---|
| Daemon `start()` step 0.5 | Loader calls `setup(ctx)` for each plugin. |
| `start()` step 1+ | Plugin-registered channels are added to the router and started. Bus subscribers see every event. |
| Daemon `stop()` | Each plugin's `dispose()` runs: optional `teardown()` first, then bus subscribers are detached. Disposal happens after channels stop and tasks drain. |

Inside `setup()`, the daemon's subsystems are partially initialized:

- ✅ `ctx.agents` is populated.
- ✅ `ctx.config` is fully validated and frozen.
- ✅ The bus is live.
- ⚠️ Channels haven't started yet. `ctx.addChannel(adapter)` is the
  way to participate; calling `adapter.start()` directly is wrong —
  the daemon does that after `setup()` returns.
- ⚠️ Mesh, cron, business layer aren't started. Don't try to reach
  them in `setup()`; subscribe to bus events instead and react when
  they fire.

## Bus subscriber rules

The bus is a **synchronous** Node `EventEmitter`. Subscribers must:

1. **Return immediately.** Long work blocks every other subscriber on
   the same event, including the SQLite writer and the dashboard SSE
   broadcast.
2. **Be defensive.** A throw is logged with the plugin's prefix and
   does not propagate to sibling subscribers (the loader wraps every
   `ctx.on` callback). Don't rely on this — fix the bug.
3. **Queue async work.** If you need to call an HTTP API, push the
   payload onto an internal queue and process out-of-band.

Available events (full payloads in `src/events/bus.ts`):

| Event | When fired |
|---|---|
| `message:matched` | Inbound message routed to an agent |
| `message:dropped` | Inbound message dropped (dedup, blocked, no agent) |
| `task:started` | Agent task dispatched |
| `task:completed` | Agent task finished (with usage + tier-2 split) |
| `session:rotated` | Claude session rotation (stale / max-turns / tier-2) |

## Channel adapters

A plugin's channel adapter is a class implementing `ChannelAdapter`
(see `src/channels/types.ts`). Minimum surface:

```ts
class MyChannel implements ChannelAdapter {
  readonly name = "my-channel"
  async start(): Promise<void> { /* connect, subscribe */ }
  async stop(): Promise<void> { /* disconnect */ }
  async send(msg: OutgoingMessage): Promise<string | void> { /* … */ }
  onMessage(handler: (m: IncomingMessage) => Promise<void>): void {
    /* store handler; call it when an inbound message arrives */
  }
}
```

The loader rejects an `addChannel(adapter)` whose `name` collides
with a built-in channel (`telegram`, `whatsapp`, `discord`, `slack`,
`gitlab`, `github`); it logs and skips. Pick a unique name.

## Failure modes

The loader is defensive: any of these failures log and continue.
None of them abort daemon boot.

| Failure | Plugin loaded? | Log line includes |
|---|---|---|
| `import()` throws | No | `import failed for "<name>"` |
| Default export missing manifest/setup | No | `did not export a default AgentXPlugin` |
| Manifest fails Zod validation | No | `manifest invalid: <issue>` |
| `agentxRange` doesn't match daemon major.minor | No | `requires agentx <range>` |
| `setup()` throws | No | `setup() failed: <error>` |
| `setup()` exceeds 15 s | No | `setup() exceeded 15000ms` |
| Subscriber callback throws | Yes | `subscriber for "<event>" threw:` |
| `addChannel` name collides | Plugin yes, channel no | `name "<n>" already in use` |
| `teardown()` throws | Plugin yes | `teardown() threw:` |

## Operator commands

```bash
# List configured plugins
agentx plugin list

# Dry-run import each plugin and report ✓/✗
agentx plugin doctor
```

`doctor` exits non-zero when any plugin fails — useful in CI to
catch a broken `pnpm install` before deploy.

## Versioning

The plugin contract is at v1. The `agentxRange` field gates against
the daemon's `major.minor`; a plugin built for `0.18` won't load
against `0.19` until you update its manifest. We track contract
changes in this file's git history.

Out of scope for v1 (may come later): sandbox, hot-reload,
auto-discovery from `node_modules`, runtime registry mutation, MCP
tool registration.
