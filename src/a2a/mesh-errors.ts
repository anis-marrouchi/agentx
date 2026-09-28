// --- Mesh error wrappers ---
//
// A failure that crosses the mesh arrives wrapped in our own plumbing. A
// fallback hop wraps the origin peer's message, e.g.
//   Peer "a" /task error: 500: mesh fallback failed: Peer "b" /task error: 500: <real cause>
// and a peer that answered 200 with an error gives
//   Peer "a" agent error: <real cause>
// (both shapes come from mesh.sendTask and registry's mesh fallback).
//
// One peel, shared by the router's failure notice (cleanMeshError) and the
// queued-answer check (parseQueued), so the two never disagree about what
// the peer actually said.

/** The innermost cause of a mesh error, without peer names or status codes.
 *  Runs until it stops making progress; bounded for safety. */
export function unwrapMeshError(raw: string): string {
  let out = (raw || "").trim()
  for (let i = 0; i < 5; i++) {
    const before = out
    out = out
      .replace(/^Peer\s+"[^"]*"\s+\/task error:\s*\d{3}:\s*/i, "")
      .replace(/^Peer\s+"[^"]*"\s+agent error:\s*/i, "")
      .replace(/^mesh fallback failed:\s*/i, "")
      .trim()
    if (out === before) break
  }
  return out
}
