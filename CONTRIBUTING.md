# Contributing to AgentX

Thanks for considering a contribution. The full guide lives at
[`docs/contributing.md`](docs/contributing.md) — repo layout, how to run the
daemon locally, test discipline, PR conventions, and the three-tier source
rule.

## TL;DR

```bash
pnpm install
pnpm run build
node dist/cli.js daemon start            # boots a local daemon on :18800
pnpm test                                # vitest, includes tier-discipline check
```

Config lives in `agentx.json` (Zod-validated by `src/daemon/config.ts`);
copy `agentx.example.json` to start.

## Where to file what

- **Bug reports:** open an issue with reproduction steps, `agentx daemon logs`
  output, and the failing config block. Don't paste tokens.
- **Feature requests:** open an issue first — keeps the design conversation
  visible and avoids wasted PR work.
- **Good first issues:** filter the issue tracker for `good first issue` —
  small, scoped, with clear acceptance criteria.
- **Security:** don't open a public issue. Email anis.marrouchi@noqta.tn
  (responsible disclosure: ~14 day window).

## Pull-request checklist

- One change per PR; keep diffs small and named.
- Tests pass locally (`pnpm test`) and the daemon still starts (`node dist/cli.js daemon start`).
- For Zod schema changes, add the field BEFORE using it in consumers — unknown keys are silently stripped.
- For new config fields, update `agentx.example.json` and `docs/reference/config-schema.md`.
- Commits follow the convention in [`docs/contributing.md`](docs/contributing.md#commit-style).

## What this project is NOT

- Not a chatbot. AgentX coordinates agents you've configured; it doesn't have an opinion about what they say.
- Not a hosted service. Everything runs on your machines — `agentx.json` and SQLite are the source of truth.
- Not an agent framework. If you want a DSL for building a single agent, look at AutoGen / LangGraph / CrewAI. AgentX is the layer above: routing, observability, cost, schedules, and channels for agents you already have.
- Not provider-locked. Claude, OpenAI, and any tool-using LLM backend can be plugged in via `providers.<name>` in `agentx.json`.

## License

MIT — see [`LICENSE`](LICENSE). By contributing you agree your changes are released under the same terms.
