#!/usr/bin/env bash
# Runs one arm of the LEANN vs BM25 spike (#1390) under asciinema, so the
# recording, the results file and the COMMANDS.md entry share one run id.
#
#   bench/leann-1390/record.sh <state-dir> A
#   bench/leann-1390/record.sh <state-dir> B
#   bench/leann-1390/record.sh <state-dir> C --model BAAI/bge-m3
#
# Writes <state-dir>/casts/<run_id>.cast. Without asciinema it stops
# rather than run unrecorded: every run in the series needs its cast.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <state-dir> A|B|C [extra args]" >&2
  exit 2
fi
state="$1"; arm="$(echo "$2" | tr '[:lower:]' '[:upper:]')"; shift 2
command -v asciinema >/dev/null || { echo "asciinema is not installed (pip install asciinema)" >&2; exit 1; }

run_id="$(date -u +%Y%m%dT%H%M%SZ)-$arm"
here="$(cd "$(dirname "$0")" && pwd)"
case "$arm" in
  A|B) cmd=(pnpm --silent bench:leann run "$state" --arm "$arm" --run-id "$run_id" "$@") ;;
  C)   cmd=(python3 "$here/arm_c_leann.py" "$state" --run-id "$run_id" "$@") ;;
  *)   echo "arm must be A, B or C" >&2; exit 2 ;;
esac

mkdir -p "$state/casts"
cast="$state/casts/$run_id.cast"
printf -v quoted '%q ' "${cmd[@]}"
asciinema rec --quiet --overwrite --command "$quoted" "$cast"
echo "recorded $cast"
