#!/usr/bin/env python3
"""Arm C of the LEANN vs BM25 spike (#1390): LEANN, HNSW, recompute on.

Runs only on the DO box, through devops-agent. See README.md here.

    python3 bench/leann-1390/arm_c_leann.py <state-dir> --model intfloat/multilingual-e5-small
    python3 bench/leann-1390/arm_c_leann.py <state-dir> --model BAAI/bge-m3 --k 10 --run-id <id>

Reads <state-dir>/snapshot/{corpus,questions}.jsonl, builds one LEANN
index per pool under <state-dir>/leann-index/, and writes the same
results-<run_id>.jsonl lines as arms A and B (ids, scores, timings, never
text), a run-<run_id>.meta.json with build time, index size and memory,
and an entry in COMMANDS.md. Grade with `pnpm bench:leann grade`.

Pure semantic search: prebuild_bm25 stays off and vector_weight stays at
1.0, so LEANN's own keyword index plays no part (that would be arm D,
which is not approved).
"""

import argparse
import hashlib
import json
import os
import resource
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def read_jsonl(path):
    out = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                sys.exit(f"{path}:{i}: not JSON")
    return out


def load_snapshot(snap_dir):
    """Same checks and hash as loadSnapshot in lib.ts."""
    corpus_path, questions_path = snap_dir / "corpus.jsonl", snap_dir / "questions.jsonl"
    docs, questions = read_jsonl(corpus_path), read_jsonl(questions_path)
    ids = set()
    for d in docs:
        if not d.get("id") or not isinstance(d.get("text"), str):
            sys.exit(f"corpus entry without id/text: {d.get('id')!r}")
        if d["id"] in ids:
            sys.exit(f"duplicate doc id: {d['id']}")
        ids.add(d["id"])
    qids = set()
    for q in questions:
        if not q.get("qid") or not isinstance(q.get("query"), str):
            sys.exit(f"question without qid/query: {q.get('qid')!r}")
        if q["qid"] in qids:
            sys.exit(f"duplicate qid: {q['qid']}")
        qids.add(q["qid"])
        if not q.get("expected"):
            sys.exit(f"{q['qid']}: no expected ids (unlabelled)")
        for e in q["expected"]:
            if e not in ids:
                sys.exit(f"{q['qid']}: expected id not in corpus: {e}")
    h = hashlib.sha256()
    h.update(corpus_path.read_bytes())
    h.update(questions_path.read_bytes())
    return docs, questions, h.hexdigest()[:16]


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_run_id(arm):
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + arm


def slug(s):
    return "".join(c if c.isalnum() else "-" for c in s).strip("-").lower()


def dir_size(prefix):
    """Bytes of every file LEANN wrote for one index (they share the prefix)."""
    parent, stem = prefix.parent, prefix.name
    return sum(p.stat().st_size for p in parent.iterdir() if p.name.startswith(stem) and p.is_file())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("state_dir")
    ap.add_argument("--model", required=True, help="sentence-transformers model id (multilingual)")
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--run-id")
    ap.add_argument("--complexity", type=int, default=64, help="LEANN search complexity (its default)")
    ap.add_argument("--query-prefix", help='default "query: " for e5 models, else none')
    ap.add_argument("--passage-prefix", help='default "passage: " for e5 models, else none')
    ap.add_argument("--rebuild", action="store_true", help="rebuild indexes that already exist")
    args = ap.parse_args()

    try:
        import leann
        from leann import LeannBuilder, LeannSearcher
    except ImportError:
        sys.exit("leann is not installed: uv pip install leann (see README.md)")

    # e5 models were trained with these prefixes; LEANN does not add them.
    e5 = "e5" in args.model.lower()
    qpre = args.query_prefix if args.query_prefix is not None else ("query: " if e5 else "")
    ppre = args.passage_prefix if args.passage_prefix is not None else ("passage: " if e5 else "")

    state = Path(args.state_dir)
    docs, questions, snap_hash = load_snapshot(state / "snapshot")
    run_id = args.run_id or new_run_id("C")
    variant = f"leann-hnsw-{slug(args.model)}"
    k = max(1, args.k)

    meta = {
        "run_id": run_id, "arm": "C", "variant": variant, "snapshot": snap_hash,
        "model": args.model, "query_prefix": qpre, "passage_prefix": ppre,
        "leann_version": getattr(leann, "__version__", "unknown"),
        "python": sys.version.split()[0], "complexity": args.complexity,
        "recompute_embeddings": True, "pools": {}, "started": now_iso(),
    }

    pools = {}

    def pool_for(kind):
        key = kind or "all"
        if key in pools:
            return pools[key]
        sel = [d for d in docs if not kind or d.get("kind") == kind]
        prefix = state / "leann-index" / f"{slug(args.model)}-{snap_hash}" / f"{key}.leann"
        prefix.parent.mkdir(parents=True, exist_ok=True)
        built = False
        t0 = time.perf_counter()
        if args.rebuild or not Path(str(prefix) + ".meta.json").exists():
            b = LeannBuilder(backend_name="hnsw", embedding_model=args.model, embedding_mode="sentence-transformers")
            for d in sel:
                b.add_text(ppre + d["text"], metadata={"note_id": d["id"]})
            b.build_index(str(prefix))
            built = True
        build_s = time.perf_counter() - t0
        searcher = LeannSearcher(str(prefix), recompute_embeddings=True)
        t1 = time.perf_counter()
        searcher.search(qpre + "warm up", top_k=1, complexity=args.complexity)
        cold_ms = (time.perf_counter() - t1) * 1000
        meta["pools"][key] = {
            "docs": len(sel), "built_now": built, "build_s": round(build_s, 3) if built else None,
            "index_bytes": dir_size(prefix), "first_query_ms": round(cold_ms, 1),
        }
        pools[key] = searcher
        return searcher

    # Written as .partial and renamed at the end, as in run.ts: the grader
    # reads only finished runs.
    out_path = state / f"results-{run_id}.jsonl"
    partial = state / f"results-{run_id}.jsonl.partial"
    partial.write_text("")
    print(f"run {run_id}  arm C ({variant})  snapshot {snap_hash}  {len(questions)} questions  k={k}")
    with partial.open("a", encoding="utf-8") as out:
        for q in questions:
            searcher = pool_for(q.get("kind"))
            t0 = time.perf_counter()
            res = searcher.search(qpre + q["query"], top_k=k, complexity=args.complexity)
            latency = (time.perf_counter() - t0) * 1000
            hits = [{"id": r.metadata.get("note_id", r.id), "score": round(float(r.score), 4)} for r in res][:k]
            rank = next((i + 1 for i, h in enumerate(hits) if h["id"] in q["expected"]), None)
            line = {
                "ts": now_iso(), "run_id": run_id, "arm": "C", "variant": variant, "snapshot": snap_hash,
                "qid": q["qid"], "lang": q.get("lang"), "type": q.get("type"), "k": k,
                "latency_ms": round(latency, 4), "hits": hits, "expected": q["expected"], "first_hit_rank": rank,
            }
            out.write(json.dumps(line, ensure_ascii=False) + "\n")
            top = " ".join(f"{h['id']}:{h['score']}" for h in hits[:3]) or "(no results)"
            print(f"{q['qid']:<10} {str(q.get('lang')):<6} rank {str(rank or '-'):<3} {top}")

    partial.rename(out_path)

    # ru_maxrss is KiB on Linux. LEANN's embedding server may run as a
    # separate daemon that neither figure covers; README says how to
    # measure it.
    meta["peak_rss_kib_self"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    meta["peak_rss_kib_children"] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    meta["finished"] = now_iso()
    (state / f"run-{run_id}.meta.json").write_text(json.dumps(meta, indent=2) + "\n")

    try:
        commit = subprocess.run(["git", "describe", "--always", "--dirty"], capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        commit = "unknown"
    cmd = shlex.join(["python3", os.path.relpath(sys.argv[0])] + sys.argv[1:])
    with (state / "COMMANDS.md").open("a", encoding="utf-8") as f:
        f.write(f"\n## {run_id}\n\n- when: {now_iso()}\n- agentx commit: {commit}\n- snapshot: {snap_hash}\n"
                f"- leann: {meta['leann_version']}, python {meta['python']}\n\n```bash\n{cmd}\n```\n")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
