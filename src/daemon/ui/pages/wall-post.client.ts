// --- One post on its own, with its thread (#1316), in the feed's look (#2101) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), nameOf(), avatar(), shortTime(), stamp(), isOpen(), taskHref(),
// activityHref(), progressHtml(), planHtml(), resultHtml(), factsHtml(),
// threadHtml(), cardHtml(), concHtml(), qaText(), forge*(), allAgents(),
// liveTaskOf(), closeHtml(), runOnHtml(), spaceHtml(), diffButtonHtml(),
// diffHtml(), and the feed's parts (wall-feed.client.ts): fdIcon(),
// fdStateOf(), fdStateHtml(), fdLiveRun(), fdFailHtml().
//
// orca-design: the feed's 720px reading column and gutters, its author line
// and state set, one hairline meta line with lucide icons, the comment box
// as the feed's composer (one bordered box, tools left, round send right),
// and a loading state that is already the post's box (no layout shift).

import { hubIconMap } from "./hub-lucide"
import { HUB_NAME } from "../hub-name"

/** The icons the post page draws besides the feed's. */
const PP_ICONS = ["activity", "circle-check", "external-link", "link", "check", "message-circle", "phone", "radio", "repeat-2", "timer", "folder", "square", "users", "arrow-up", "server", "chevrons-up-down"]

export const WALL_POST_SCRIPT = String.raw`
  // --- One post on its own (#1316, wall-post.client.ts) ---
  var PI = ${JSON.stringify(hubIconMap(PP_ICONS, 14))};
  var PI16 = ${JSON.stringify(hubIconMap(["arrow-up"]))};
  /** Grey rows where the thread will be (A16). */
  function postThreadSkeletonHtml() {
    return '<ol class="wt is-loading" aria-hidden="true">' + [64, 48, 56].map(function (w) {
      return '<li><span class="pp-sk pp-sk--av"></span><span class="pp-sk" style="width:' + w + '%"></span></li>';
    }).join('') + '</ol>';
  }
  /** The post page while the posts load: the post's own boxes, in grey, so
   *  nothing moves when it arrives (author line, title, steps, result). */
  function postSkeletonHtml() {
    return '<article class="wp wp--open wtk is-loading" aria-busy="true" aria-label="Loading the post">' +
      '<div class="wp__by fp__by"><span class="pp-sk pp-sk--av"></span><span class="pp-sk" style="width:160px"></span></div>' +
      '<div class="pp-sk pp-sk--title"></div>' +
      '<div class="pp-sk pp-sk--prog" data-hub-item="gates"></div>' +
      '<section class="wtk__sec"><h2><span class="pp-sk" style="width:56px"></span></h2>' +
        '<div class="pp-sk pp-sk--line"></div><div class="pp-sk pp-sk--line" style="width:72%"></div></section>' +
      '<span class="fd-sr" role="status">Loading the post…</span>' +
    '</article>';
  }
  /** One meta item: icon and words, a link when it goes somewhere. */
  function ppMeta(icon, html, href, title, cls) {
    var a = (title ? ' title="' + esc(title) + '"' : '') + ' class="fp__mi' + (cls ? ' ' + cls : '') + '"';
    return href
      ? '<a href="' + esc(href) + '"' + (/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : '') + a + '>' + (PI[icon] || '') + html + '</a>'
      : '<span' + a + '>' + (PI[icon] || '') + html + '</span>';
  }
  /** The post page: the request as its title, where it stands, its plan,
   *  the result, the facts, one meta line, the comment box, the thread. */
  function postHtml(p) {
    var multi = S.data && S.data.nodes && S.data.nodes.length > 1;
    var conc = p.concurrent || [];
    var s = fdStateOf(p), run = s === 'working' ? fdLiveRun(p) : null;
    var copied = S.fdCopied === p.id;
    // Author line, as in the feed: avatar, name, handle, time, then the state.
    var by = '<div class="wp__by fp__by">' + avatar(p.owner) +
      '<button type="button" class="fp__name" data-agent="' + esc(p.owner) + '">' + esc(nameOf(p.owner)) + '</button>' +
      '<span class="fp__h">' + esc(p.owner) + '</span>' +
      '<span class="fp__time">' + shortTime(p.lastMoveAt) + '</span>' +
      (multi ? '<span class="fp__h pp__node">' + esc(p.node.name) + '</span>' : '') +
      fdStateHtml(s) + '</div>';
    // One meta line: runs, minutes, project, then the links out.
    var meta = [
      ppMeta('repeat-2', p.runs + (p.runs === 1 ? ' run' : ' runs') + (p.failedRuns ? ', ' + p.failedRuns + ' failed' : ''), '', 'Runs that worked on it', p.failedRuns ? 'is-err' : ''),
      p.runMs ? ppMeta('timer', mins(p.runMs) + ' min', '', 'Minutes the runs took') : '',
      p.project ? ppMeta('folder', esc(p.project), '', 'Project') : '',
      p.home ? (/^https?:\/\//.test(p.home.link)
        ? ppMeta('external-link', '<span class="pp__home">Home: ' + esc(p.home.link.replace(/^https?:\/\//, '')) + '</span>', p.home.link, 'Home: ' + p.home.link)
        : ppMeta('external-link', 'Home: ' + esc(p.home.link), '', 'Home')) : '',
      // A PR or MR home has its diff (#2102, wall-diff.client.ts).
      diffButtonHtml(p),
      // The node its issue runs on (#2104), when the owner moved it.
      p.runOn ? ppMeta('server', 'Runs on ' + esc(p.runOn), '', 'This issue\'s runs go to ' + p.runOn, 'wro__on') : '',
      p.evidence ? (/^https?:\/\//.test(p.evidence) ? ppMeta('circle-check', 'Proof', p.evidence) : ppMeta('circle-check', 'Proof: ' + esc(p.evidence))) : '',
    ];
    (p.comments || []).slice(0, 3).forEach(function (c) {
      if (/^https?:\/\//.test(c.url)) meta.push(ppMeta('message-circle', 'Comment' + (c.agentId ? ' by ' + esc(c.agentId) : '') + ' ' + shortTime(c.at), c.url, 'Comment posted ' + stamp(c.at)));
    });
    if (p.lastRun) {
      meta.push(ppMeta('activity', 'Task record and trace', taskHref(p.lastRun.taskId, p.lastRun.agentId, p.node, !isOpen(p))));
      meta.push(ppMeta('users', 'Agent activity', activityHref(p.lastRun.agentId)));
    }
    // Copy link always shows here (it is the page); Stop while it runs.
    var acts = '<span class="fd-acts">' +
      '<button type="button" class="fd-ib" data-fd-copy="' + esc(p.id) + '" aria-label="' + (copied ? 'Link copied' : 'Copy link') + '" title="' + (copied ? 'Link copied' : 'Copy link') + '">' + (copied ? PI.check : PI.link) + '</button>' +
      (run ? '<button type="button" class="ax-btn ax-btn--ghost fd-xs" data-fd-stop="' + esc(p.id) + '"' + (S.fdBusy && S.fdBusy[p.id] ? ' disabled' : '') + '>' + PI.square + 'Stop</button>' : '') +
    '</span>';
    var t = S.threads[p.id];
    return '<article class="wp wp--open wtk" id="open-' + esc(p.id) + '">' +
      by +
      '<h1 class="wtk__title">' + esc(p.headline) + '</h1>' +
      progressHtml(p, t && t.plan) +
      (p.blocked ? '<div class="wp__block" title="Since ' + esc(stamp(p.blocked.since)) + '">Why it waits: ' + esc(p.blocked.why) + '</div>' : '') +
      (s === 'failed' ? fdFailHtml(p) : '') +
      (t && t.plan && t.plan.length ? planHtml(t.plan) : '') +
      resultHtml(p) +
      (p.timeFlag ? '<div class="wp__flag">Time: ' + esc(p.timeFlag) + '</div>' : '') +
      (forgeClosedOpen(p) ? '<div class="wp__flag">' + esc(forgeName(p.forgeState)) + ' says ' + esc(p.forgeState.state) + (p.forgeState.closedBy ? ' by ' + esc(p.forgeState.closedBy) : '') + ', but this post is still open. Do not pick it up.</div>' : '') +
      (forgeOpenClosed(p) ? '<div class="wp__flag">' + esc(forgeName(p.forgeState)) + ' says open, but this post is ' + esc(p.state) + '. Close it there or reopen it here.</div>' : '') +
      (forgeFlags(p).length ? '<div class="wp__flag">GitLab time: ' + esc(forgeFlags(p).join('; ')) + '</div>' : '') +
      conc.map(function (o) { return concHtml(o, function (id, agent) { return '<a href="' + esc(taskHref(id, agent, p.node, true)) + '">' + esc(id) + '</a>'; }); }).join('') +
      cardsOf(p).map(function (c) { return cardHtml(c, p); }).join('') +
      (qaText(p) ? '<div class="wp__qa">QA: ' + esc(qaText(p)) + (p.awaitingQa && p.qa ? ' — new verdict asked' : '') + '</div>' : '') +
      factsHtml(p) +
      '<div class="fp__m pp__m">' + meta.filter(Boolean).join('') + acts + '</div>' +
      doHtml(p) +
      diffHtml(p) +
      '<section class="wp__thread" data-for="' + esc(p.id) + '" aria-label="Thread"><h2 class="wp__th">Thread</h2>' +
        (!t || t.loading ? postThreadSkeletonHtml() : threadHtml(t, p)) + '</section>' +
      '</article>';
  }
  function postPageHtml() {
    var p = findPost(S.post);
    if (p) return postHtml(p);
    if (!S.data) return postSkeletonHtml();
    return '<div class="fd-empty"><p>This post is not on the ${HUB_NAME}: it may be older than seven days, or its node did not answer.</p><button type="button" class="ax-btn ax-btn--ghost" data-back>Back to the feed</button></div>';
  }

  // --- What the owner does from an open post (#1316): the feed's composer ---
  function doHtml(p) {
    var others = allAgents().filter(function (a) { return a.id !== p.owner; });
    var draft = S.drafts[p.id] || '';
    var live = liveTaskOf(p.owner);
    return '<section class="wdo" data-for="' + esc(p.id) + '" aria-label="Comment">' +
      // Any post takes a comment (#1355): on a closed one it opens the post
      // again; an @name in it brings that agent in with a post of its own.
      '<label class="wdo__l" for="wdo-text">Comment to @' + esc(p.owner) + (isOpen(p) ? '' : ': this post is ' + esc(p.state) + ', so a comment opens it again') + '</label>' +
      '<div class="fd-compose">' +
        '<textarea id="wdo-text" class="wdo__t" rows="2" maxlength="4000" placeholder="It reaches ' + esc(nameOf(p.owner)) + ' like a message on any channel. Use @name to bring in another agent.">' + esc(draft) + '</textarea>' +
        '<div class="fd-compose__row">' +
          '<button type="button" class="ax-btn ax-btn--ghost fd-xs" data-act="call" title="' + esc(nameOf(p.owner)) + ' calls you on AgentX Voice about this post">' + PI.phone + 'Call ' + esc(nameOf(p.owner)) + '</button>' +
          (live ? '<a class="ax-btn ax-btn--ghost fd-xs" href="' + esc(wallTaskHref(live.t, p.owner, live.n.url)) + '" title="' + esc(nameOf(p.owner)) + ' is working now">' + PI.radio + 'Join live</a>' : '') +
          (others.length
            ? '<span class="wdo__sp"><label class="fd-pick">' + PI.users + '<select id="wdo-with" aria-label="Talks with">' + others.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>'; }).join('') + '</select>' + PI['chevrons-up-down'] + '</label>' +
              '<button type="button" class="ax-btn ax-btn--ghost fd-xs" data-act="space" title="Two agents talk about this post out loud on this computer">Start a Space</button></span>'
            : '') +
          '<button type="button" class="fd-send" data-act="comment" aria-label="Comment" title="Comment">' + PI16['arrow-up'] + '</button>' +
        '</div>' +
      '</div>' +
      '<div id="wdo-close">' + closeHtml(p) + '</div>' +
      '<div id="wdo-runon">' + runOnHtml(p) + '</div>' +
      '<p class="wdo__n" id="wdo-note" role="status">' + esc(S.doNote || '') + '</p>' +
      '<div id="wdo-space">' + spaceHtml() + '</div>' +
    '</section>';
  }
`

export const WALL_POST_CSS = `
/* The post page (#2101, wall-post.client.ts): the feed's column and parts. */
.ax-wall.is-post .ax-wall__main > :is(.ax-wall__head, .ax-wall__post) { max-width: 720px; margin-left: auto; margin-right: auto; }
.ax-wall.is-post .ax-wall__head { position: static; background: none; backdrop-filter: none; -webkit-backdrop-filter: none; border-bottom: 0; }
.ax-wall.is-post .ax-wall__titlebar { padding: 24px 0 16px; gap: 8px; }
.ax-wall.is-post .ax-wall__titlebar h1 { font-size: var(--ax-fs-pane); font-weight: var(--ax-fw-strong); letter-spacing: -.01em; }
.ax-wall.is-post .ax-wall__back svg { width: 16px; height: 16px; }

.ax-wall__post { padding-bottom: 48px; }
.ax-wall__post .wp { display: flex; flex-direction: column; gap: 0; padding: 0; border: 0; box-shadow: none; }
.ax-wall__post .wp:hover { background: none; }
.ax-wall__post .wp__by { align-items: center; flex-wrap: nowrap; gap: 8px; }
.ax-wall__post .wp__by > .av { --av-size: 28px; width: 28px; height: 28px; flex: none; border-radius: var(--ax-radius-md); background: var(--ax-surface-2); color: var(--ax-text-2); border: 1px solid var(--ax-border); font-size: 11px; font-weight: 600; }
.ax-wall__post .wp__by > .av.is-live::after { display: none; }
.ax-wall__post .wtk__title { margin: 12px 0 8px; font-size: 20px; line-height: 1.35; font-weight: var(--ax-fw-strong); letter-spacing: -.005em; color: var(--ax-text); overflow-wrap: anywhere; }

/* Where it stands: one hairline box, the step's state in its icon colour only. */
.ax-wall__post .wtk__prog { margin: 0 0 8px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-md); background: var(--ax-bg); }
.ax-wall__post .wtk__prog li { padding: 8px 12px; border-top: 0; border-left: 1px solid var(--ax-border); font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.ax-wall__post .wtk__prog li:first-child { border-left: 0; }
.ax-wall__post .wtk__prog b { display: flex; align-items: center; gap: 6px; font-size: var(--ax-fs-sm); font-weight: 500; color: var(--ax-muted); }
.ax-wall__post .wtk__prog b::before { content: ""; width: 8px; height: 8px; flex: none; border-radius: 50%; border: 1.5px solid var(--ax-border-2); }
.ax-wall__post .wtk__prog .is-done b { color: var(--ax-text-2); }
.ax-wall__post .wtk__prog .is-done b::before { border-color: var(--ax-green); background: var(--ax-green); }
.ax-wall__post .wtk__prog .is-now b { color: var(--ax-text); }
.ax-wall__post .wtk__prog .is-now b::before { border-color: var(--ax-text); background: var(--ax-text); }
.ax-wall__post .wtk__prog .is-wait b { color: var(--ax-amber-ink); }
.ax-wall__post .wtk__prog .is-wait b::before { border-color: var(--ax-amber); background: var(--ax-amber); }
.ax-wall__post .wtk__prog .is-end b::before { border-color: var(--ax-muted); }

/* Sections: a title outside any card, then the rows (C4). */
.ax-wall__post .wtk__sec { margin: 24px 0 0; }
.ax-wall__post .wtk__sec h2, .ax-wall__post .wp__th { display: flex; align-items: baseline; gap: 8px; margin: 0 0 8px; padding: 0 0 8px; border: 0; border-bottom: 1px solid var(--ax-border); font-size: var(--ax-fs-sm); font-weight: 600; color: var(--ax-text); }
.ax-wall__post .wtk__sec h2 .k { margin: 0; font-weight: 400; color: var(--ax-muted); }
.ax-wall__post .wp__result { display: block; margin: 0; font-size: var(--ax-fs); line-height: 1.6; color: var(--ax-text); overflow: visible; -webkit-line-clamp: unset; }
.ax-wall__post .wp__from { margin-top: 6px; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.ax-wall__post .ax-md a { color: var(--ax-text); text-decoration: underline; text-decoration-color: var(--ax-border-2); text-underline-offset: 2px; }

/* The plan: one row per step, split by hairlines. */
.ax-wall__post .wtk__plan li { gap: 12px; padding: 10px 0; border-top: 0; border-bottom: 1px solid var(--ax-border); font-size: var(--ax-fs-sm); }
.ax-wall__post .wtk__plan li:last-child { border-bottom: 0; }
.ax-wall__post .wtk__plan b { font-weight: 500; }
.ax-wall__post .wtk__plan .h { font-family: var(--ax-mono); font-size: 12px; color: var(--ax-muted); }
.ax-wall__post .wtk__plan .k { font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.ax-wall__post .wtk__plan .chip { padding: 0; background: none; color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.ax-wall__post .wtk__plan .chip--warn { color: var(--ax-amber-ink); }
.ax-wall__post .wtk__plan .av { --av-size: 20px; width: 20px; height: 20px; font-size: 10px; border-radius: var(--ax-radius-sm); background: var(--ax-surface-2); color: var(--ax-text-2); border: 1px solid var(--ax-border); }
.ax-wall__post .wtk__mark { width: 20px; height: 20px; border-width: 1px; font-size: 11px; font-weight: 600; }

/* Waits, flags and QA: one line each, words in the state's ink. */
.ax-wall__post .wp__block { margin: 8px 0 0; font-size: var(--ax-fs-sm); color: var(--ax-amber-ink); }
.ax-wall__post .wp__flag { margin: 8px 0 0; font-size: var(--ax-fs-xs); color: var(--ax-amber-ink); }
.ax-wall__post .wp__qa { margin: 8px 0 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.ax-wall__post .fd-fail { margin-top: 8px; }
/* A card that waits on you: the feed's card. */
.ax-wall__post .wc { margin-top: 16px; padding: 12px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-md); background: var(--ax-bg); box-shadow: none; }
.ax-wall__post .wc.is-soon { border-color: var(--ax-amber); }

/* The facts: a quiet two-column list between hairlines. */
.ax-wall__post .wtk__facts { grid-template-columns: 120px 1fr; gap: 6px 16px; margin: 24px 0 0; padding: 12px 0; background: none; border-radius: 0; border-top: 1px solid var(--ax-border); border-bottom: 1px solid var(--ax-border); font-size: var(--ax-fs-sm); }
.ax-wall__post .wtk__facts dd { color: var(--ax-text); }
.ax-wall__post .wtk__facts small { color: var(--ax-muted); }
.ax-wall__post .wtk__facts a { color: inherit; }

/* The meta line: the feed's, with the links out. */
.ax-wall__post .pp__m { margin-top: 12px; }
.ax-wall__post .pp__m > :is(a, button) { display: inline-flex; align-items: center; gap: 5px; font: inherit; color: inherit; background: none; border: 0; padding: 0; text-decoration: none; cursor: pointer; }
@media (hover: hover) { .ax-wall__post .pp__m > :is(a, button):hover { color: var(--ax-text); } }
.ax-wall__post .pp__m .is-err { color: var(--ax-red-ink); }
.pp__home { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* The comment box: the feed's composer; Close and Run on as quiet rows under it. */
.ax-wall__post .wdo { margin: 24px 0 0; padding: 0; border: 0; gap: 8px; }
.ax-wall__post .wdo__l { font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.ax-wall__post .wdo .fd-compose { margin: 0; }
.ax-wall__post .fd-compose textarea { min-height: 44px; }
.ax-wall__post .fd-compose__row { flex-wrap: wrap; gap: 4px; }
.ax-wall__post .fd-compose__row .fd-send { margin-left: auto; }
.ax-wall__post .fd-compose__row .fd-xs { height: 28px; color: var(--ax-text-2); border-color: transparent; background: none; box-shadow: none; }
@media (hover: hover) { .ax-wall__post .fd-compose__row .fd-xs:hover { background: var(--ax-surface-3); color: var(--ax-text); } }
.ax-wall__post .wdo__sp { gap: 2px; }
.ax-wall__post .wdo__sp .fd-pick select { max-width: 140px; }
.ax-wall__post .wdo__row { gap: 8px; }
.ax-wall__post .wdo__row .ax-btn { height: 32px; padding: 0 12px; }
.ax-wall__post .wdo__row select, .ax-wall__post #wdo-hand { height: 32px; padding: 0 8px; font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-text); background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-md); }
.ax-wall__post .wro label { font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.ax-wall__post #wdo-close:empty, .ax-wall__post #wdo-runon:empty, .ax-wall__post #wdo-space:empty { display: none; }

/* The thread: who, what and when on one line; the words under it. */
.ax-wall__post .wp__thread { margin-top: 32px; }
.ax-wall__post .wt { margin: 0; }
.ax-wall__post .wt > li { gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--ax-border); }
.ax-wall__post .wt > li:last-child { border-bottom: 0; }
.ax-wall__post .wt > li::before { content: none; }
/* A reply is a row, not a card (the Reviews page's .wr box stays there). */
.ax-wall__post .wt .wr { margin: 0; padding: 0; border: 0; border-radius: 0; background: none; font-size: var(--ax-fs-sm); color: var(--ax-muted); }
.ax-wall__post .wt > li > .av { --av-size: 24px; width: 24px; height: 24px; flex: none; border-radius: var(--ax-radius-md); background: var(--ax-surface-2); color: var(--ax-text-2); border: 1px solid var(--ax-border); font-size: 10px; font-weight: 600; }
.ax-wall__post .wt .who { font-weight: 500; color: var(--ax-text); }
.ax-wall__post .wt .txt { margin-top: 4px; color: var(--ax-text-2); line-height: 1.5; }
.ax-wall__post .wt .men { background: var(--ax-surface-2); }
.ax-wall__post .wt .more { color: var(--ax-muted); text-decoration: underline; text-underline-offset: 2px; }
.ax-wall__post .wt .wt > li { border-bottom: 0; padding: 6px 0; }

/* Loading: grey blocks where the post and its thread will be (A16). */
.pp-sk { display: block; height: 12px; border-radius: var(--ax-radius-sm); background: var(--ax-surface-3); }
.pp-sk--av { width: 28px; height: 28px; flex: none; border-radius: var(--ax-radius-md); }
.pp-sk--title { width: 60%; height: 22px; margin: 15px 0 11px; }
.pp-sk--prog { height: 54px; margin: 0 0 8px; border-radius: var(--ax-radius-md); }
.pp-sk--line { margin: 0 0 10px; }
.ax-wall__post .wt.is-loading > li { align-items: center; }
.ax-wall__post .wt.is-loading .pp-sk--av { width: 24px; height: 24px; }
@media (prefers-reduced-motion: no-preference) { .pp-sk { animation: pp-pulse 1.4s ease-in-out infinite; } }
@keyframes pp-pulse { 50% { opacity: .55; } }

/* Mid width: the feed's 24px gutters. */
@media (max-width: 1180px) {
  .ax-wall.is-post .ax-wall__main > :is(.ax-wall__head, .ax-wall__post) { padding-left: 24px; padding-right: 24px; max-width: 768px; }
}
/* Phone: 16px gutters, the steps two by two. */
@media (max-width: 640px) {
  .ax-wall.is-post .ax-wall__main > :is(.ax-wall__head, .ax-wall__post) { padding-left: 16px; padding-right: 16px; }
  .ax-wall.is-post .ax-wall__titlebar { padding: 12px 0; }
  .ax-wall.is-post .ax-wall__titlebar h1 { font-size: 20px; }
  .ax-wall__post .wtk__title { font-size: 18px; }
  .ax-wall__post .wtk__prog li { border-top: 1px solid var(--ax-border); }
  .ax-wall__post .wtk__prog li:nth-child(-n+2) { border-top: 0; }
  .ax-wall__post .wtk__prog li:nth-child(odd) { border-left: 0; }
  .ax-wall__post .wtk__facts { grid-template-columns: 96px 1fr; }
  .ax-wall__post .fd-compose textarea { font-size: 16px; }
  .ax-wall__post .fp__h { display: none; }
  /* The feed's phone row keeps its meta on one line; the page wraps it. */
  .ax-wall__post .pp__m { flex-wrap: wrap; }
}
`
