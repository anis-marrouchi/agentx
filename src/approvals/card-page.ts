import { randomBytes } from "crypto"
import { AX_TOKENS_CSS } from "@/daemon/ui/tokens"
import { esc } from "@/daemon/ui/util"
import { CARD_CSS } from "./card-page-style"
import { CHOICE_PLACEHOLDER } from "./choices"
import type { DecisionCard } from "./cards"

// --- The Mac card: one decision card as a small web page ---
//
// card-window.ts shows this page in a floating window. It is rendered here,
// with every piece of card text escaped, and shipped as one file: no
// network (the Content-Security-Policy forbids it), no dashboard session.
//
// The page talks back through its title, which the window reads:
//   agentx:size:<px>         the height it needs, so the window fits it
//   agentx:answer:<json>     what the operator did; the window closes
// The answer is {action:"yes", choice?, text?}, {action:"no"} or
// {action:"dismiss"}. card-window.ts checks it against the card again, so
// a page that misbehaves still can't approve something the card didn't
// offer.

export interface CardPageOptions {
  /** Shown instead of the agent id, e.g. "Yasmine". */
  from?: string
  /** "chime" plays a soft two-note chime in the page; anything else: silent here. */
  sound?: string
  volume?: number
  theme?: "system" | "light" | "dark"
  now?: number
  /** Previews and screenshots: start with this option (1-based) picked. */
  pick?: number
}

function ago(iso: string, now: number): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (!Number.isFinite(min)) return ""
  if (min < 1) return "just now"
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

function when(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

function primaryLabel(card: DecisionCard): string {
  return card.draft ? "Send" : card.choices?.length ? "Choose" : "Yes"
}

export function renderCardPage(card: DecisionCard, opts: CardPageOptions = {}): string {
  const now = opts.now ?? Date.now()
  const from = opts.from || card.raised_by
  const nonce = randomBytes(12).toString("base64")
  const choices = card.choices ?? []
  const kind = card.origin?.kind === "reminder" ? "Reminder" : "Decision"
  const sub = [from === card.raised_by ? "" : card.raised_by, ago(card.created_at, now)].filter(Boolean).join(" · ")
  const options = choices.map((c, i) =>
    `<button class="opt" role="radio" aria-checked="false" data-i="${i}"><span class="n">${i + 1}</span><span>${esc(c)}</span></button>`,
  ).join("")
  const data = {
    choices,
    draft: card.draft ?? "",
    placeholder: CHOICE_PLACEHOLDER,
    chime: opts.sound === "chime",
    volume: Math.min(1, Math.max(0, opts.volume ?? 0.4)),
    theme: opts.theme ?? "system",
    pick: opts.pick && opts.pick <= choices.length ? opts.pick - 1 : -1,
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>AgentX</title>
<style>${AX_TOKENS_CSS}${CARD_CSS}</style></head>
<body><main class="card">
<div class="head"><div class="avatar">${esc(from.slice(0, 1).toUpperCase())}</div>
<div class="who"><b>${esc(from)}</b><span>${esc(sub)}</span></div>
<span class="kind">${kind}</span></div>
<h1 dir="auto">${esc(card.title)}</h1>
${card.context ? `<p class="context" dir="auto">${esc(card.context)}</p>` : ""}
<p class="ask" dir="auto">${esc(card.ask)}</p>
${card.recommend ? `<p class="recommend" dir="auto"><b>Recommended:</b> ${esc(card.recommend)}</p>` : ""}
${options ? `<div class="options" role="radiogroup">${options}</div>` : ""}
${card.draft ? `<div class="label-row"><span class="label">Message</span><span class="edited" id="edited">Edited</span></div>
<textarea id="text" dir="auto" spellcheck="true"></textarea>` : ""}
<p class="expires">If you don't answer by ${esc(when(card.expires))}: ${esc(card.if_silent)}.</p>
<div class="foot"><button class="btn ghost later" id="later">Not now<kbd>esc</kbd></button>
<button class="btn" id="no">No</button>
<button class="btn primary" id="yes">${primaryLabel(card)}<kbd>⌘↩</kbd></button></div>
<p class="note">Nothing goes out until you click. ${esc(from)} does the rest.</p>
</main>
<script type="application/json" id="data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script nonce="${nonce}">${CARD_SCRIPT}</script>
</body></html>`
}

// Plain ES2019, no imports: it runs in the window's WKWebView.
const CARD_SCRIPT = `
(function () {
  var d = JSON.parse(document.getElementById("data").textContent);
  var root = document.documentElement;
  var dark = d.theme === "dark" || (d.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) root.setAttribute("data-theme", "dark");
  var opts = [].slice.call(document.querySelectorAll(".opt"));
  var box = document.getElementById("text");
  var edited = document.getElementById("edited");
  var yes = document.getElementById("yes");
  var pick = -1, touched = false, done = false;

  function fill(i) { return d.draft.split(d.placeholder).join(i >= 0 ? d.choices[i] : "").trim(); }
  function send(a) { if (done) return; done = true; document.title = "agentx:answer:" + JSON.stringify(a); }
  function fit() { document.title = "agentx:size:" + Math.ceil(document.querySelector(".card").getBoundingClientRect().height); }
  function update() {
    opts.forEach(function (o, i) { o.setAttribute("aria-checked", String(i === pick)); });
    yes.disabled = (d.choices.length > 0 && pick < 0) || (box && !box.value.trim());
  }
  function grow() { if (!box) return; box.style.height = "auto"; box.style.height = box.scrollHeight + 4 + "px"; }
  function choose(i) {
    // An edited message keeps the edits, with the old pick swapped for the new one.
    if (box && touched && pick >= 0) box.value = box.value.split(d.choices[pick]).join(d.choices[i]);
    else if (box) box.value = fill(i);
    pick = i;
    if (box) { grow(); touched = box.value.trim() !== fill(i); edited.classList.toggle("on", touched); }
    update();
    if (box) box.focus();
  }
  opts.forEach(function (o, i) { o.addEventListener("click", function () { choose(i); }); });
  if (box) {
    box.value = d.choices.length ? "" : fill(-1);
    box.placeholder = d.choices.length ? "Pick an option above" : "";
    grow();
    box.addEventListener("input", function () { grow(); touched = box.value.trim() !== fill(pick); edited.classList.toggle("on", touched); update(); });
  }
  yes.addEventListener("click", function () {
    if (yes.disabled) return;
    var a = { action: "yes" };
    if (pick >= 0) a.choice = d.choices[pick];
    if (box) a.text = box.value.trim();
    send(a);
  });
  document.getElementById("no").addEventListener("click", function () { send({ action: "no" }); });
  document.getElementById("later").addEventListener("click", function () { send({ action: "dismiss" }); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") return send({ action: "dismiss" });
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); return yes.click(); }
    if (document.activeElement !== box && /^[1-9]$/.test(e.key) && opts[+e.key - 1]) choose(+e.key - 1);
  });
  if (d.pick >= 0) choose(d.pick); else update();
  requestAnimationFrame(fit);
  if (box) new ResizeObserver(fit).observe(box);

  if (d.chime) try {
    var ac = new AudioContext(), t = ac.currentTime + 0.05;
    [[783.99, 0], [1046.5, 0.14]].forEach(function (n) {
      [1, 2].forEach(function (h) {
        var o = ac.createOscillator(), g = ac.createGain();
        o.type = "sine"; o.frequency.value = n[0] * h;
        g.gain.setValueAtTime(0, t + n[1]);
        g.gain.linearRampToValueAtTime(d.volume * (h === 1 ? 0.5 : 0.12), t + n[1] + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + n[1] + 1.4);
        o.connect(g).connect(ac.destination); o.start(t + n[1]); o.stop(t + n[1] + 1.5);
      });
    });
  } catch (e) {}
})();
`
