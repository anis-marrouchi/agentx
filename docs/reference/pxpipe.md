# pxpipe (image-context compression)

[pxpipe](https://github.com/teamchong/pxpipe) is a local Anthropic-API proxy that renders bulky request context (system-prompt slab, tool docs, large `tool_result` bodies, collapsed history) into dense PNGs before forwarding. The pitch: image tokens are priced by pixels, not content, so dense text lands at ~3.1 chars/image-token vs ~1.9–3.9 chars/token as text — the project claims 59–70% end-to-end savings on Claude Code traffic.

agentx integrates it as an **opt-in flag** on the claude-code tier:

- Global: `pxpipe: { enabled, url, autoStart, models }` in `agentx.json` (see [config schema](/reference/config-schema#pxpipe))
- Per agent: `agents.<id>.pxpipe: true|false`
- Per task: `POST /task { "pxpipe": true }` — used by the bench harness

Resolution: task → agent → global. Fail-open: if the proxy is unreachable and can't be auto-started, the dispatch runs direct. OAuth/subscription auth survives the proxy (verified 2026-07-08 — a subscription-billed Fable 5 call succeeded through it).

## Bench harness

```bash
# cost A/B — same message, N fresh-session runs per arm
agentx bench pxpipe --agent <id> --runs 3 --url http://127.0.0.1:18800

# fidelity A/B — agent Reads a dense generated payload (turn 1),
# then must recall exact 12-char hex ids from it (turn 2)
agentx bench pxpipe --agent <id> --fidelity --workspace <agent-ws> --runs 2
```

Each run uses a fresh chatId + `freshSession: true` so neither arm inherits the other's prompt cache. The table reports what the API actually billed; the proxy's own `~/.pxpipe/events.jsonl` counterfactual is printed separately because it is *not* ground truth (see below).

## Bench results (2026-07-08, Fable 5 [1m], MacBook, pxpipe-proxy 0.8.0)

Fidelity mode, 2 runs/arm, 30k-char dense payload, 6 hex-recall probes/run:

| metric (avg/run) | pxpipe OFF | pxpipe ON | delta |
|---|---|---|---|
| input tokens | 12,307 | 14,160 | **+15%** |
| output tokens | 337 | 641 | **+90%** |
| cache read | 98,956 | 141,636 | **+43%** |
| cache create | 40,786 | 45,979 | **+13%** |
| total input | 152,049 | 201,774 | **+33%** |
| est. cost ($, API rates) | 0.2246 | 0.2670 | **+19%** |
| duration (ms) | 29,478 | 58,590 | **+99%** |
| verbatim recall | 12/12 | 12/12 | ok |

Cost mode, 3 runs/arm, plain agent task ("list files, summarize rules"):

| metric (avg/run) | pxpipe OFF | pxpipe ON | delta |
|---|---|---|---|
| input tokens | 12,098 | 13,340 | +10% |
| output tokens | 492 | 598 | +22% |
| cache read | 44,142 | 54,125 | +23% |
| cache create | 19,238 | 66,609 | **+246%** |
| total input | 75,477 | 134,074 | **+78%** |
| est. cost ($, API rates) | 0.1291 | 0.3150 | **+144%** |
| duration (ms) | 24,493 | 51,700 | **+111%** |

During the same window pxpipe's own `events.jsonl` claimed a 50% saving (802k-token counterfactual vs 402k billed) — the counterfactual assumes the request would have been sent as *uncached* text, which Claude Code never does. The cache-create explosion (+246%) is the tell: imaged pages re-created cache on fresh sessions far more expensively than the text slab did.

### Why it lost money here

pxpipe did engage fully — 9–11 images per request, the entire ~242k-char Claude Code system/tool-doc slab imaged, `compressed: true` on every ON-arm request. Three things ate the theoretical savings:

1. **The counterfactual is inflated.** pxpipe's profitability gate compares billed tokens against a `count_tokens` probe of the *uncached text* request (~110–130k tokens on our traffic). But the OFF arm's real billed context was ~40–50k tokens/request — Claude Code always runs with prompt caching, and cache reads bill at 10% of base. Against the *cached-text* reality, imaging made each request **bigger** (~68k billed), not smaller.
2. **Output inflation.** The ON arm produced ~90% more output tokens (a documented effect of imaged context — the model re-derives verbosely). Output is the most expensive token class.
3. **Render + vision-prefill latency.** ~11M pixels of PNG per request roughly doubled wall-clock time.

Fidelity: 12/12 exact hex recalls on both arms — consistent with pxpipe's own audit (13/15 on Fable 5), but their audit also shows **0/15 on Opus** with silent confabulations, and 12/12 on a small sample is not clearance for agents that quote hashes/IDs or apply diffs.

### When it could still win

Our bench agent has a small workspace and short sessions. The configurations where pxpipe's claims might hold: very long uncacheable histories (rotating sessions where cache_create dominates), providers/paths without prompt caching, or workloads where the imaged slab is stable enough to cache as images across many turns. If you have such an agent, measure it with `agentx bench pxpipe` before enabling — that's what the harness is for.

### Verdict

Keep `pxpipe.enabled: false` fleet-wide. The flag, proxy manager, and bench harness stay — re-benchmark when (a) pxpipe changes its gate to a cached-text baseline, (b) Anthropic reprices image tokens, or (c) a specific agent shows chronic cache-create-heavy traffic.

## Related approaches (evaluated, not adopted)

- **QR/barcode encoding**: dead end. General VLMs cannot decode QR (no error-correction circuit in a patch encoder), and Anthropic server-side image resampling destroys pixel phase — pxpipe's own FINDINGS.md reached the same conclusion for all glyph-density tricks beyond plain rendered text.
- **DeepSeek-OCR / Glyph** (trained optical compression, ~10×/3–4×): the "done right" version, but requires running your own VLM — not applicable to Anthropic-hosted models.
- **LLMLingua-2** (text-side pruning, 2–5×): provider-agnostic and *inspectably* lossy (dropped tokens are visible, surviving tokens aren't mutated) — the safer mid-ground if history compression is ever needed.
- **Prompt caching discipline**: the lever that actually dominates agentx costs today (cache reads at 10%), and precisely the thing image re-rendering puts at risk.
