// Install matrix pass rate (#1294): the last runs of the install matrix and
// the README badge made from them. No I/O; install-matrix-status.mjs reads
// and writes the files on the install-matrix-status branch.

/** Runs kept, and counted in the pass rate. */
export const KEEP = 20

/**
 * The history after one more run, newest last. A run is one release (or the
 * weekly check) installed every supported way; it passes when every way did.
 */
export function recordRun(history, run, keep = KEEP) {
  const entry = { at: run.at, version: run.version, ok: run.ok === true, run: run.run, cells: run.cells ?? {} }
  return [...(Array.isArray(history) ? history : []), entry].slice(-keep)
}

export function passRate(history) {
  const runs = Array.isArray(history) ? history : []
  const passed = runs.filter((r) => r.ok).length
  return { passed, runs: runs.length, percent: runs.length ? Math.round((passed / runs.length) * 100) : null }
}

/** A shields.io endpoint badge: https://shields.io/badges/endpoint-badge */
export function badgeJson(history) {
  const { passed, runs, percent } = passRate(history)
  const color = percent === null ? "lightgrey" : percent === 100 ? "brightgreen" : percent >= 90 ? "green" : percent >= 75 ? "yellow" : "red"
  return {
    schemaVersion: 1,
    label: "install matrix",
    message: percent === null ? "no runs yet" : `${percent}% of last ${runs} (${passed}/${runs})`,
    color,
  }
}
