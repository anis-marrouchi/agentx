import { randomBytes } from "crypto"
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
  /** Shown instead of the agent id, e.g. "Sam". */
  from?: string
  /** "chime" plays a soft two-note chime in the page; anything else: silent here. */
  sound?: string
  volume?: number
  theme?: "system" | "light" | "dark"
  now?: number
  /** Previews and screenshots: start with this option (1-based) picked. */
  pick?: number
  /** Screenshots: no slide-in, so the picture never catches the card half faded. */
  still?: boolean
}

const time = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
const day = (d: Date) => `${d.getDate()} ${d.toLocaleDateString("en-US", { month: "short" })}`

/** "since 09:41" for a card raised today, "since 28 Sep" for an older one. */
function since(iso: string, now: number): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return `since ${d.toDateString() === new Date(now).toDateString() ? time(d) : day(d)}`
}

/** "Thu 14:00" inside the coming week, "Thu 8 Oct 14:00" past it. */
function when(iso: string, now: number): string {
  const d = new Date(iso)
  const soon = d.getTime() - now < 6 * 86_400_000
  return [d.toLocaleDateString("en-US", { weekday: "short" }), ...(soon ? [] : [day(d)]), time(d)].join(" ")
}

function initials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[1][0] : name.trim().slice(0, 1)).toUpperCase()
}

/**
 * The option the recommendation names, and the reason that is left. The
 * card stores its advice as one line ("Thursday 10:00: your calendar is
 * free"); when that line names an option, the card marks that option and
 * starts with it picked. No match: nothing is picked, the line shows whole.
 */
export function recommended(card: Pick<DecisionCard, "recommend" | "choices">): { index: number; why: string } {
  const text = (card.recommend ?? "").trim()
  const low = text.toLowerCase()
  let index = -1
  ;(card.choices ?? []).forEach((c, i) => {
    if (low.includes(c.toLowerCase()) && (index < 0 || c.length > card.choices![index].length)) index = i
  })
  if (index < 0) return { index, why: text }
  const label = card.choices![index]
  if (!low.startsWith(label.toLowerCase())) return { index, why: text }
  const why = text.slice(label.length).replace(/^[\s:,.;–—-]+/, "")
  return { index, why: why.slice(0, 1).toUpperCase() + why.slice(1) }
}

function primaryLabel(card: DecisionCard): string {
  return card.draft ? "Send" : card.choices?.length ? "Choose" : "Yes"
}

const ICON = (path: string) =>
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`
const CLOCK = ICON('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')
const LOCK = ICON('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>')

export function renderCardPage(card: DecisionCard, opts: CardPageOptions = {}): string {
  const now = opts.now ?? Date.now()
  const from = opts.from || card.raised_by
  const nonce = randomBytes(12).toString("base64")
  const choices = card.choices ?? []
  const reminder = card.origin?.kind === "reminder"
  const rec = recommended(card)
  const options = choices.map((c, i) =>
    `<button class="opt" role="radio" aria-checked="false" data-i="${i}"><span class="n">${i + 1}</span><span class="t">${esc(c)}</span>${i === rec.index ? '<i class="dot"></i>' : ""}</button>`,
  ).join("")
  const recLabel = card.recommend ? `<span class="rec"><i class="dot"></i>${esc(from)} recommends</span>` : ""
  const data = {
    choices,
    draft: card.draft ?? "",
    placeholder: CHOICE_PLACEHOLDER,
    chime: opts.sound === "chime",
    volume: Math.min(1, Math.max(0, opts.volume ?? 0.4)),
    theme: opts.theme ?? "system",
    // A pick asked for (previews) wins; else the card opens on the recommended option.
    pick: opts.pick && opts.pick <= choices.length ? opts.pick - 1 : rec.index,
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>AgentX</title>
<style>${CARD_CSS}</style></head>
<body><div class="wrap"><main class="card${opts.still ? " still" : ""}"><div class="body">
<div class="head"><span class="avatar">${esc(initials(from))}</span>
<div class="who"><b>${esc(from)}</b><span>${esc(since(card.created_at, now))}</span></div>
<span class="kind${reminder ? "" : " decision"}">${reminder ? "Reminder" : "Decision"}</span></div>
<h1 dir="auto">${esc(card.title)}</h1>
${card.context ? `<p class="context" dir="auto">${esc(card.context)}</p>` : ""}
<p class="ask" dir="auto">${esc(card.ask)}</p>
${options || recLabel ? `<div class="label-row">${options ? '<span class="label">Pick one</span>' : ""}${recLabel}</div>` : ""}
${options ? `<div class="options" role="radiogroup">${options}</div>` : ""}
${rec.why ? `<p class="why" dir="auto">${esc(rec.why)}</p>` : ""}
${card.draft ? `<div class="label-row" id="msg"><span class="label">Message</span><span class="edited"><i class="dot"></i>Edited</span><button class="reset" id="reset">Reset</button></div>
<textarea id="text" dir="auto" rows="2" spellcheck="true"></textarea>` : ""}
<div class="notes"><div>${CLOCK}<span>If you don't answer by ${esc(when(card.expires, now))}: ${esc(card.if_silent)}.</span></div>
<div>${LOCK}<span>Nothing goes out until you click.</span></div></div>
</div><div class="foot"><button class="btn later" id="later">Not now<kbd>esc</kbd></button>
<button class="btn" id="no">No</button>
<button class="btn primary" id="yes">${primaryLabel(card)}<kbd>⌘↩</kbd></button></div>
</main></div>
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
  var msg = document.getElementById("msg");
  var yes = document.getElementById("yes");
  var pick = -1, touched = false, done = false;

  function fill(i) { return d.draft.split(d.placeholder).join(i >= 0 ? d.choices[i] : "").trim(); }
  function send(a) { if (done) return; done = true; document.title = "agentx:answer:" + JSON.stringify(a); }
  function fit() { document.title = "agentx:size:" + Math.ceil(document.querySelector(".wrap").getBoundingClientRect().height); }
  function mark() { touched = box.value.trim() !== fill(pick); msg.classList.toggle("touched", touched); }
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
    if (box) { grow(); mark(); }
    update();
    if (box) box.focus();
  }
  opts.forEach(function (o, i) { o.addEventListener("click", function () { choose(i); }); });
  if (box) {
    box.value = d.choices.length ? "" : fill(-1);
    box.placeholder = d.choices.length ? "Pick an option above" : "";
    grow();
    box.addEventListener("input", function () { grow(); mark(); update(); });
    document.getElementById("reset").addEventListener("click", function () { box.value = fill(pick); grow(); mark(); update(); box.focus(); });
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
