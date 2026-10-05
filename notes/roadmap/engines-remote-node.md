---
title: "Engines on another AgentX node"
---

# Engines on another AgentX node (#445)

> **Status:** decided, not built. Waiting on one thing: an answer on the model provider's terms that the owner trusts and that others can read.
> **Owner decision (2026-10-05):** host-side agent first, once the terms are clear. Any agent a teammate can reach goes on `billing: "api"`. A model relay through an existing gateway comes later, if at all.
> **Source:** the spike thread on [#445](https://github.com/anis-marrouchi/agentx/issues/445), 2026-10-02 to 2026-10-05. This note is the one place that holds its outcome; the thread holds the history.

## The question

The owner asked (voice, 2026-10-02): a teammate installs AgentX but has no Claude subscription. Can there be an engine option, next to `claude-code`, `opencode` and `codex-cli`, that runs the teammate's turns on the engine of **another** AgentX node they were let into, whatever provider that node uses?

Two cases came out of the discussion:

- **Case 1:** a teammate or a client uses the host's engine.
- **Case 2:** the reverse. A client shares one folder of their own project with the host, over the private network, and the host's own agent works in it as part of the host's service. The client does not get the host's engine.

## What exists today

- The mesh carries a task from one node to an agent on another ([Add a second machine](../../docs/jobs/second-machine.md), [When an agent asks another agent](../../docs/jobs/ask-another-agent.md)).
- A guest mesh grant opens one agent of the host to another organisation, with scope, level, pause and end ([Let another organisation into part of your mesh](../../docs/jobs/guest-mesh.md)). The guest asks; the host's agent acts on the host's files.
- People, paired machines and per-person limits on agents, tools and skills ([Tell agents who is who](../../docs/jobs/people.md), [Invite a teammate](../../docs/jobs/members.md)).
- `agents.<id>.billing` on the `claude-code` tier: `"subscription"` (default) strips `ANTHROPIC_API_KEY` and uses the shared sign-in; `"api"` bills the key and drops the sign-in token. An `api` agent with no key fails its run rather than falling back (`src/daemon/config.ts`, `src/utils/workspace-env.ts`).

## The two shapes

| | (a) Host-side agent | (b) Model relay |
|---|---|---|
| Where the turn runs | On the host. The agent reads and edits the host's files. | On the teammate's node. Tools and files stay there; only the model calls go to the host, which adds its key. |
| What exists | Mesh task and guest grant: all of it. | Nothing in AgentX. A throwaway relay was tried, see below. |
| Fits | Answers, reviews, drafts, work on the host's project. | A teammate working on their own disk. |
| Cost to build | Small: a billing rule and a check. | A gateway to build and keep: per-person keys, call log, cap, rate limit, model list, export. |
| Terms | Documented provider case for an organisation's own authorised users on its key. | Same for a teammate. For a paying client running Claude Code, the Claude Code legal page rules it out (quote below). |

**Decision:** (a) first. If (b) is ever wanted, put an existing gateway product beside the host rather than building one inside AgentX. OpenRouter already gives one key per person with a credit limit and usage per key, which covers the OpenAI-style engines; a self-built relay would then be needed for `claude-code` only.

### Which engines could point at a relay, if (b) ever comes

| Engine | Can point at a host relay | How it was checked |
|---|---|---|
| `claude-code` | yes: `ANTHROPIC_BASE_URL` plus a per-person credential | run against a stub relay |
| `opencode` | yes: OpenAI-compatible provider with a `baseURL` | docs only |
| `codex-cli` | yes: `[model_providers.<id>]` with `base_url` and `env_key` | docs only |
| `sdk`, `orchestrator` | yes: `providers.<name>.baseUrl` or `OPENAI_BASE_URL` | code read only |

### The throwaway proof

A 65-line relay in front of a stub provider (no real model, no spend), driven by the real `claude` CLI with an empty config folder and a per-person key. Not in the repo.

- The Read tool ran on the local machine, its result went through the relay, and the answer came back.
- The relay logged every model call under the person's name.
- A model off the person's list returned 403; the cap returned 429; removing the key returned 401 on the next call with no restart.
- A one-line prompt sent roughly 27k input tokens per model call (estimated from request size), so per-person cost is not small.

Not proven: a real provider, real usage numbers, prompt caching through the relay, a run through an AgentX daemon.

## Provider terms, as read on 2026-10-02

Not legal advice. The sentences below were checked word for word on the pages named, except where marked. Re-check each before relying on it.

| Page | Sentence | Checked |
|---|---|---|
| [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms), effective 2025-10-08 | "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else." | on the page |
| [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms), effective 2025-06-17 | Permission to use the Services "including to power products and services Customer makes available to its own customers and end users"; may not "resell the Services except as expressly approved by Anthropic"; "Anthropic may not train models on Customer Content from Services." | on the page (training sentence quoted by the owner, not re-fetched) |
| [Claude Code: Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) | "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users." | on the page |
| same page | "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential." | on the page |
| same page | An API key may be configured "in a development environment, secrets manager, or machine image for use by the customer's own authorized users — provided the resulting usage is billed to the key owner … and is not resold or intermediated as described above." | on the page |
| [OpenRouter Terms](https://openrouter.ai/terms), updated 2026-08-31 | Not "for purposes of reselling API access to Models or otherwise developing a competing service". The host's customers are covered "to the extent you incorporate the Service into your own products and services". | on the page |
| [DeepSeek Open Platform Terms](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html), effective 2026-04-29 | "do not share or publicly disclose your API key with others, and do not expose it in browser or other client-side code." Models may serve "both internal and external end users". | on the page |
| OpenAI [Terms of Use](https://openai.com/policies/terms-of-use/) and [Services Agreement](https://openai.com/policies/services-agreement/) | "You may not share your account credentials or make your account available to anyone else"; "Customer may not resell or lease access to its Account". | **not on the live page**: it refused the fetch; read from archive copies of 2026-09-26 and 2026-09-30. Least certain. |

Reading, for the owner to weigh:

- A **team member** inside the host's organisation, on the host's API key, matches "the customer's own authorized users". This is the hard rule from 2026-10-02: the shared engine is offered only through an API key billed to the host, never through a personal subscription.
- A **client charged at cost** for a relayed Claude Code is the case the "may not pay for, resell, or intermediate" sentence seems written for. For the `sdk` and `orchestrator` engines, which call the API directly, only the Commercial Terms apply, and they allow powering a product for one's own customers.
- The question put to the provider can be one line: *is a client who uses my Claude Code relay, billed at cost on my API key, an authorised user or an end user?*

### Account type for client work (case 2)

| Provider | Account type | Clause |
|---|---|---|
| Anthropic | API key or a business plan, not Pro or Max | Commercial Terms: no training on Customer Content |
| OpenRouter | API key | Customers covered when the Service is part of the host's own products and services; each model's own terms apply too |
| DeepSeek | API key | Models may serve external end users; training clause not looked for |
| OpenAI | API key | Not checked on a live page |

## Case 2: the host's agent on a client's folder

Possible today with no AgentX change: the client shares one folder over the private network (Tailscale, no code host in between), the host mounts it and makes it the workspace of a host agent on `billing: "api"`. Engine, key and session stay on the host; the client ends it by unsharing. Not tested.

Missing: a consent record before the first turn touches the client's files, and a pause the client controls. Guest grants do not cover it: they run the other way.

## Limits the host needs by default

Before any shape of case 1 is offered to someone outside the household:

- a per-person spend cap and rate limit;
- an allowed model list per person;
- a log of every turn with the person's name;
- ending access at once.

For (a) today: per-person agent, tool and skill limits exist; a grant has pause and end, and counts turns and tokens. A spend view per person and a monthly export do not exist.

## What happens when the owner says yes

In this order; none is filed yet.

1. **Billing rule.** Put every agent a teammate or guest can reach on `billing: "api"`, and refuse a guest or limited person's turn on an agent that is still on the subscription. The check is the `billing` setting itself. Docs: the guest-mesh page already says to use `api` for the grant's agent.
2. **Spend view and export.** Per-person turns, tokens and cost on the People page, with a monthly export.
3. **Case 2 page.** A docs page for the client-folder job, plus the consent record and client-side pause.
4. **Setup.** One line in config and one screen in setup for "this agent is shared", working with defaults.
5. **Later, if at all.** A relay through an existing gateway: the `agentx` engine option on the teammate's node (host address plus the key from pairing, setting two environment variables), a call log, cap, rate limit and model list on the gateway side.

Rough guess from the spike: one to two weeks for items 1 to 4. Not measured.

## Not done, on purpose

- No code for the engine, the relay or the billing check. The owner's direction is open, not built.
- No child issue filed.
- OpenAI terms not read on a live page. Anthropic Usage Policy and the OpenRouter key management page not fetched.
