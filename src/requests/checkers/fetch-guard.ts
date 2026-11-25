import { BlockList, isIP } from "net"
import { lookup as dnsLookup } from "dns"
import { Agent, fetch as undiciFetch } from "undici"

// --- The fetch guard of the URL check (#2122) ---
//
// The URL check opens addresses an agent wrote: a proof link, a plan
// step's check address, a loop's closeWhen. The daemon must not open one
// that points at this machine or its network (SSRF). Before each fetch,
// and before each redirect is followed, the host is resolved and every
// address it has is checked: loopback, private, link-local, ULA and the
// like are refused. Only http and https. The connection itself resolves
// through the same check, so a name that changes its answer between the
// check and the connect (DNS rebinding) is refused too.

/** The ranges a link may not reach. */
const BLOCKED = new BlockList()
for (const [net, bits] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) BLOCKED.addSubnet(net, bits, "ipv4")
for (const [net, bits] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // local-use NAT64
  ["fc00::", 7], // unique local (ULA)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (old)
  ["ff00::", 8], // multicast
] as const) BLOCKED.addSubnet(net, bits, "ipv6")

/** Why an address may not be fetched, or null when it may. */
export function blockedAddress(address: string): string | null {
  const family = isIP(address)
  if (!family) return `${address} is not an IP address`
  // An IPv4-mapped IPv6 address (::ffff:127.0.0.1, ::ffff:7f00:1) is
  // checked as the IPv4 address it carries.
  const mapped = family === 6 ? mappedV4(address) : null
  const blocked = mapped ? BLOCKED.check(mapped, "ipv4") : BLOCKED.check(address, family === 6 ? "ipv6" : "ipv4")
  return blocked ? `${address} is a private, loopback or link-local address` : null
}

function mappedV4(address: string): string | null {
  const m = address.toLowerCase().match(/^(?:::|(?:0{1,4}:){5})ffff:(.+)$/)
  if (!m) return null
  const tail = m[1]
  if (isIP(tail) === 4) return tail
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hex) return null
  const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/** Every address a host name resolves to. */
export type HostLookup = (host: string) => Promise<string[]>

const systemLookup: HostLookup = (host) => new Promise((resolve, reject) => {
  dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs.map((a) => a.address))))
})

const MAX_REDIRECTS = 5

/** Why the address of `url` may not be fetched, or null when it may. */
export async function refusedUrl(url: URL, lookup: HostLookup = systemLookup): Promise<string | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol} is not http or https`
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase()
  if (!host) return "the address has no host"
  if (host === "localhost" || host.endsWith(".localhost") || host === "local" || host.endsWith(".local")) return `${host} is a local name`
  if (isIP(host)) return blockedAddress(host)
  let addrs: string[]
  try {
    addrs = await lookup(host)
  } catch (e: any) {
    return `${host} did not resolve: ${String(e?.code ?? e?.message ?? e).slice(0, 100)}`
  }
  if (!addrs.length) return `${host} did not resolve`
  for (const a of addrs) {
    const why = blockedAddress(a)
    if (why) return `${host} resolves to ${why.replace(/ is /, ", ")}`
  }
  return null
}

/** The connect-time lookup: the answer the socket uses is checked too. */
function guardedConnectLookup(hostname: string, options: any, callback: (...args: any[]) => void): void {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, addrs: any) => {
    if (err) return callback(err)
    const list = addrs as Array<{ address: string; family: number }>
    const bad = list.map((a) => blockedAddress(a.address)).find(Boolean)
    if (bad || !list.length) return callback(Object.assign(new Error(`refused: ${hostname} resolves to ${bad ? bad.replace(/ is /, ", ") : "nothing"}`), { code: "EREFUSEDPRIVATE" }))
    if (options?.all) return callback(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

let pinned: Agent | undefined
const defaultFetch: typeof fetch = (input, init) => {
  pinned ??= new Agent({ connect: { lookup: guardedConnectLookup as any } })
  return undiciFetch(input as any, { ...(init as any), dispatcher: pinned }) as unknown as Promise<Response>
}

/** A fetch that refuses private addresses and follows redirects itself,
 *  checking each one. Throws (as fetch does on a network error) when an
 *  address is refused, so a check reads it as not reachable. Tests give
 *  their own `fetch` and `lookup`. */
export function guardedFetch(opts: { fetch?: typeof fetch; lookup?: HostLookup; maxRedirects?: number } = {}): typeof fetch {
  const inner = opts.fetch ?? defaultFetch
  const lookup = opts.lookup ?? systemLookup
  const max = opts.maxRedirects ?? MAX_REDIRECTS
  return (async (input: string | URL | Request, init?: RequestInit) => {
    let url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
    for (let hop = 0; ; hop++) {
      const why = await refusedUrl(url, lookup)
      if (why) throw new Error(`refused: ${why}${hop ? ` (redirected to ${url.href})` : ""}`)
      const res = await inner(url.href, { ...init, redirect: "manual" })
      const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null
      if (!to) return res
      await res.body?.cancel().catch(() => {})
      if (hop >= max) throw new Error(`more than ${max} redirects`)
      url = new URL(to, url)
    }
  }) as typeof fetch
}

/** The URL check's fetch when no other is given. */
export const safeFetch: typeof fetch = guardedFetch()
