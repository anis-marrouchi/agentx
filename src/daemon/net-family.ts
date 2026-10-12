import net from "node:net"

// --- Connect attempt timeout for dual-stack hosts (#930) ---
//
// Node 20+ turns on `autoSelectFamily` (happy eyeballs) for every outbound
// connection, fetch included, and gives each address only 250 ms to connect
// before moving to the next. On a host that resolves both A and AAAA but has
// no IPv6 route, the IPv6 attempt fails at once and the IPv4 attempt is then
// abandoned after 250 ms. A slow uplink whose TCP connect takes longer fails
// every request with ETIMEDOUT about 300 ms in, while curl from the same
// host succeeds. Raising the per-attempt timeout keeps happy eyeballs and
// lets a slow but working link connect.

/**
 * Raise Node's per-address connect attempt timeout to `ms`. Never lowers a
 * larger value already set (for example with
 * `--network-family-autoselection-attempt-timeout`). Returns the value in
 * effect afterwards, or undefined when this Node has no such setting.
 */
export function applyConnectAttemptTimeout(ms: number): number | undefined {
  const get = (net as any).getDefaultAutoSelectFamilyAttemptTimeout as (() => number) | undefined
  const set = (net as any).setDefaultAutoSelectFamilyAttemptTimeout as ((v: number) => void) | undefined
  if (typeof get !== "function" || typeof set !== "function") return undefined
  const current = get()
  if (ms > current) set(ms)
  return get()
}
