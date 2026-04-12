---
title: "6. Shared wiki — compounding team knowledge"
---

# 6. Shared wiki — compounding team knowledge

> **Status:** planned (V2) · **Difficulty:** intermediate

::: warning This page is on the roadmap
The wiki ships and runs daily on the maintainer's own deployment. A user-facing walkthrough is pending.
:::

## Scenario (planned)

Every conversation your agents have gets saved as a raw entry. Overnight, a cron runs `agentx wiki absorb` — an LLM reads the new entries, compares them to existing articles, and writes **distilled, cited wiki articles** the whole team can read tomorrow. After a week you have `projects/`, `people/`, `decisions/`, `patterns/` directories with interlinked `[[wikilinks]]`, each article marked `public`, `shared`, or `private`.

## Outline (what this page will teach)

- The three wiki modes: `unified` (default), `flat` (Karpathy), `graph` (knowledge graph)
- Ingesting conversations into raw entries automatically
- `agentx wiki absorb` — the daily compile step; the prompt template per mode
- Cron pattern: `wiki-absorb-midnight` with `onError: ["notify", "disable"]` (see [Journey 2](/journey/02-scheduled-reports))
- `agentx wiki query <question>` — how agents retrieve before answering
- `agentx wiki serve` — Wikipedia-style web browser at `:4200`
- Permissions: when to write `public` vs `shared` vs `private`

## Today's nearest equivalents

- **Wiki CLI** — every command: [reference/cli → Wiki](/reference/cli#wiki)
- **Concepts page** — short wiki primer: [concepts](/concepts#_5-wiki)
- **Source** — the absorb prompt template lives at [`src/wiki/prompts.ts`](https://github.com/anis-marrouchi/agentx/blob/master/src/wiki/prompts.ts); the `SKILL.md` that drives absorb is at [`src/wiki/SKILL.md`](https://github.com/anis-marrouchi/agentx/blob/master/src/wiki/SKILL.md)

## Contribute

The ideal V2 page walks through a seven-day loop with screenshots: day 1 entries → day 7 articles with wikilinks.
