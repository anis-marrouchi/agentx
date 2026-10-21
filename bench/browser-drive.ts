/**
 * Browser driving spike (#1118): where does the time go when an agent drives
 * a browser, and does a small model picking the target make it faster?
 *
 * One fixed task on a local, harmless test site: open a registration form,
 * fill eight fields, submit, confirm the reference number. The browser is the
 * agent Chrome (CDP, port 9222 by default) driven through the real
 * chrome-devtools MCP server, so snapshot sizes and tool timings are the ones
 * an agent sees.
 *
 * Modes:
 *   baseline  one model, one action per turn, a fresh snapshot every turn,
 *             all earlier snapshots kept in the conversation (how an agent
 *             loop behaves today)
 *   picker    the big model plans once; the small model maps each target
 *             ("the work email field") to a snapshot uid; fills one by one
 *   batch     as picker, but the small model maps every target in one call
 *             and the fills go out as one fill_form
 *   oneshot   the big model alone returns every uid in one call, then
 *             fill_form (separates "small model" from "batching")
 *
 * Backends:
 *   anthropic real model calls (ANTHROPIC_API_KEY)
 *   oracle    no model: targets are matched by label in code. Gives the floor
 *             (browser + MCP time only) and runs anywhere.
 *
 * Usage:
 *   tsx bench/browser-drive.ts --backend oracle --runs 3
 *   tsx bench/browser-drive.ts --backend anthropic --runs 3 \
 *     --big claude-sonnet-5-5 --small claude-haiku-5-5
 *
 * Raw timings go to <out>/<stamp>/raw.jsonl, the table to summary.md.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// ── Options ──────────────────────────────────────────────────────────────────

type Mode = "baseline" | "picker" | "batch" | "oneshot";
const ALL_MODES: Mode[] = ["baseline", "picker", "batch", "oneshot"];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const opts = {
  runs: Number(arg("runs", "3")),
  modes: arg("modes", ALL_MODES.join(",")).split(",") as Mode[],
  backend: arg("backend", "anthropic") as "anthropic" | "oracle",
  big: arg("big", "claude-sonnet-5-5"),
  small: arg("small", "claude-haiku-5-5"),
  cdp: arg("cdp", "http://127.0.0.1:9222"),
  mcpBin: arg("mcp-bin", ""),
  out: arg("out", "state/browser-spike"),
  maxTurns: Number(arg("max-turns", "20")),
};

for (const m of opts.modes) {
  if (!ALL_MODES.includes(m)) throw new Error(`unknown mode ${m}`);
}
if (opts.backend === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Use --backend oracle for a run without a model.");
  process.exit(2);
}

// ── The task and the test site ──────────────────────────────────────────────

const EXPECTED: Record<string, string> = {
  fullName: "Sam Rivera",
  email: "sam.rivera@example.org",
  phone: "+1 555 0100",
  company: "Example Labs",
  country: "Tunisia",
  session: "afternoon",
  notes: "Vegetarian meal please",
  agree: "yes",
};

const TASK = (url: string) =>
  `Open ${url} and register for the workshop with these details: ` +
  `name Sam Rivera, email sam.rivera@example.org, phone +1 555 0100, ` +
  `company Example Labs, country Tunisia, the afternoon session, ` +
  `note "Vegetarian meal please", and agree to the code of conduct. ` +
  `Submit, then confirm the registration was received and report the reference number.`;

// Natural descriptions the planner is expected to produce; the oracle maps
// them by label. role + name pattern as they appear in a chrome-devtools snapshot.
const ORACLE_TARGETS: Record<string, { role: string; name: RegExp; value: string }> = {
  fullName: { role: "textbox", name: /^Full name/, value: EXPECTED.fullName },
  email: { role: "textbox", name: /^Work email/, value: EXPECTED.email },
  phone: { role: "textbox", name: /^Phone/, value: EXPECTED.phone },
  company: { role: "textbox", name: /^Company/, value: EXPECTED.company },
  country: { role: "combobox", name: /^Country/, value: EXPECTED.country },
  session: { role: "radio", name: /^Afternoon/, value: "true" },
  notes: { role: "textbox", name: /^Anything we should know/, value: EXPECTED.notes },
  agree: { role: "checkbox", name: /code of conduct/, value: "true" },
};

const COUNTRIES = [
  "Algeria", "Argentina", "Australia", "Brazil", "Canada", "Egypt", "France",
  "Germany", "India", "Italy", "Japan", "Kenya", "Mexico", "Morocco",
  "Netherlands", "Nigeria", "Spain", "Tunisia", "United Kingdom", "United States",
];

type Submission = Record<string, string>;

function formPage(): string {
  const nav = ["Home", "Program", "Speakers", "Venue", "Travel", "Sponsors", "FAQ", "Blog", "Contact", "Sign in"]
    .map((l) => `<a href="#${l.toLowerCase()}">${l}</a>`)
    .join(" ");
  const options = COUNTRIES.map((c) => `<option>${c}</option>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Community Workshop</title></head><body>
<header><nav>${nav}</nav>
<form action="/search" role="search"><label>Search <input type="search" name="q"></label><button>Go</button></form></header>
<main>
<h1>Community Workshop 2026</h1>
<p>A day of hands-on sessions for people who build with open tools. Seats are limited; registration closes one week before the event.</p>
<p>Morning: introductions and lightning talks. Afternoon: small-group labs. Lunch is provided.</p>
<h2>Register</h2>
<form action="/register" method="post">
<p><label>Full name <input name="fullName" required></label></p>
<p><label>Work email <input type="email" name="email" required></label></p>
<p><label>Phone <input type="tel" name="phone"></label></p>
<p><label>Company <input name="company"></label></p>
<p><label>Country <select name="country"><option value="">Choose…</option>${options}</select></label></p>
<fieldset><legend>Session</legend>
<label><input type="radio" name="session" value="morning"> Morning</label>
<label><input type="radio" name="session" value="afternoon"> Afternoon</label></fieldset>
<p><label>Anything we should know? <textarea name="notes"></textarea></label></p>
<p><label><input type="checkbox" name="agree" value="yes"> I agree to the code of conduct</label></p>
<p><button type="submit">Register</button> <a href="#">Cancel</a></p>
</form>
</main>
<footer>
<form action="/newsletter" method="post"><label>Email address <input type="email" name="newsletter"></label><button>Subscribe</button></form>
<p><a href="#privacy">Privacy</a> <a href="#terms">Terms</a> <a href="#press">Press</a></p>
</footer></body></html>`;
}

function thanksPage(ref: string, s: Submission): string {
  const rows = Object.entries(s)
    .map(([k, v]) => `<li>${k}: ${v.replace(/[<&]/g, "")}</li>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Registered</title></head><body>
<h1>Registration received</h1><p>Your reference: ${ref}</p><ul>${rows}</ul><p><a href="/">Back</a></p></body></html>`;
}

function startSite(): Promise<{ server: Server; url: string; submissions: Submission[]; newsletterHits: () => number; lastRef: () => string }> {
  const submissions: Submission[] = [];
  let newsletter = 0;
  let ref = "";
  const server = createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const s = Object.fromEntries(new URLSearchParams(body));
        if (req.url === "/newsletter") {
          newsletter++;
          res.writeHead(200, { "content-type": "text/html" }).end("<h1>Subscribed</h1>");
          return;
        }
        submissions.push(s);
        ref = `WS-${1000 + submissions.length}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        res.writeHead(200, { "content-type": "text/html" }).end(thanksPage(ref, s));
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(formPage());
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}/`, submissions, newsletterHits: () => newsletter, lastRef: () => ref });
    }),
  );
}

// ── Minimal MCP client (stdio, newline-delimited JSON-RPC) ──────────────────

class Mcp {
  private proc: ChildProcess;
  private buf = "";
  private nextId = 0;
  private pending = new Map<number, (m: any) => void>();

  constructor(cmd: string, args: string[]) {
    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
    this.proc.stdout!.on("data", (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          this.pending.get(m.id)?.(m);
          this.pending.delete(m.id);
        } catch {
          // not a JSON-RPC line
        }
      }
    });
  }

  private rpc(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async init(): Promise<void> {
    await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "browser-drive-bench", version: "0" } });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  /** Calls a tool; returns its text and how long it took. */
  async tool(name: string, args: Record<string, unknown>): Promise<{ text: string; ms: number; error: boolean }> {
    const t = performance.now();
    const m = await this.rpc("tools/call", { name, arguments: args });
    const ms = performance.now() - t;
    if (m.error) return { text: String(m.error.message), ms, error: true };
    const text = (m.result.content ?? []).map((c: any) => c.text ?? "").join("\n");
    return { text, ms, error: Boolean(m.result.isError) || /^Error:/m.test(text) };
  }

  close(): void {
    this.proc.kill();
  }
}

// ── Model backends ──────────────────────────────────────────────────────────

type Msg = { role: "user" | "assistant"; content: string };
type ModelReply = { text: string; ms: number; inputTokens?: number; outputTokens?: number };

async function callAnthropic(model: string, system: string, messages: Msg[]): Promise<ModelReply> {
  const base = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const t = performance.now();
  const r = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: 1024, system, messages }),
  });
  const body: any = await r.json();
  const ms = performance.now() - t;
  if (!r.ok) throw new Error(`${model}: ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
  const text = (body.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  return { text, ms, inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens };
}

function parseJson(text: string): any {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error(`no JSON in reply: ${text.slice(0, 200)}`);
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  return JSON.parse(text.slice(start, end + 1));
}

/** Parses "uid=1_4 combobox "Country " ..." lines of a chrome-devtools snapshot. */
function snapshotNodes(snapshot: string): { uid: string; role: string; name: string }[] {
  const out: { uid: string; role: string; name: string }[] = [];
  for (const line of snapshot.split("\n")) {
    const m = line.match(/uid=(\S+) (\w+)(?: "([^"]*)")?/);
    if (m) out.push({ uid: m[1], role: m[2], name: (m[3] ?? "").trim() });
  }
  return out;
}

function oracleUid(snapshot: string, key: string): string {
  const t = ORACLE_TARGETS[key];
  return snapshotNodes(snapshot).find((n) => n.role === t.role && t.name.test(n.name))?.uid ?? "";
}

function oracleSubmitUid(snapshot: string): string {
  return snapshotNodes(snapshot).find((n) => n.role === "button" && n.name === "Register")?.uid ?? "";
}

function referenceIn(snapshot: string): string {
  return snapshot.match(/WS-\d+-[A-Z0-9]+/)?.[0] ?? "";
}

// What the planner hands the picker: a description plus the value to set.
type Step = { target: string; value: string };
type Pick = { uid: string; value: string };

const ORACLE_REPLY: ModelReply = { text: "", ms: 0 };

const SYSTEM_DRIVER =
  "You drive a web browser through a page snapshot (accessibility tree). Each element has a uid. " +
  "Reply with ONE JSON object and nothing else.";

// ── Measurement record ──────────────────────────────────────────────────────

type Rec = {
  run: number;
  mode: Mode;
  backend: string;
  step: number;
  kind: "navigate" | "read" | "plan" | "pick" | "decide" | "fill" | "fill_form" | "click" | "wait" | "verify";
  ms: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  snapshotChars?: number;
  snapshotTokensEst?: number;
  detail?: string;
  error?: boolean;
};

const est = (s: string) => Math.ceil(s.length / 4);

// ── One run ─────────────────────────────────────────────────────────────────

type RunResult = {
  run: number;
  mode: Mode;
  ok: boolean;
  totalMs: number;
  wrongTargets: number;
  toolErrors: number;
  reportedRef: string;
  serverRef: string;
  recs: Rec[];
};

async function runOnce(mode: Mode, run: number, mcp: Mcp, site: Awaited<ReturnType<typeof startSite>>): Promise<RunResult> {
  const recs: Rec[] = [];
  let step = 0;
  const rec = (r: Omit<Rec, "run" | "mode" | "backend" | "step">) => recs.push({ run, mode, backend: opts.backend, step: step++, ...r });
  const before = site.submissions.length;
  const newsletterBefore = site.newsletterHits();
  const t0 = performance.now();

  const opened = await mcp.tool("new_page", { url: site.url });
  const pageId = Number(opened.text.match(/^(\d+):.*\[selected\]/m)?.[1]);
  rec({ kind: "navigate", ms: opened.ms, error: opened.error || !pageId });

  const read = async (kind: "read" | "verify" = "read") => {
    const s = await mcp.tool("take_snapshot", { pageId });
    rec({ kind, ms: s.ms, snapshotChars: s.text.length, snapshotTokensEst: est(s.text), error: s.error });
    return s.text;
  };
  const act = async (kind: "fill" | "click" | "fill_form", args: Record<string, unknown>) => {
    const tool = kind;
    const r = await mcp.tool(tool, { pageId, ...args });
    rec({ kind, ms: r.ms, detail: JSON.stringify(args).slice(0, 300), error: r.error });
    return r;
  };
  const waitConfirm = async () => {
    const w = await mcp.tool("wait_for", { pageId, text: ["Registration received"], timeout: 10000 });
    rec({ kind: "wait", ms: w.ms, error: w.error });
  };
  const model = async (kind: "plan" | "pick" | "decide" | "verify", which: string, system: string, messages: Msg[], snapshot?: string): Promise<ModelReply> => {
    const r = await callAnthropic(which, system, messages);
    rec({
      kind, ms: r.ms, model: which, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
      snapshotChars: snapshot?.length, snapshotTokensEst: snapshot ? est(snapshot) : undefined,
    });
    return r;
  };

  let reportedRef = "";
  let toolErrors = 0;

  if (mode === "baseline") {
    // One action per turn; every turn re-reads the page; the conversation
    // keeps every earlier snapshot, as an agent's context does.
    const messages: Msg[] = [];
    const oracleQueue = [...Object.keys(ORACLE_TARGETS), "submit", "done"];
    for (let turn = 0; turn < opts.maxTurns; turn++) {
      const snap = await read(turn === 0 ? "read" : "verify");
      let action: any;
      if (opts.backend === "oracle") {
        const next = oracleQueue.shift()!;
        if (next === "submit") action = { action: "click", uid: oracleSubmitUid(snap) };
        else if (next === "done") action = { action: "done", reference: referenceIn(snap) };
        else action = { action: "fill", uid: oracleUid(snap, next), value: ORACLE_TARGETS[next].value };
        rec({ kind: "decide", ms: ORACLE_REPLY.ms, snapshotChars: snap.length, snapshotTokensEst: est(snap) });
      } else {
        messages.push({
          role: "user",
          content:
            (turn === 0 ? `Task: ${TASK(site.url)}\nThe page is already open.\n\n` : "") +
            `Page snapshot:\n${snap}\n\nNext action, one of:\n` +
            `{"action":"fill","uid":"…","value":"…"} (checkbox/radio: value "true"; select: the option text)\n` +
            `{"action":"click","uid":"…"}\n{"action":"done","reference":"…"}\n{"action":"fail","reason":"…"}`,
        });
        const r = await model("decide", opts.big, SYSTEM_DRIVER, messages, snap);
        messages.push({ role: "assistant", content: r.text });
        try {
          action = parseJson(r.text);
        } catch {
          action = { action: "fail", reason: "unparseable reply" };
        }
      }
      if (action.action === "done") {
        reportedRef = String(action.reference ?? "");
        break;
      }
      if (action.action === "fail") break;
      const r = await act(action.action === "click" ? "click" : "fill", action.action === "click" ? { uid: action.uid } : { uid: action.uid, value: String(action.value) });
      if (r.error) toolErrors++;
      if (action.action === "click" && !r.error) await waitConfirm();
      if (opts.backend !== "oracle" && r.error) messages.push({ role: "user", content: `Tool error: ${r.text.slice(0, 300)}` }, { role: "assistant", content: "Noted." });
    }
  } else {
    const snap = await read();
    let picks: Pick[] = [];
    let submitUid = "";

    if (opts.backend === "oracle") {
      if (mode === "oneshot") rec({ kind: "plan", ms: 0 });
      else {
        rec({ kind: "plan", ms: 0 });
        if (mode === "batch") rec({ kind: "pick", ms: 0 });
      }
      for (const key of Object.keys(ORACLE_TARGETS)) {
        if (mode === "picker") rec({ kind: "pick", ms: 0 });
        picks.push({ uid: oracleUid(snap, key), value: ORACLE_TARGETS[key].value });
      }
      if (mode === "picker") rec({ kind: "pick", ms: 0 });
      submitUid = oracleSubmitUid(snap);
    } else if (mode === "oneshot") {
      const r = await model("plan", opts.big, SYSTEM_DRIVER, [{
        role: "user",
        content: `Task: ${TASK(site.url)}\nThe page is already open.\n\nPage snapshot:\n${snap}\n\n` +
          `Reply {"fills":[{"uid":"…","value":"…"}],"submit":"<uid of the submit button>"}. ` +
          `Checkbox/radio value "true"; select value is the option text.`,
      }], snap);
      const plan = parseJson(r.text);
      picks = (plan.fills ?? []).map((f: any) => ({ uid: String(f.uid), value: String(f.value) }));
      submitUid = String(plan.submit ?? "");
    } else {
      // The big model plans in words; it never names a uid.
      const r = await model("plan", opts.big, SYSTEM_DRIVER, [{
        role: "user",
        content: `Task: ${TASK(site.url)}\nThe page is already open.\n\nPage snapshot:\n${snap}\n\n` +
          `Plan the form fill. Do NOT give uids; describe each target in words so a helper can find it. ` +
          `Reply {"steps":[{"target":"the work email field","value":"…"}],"submit":"<description of the submit button>"}. ` +
          `Checkbox/radio value "true"; select value is the option text.`,
      }], snap);
      const plan = parseJson(r.text);
      const steps: Step[] = (plan.steps ?? []).map((s: any) => ({ target: String(s.target), value: String(s.value) }));
      const targets = [...steps.map((s) => s.target), String(plan.submit ?? "the submit button")];
      const SYSTEM_PICKER = "You map a description of a page element to its uid in an accessibility snapshot. Reply with JSON only.";
      if (mode === "batch") {
        const p = await model("pick", opts.small, SYSTEM_PICKER, [{
          role: "user",
          content: `Snapshot:\n${snap}\n\nTargets:\n${targets.map((t, i) => `${i}. ${t}`).join("\n")}\n\nReply {"uids":["…", …]} in the same order.`,
        }], snap);
        const uids: string[] = (parseJson(p.text).uids ?? []).map(String);
        picks = steps.map((s, i) => ({ uid: uids[i] ?? "", value: s.value }));
        submitUid = uids[steps.length] ?? "";
      } else {
        for (const [i, t] of targets.entries()) {
          const p = await model("pick", opts.small, SYSTEM_PICKER, [{
            role: "user",
            content: `Snapshot:\n${snap}\n\nTarget: ${t}\nReply {"uid":"…"}.`,
          }], snap);
          const uid = String(parseJson(p.text).uid ?? "");
          if (i < steps.length) picks.push({ uid, value: steps[i].value });
          else submitUid = uid;
        }
      }
    }

    if (mode === "picker") {
      for (const p of picks) if ((await act("fill", p)).error) toolErrors++;
    } else {
      if ((await act("fill_form", { elements: picks })).error) toolErrors++;
    }
    const c = await act("click", { uid: submitUid });
    if (c.error) toolErrors++;
    else await waitConfirm();

    // Verify: one re-read of the result page and one judgment by the big model.
    const done = await read("verify");
    if (opts.backend === "oracle") {
      reportedRef = referenceIn(done);
    } else {
      const v = await model("verify", opts.big, SYSTEM_DRIVER, [{
        role: "user",
        content: `Task: ${TASK(site.url)}\n\nThe form was submitted. Page snapshot now:\n${done}\n\nReply {"ok":true|false,"reference":"…"}.`,
      }], done);
      try {
        reportedRef = String(parseJson(v.text).reference ?? "");
      } catch {
        reportedRef = "";
      }
    }
  }

  const totalMs = performance.now() - t0;
  await mcp.tool("close_page", { pageId });

  // Ground truth: what the server actually received.
  const got = site.submissions.length > before ? site.submissions[site.submissions.length - 1] : undefined;
  let wrongTargets = site.newsletterHits() - newsletterBefore;
  for (const [k, v] of Object.entries(EXPECTED)) if ((got?.[k] ?? "") !== v) wrongTargets++;
  const serverRef = got ? site.lastRef() : "";
  const ok = Boolean(got) && wrongTargets === 0 && reportedRef === serverRef;
  return { run, mode, ok, totalMs, wrongTargets, toolErrors, reportedRef, serverRef, recs };
}

// ── Summary ─────────────────────────────────────────────────────────────────

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sec = (ms: number) => (ms / 1000).toFixed(2);

function summarize(results: RunResult[]): string {
  const lines = [
    `Backend: ${opts.backend}` + (opts.backend === "anthropic" ? ` · big ${opts.big} · small ${opts.small}` : "") + ` · runs per mode: ${opts.runs}`,
    "",
    "Per run, median across runs. Times in seconds.",
    "",
    "| Mode | Success | Total | Model think | Tool calls | Page wait | Snapshot reads (time) | Model calls | Input tokens (sum) | Snapshot tokens est. (median) | Wrong targets | Tool errors |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const mode of opts.modes) {
    const rs = results.filter((r) => r.mode === mode);
    if (!rs.length) continue;
    const per = (f: (r: RunResult) => number) => median(rs.map(f));
    const sum = (r: RunResult, kinds: Rec["kind"][]) => r.recs.filter((x) => kinds.includes(x.kind)).reduce((a, x) => a + x.ms, 0);
    const modelKinds: Rec["kind"][] = ["plan", "pick", "decide"];
    const modelMs = (r: RunResult) => r.recs.filter((x) => x.model).reduce((a, x) => a + x.ms, 0);
    const modelCalls = (r: RunResult) => r.recs.filter((x) => x.model || (opts.backend === "oracle" && modelKinds.includes(x.kind))).length;
    const reads = (r: RunResult) => r.recs.filter((x) => (x.kind === "read" || x.kind === "verify") && !x.model).length;
    const readMs = (r: RunResult) => r.recs.filter((x) => (x.kind === "read" || x.kind === "verify") && !x.model).reduce((a, x) => a + x.ms, 0);
    const inTok = (r: RunResult) => r.recs.reduce((a, x) => a + (x.inputTokens ?? 0), 0);
    const snapTok = median(rs.flatMap((r) => r.recs.filter((x) => x.kind === "read" && x.snapshotTokensEst).map((x) => x.snapshotTokensEst!)));
    lines.push(
      `| ${mode} | ${rs.filter((r) => r.ok).length}/${rs.length} | ${sec(per((r) => r.totalMs))} | ${sec(per(modelMs))} | ` +
        `${sec(per((r) => sum(r, ["navigate", "fill", "fill_form", "click"])))} | ${sec(per((r) => sum(r, ["wait"])))} | ` +
        `${per(reads)} (${sec(per(readMs))}) | ${per(modelCalls)} | ${opts.backend === "oracle" ? "n/a" : per(inTok)} | ${snapTok} | ` +
        `${rs.reduce((a, r) => a + r.wrongTargets, 0)} | ${rs.reduce((a, r) => a + r.toolErrors, 0)} |`,
    );
  }
  lines.push("", "Wrong targets and tool errors are totals across runs. A wrong target is a field the server did not receive as asked, or a newsletter sign-up.");
  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(opts.out, stamp);
  mkdirSync(dir, { recursive: true });
  const rawPath = join(dir, "raw.jsonl");

  const site = await startSite();
  const mcpArgs = ["--browserUrl", opts.cdp, "--no-usage-statistics", "--no-performance-crux"];
  const mcp = opts.mcpBin
    ? new Mcp(process.execPath, [opts.mcpBin, ...mcpArgs])
    : new Mcp("npx", ["-y", "chrome-devtools-mcp@latest", ...mcpArgs]);
  await mcp.init();
  // Attach once before timing anything, so the first run does not pay for it.
  await mcp.tool("list_pages", {});

  const results: RunResult[] = [];
  try {
    for (let run = 1; run <= opts.runs; run++) {
      // Interleave the modes so a slow minute does not land on one mode only.
      for (const mode of opts.modes) {
        let r: RunResult;
        try {
          r = await runOnce(mode, run, mcp, site);
        } catch (e) {
          console.error(`${mode} run ${run}: ${(e as Error).message}`);
          continue;
        }
        results.push(r);
        for (const x of r.recs) appendFileSync(rawPath, JSON.stringify(x) + "\n");
        appendFileSync(rawPath, JSON.stringify({ result: { ...r, recs: undefined } }) + "\n");
        console.log(`${mode.padEnd(8)} run ${run}: ${r.ok ? "ok  " : "FAIL"} ${sec(r.totalMs)}s wrong=${r.wrongTargets} errors=${r.toolErrors}`);
      }
    }
  } finally {
    mcp.close();
    site.server.close();
  }

  const summary = summarize(results);
  writeFileSync(join(dir, "summary.md"), `# Browser driving spike (#1118)\n\n${summary}\n`);
  console.log(`\n${summary}\n\nRaw timings: ${rawPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
