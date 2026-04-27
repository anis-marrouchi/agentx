# References Registry

Operator-facing fact registry. Skills cite references by dotted ID; the
agentx context engine renders matching references as a deterministic
`[Verified References]` block at the top of agent context.

## Where things live

| Path | Committed? | Purpose |
|---|---|---|
| `references/example/*.yaml` | yes | Schema-illustrative templates with placeholder values. |
| `references/recipes/example.yaml` | yes | Example recipe wiring intent → references + skills. |
| `references/<your-project>/*.yaml` | optional (operator choice) | Public/non-secret operator data shared with the team. |
| `.agentx/references/<your-project>/*.yaml` | **NO** (gitignored) | Operator-private data: client SSH hosts, GitLab project IDs, contacts. |
| `.agentx/references/recipes/*.yaml` | **NO** | Operator-private recipe rules per project. |

`.agentx/` is gitignored (see top-level `.gitignore`). Project-specific
data — KSI for Noqta, your own clients for you — must NOT be committed
to the agentx repo.

## Search order

Loader walks (in this order, merging by namespace):

1. `references/`
2. `.references/`
3. `.agentx/references/`

Recipes:

1. `references/recipes/`
2. `.references/recipes/`
3. `.agentx/references/recipes/`
4. `.agentx/recipes/`

## Schema

Each YAML file is one `ReferenceFile`:

```yaml
namespace: <prefix>      # optional, prepended to every card id
cards:
  - id: <slug>           # required; lowercase, dotted slug
    kind: ssh | gitlab | path | contact | http | secret-pointer
    summary: <one line>  # rendered in the verified-references block
    fields:              # typed key/value bag — strings, numbers, bools
      user: clawd
      host: 198.51.100.10
    tags: [deploy]       # optional, used by recipes
    ownerAgent: devops   # optional
    lastVerified: "2026-04-27"  # optional ISO date
    notes: |             # optional, never sent to the agent
      Free-form notes for human readers.
```

Recipe schema (`recipes/*.yaml`):

```yaml
recipes:
  - id: my-recipe
    priority: 10
    when:
      agentIds: [devops-agent]
      messageRegex: ["deploy|ssh"]
      intentTags: ["deployment"]    # optional — matched against intent classifier output
      requireTags: ["deploy"]       # optional — every card must carry every tag
    references:
      - example.ssh.prod
      - example.contacts.*           # trailing .* expands to every id under that prefix
    skills: [example-deploy]         # required-skill names (audit lint flags FAILING when missing)
```

## How to onboard a new project

1. Pick a namespace. Use a single-segment slug — e.g. `acme`, `bigco`,
   `mtgl`, `ksi`. This becomes the prefix on every card id.
2. Drop YAML files under `.agentx/references/<namespace>/`. Suggested
   split: `ssh.yaml`, `gitlab.yaml`, `paths.yaml`, `contacts.yaml`. The
   split is purely organizational — cards from any file in the tree
   are merged.
3. Drop recipe rules at `.agentx/references/recipes/<namespace>.yaml`.
   Match by `agentIds` and `messageRegex` to keep retrieval narrow.
4. Add `contextReferences: true` to the relevant agents in `agentx.json`.
5. Restart the daemon. The first turn for each agent loads its
   reference bundle once and caches for the daemon's lifetime.
6. `pnpm agentx skill audit` — verifies that every skill citing a
   reference resolves, and that every skill required by a recipe is
   installed.

## Operator-private fact policy

- Never put tokens, passwords, or service-account keys in references.
  Use `kind: secret-pointer` and a `tokenEnv` field naming the env var.
- IPs, hostnames, project IDs, paths, and contact emails are usually
  fine to keep in `.agentx/references/`. They are not committed.
- If a fact must be public to the team, put it under `references/`
  (committed) and tell your team to rebase regularly.
