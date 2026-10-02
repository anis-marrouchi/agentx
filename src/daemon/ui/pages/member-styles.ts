// --- Styles of the member pages (/member) (#443) ---
//
// Drawn from the approved concept (branch 443-member-page-concept). Only
// token values: --link and --tick are names for existing tokens, chosen so
// small text keeps its contrast (plain blue on white is under 4.5:1).

export const BASE_CSS = `
:root { --link: var(--ax-blue-d); --ring: var(--ax-blue); --tick: var(--ax-green-d); }
[data-theme="dark"] { --link: var(--ax-blue); --tick: var(--ax-green); }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--ax-bg); color: var(--ax-text); font-family: var(--ax-font); }
body { min-height: 100dvh; font-size: 16px; line-height: 1.5; -webkit-text-size-adjust: 100%; }
h1, h2, p, ul, ol { margin: 0; }
ul, ol { padding: 0; list-style: none; }
a { color: var(--link); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; }
code { font-family: var(--ax-mono); font-size: 0.92em; background: var(--ax-surface-3); padding: 1px 6px; border-radius: 6px; }
:focus-visible { outline: 3px solid var(--ring); outline-offset: 2px; border-radius: 4px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.bar { display: flex; align-items: center; gap: 12px; padding: 14px 20px; background: var(--ax-surface); border-bottom: var(--ax-border-w) solid var(--ax-border); }
.mark { flex: none; width: 36px; height: 36px; border-radius: 10px; }
.bar h1 { font-size: 20px; font-weight: 700; line-height: 1.2; }
.bar .grow { flex: 1; min-width: 0; }
.who { font-size: 14px; color: var(--ax-text-2); overflow-wrap: anywhere; }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; counter-reset: s; }
.steps li { counter-increment: s; font-size: 14px; color: var(--ax-text-2); padding-top: 10px; border-top: 4px solid var(--ax-border-2); }
.steps li::before { content: counter(s) ". "; }
.steps li.done { border-color: var(--ax-blue); }
.steps li.now { border-color: var(--ax-blue); color: var(--ax-text); font-weight: 700; }
.narrow { max-width: 480px; margin: 0 auto; padding: 28px 20px 48px; }
.narrow .steps { margin-bottom: 24px; }
.card { padding: 24px; background: var(--ax-surface); border: var(--ax-border-w) solid var(--ax-border-2); border-radius: var(--ax-radius-lg); box-shadow: var(--ax-shadow-lg); }
.card h2 { font-size: 24px; font-weight: 700; line-height: 1.2; margin-bottom: 8px; }
.card p { color: var(--ax-text-2); }
.help { margin-top: 20px; font-size: 14px; color: var(--ax-text-2); }
`

export const WORK_CSS = `
.icon-btn { min-width: 44px; min-height: 44px; font-size: 20px; line-height: 1; border: var(--ax-border-w) solid var(--ax-border-2); border-radius: var(--ax-radius-pill); background: var(--ax-surface); color: var(--ax-text); cursor: pointer; }
.strip, .install { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 10px 20px; font-size: 14px; background: var(--ax-amber-t); color: var(--ax-amber-ink); border-bottom: var(--ax-border-w) solid var(--ax-amber-e); }
.strip[hidden], .install[hidden] { display: none; }
.strip button { min-height: 36px; padding: 4px 16px; font: inherit; font-weight: 700; color: var(--ax-amber-ink); background: transparent; border: var(--ax-border-w) solid var(--ax-amber-ink); border-radius: var(--ax-radius-pill); cursor: pointer; }
.strip button:disabled { opacity: 0.55; cursor: default; }
.install { display: block; background: var(--ax-surface-2); color: var(--ax-text-2); border-bottom-color: var(--ax-border); }
.wrap { max-width: 760px; margin: 0 auto; padding: 24px 20px 48px; }
.sum { font-size: 22px; font-weight: 600; line-height: 1.3; margin-bottom: 24px; text-wrap: balance; }
.wrap h2 { font-size: 15px; font-weight: 700; color: var(--ax-text-2); margin: 32px 0 8px; }
.wrap h2 .n { font-weight: 400; }
.wrap section:first-of-type h2 { margin-top: 0; }
.need { margin-top: 32px; border: var(--ax-border-w) solid var(--ax-blue); border-radius: var(--ax-radius-lg); background: var(--ax-surface); box-shadow: 0 4px 0 var(--ax-blue-d); }
.need[hidden] { display: none; }
.wrap .need h2 { margin: 0; padding: 14px 20px 0; color: var(--ax-text); font-size: 17px; }
.need li { padding: 14px 20px 18px; }
.need li + li { border-top: var(--ax-border-w) solid var(--ax-border); }
.need .q { font-size: 19px; font-weight: 600; line-height: 1.35; margin: 6px 0 8px; overflow-wrap: anywhere; }
.need .for { color: var(--ax-text-2); overflow-wrap: anywhere; }
.need .for b { color: var(--ax-text); font-weight: 600; }
.state { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; white-space: nowrap; }
.state::before { content: ""; flex: none; width: 12px; height: 12px; border-radius: 50%; box-sizing: border-box; }
.state.work::before { background: var(--ax-blue); }
.state.wait { color: var(--ax-amber-ink); }
.state.wait::before { border: 3px solid var(--ax-amber-ink); }
.state.stuck { color: var(--ax-red-ink); }
.state.stuck::before { border-radius: 2px; background: var(--ax-red); transform: rotate(45deg); }
.state.done::before { background: var(--tick); clip-path: polygon(12% 52%, 0 66%, 38% 100%, 100% 22%, 86% 10%, 36% 70%); border-radius: 0; }
.state.free::before { background: var(--tick); }
.state.off { color: var(--ax-text-2); }
.state.off::before { height: 3px; border-radius: 2px; background: var(--ax-muted); }
.state.work.live::before { animation: halo 1.8s ease-out infinite; }
@keyframes halo { 0% { box-shadow: 0 0 0 0 var(--ax-blue); } 100% { box-shadow: 0 0 0 7px transparent; } }
@media (prefers-reduced-motion: reduce) { .state.work.live::before { animation: none; } }
.meta { display: flex; flex-wrap: wrap; gap: 2px 18px; font-size: 14px; color: var(--ax-text-2); }
.moved { font-variant-numeric: tabular-nums; }
.note { font-size: 14px; overflow-wrap: anywhere; }
.muted { color: var(--ax-text-2); }
.agents { display: grid; grid-template-columns: 1fr; gap: 12px; }
@media (min-width: 640px) { .agents { grid-template-columns: 1fr 1fr; } }
.agent { display: grid; gap: 6px; align-content: start; padding: 16px 18px 18px; background: var(--ax-surface); border: var(--ax-border-w) solid var(--ax-border-2); border-radius: var(--ax-radius-lg); }
.agent .top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; }
.agent .name { font-size: 17px; font-weight: 700; overflow-wrap: anywhere; }
.agent .state { font-size: 15px; }
.agent .state::before { width: 14px; height: 14px; }
.agent .what { overflow-wrap: anywhere; }
.agent .hint { font-size: 14px; color: var(--ax-text-2); padding-top: 8px; border-top: var(--ax-border-w) solid var(--ax-border); margin-top: 4px; }
.agent.free { border-color: var(--tick); }
.agent.free .hint { color: var(--ax-text); font-weight: 600; }
.agent .more { justify-self: start; min-height: 44px; padding: 0; font: inherit; font-size: 14px; font-weight: 700; color: var(--link); background: none; border: 0; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.agent .more::after { content: " \\25BE"; }
.agent .more[aria-expanded="true"]::after { content: " \\25B4"; }
.agent .detail { display: none; gap: 14px; padding-top: 14px; border-top: var(--ax-border-w) solid var(--ax-border); }
.agent.open .detail { display: grid; }
.agent.open { border-color: var(--ax-blue); }
@media (min-width: 640px) { .agent.open { grid-column: 1 / -1; } }
.detail .full { overflow-wrap: anywhere; white-space: pre-wrap; }
.detail dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-size: 14px; }
.detail dt { color: var(--ax-text-2); }
.detail dd { margin: 0; overflow-wrap: anywhere; }
.rows { border-top: var(--ax-border-w) solid var(--ax-border); }
.row { display: grid; grid-template-columns: 1fr; gap: 4px 20px; padding: 14px 0; border-bottom: var(--ax-border-w) solid var(--ax-border); }
.row .text { overflow-wrap: anywhere; }
@media (min-width: 640px) {
  .row { grid-template-columns: 1fr 230px; }
  .row .side { grid-column: 2; grid-row: 1 / span 3; display: grid; gap: 2px; align-content: start; justify-items: end; text-align: right; font-size: 14px; color: var(--ax-text-2); }
}
@media (max-width: 639px) {
  .row .side { display: flex; flex-wrap: wrap; gap: 2px 18px; align-items: center; font-size: 14px; color: var(--ax-text-2); order: -1; }
}
.blank { padding: 28px 24px; border: var(--ax-border-w) dashed var(--ax-border-2); border-radius: var(--ax-radius-lg); }
.blank p + p { margin-top: 8px; color: var(--ax-text-2); }
.foot { margin-top: 28px; font-size: 14px; color: var(--ax-text-2); }
`

export const LOCKED_CSS = `
.pair-form { display: grid; gap: 8px; margin-top: 20px; }
.pair-form label { font-weight: 600; margin-top: 8px; }
.pair-form input { width: 100%; min-height: 52px; padding: 10px 14px; font: inherit; font-size: 17px; color: var(--ax-text); background: var(--ax-surface); border: var(--ax-border-w) solid var(--ax-text-2); border-radius: var(--ax-radius-sm); }
.pair-form input#pair-code { min-height: 64px; font: 600 26px/1.2 var(--ax-mono); letter-spacing: 0.12em; text-align: center; text-transform: uppercase; }
.pair-form input:focus { border-color: var(--ax-blue); outline: none; }
.pair-form button { margin-top: 16px; min-height: 56px; border: 0; border-radius: var(--ax-radius-pill); font: inherit; font-size: 19px; font-weight: 700; color: #fff; background: var(--ax-blue-d); box-shadow: 0 4px 0 #134aad; cursor: pointer; }
.pair-form button:disabled { opacity: 0.55; cursor: default; }
.pair-msg { min-height: 1.5em; }
.card .pair-msg.bad { color: var(--ax-red-ink); }
[data-theme="dark"] .card .pair-msg.bad { color: var(--ax-red); }
.card .pair-offline { padding: 8px 12px; border-radius: var(--ax-radius-sm); font-size: 14px; background: var(--ax-amber-t); color: var(--ax-amber-ink); border: 1px solid var(--ax-amber-e); }
`

export const WAITING_CSS = `
.pulse { display: inline-block; width: 12px; height: 12px; margin-right: 10px; border-radius: 50%; border: 3px solid var(--ax-amber-ink); box-sizing: border-box; animation: breathe 2.4s ease-in-out infinite; }
@keyframes breathe { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
`
