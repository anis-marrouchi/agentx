# Workflow Authoring in YAML (Move C)

> Status: shipped 2026-04-30. YAML is read-only authoring; the editor
> still saves JSON.

A workflow can be written in YAML at `.agentx/workflows/<id>.yaml`
instead of (or alongside) `.agentx/workflows/<id>.json`. Both formats
share the same Zod schema (`workflowSchema`), the same engine, and
the same CLI. The only addition is the optional `flow:` shorthand
for linear sequences.

## Quick start

```yaml
id: hello
version: 2
title: Hello, world
nodes:
  - id: start
    type: trigger.manual
    config: {}
  - id: act
    type: agent
    config:
      agentId: coder
      prompt: "Say hi to {{start.text}}"
  - id: done
    type: end
    config: {}
flow: [start, act, done]
```

Drop that into `.agentx/workflows/hello.yaml`, restart the daemon,
and `agentx workflow list` shows the new workflow alongside any JSON
ones. Trigger it via `agentx workflow run hello --input '{"text":"hi"}'`.

## How it differs from JSON

YAML is **a different format for the same shape**. Every workflow you
can express in JSON, you can express in YAML. The only addition is
the `flow:` shorthand below.

The schema source of truth lives in `src/workflows/types.ts`
(`workflowSchema`). YAML files are parsed → desugared → validated by
the same Zod schema; nothing in the engine knows the file's
on-disk format.

## The `flow:` shorthand

`flow: [a, b, c]` synthesizes the linear edges:

```yaml
edges:
  - { from: a, to: b }
  - { from: b, to: c }
```

That's the whole sugar. There is no `parallel:`, `conditional:`,
`loop:`, `for_each:`, or `while:` block — those have semantics that
no array can imply. Use explicit `nodes` + `edges` for them.

### Rules `flow:` enforces at parse time

- **Unknown node ids fail.** `flow: [start, ghost]` errors with
  `flow references unknown node "ghost"`.
- **Multi-port and suspending nodes are forbidden.** A `flow:` may
  not include a node whose type is `branch`, `gateway.parallel`,
  `rule`, `signal.wait`, `userTask`, `subProcess`, `timer.boundary`,
  or `checkpoint`. The error names the type and the id:
  `flow cannot include branch node "route"; use explicit edges for
  branch nodes`.
- **`flow:` and `edges:` may coexist.** Both are honoured; duplicate
  `(from, fromPort, to)` triples are deduped, so a `flow:` linear
  edge that's also explicitly written in `edges:` produces one
  edge, not two. Different `fromPort` values are NOT considered
  duplicates.
- **Single-id flows produce no edges.** Useful when the only node
  is terminal (e.g. a manual trigger that records and ends).

## When to use which

- **JSON** when the editor is your authoring loop. The visual graph
  editor saves JSON; if you `agentx workflow show` and pipe the
  output into `> .agentx/workflows/foo.json`, you get JSON.
- **YAML** when you author by hand. Multi-line prompts read better,
  comments help reviewers, and `flow:` cuts the edge bookkeeping for
  linear paths.

You can switch a workflow from JSON to YAML by `agentx workflow show
<id> --format yaml > .agentx/workflows/<id>.yaml` and then deleting
the JSON. The reverse works too.

## What happens when both `<id>.json` and `<id>.yaml` exist?

**Hard error.** `WorkflowStore.list()` skips the id, `get()` returns
null, and `agentx workflow validate` (and `validateAll()`)
emits a duplicate-id error on **both** files so you see what to
delete:

```
  ✗ foo
    duplicate workflow id "foo" — found foo.json and foo.yaml; delete one to disambiguate
```

This is intentional: silently picking one extension over the other
hides authoring intent. We never guess.

## Editor saves over a YAML-authored workflow

The visual editor always writes JSON. If you save a workflow whose
id has a YAML sibling on disk, `WorkflowStore.save()` throws:

```
yaml-authored workflow "foo" exists at .agentx/workflows/foo.yaml;
edit on disk or delete the YAML before saving from the editor
```

Editing YAML in the editor would either silently lose the YAML
formatting or produce two files for one id (we just rejected that).
Pick one authoring loop per workflow.

## Templating

YAML inherits the same `{{nodeId.path}}` templating that JSON uses
(`src/workflows/template.ts`). There is no JSONata, no expressions,
no function calls — by design. Template rules:

- `{{nodeId.path}}` — dotted-path lookup against the run context
- `{{env.NAME}}` — process env var, **only** if `NAME` is in
  `envAllow:` for this workflow
- Missing paths render as empty strings (no literal `{{...}}` left
  in output)
- Objects render as `JSON.stringify`, scalars as `String(value)`

## Gotchas

- **YAML number vs string coercion.** `123` is a number, `"123"` is
  a string. Quote ids and values that some node configs expect as
  strings (e.g. chat ids).
- **Multi-line prompts.** Use `|` for literal blocks (preserves
  newlines, strips trailing newline) or `>` for folded blocks
  (collapses runs of whitespace into single spaces). The
  whatsapp-client-support example uses both.
- **Multi-document YAML is rejected.** `---` separators between
  documents cause a parse error in v1. One workflow per file.
- **Tabs vs spaces.** YAML rejects tabs in indentation. Stick to
  spaces (most editors do this automatically).
- **`flow:` is a one-way authoring affordance.** `agentx workflow
  show <id> --format yaml` always renders the canonical
  `nodes` + `edges` form, never the original `flow:`. Round-tripping
  is JSON-equivalent, not YAML-equivalent.

## Reference

- Canonical example: `examples/workflows/whatsapp-client-support.yaml`
  (and the JSON twin alongside, for diffing — they desugar to the
  same workflow).
- Parser: `src/workflows/yaml.ts`
- Schema: `src/workflows/types.ts`
- Template engine: `src/workflows/template.ts`
- Store: `src/workflows/store.ts`
