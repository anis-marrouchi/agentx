// --- Wall capacity per owner, browser side (#1191) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's esc().
// Shows the capacity rows the Wall reply carries (src/daemon/wall-capacity.ts):
// per agent, its work in progress, the items waiting on it and the
// over-capacity flag. Each owner links to the list of its open posts.
// Read-only: nothing is written or sent.

export const WALL_CAPACITY_SCRIPT = String.raw`
  function capacityHtml(cap) {
    var rows = (cap && cap.owners) || [];
    var t = cap && typeof cap.threshold === 'number' ? cap.threshold : null;
    var note = t === null ? 'No threshold set, so no agent is flagged.' : 'Flagged: in progress plus waiting above ' + t + '.';
    var head = '<h3>Capacity per owner</h3><p class="ax-wall__count">Open work on every node, by agent. ' + note + '</p>';
    if (!rows.length) return head + '<p class="ax-wall__empty">No agent carries open work.</p>';
    return head + '<table class="wl"><thead><tr><th>Owner</th><th>In progress</th><th>Waiting on it</th><th>Capacity</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var href = '#owner=' + encodeURIComponent(r.owner) + '&view=list';
        var flag = r.over ? '<span class="chip chip--warn">over capacity</span>' : t === null ? '—' : 'ok';
        return '<tr' + (r.over ? ' class="is-over"' : '') + '><td><a href="' + esc(href) + '">' + esc(r.owner) + '</a></td>' +
          '<td class="num">' + r.inProgress + '</td><td class="num">' + r.waiting + '</td><td>' + flag + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
`
