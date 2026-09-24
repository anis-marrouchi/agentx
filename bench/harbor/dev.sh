#!/usr/bin/env bash
# Level 1: cheap A/B runs of agentx against Claude Code on the dev set.
#
#   bench/harbor/dev.sh baseline --yes   # Claude Code, once per model + task list
#   bench/harbor/dev.sh agentx --yes     # agentx built from this checkout
#   bench/harbor/dev.sh compare [JOB]    # task-by-task, B = JOB or the newest agentx job
#
# Both sides bill ANTHROPIC_API_KEY (never the subscription), run the same
# tasks, model and attempt count. A job that already exists is reused, so
# the baseline is paid for once and each agentx attempt only pays for
# itself. Nothing is spent without --yes.
#
# Knobs (environment):
#   DEV_MODEL        default anthropic/claude-haiku-4-5-20251001
#   DEV_ATTEMPTS     attempts per task, default 2
#   DEV_CONCURRENCY  parallel trials, default 2 (a 6 GB Docker VM fits 2)
#   JOBS_DIR         default jobs
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
MODEL="${DEV_MODEL:-anthropic/claude-haiku-4-5-20251001}"
ATTEMPTS="${DEV_ATTEMPTS:-2}"
CONCURRENCY="${DEV_CONCURRENCY:-2}"
JOBS="${JOBS_DIR:-$REPO/jobs}"
SLUG="$(echo "${MODEL#*/}" | tr -c 'a-zA-Z0-9.\n-' '-')"
# Rough per-trial cost at Haiku 4.5 prices; the real figure comes from the report.
EST_PER_TRIAL="0.50"

cmd="${1:-}"; shift || true
yes=0; force=0; arg=""
for a in "$@"; do
  case "$a" in
    --yes) yes=1 ;;
    --force) force=1 ;;
    *) arg="$a" ;;
  esac
done

tasks=()
while read -r line; do
  line="${line%%#*}"; line="${line//[[:space:]]/}"
  [ -n "$line" ] && tasks+=("$line")
done < "$HERE/dev-set.txt"
include=()
for t in "${tasks[@]}"; do include+=(-i "$t"); done

baseline_job="dev-baseline-$SLUG"

need() { command -v "$1" >/dev/null || { echo "dev.sh: $1 not found ($2)" >&2; exit 1; }; }

confirm() {
  local what="$1"
  local trials=$(( ${#tasks[@]} * ATTEMPTS ))
  local est
  est="$(awk -v n="$trials" -v p="$EST_PER_TRIAL" 'BEGIN { printf "%.0f", n * p }')"
  echo "$what: ${#tasks[@]} tasks x $ATTEMPTS attempts = $trials trials on $MODEL (~\$$est, API-billed)"
  if [ "$yes" != 1 ]; then echo "re-run with --yes to spend it"; exit 0; fi
}

api_only_env() {
  [ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "dev.sh: ANTHROPIC_API_KEY is required (dev runs bill the API)" >&2; exit 1; }
  # Keep the subscription out of it entirely.
  unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_FORCE_OAUTH
}

reuse() {
  if [ -d "$JOBS/$1" ] && [ "$force" != 1 ]; then
    echo "$1 exists: reusing it (--force to rerun)"
    exit 0
  fi
  rm -rf "${JOBS:?}/$1"
}

case "$cmd" in
  baseline)
    need harbor "uv tool install harbor"
    reuse "$baseline_job"
    confirm "baseline (claude-code)"
    api_only_env
    harbor run -d terminal-bench@2.0 -a claude-code -m "$MODEL" "${include[@]}" \
      -k "$ATTEMPTS" -n "$CONCURRENCY" -o "$JOBS" --job-name "$baseline_job"
    ;;

  agentx)
    need harbor "uv tool install harbor"
    need pnpm "corepack enable"
    sha="$(git -C "$REPO" rev-parse --short HEAD)"
    [ -z "$(git -C "$REPO" status --porcelain -- src package.json pnpm-lock.yaml)" ] || sha="$sha-dirty"
    job="dev-agentx-$sha-$SLUG"
    reuse "$job"
    confirm "agentx at $sha (claude-code tier)"
    api_only_env
    mkdir -p "$JOBS/pkgs"
    (cd "$REPO" && pnpm -s build >/dev/null)
    packed="$(cd "$REPO" && npm pack --silent --pack-destination "$JOBS/pkgs" | tail -1)"
    tgz="agentx-$sha.tgz"  # npm names it by version, which every commit shares
    mv "$JOBS/pkgs/$packed" "$JOBS/pkgs/$tgz"
    PYTHONPATH="$HERE" harbor run -d terminal-bench@2.0 -a agentx_agent:AgentX -m "$MODEL" \
      --ak tier=claude-code --ak billing=api --ak "tarball=$JOBS/pkgs/$tgz" \
      "${include[@]}" -k "$ATTEMPTS" -n "$CONCURRENCY" -o "$JOBS" --job-name "$job"
    ;;

  compare)
    b="${arg:-$(ls -td "$JOBS"/dev-agentx-*-"$SLUG" 2>/dev/null | head -1 | xargs -n1 basename 2>/dev/null || true)}"
    [ -n "$b" ] || { echo "dev.sh: no agentx job to compare yet" >&2; exit 1; }
    python3 "$HERE/report.py" "$JOBS" --compare "$baseline_job" "$b"
    ;;

  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
