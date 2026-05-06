# Procedures

Path: `/procedures`

Read-only catalog of the **verb library** workflows compose with. This is **Tier 3** in the [three-tier model](../../architecture/three-tier) — reusable building blocks below the named SOP layer (workflows) and above the always-on infrastructure (agents, channels, mesh).

## Three sections

### 1. Built-in actions
Typed steps registered at daemon boot. Each has a strict input/output Zod schema, surfaced collapsibly on the page so you can see exactly what to pass and what comes back. The shipped catalog (8 actions):

| Action | Purpose |
|---|---|
| `http.fetch` | GET a URL; 1MB body cap; returns `{status, statusText, headers, body, truncated, url}` |
| `http.post` | POST a JSON body; same response shape |
| `file.read_lines` | Read a UTF-8 text file as `string[]`; 8MB cap; scoped to allowed roots |
| `file.write_jsonl` | Append a record as one NDJSON line; same scoping |
| `extract.structured` | Single-call typed extraction: prompt + JSON-Schema → structured data via forced tool_use |
| `rag.lexical` | BM25 search over an agent's pre-built index (no embedding key needed) |
| `agent.call` | Dispatch a task to a **local** agent on this daemon; `freshSession: true` by default |
| `mesh.delegate` | Send a task to a **remote** mesh peer's agent; same fresh-session default |

### 2. Sub-workflows
Active workflows shaped as procedures — `trigger.manual` + a non-empty `inputSchema`. Each entry shows the typed input contract as a table (field, type, required, description) plus a copy-paste `subProcess { workflowId: "..." }` snippet ready to paste into a parent workflow's nodes. Deep-link to `/workflows#<id>` for full editing.

A workflow becomes "discoverable as a procedure" automatically when its inputSchema is non-empty — no metadata flag needed.

### 3. Workflow templates
The five templates `agentx workflow init <id> --template <name>` ships:
- **linear** — trigger → agent → end (smallest valid graph)
- **branching** — classify, route on RESULT to one of N branches
- **extract** — `extract.structured` with a JSON-schema-shaped output
- **human-in-the-loop** — `userTask` form pause + resume
- **retry** — per-node retry policy with a branch fallback path

## What you can do here

This page is **read-only**. Adding a new procedure is a code change:

| To add… | Edit |
|---|---|
| A new built-in typed action | Drop a module in `src/actions/builtin/`, import + register in `src/actions/builtin/index.ts` |
| A new workflow template | Add a YAML in `src/workflows/templates/`, ship via `tsup` web bundle |
| A sub-workflow | Author a workflow with `trigger.manual` + `inputSchema` and promote it from a draft on `/workflows` |

The CLAUDE.md generator auto-injects the built-in catalog into every agent's workspace — agents discover them at the workspace level. See [CLAUDE.md catalog injection](../../architecture/three-tier#tier-3-—-procedure).

## Compose a procedure into a workflow

In a workflow YAML, reference a built-in action:

```yaml
- id: pull
  type: action.builtin
  config:
    name: http.fetch
    input:
      url: "https://api.github.com/repos/{{trigger.input.repo}}"
```

Or call a sub-workflow:

```yaml
- id: deploy
  type: subProcess
  config:
    workflowId: mr-deploy            # the discoverable sub-workflow id
    inputMap:
      project: "{{trigger.input.project}}"
      environment: "{{trigger.input.environment}}"
      ref: "{{trigger.input.ref}}"
    awaitCompletion: true
```

Both paths land in `/traces` as structured steps, unlike opaque `Bash`/`curl`/`Read` calls.

## Implementation pointers

- Page module: `src/daemon/ui/pages/procedures.ts`
- Built-in registry: `src/actions/builtin/registry.ts`; entries under `src/actions/builtin/<name>.ts`
- API: `GET /api/actions/builtin` (list), `POST /api/actions/builtin/:name` (run with body)
- Templates: `src/workflows/templates/*.yaml` (bundled via `tsup` onSuccess hook)
- See also: [Three-tier model](../../architecture/three-tier), [Actions registry](../actions), [Workflows reference](../workflows)
