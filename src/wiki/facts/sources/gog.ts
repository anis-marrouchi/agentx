import { binaryExists, run } from "../exec"
import type { EntityHint, FactRecord, FactSource } from "../types"

// Contact cards, from Google Contacts via `gog`.
//
// On this install the People API is not enabled on the OAuth project and
// every call returns 403 accessNotConfigured. That is the normal case
// for a source, not an exception: `available()` reports false, the
// resolver drops it, and the absorb runs with one fewer input. Enabling
// the API turns it on with no code change.

interface GogContact {
  names?: Array<{ displayName?: string }>
  emailAddresses?: Array<{ value?: string }>
  phoneNumbers?: Array<{ value?: string }>
  organizations?: Array<{ name?: string; title?: string }>
  addresses?: Array<{ formattedValue?: string; country?: string }>
}

export function createGogSource(): FactSource {
  return {
    name: "gog",
    provides: ["contact value", "email", "organisation", "role", "country"],
    async available() {
      if (!(await binaryExists("gog"))) {
        return { kind: "not-installed", hint: "brew install gog  — Google CLI" }
      }
      // A 403 for a disabled API is reported on stdout with exit 0, so
      // the exit code alone would call this source healthy. The probe
      // takes no flags beyond -j: an unknown flag makes gog print a
      // usage error instead of calling the API, and the probe then
      // passes while every real lookup fails.
      const { stdout, stderr } = await run("gog", ["contacts", "list", "-j"], { timeoutMs: 20_000 })
      const out = stdout + stderr
      if (/unknown flag|Run with --help/i.test(out)) {
        return { kind: "failed", hint: `gog rejected the probe: ${out.split("\n")[0]}` }
      }
      if (/accessNotConfigured|has not been used in project/i.test(out)) {
        return {
          kind: "not-configured",
          hint: "enable the People API on the gog OAuth project, then retry (console.developers.google.com → APIs → People API)",
        }
      }
      if (/invalid_grant|PERMISSION_DENIED|unauthenticated/i.test(out)) {
        return { kind: "not-configured", hint: "gog auth login  — the stored token is expired or lacks contacts scope" }
      }
      return null
    },
    async lookup(hints: EntityHint[], signal?: AbortSignal) {
      const records: FactRecord[] = []
      for (const h of hints) {
        const { stdout, code } = await run("gog", ["contacts", "search", h.name, "-j", "--results-only"], { signal, timeoutMs: 20_000 })
        if (code !== 0) continue
        let parsed: unknown
        try { parsed = JSON.parse(stdout) } catch { continue }
        const list: GogContact[] = Array.isArray(parsed)
          ? (parsed as GogContact[])
          : ((parsed as { results?: unknown[]; people?: unknown[] })?.results as GogContact[])
            ?? ((parsed as { people?: unknown[] })?.people as GogContact[])
            ?? []
        for (const c of list) {
          const fields: Record<string, string> = {}
          const phone = c.phoneNumbers?.[0]?.value
          const email = c.emailAddresses?.[0]?.value
          const org = c.organizations?.[0]
          if (phone) fields.phone = phone
          if (email) fields.email = email
          if (org?.name) fields.organisation = org.name
          if (org?.title) fields.role = org.title
          const country = c.addresses?.[0]?.country
          if (country) fields.country = country
          if (Object.keys(fields).length === 0) continue
          records.push({ name: c.names?.[0]?.displayName ?? h.name, source: "gog", fields })
        }
      }
      return records
    },
  }
}
