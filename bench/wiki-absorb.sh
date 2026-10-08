#!/usr/bin/env bash
# Wiki absorb before/after benchmark (#808).
#
# Copies a wiki snapshot once per variant, absorbs the same pending
# entries with each variant's flags until the queue is empty, then scores
# what each variant wrote and prints time and cost side by side.
#
# Usage:
#   bench/wiki-absorb.sh <snapshot-wiki-dir> [name=flags ...]
#
#   bench/wiki-absorb.sh /tmp/wiki-snapshot
#   bench/wiki-absorb.sh /tmp/wiki-snapshot "baseline=--max 10" "batch20=--max 20"
#
# Default variants: baseline (--max 10, today's default) and batch20 (--max 20).
#
# Environment:
#   AGENTX       command to run (default: agentx)
#   OUT          results folder (default: $TMPDIR/wiki-absorb-<utc time>). It holds
#                full copies of the wiki, so keep it out of the repository.
#   ROUNDS       absorb runs per variant before giving up (default: 40)
#   SINCE/UNTIL  YYYY-MM-DD bounds on the entries, passed to every absorb
#   SAMPLE_N     articles in each scorecard (default: 40)
#   SEED         scorecard seed (default: absorb-bench)
#   JUDGE=1      add the model judge to each scorecard (one call per article)
#   EXTRA        flags added to every absorb, e.g. "--no-facts"
#
# The snapshot must hold pending entries: copy .agentx/wiki before a
# backlog is absorbed (or from a backup). It is never written to.
# Empty arrays are expanded as ${A[@]+"${A[@]}"}: with set -u, bash 3.2
# (macOS /bin/bash) treats "${A[@]}" on an empty array as unbound.
set -euo pipefail

SNAP=${1:?usage: bench/wiki-absorb.sh <snapshot-wiki-dir> [name=flags ...]}
shift
AGENTX=${AGENTX:-agentx}
OUT=${OUT:-${TMPDIR:-/tmp}/wiki-absorb-$(date -u +%Y%m%dT%H%M%SZ)}
ROUNDS=${ROUNDS:-40}
SAMPLE_N=${SAMPLE_N:-40}
SEED=${SEED:-absorb-bench}

if [ "$#" -gt 0 ]; then VARIANTS=("$@"); else VARIANTS=("baseline=--max 10" "batch20=--max 20"); fi

WINDOW=()
[ -n "${SINCE:-}" ] && WINDOW+=(--since "$SINCE")
[ -n "${UNTIL:-}" ] && WINDOW+=(--until "$UNTIL")
JUDGE_FLAG=()
[ "${JUDGE:-}" = "1" ] && JUDGE_FLAG=(--judge)

mkdir -p "$OUT"
for variant in "${VARIANTS[@]}"; do
  v=${variant%%=*}
  flags=${variant#*=}
  [ "$v" != "$variant" ] || { echo "variant must be name=flags: $variant" >&2; exit 2; }
  work="$OUT/$v/wiki"
  rm -rf "$work"; mkdir -p "$OUT/$v"
  cp -a "$SNAP" "$work"
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "== $v ($flags) from $started"
  for round in $(seq 1 "$ROUNDS"); do
    # shellcheck disable=SC2086
    $AGENTX wiki absorb --dir "$work" $flags ${EXTRA:-} ${WINDOW[@]+"${WINDOW[@]}"} --run-label "$v" > "$OUT/$v/round-$round.log" 2>&1 || true
    # Stop once no agent had anything left to absorb.
    grep -q "entries to absorb" "$OUT/$v/round-$round.log" || break
  done
  $AGENTX wiki absorb-eval --dir "$work" --changed-after "$started" --n "$SAMPLE_N" --seed "$SEED" \
    ${JUDGE_FLAG[@]+"${JUDGE_FLAG[@]}"} --out "$OUT/$v/scorecard.md" --json > "$OUT/$v/scorecard.json"
  $AGENTX wiki absorb-runs --dir "$work" --label "$v" --json > "$OUT/$v/runs.json"
  $AGENTX wiki absorb-runs --dir "$work" --label "$v"
done

echo "Results in $OUT (scorecard.md, scorecard.json and runs.json per variant)"
