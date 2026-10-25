// --- The Wall's portfolio page (/portfolio) (#1194) ---
//
// For the people the owner gave a portfolio key: across every group,
// what is open per project, what each owner carries and finished, and
// what is blocked. Counts and titles only; the summary comes from
// /api/portfolio (wall-portfolio.ts). The HTML holds no data. The key is
// typed once and kept in this browser; "Forget the key" drops it.
//
// No backticks, backslashes or dollar-brace inside the client script:
// it sits in a TS template literal. Data is drawn with textContent only.

import { AX_TOKENS_CSS } from "../tokens"
import { BASE_CSS } from "./member-styles"

const PORTFOLIO_CSS = `
.wrap { max-width: 960px; margin: 0 auto; padding: 20px 20px 48px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; }
.wrap h2 { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
.sum { font-size: 15px; color: var(--ax-text-2); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
.tile { padding: 12px; background: var(--ax-surface); border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-lg); }
.tile b { display: block; font-size: 24px; line-height: 1.2; font-variant-numeric: tabular-nums; }
.tile span { font-size: 13px; color: var(--ax-text-2); }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { padding: 8px 10px; text-align: left; border-bottom: var(--ax-border-w) solid var(--ax-border); }
th { font-weight: 600; color: var(--ax-text-2); }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
.empty { color: var(--ax-text-2); font-size: 14px; }
.foot { font-size: 13px; color: var(--ax-text-2); }
.key-form { display: grid; gap: 8px; margin-top: 16px; }
.key-form input { min-height: 44px; padding: 8px 12px; font: inherit; border: var(--ax-border-w) solid var(--ax-border-2); border-radius: 8px; background: var(--ax-bg); color: var(--ax-text); }
.key-form button, .forget { min-height: 44px; padding: 8px 16px; font: inherit; font-weight: 600; border-radius: var(--ax-radius-pill); cursor: pointer; }
.key-form button { border: 0; background: var(--ax-blue); color: #fff; }
.forget { border: var(--ax-border-w) solid var(--ax-border-2); background: var(--ax-surface); color: var(--ax-text); }
.msg { min-height: 1.5em; font-size: 14px; color: var(--ax-red-ink); }
`

const PORTFOLIO_SCRIPT = `
(function () {
  var KEY = "ax-portfolio-key";
  var $ = function (id) { return document.getElementById(id); };
  function stored() { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } }
  function store(k) { try { if (k) localStorage.setItem(KEY, k); else localStorage.removeItem(KEY); } catch (e) {} }
  function el(tag, text, cls) { var x = document.createElement(tag); if (text !== undefined) x.textContent = String(text); if (cls) x.className = cls; return x; }
  function ago(at, now) {
    var h = Math.floor((now - at) / 3600000);
    return h < 1 ? "under an hour" : h < 48 ? h + " h" : Math.floor(h / 24) + " days";
  }
  function table(holder, cols, rows) {
    holder.textContent = "";
    if (!rows.length) { holder.appendChild(el("p", "Nothing here.", "empty")); return; }
    var t = el("table"), head = el("tr");
    cols.forEach(function (c) { head.appendChild(el("th", c[0], c[2] ? "n" : "")); });
    var th = el("thead"); th.appendChild(head); t.appendChild(th);
    var tb = el("tbody");
    rows.forEach(function (r) {
      var tr = el("tr");
      cols.forEach(function (c) { tr.appendChild(el("td", c[1](r), c[2] ? "n" : "")); });
      tb.appendChild(tr);
    });
    t.appendChild(tb); holder.appendChild(t);
  }
  function locked(msg) {
    $("locked").hidden = false; $("view").hidden = true; $("forget").hidden = true;
    $("who").textContent = "Needs a key";
    $("key-msg").textContent = msg || "";
  }
  function paint(s) {
    $("locked").hidden = true; $("view").hidden = false; $("forget").hidden = false;
    $("who").textContent = s.viewer ? "Key of " + s.viewer : "Owner";
    var t = s.totals;
    $("sum").textContent = "Across " + s.nodes.length + (s.nodes.length === 1 ? " node" : " nodes") + ", every group. Finished counts cover the last " + s.days + " days.";
    var tiles = $("tiles"); tiles.textContent = "";
    [["Open", t.open], ["In progress", t.inProgress], ["Blocked", t.blocked], ["Stalled", t.stalled], ["Finished", t.done]].forEach(function (x) {
      var d = el("div", undefined, "tile"); d.appendChild(el("b", x[1])); d.appendChild(el("span", x[0])); tiles.appendChild(d);
    });
    var n = function (k) { return function (r) { return r[k]; }; };
    table($("projects"), [["Project", n("project")], ["Open", n("open"), 1], ["In progress", n("inProgress"), 1], ["Blocked", n("blocked"), 1], ["Stalled", n("stalled"), 1], ["Finished", n("done"), 1]], s.projects);
    table($("owners"), [["Owner", n("owner")], ["Open", n("open"), 1], ["In progress", n("inProgress"), 1], ["Blocked", n("blocked"), 1], ["Finished", n("done"), 1]], s.owners);
    table($("blocks"), [["Title", n("title")], ["Project", n("project")], ["Owner", n("owner")], ["Waits on", function (r) { return r.waitingOn === "owner" ? "the owner" : "others"; }], ["For", function (r) { return ago(r.since, s.syncedAt); }]], s.blocks);
    var down = s.nodes.filter(function (x) { return !x.ok; }).map(function (x) { return x.name; });
    $("updated").textContent = "Updated " + new Date(s.syncedAt).toLocaleString() + (down.length ? ". Not reachable: " + down.join(", ") : "");
  }
  function load() {
    var k = stored();
    if (!k) { locked(""); return; }
    fetch("/api/portfolio?days=7", { headers: { Authorization: "Bearer " + k, Accept: "application/json" }, cache: "no-store" })
      .then(function (r) {
        if (r.status === 401) { store(""); locked("That key does not open the portfolio."); return null; }
        if (r.status === 503) { locked("The portfolio is not switched on yet. Ask the owner to set the dashboard token."); return null; }
        if (!r.ok) throw new Error("answered " + r.status);
        return r.json();
      })
      .then(function (s) { if (s) paint(s); })
      .catch(function (e) { $("updated").textContent = "Could not load: " + e.message; });
  }
  $("key-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var k = $("key").value.trim();
    if (!k) { $("key-msg").textContent = "Type the key the owner gave you."; return; }
    store(k); $("key").value = ""; load();
  });
  $("forget").addEventListener("click", function () { store(""); locked("The key is gone from this browser."); });
  $("refresh").addEventListener("click", load);
  load();
})();
`

export function renderPortfolioPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Portfolio · AgentX</title>
<style>${AX_TOKENS_CSS}${BASE_CSS}${PORTFOLIO_CSS}</style>
</head>
<body>
<header class="bar">
  <div class="grow"><h1>Portfolio</h1><p id="who" class="who">Loading…</p></div>
  <button type="button" id="refresh" class="forget">Refresh</button>
  <button type="button" id="forget" class="forget" hidden>Forget the key</button>
</header>
<main id="locked" class="narrow" hidden>
  <div class="card">
    <h2>Type your key</h2>
    <p>The owner gave you a portfolio key. It shows counts and titles across every project, read-only.</p>
    <form id="key-form" class="key-form" novalidate>
      <label for="key">Portfolio key</label>
      <input id="key" name="key" type="password" autocomplete="off" spellcheck="false" required>
      <button type="submit">Open the portfolio</button>
      <p id="key-msg" class="msg" role="status" aria-live="polite"></p>
    </form>
    <p class="help">No key? Only the owner can make one.</p>
  </div>
</main>
<main id="view" class="wrap" hidden>
  <p id="sum" class="sum" aria-live="polite"></p>
  <div id="tiles" class="tiles"></div>
  <section aria-labelledby="h-projects"><h2 id="h-projects">Projects</h2><div id="projects" class="scroll"></div></section>
  <section aria-labelledby="h-owners"><h2 id="h-owners">Owners: load and finished</h2><div id="owners" class="scroll"></div></section>
  <section aria-labelledby="h-blocks"><h2 id="h-blocks">Blocked</h2><div id="blocks" class="scroll"></div></section>
  <p id="updated" class="foot"></p>
</main>
<script>${PORTFOLIO_SCRIPT}</script>
</body>
</html>`
}
