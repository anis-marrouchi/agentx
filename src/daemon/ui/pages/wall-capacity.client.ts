// --- Wall capacity per owner, browser side (#1191) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's esc().
// Shows the capacity rows the Wall reply carries (src/daemon/wall-capacity.ts):
// per agent, its work in progress, the items waiting on it and the
// over-capacity flag. Each owner links to the List filtered on the posts
// counted for it (the "Counted for" filter), so the list matches the numbers.
// Read-only: nothing is written or sent.

export const WALL_CAPACITY_SCRIPT = String.raw`
  // Mirrors wallCapacity in src/daemon/wall-capacity.ts: an open post counts
  // for the agent working on it now (in progress: the active step's agent,
  // else the owner), and for the agent its recorded blocker names.
  function countsFor(p, agent) {
    if (OPEN.indexOf(p.state) < 0) return false;
    var worker = p.state === 'in_progress' ? (p.stepAgent || p.owner) : null;
    if (worker === agent) return true;
    var b = p.blockedBy;
    return !!b && b.kind === 'agent' && b.who === agent && b.who !== p.owner && b.who !== worker;
  }
  function capacityHtml(cap) {
    var rows = (cap && cap.owners) || [];
    var t = cap && typeof cap.threshold === 'number' ? cap.threshold : null;
    var note = t === null ? 'No threshold set, so no agent is flagged.' : 'Flagged: in progress plus waiting above ' + t + '.';
    var head = '<h3>Capacity per owner</h3><p class="ax-wall__count">Open work on every node, by agent. ' + note + '</p>';
    if (!rows.length) return head + '<p class="ax-wall__empty">No agent carries open work.</p>';
    return head + '<table class="wl"><thead><tr><th>Owner</th><th>In progress</th><th>Waiting on it</th><th>Capacity</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var href = '#load=' + encodeURIComponent(r.owner) + '&view=list';
        var flag = r.over ? '<span class="chip chip--warn">over capacity</span>' : t === null ? '—' : 'ok';
        return '<tr' + (r.over ? ' class="is-over"' : '') + '><td><a href="' + esc(href) + '">' + esc(r.owner) + '</a></td>' +
          '<td class="num">' + r.inProgress + '</td><td class="num">' + r.waiting + '</td><td>' + flag + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
`
