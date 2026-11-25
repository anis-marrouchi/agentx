# AgentX agent guidance

Every coding agent working in this repository (Claude Code, Codex, the Coder agent and others) follows the rules in [CLAUDE.md](CLAUDE.md). Read it before you change anything.

Two rules apply to every PR, in short:

- **Impact sweep (Rule A).** The PR description lists every surface the change touches (Hub pages, CLI, phone and Mac apps, docs, settings, other agents' flows) under **Impacted**, and the PR checks each one. Hub styling must match on every page; an old-style page goes on the checklist in issue #2218.
- **Progressive disclosure (Rule B).** Simple by default. Extra controls stay hidden until asked for (chip pop-up, hover drop-down, "more" menu, setting switch).

Full text: [CLAUDE.md › Impact Sweep Rule](CLAUDE.md#impact-sweep-rule-rule-a-anis-2026-11-25) and [CLAUDE.md › Progressive Disclosure Rule](CLAUDE.md#progressive-disclosure-rule-rule-b-anis-2026-11-25).
