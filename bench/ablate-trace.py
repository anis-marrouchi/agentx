# Ablation for #455: add one lean-AgentX ingredient at a time to the bare
# Claude Code CLI on the `trace` task, and record the number of model calls
# and whether the first call already read the source (or only surveyed the
# files with `ls` / `wc -l`). Results: results/ablation-trace-sonnet-5-5.jsonl,
# read in results/token-test-sonnet-5-5.md.
#
#   python3 bench/ablate-trace.py 10 bare,lean       # runs per variant, variants
#
# Inputs in ABLATE_DIR (default: this script's folder):
#   template/          the trace project (writeFixture from compare-claude-code.ts)
#   prompt.txt         the trace prompt
#   argv-lean.json     the argv `agentx exec --profile lean` gives the claude CLI,
#                      captured with a fake `claude` on PATH that dumps its argv
#   CLAUDE.md, AGENTS.md, dotclaude/   the files `--setup-workspace` writes
#   code-quality-no300.md              the code-quality rule without the 300-line line
# Every run calls the model (about $0.07 a run on Sonnet 5.5).
import json, os, re, shutil, subprocess, sys, glob, time
S = os.environ.get("ABLATE_DIR") or os.path.dirname(os.path.abspath(__file__))
lean = json.load(open(f"{S}/argv-lean.json"))
WRAPPED, APPEND, MCP = lean[1], lean[8], lean[11]
PROMPT = open(f"{S}/prompt.txt").read().strip()
VARIANTS = {
    "bare":   dict(),
    "prompt": dict(prompt=True),
    "append": dict(append=True),
    "mcp":    dict(mcp=True),
    "files":  dict(files=True),
    "lean":   dict(prompt=True, append=True, mcp=True, files=True, sources=True),
    "rules":    dict(files=["rules"]),
    "settings": dict(files=["settings"]),
    "md":       dict(files=["md"]),
    "lean-no300": dict(prompt=True, append=True, mcp=True, files=["md", "settings", "testing-rule", "no300"], sources=True),
    "lean-norule": dict(prompt=True, append=True, mcp=True, files=["md", "settings", "testing-rule"], sources=True),
}
only = sys.argv[2].split(",") if len(sys.argv) > 2 else list(VARIANTS)
runs = int(sys.argv[1]) if len(sys.argv) > 1 else 10
out = f"{S}/results.jsonl"
projects = os.path.expanduser("~/.claude/projects")

def session_log(work):
    key = re.sub(r"[^A-Za-z0-9]", "-", work)
    fs = glob.glob(f"{projects}/{key}/*.jsonl")
    return fs[0] if fs else None

def analyse(log):
    calls, first_result, order = {}, None, []
    seen_first_call = False
    for l in open(log):
        e = json.loads(l)
        if e.get("type") == "assistant":
            mid = e["message"].get("id")
            if mid not in calls: calls[mid] = []; order.append(mid)
            for c in e["message"].get("content", []):
                if c.get("type") == "tool_use": calls[mid].append(c["name"] + ":" + json.dumps(c.get("input"))[:200])
        if e.get("type") == "user" and len(order) == 1 and first_result is None:
            content = e["message"].get("content")
            if isinstance(content, list):
                texts = []
                for c in content:
                    if c.get("type") == "tool_result":
                        cc = c.get("content")
                        texts.append(cc if isinstance(cc, str) else json.dumps(cc))
                if texts: first_result = "\n".join(texts)
    read_src = bool(first_result) and ("const CODES" in first_result or "export function checkout" in first_result)
    return len(order), read_src, [calls[m] for m in order]

for n in range(1, runs + 1):
    for name in only:
        v = VARIANTS[name]
        work = f"{S}/runs/{name}-{n}/work"
        shutil.copytree(f"{S}/template", work)
        files = v.get("files")
        if files is True: files = ["md", "settings", "rules"]
        if files:
            os.makedirs(f"{work}/.claude/rules", exist_ok=True)
            if "md" in files: shutil.copy(f"{S}/CLAUDE.md", work); shutil.copy(f"{S}/AGENTS.md", work)
            if "settings" in files: shutil.copy(f"{S}/dotclaude/settings.json", f"{work}/.claude/")
            if "rules" in files or "testing-rule" in files: shutil.copy(f"{S}/dotclaude/rules/testing.md", f"{work}/.claude/rules/")
            if "rules" in files: shutil.copy(f"{S}/dotclaude/rules/code-quality.md", f"{work}/.claude/rules/")
            if "no300" in files: shutil.copy(f"{S}/code-quality-no300.md", f"{work}/.claude/rules/code-quality.md")
        args = ["claude", "-p", WRAPPED if v.get("prompt") else PROMPT, "--output-format", "json",
                "--model", "claude-sonnet-5-5", "--dangerously-skip-permissions"]
        if v.get("append"): args += ["--append-system-prompt", APPEND]
        if v.get("mcp"): args += ["--strict-mcp-config", "--mcp-config", MCP]
        if v.get("sources"): args += ["--setting-sources", "project,local"]
        t = time.time()
        r = subprocess.run(args, cwd=work, capture_output=True, text=True, timeout=600)
        try: d = json.loads(r.stdout)
        except Exception: d = {"is_error": True, "result": r.stderr[-300:]}
        u = d.get("usage", {})
        tokens = sum(u.get(k, 0) for k in ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])
        ok = subprocess.run(["node", "--test"], cwd=work, capture_output=True).returncode == 0
        log = session_log(work)
        ncalls, read_src, calls = analyse(log) if log else (None, None, [])
        rec = dict(variant=name, run=n, ok=ok, error=d.get("is_error"), tokens=tokens, cost=d.get("total_cost_usd"),
                   calls=ncalls, first_call_read_src=read_src, wall=round(time.time() - t, 1), tool_calls=calls)
        open(out, "a").write(json.dumps(rec) + "\n")
        print(f"{name} {n}: ok={ok} calls={ncalls} first_read_src={read_src} tokens={tokens} cost={d.get('total_cost_usd')}", flush=True)
