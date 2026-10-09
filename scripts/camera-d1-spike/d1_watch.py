#!/usr/bin/env python3
# Spike for issue #844: Liquid AI's open d1 decision models as a local watcher
# on the phone camera share. Demo only; nothing here is wired into AgentX.
# See README.md next to this file.
#
#   python d1_watch.py bench --set DIR [--target "a phone on the floor" ...]
#   python d1_watch.py watch --frames DIR --target "a phone on the floor" ...
#
# bench: runs every picture in DIR against every target and prints accuracy,
#        latency per frame and memory. DIR/labels.json maps a file name to the
#        targets that ARE in that picture; every other target counts as absent.
# watch: polls DIR for new frame-*.png files (the camera share with
#        camera.bot.keepFrames on) and raises an alert when a target shows up
#        on --hits frames in a row. Alerts are a local Mac banner by default;
#        --notify also sends the alert TEXT (never the picture) through
#        `agentx notify`.
#
# Everything runs on this machine. After the first download, set
# HF_HUB_OFFLINE=1 (or pass --offline) so nothing is fetched or sent.

from __future__ import annotations

import argparse
import json
import os
import resource
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_MODEL = "LiquidAI/d1-3B"
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}


def question_key(i: int) -> str:
    return f"t{i}"


def build_questions(targets: list[str]) -> dict:
    """One yes/no question per named target, all asked in a single pass.

    Uses the "choice" type because that is the one the published image
    example shows; a two-way choice is a yes/no."""
    return {
        question_key(i): {
            "type": "choice",
            "instructions": f"Is there {t} in this picture?",
            "criteria": {"yes": f"{t} is clearly visible", "no": f"there is no {t} in the picture"},
        }
        for i, t in enumerate(targets)
    }


def yes_probability(result, key: str) -> float:
    """P(yes) for one question from whatever system_one returned.

    The model card's exact return shape was not reachable when this was
    written, so this accepts the plausible ones and fails loudly otherwise
    (run with --raw to see what came back)."""
    if isinstance(result, (list, tuple)) and len(result) == 1:
        result = result[0]
    if not isinstance(result, dict) or key not in result:
        raise ValueError(f"no answer for {key!r} in {result!r}")
    a = result[key]
    if isinstance(a, str):
        return 1.0 if a.strip().lower() == "yes" else 0.0
    if not isinstance(a, dict):
        raise ValueError(f"unexpected answer for {key!r}: {a!r}")
    probs = a.get("probabilities") or a.get("probs") or a.get("scores")
    if isinstance(probs, dict) and "yes" in probs:
        return float(probs["yes"])
    for name in ("choice", "answer", "label", "decision", "value"):
        if isinstance(a.get(name), str):
            picked = a[name].strip().lower() == "yes"
            conf = a.get("confidence")
            if isinstance(conf, (int, float)):
                return float(conf) if picked else 1.0 - float(conf)
            return 1.0 if picked else 0.0
    raise ValueError(f"unexpected answer for {key!r}: {a!r}")


# ---------------------------------------------------------------- model


def pick_device(want: str | None) -> str:
    import torch

    if want:
        return want
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model(name: str, device: str):
    import torch
    from transformers import AutoModel

    dtype = torch.float32 if device == "cpu" else torch.bfloat16
    model = AutoModel.from_pretrained(name, trust_remote_code=True, dtype=dtype).to(device)
    model.eval()
    return model


def sync(device: str) -> None:
    import torch

    if device == "mps":
        torch.mps.synchronize()
    elif device == "cuda":
        torch.cuda.synchronize()


def ask(model, device: str, image_path: Path, questions: dict):
    """One forward pass on one picture; returns (result, seconds in the model)."""
    import torch
    from PIL import Image

    with Image.open(image_path) as im:
        photo = im.convert("RGB")
    t0 = time.perf_counter()
    with torch.inference_mode():
        result = model.system_one(None, questions, images=[photo])
    sync(device)
    return result, time.perf_counter() - t0


def memory_mb(device: str) -> dict:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # ru_maxrss is bytes on macOS, kilobytes on Linux.
    peak_mb = peak / (1024 * 1024) if sys.platform == "darwin" else peak / 1024
    out = {"process_peak_rss_mb": round(peak_mb)}
    try:
        import torch

        if device == "mps":
            out["mps_driver_mb"] = round(torch.mps.driver_allocated_memory() / 2**20)
        elif device == "cuda":
            out["cuda_peak_mb"] = round(torch.cuda.max_memory_allocated() / 2**20)
    except Exception:
        pass
    return out


# ---------------------------------------------------------------- bench


@dataclass
class Tally:
    tp: int = 0
    fp: int = 0
    fn: int = 0
    tn: int = 0
    misses: list[str] = field(default_factory=list)

    def add(self, said: bool, truth: bool, name: str) -> None:
        if said and truth:
            self.tp += 1
        elif said:
            self.fp += 1
            self.misses.append(f"false alarm: {name}")
        elif truth:
            self.fn += 1
            self.misses.append(f"missed: {name}")
        else:
            self.tn += 1

    @property
    def total(self) -> int:
        return self.tp + self.fp + self.fn + self.tn

    @property
    def accuracy(self) -> float:
        return (self.tp + self.tn) / self.total if self.total else 0.0


def load_labels(set_dir: Path) -> tuple[list[Path], dict[str, list[str]], list[str]]:
    labels_file = set_dir / "labels.json"
    if not labels_file.exists():
        raise SystemExit(f"{labels_file} is missing; see README.md for its format")
    raw = json.loads(labels_file.read_text())
    labels = {k: list(v) for k, v in raw.get("images", raw).items() if k != "targets"}
    targets = list(raw.get("targets", []))
    images = sorted(p for p in set_dir.iterdir() if p.suffix.lower() in IMAGE_EXT)
    unlabelled = [p.name for p in images if p.name not in labels]
    if unlabelled:
        raise SystemExit(f"no entry in labels.json for: {', '.join(unlabelled)} (use [] for 'none of the targets')")
    return images, labels, targets


def percentile(xs: list[float], p: float) -> float:
    s = sorted(xs)
    return s[min(len(s) - 1, round(p * (len(s) - 1)))]


def score_set(images: list[Path], labels: dict[str, list[str]], targets: list[str], answer, threshold: float):
    """Run `answer(path) -> {target: P(yes)}` over the set; returns tallies."""
    per_target = {t: Tally() for t in targets}
    overall = Tally()
    for path in images:
        probs = answer(path)
        present = set(labels[path.name])
        for t in targets:
            said = probs[t] >= threshold
            truth = t in present
            per_target[t].add(said, truth, path.name)
            overall.add(said, truth, f"{path.name} / {t}")
    return per_target, overall


def cmd_bench(a) -> int:
    set_dir = Path(a.set).expanduser()
    images, labels, set_targets = load_labels(set_dir)
    targets = a.target or set_targets
    if not targets:
        raise SystemExit("name at least one --target, or list them under \"targets\" in labels.json")
    if not images:
        raise SystemExit(f"no pictures in {set_dir}")
    questions = build_questions(targets)
    device = pick_device(a.device)
    t0 = time.perf_counter()
    model = load_model(a.model, device)
    load_s = time.perf_counter() - t0

    # The first pass compiles kernels on MPS; keep it out of the figures.
    ask(model, device, images[0], questions)
    latencies: list[float] = []

    def answer(path: Path) -> dict[str, float]:
        result, secs = ask(model, device, path, questions)
        latencies.append(secs)
        if a.raw:
            print(f"{path.name}: {result!r}")
        return {t: yes_probability(result, question_key(i)) for i, t in enumerate(targets)}

    per_target, overall = score_set(images, labels, targets, answer, a.threshold)
    mem = memory_mb(device)

    print(f"\nModel {a.model} on {device}, loaded in {load_s:.1f} s; {len(images)} pictures x {len(targets)} targets, threshold {a.threshold}\n")
    print("| Target | Right | Wrong | Missed | False alarms |")
    print("|---|---|---|---|---|")
    for t, s in per_target.items():
        print(f"| {t} | {s.tp + s.tn}/{s.total} | {s.fp + s.fn} | {s.fn} | {s.fp} |")
    print(f"| **All** | **{overall.tp + overall.tn}/{overall.total}** ({overall.accuracy:.0%}) | {overall.fp + overall.fn} | {overall.fn} | {overall.fp} |")
    print(f"\nLatency per frame (all targets in one pass): median {statistics.median(latencies) * 1000:.0f} ms, "
          f"p95 {percentile(latencies, 0.95) * 1000:.0f} ms, max {max(latencies) * 1000:.0f} ms")
    print("Memory: " + ", ".join(f"{k} {v}" for k, v in mem.items()))
    if overall.misses:
        print("\nWrong answers:\n" + "\n".join(f"- {m}" for m in overall.misses))

    if a.out:
        Path(a.out).expanduser().write_text(json.dumps({
            "model": a.model, "device": device, "load_seconds": load_s, "threshold": a.threshold,
            "targets": targets, "pictures": len(images),
            "per_target": {t: vars(s) for t, s in per_target.items()},
            "accuracy": overall.accuracy, "latency_seconds": latencies, "memory_mb": mem,
        }, indent=2))
    return 0


# ---------------------------------------------------------------- watch


class Debounce:
    """Alert once a target is seen on `hits` frames in a row, then stay quiet
    for `cooldown` seconds for that target."""

    def __init__(self, hits: int, cooldown: float):
        self.hits = hits
        self.cooldown = cooldown
        self.streak: dict[str, int] = {}
        self.last: dict[str, float] = {}

    def see(self, target: str, seen: bool, now: float) -> bool:
        self.streak[target] = self.streak.get(target, 0) + 1 if seen else 0
        if self.streak[target] < self.hits:
            return False
        if now - self.last.get(target, float("-inf")) < self.cooldown:
            return False
        self.last[target] = now
        return True


def alert(text: str, use_agentx: bool) -> None:
    print(f"ALERT {time.strftime('%H:%M:%S')}: {text}", flush=True)
    if sys.platform == "darwin":
        script = f'display notification {json.dumps(text)} with title "Camera watcher" sound name "Glass"'
        subprocess.run(["osascript", "-e", script], check=False)
    if use_agentx:
        subprocess.run(["agentx", "notify", "--title", "Camera watcher", text], check=False)


def new_frames(root: Path, seen: set[Path]) -> list[Path]:
    found = sorted(p for p in root.rglob("frame-*.png") if p not in seen)
    seen.update(found)
    return found


def cmd_watch(a) -> int:
    root = Path(a.frames).expanduser()
    targets = a.target
    if not targets:
        raise SystemExit("name at least one --target")
    questions = build_questions(targets)
    device = pick_device(a.device)
    model = load_model(a.model, device)
    gate = Debounce(a.hits, a.cooldown)
    seen: set[Path] = set()
    if not a.include_existing and root.exists():
        new_frames(root, seen)
    print(f"Watching {root} for: {', '.join(targets)} (model {a.model} on {device}). Ctrl-C stops.", flush=True)
    try:
        while True:
            frames = new_frames(root, seen) if root.exists() else []
            # Only the newest frame matters for a live watch; skip a backlog.
            for path in frames[-1:]:
                try:
                    result, secs = ask(model, device, path, questions)
                except OSError as e:  # file still being written, or deleted under us
                    print(f"skip {path.name}: {e}", flush=True)
                    continue
                now = time.time()
                parts = []
                for i, t in enumerate(targets):
                    p = yes_probability(result, question_key(i))
                    parts.append(f"{t}={p:.2f}")
                    if gate.see(t, p >= a.threshold, now):
                        alert(f"I can see {t}.", a.notify)
                print(f"{path.name} {secs * 1000:.0f} ms  " + "  ".join(parts), flush=True)
            time.sleep(a.poll)
    except KeyboardInterrupt:
        print("\nstopped; " + ", ".join(f"{k} {v}" for k, v in memory_mb(device).items()))
    return 0


# ---------------------------------------------------------------- cli


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Local d1 watcher spike for the AgentX camera share (issue #844)")
    p.add_argument("--model", default=os.environ.get("AGENTX_D1_MODEL", DEFAULT_MODEL), help=f"Hugging Face id or local folder (default {DEFAULT_MODEL})")
    p.add_argument("--device", choices=["mps", "cpu", "cuda"], help="default: mps on a Mac")
    p.add_argument("--threshold", type=float, default=0.7, help="P(yes) needed to count a target as seen (default 0.7)")
    p.add_argument("--offline", action="store_true", help="refuse any network fetch (same as HF_HUB_OFFLINE=1)")
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("bench", help="accuracy, latency and memory on a labelled set")
    b.add_argument("--set", required=True, help="folder of pictures plus labels.json")
    b.add_argument("--target", action="append", help="a named target; repeat for more (default: labels.json targets)")
    b.add_argument("--raw", action="store_true", help="print what the model returned for each picture")
    b.add_argument("--out", help="also write the figures as JSON here")

    w = sub.add_parser("watch", help="alert on new camera-share frames")
    w.add_argument("--frames", required=True, help="folder the share writes frames into (searched recursively)")
    w.add_argument("--target", action="append", required=True, help="a named target; repeat for more")
    w.add_argument("--hits", type=int, default=2, help="frames in a row before an alert (default 2)")
    w.add_argument("--cooldown", type=float, default=60, help="seconds before the same target alerts again (default 60)")
    w.add_argument("--poll", type=float, default=0.5, help="seconds between folder checks (default 0.5)")
    w.add_argument("--include-existing", action="store_true", help="also look at frames already in the folder")
    w.add_argument("--notify", action="store_true", help="also send the alert text with `agentx notify` (leaves the Mac as a push)")

    a = p.parse_args(argv)
    if a.offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
    return cmd_bench(a) if a.cmd == "bench" else cmd_watch(a)


if __name__ == "__main__":
    sys.exit(main())
