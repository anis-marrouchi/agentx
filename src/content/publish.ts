import { mkdirSync, writeFileSync } from "fs"
import { resolve } from "path"
import type { DaemonConfig } from "@/daemon/config"
import { getIntegration } from "@/integrations/resolve"
import { PLATFORM_LABEL, type ContentDraft, type PublishContent, type PublishResult } from "./drafts"

// --- Publishing an approved draft ---
//
// Called only after the owner's yes (drafts.ts decideContentDraft).
//
// With a connector on the drafting agent (an `integrations[]` entry of
// kind "linkedin" or "x" whose token is set), the post goes out through
// the platform's API. Without one, it is saved as a ready-to-paste text
// file in <workspace>/ready/. When the platform refuses the post,
// the file is saved too, so the approved text is never lost.
//
//   linkedin  POST https://api.linkedin.com/rest/posts
//             credentials.tokenEnv: a member access token (w_member_social)
//             metadata.author: urn:li:person:<id> or urn:li:organization:<id>
//             metadata.apiVersion: LinkedIn-Version header, YYYYMM (optional)
//   x         POST https://api.x.com/2/tweets
//             credentials.tokenEnv: an OAuth 2.0 user token (tweet.write)

export const READY_DIR = "ready"
export const LINKEDIN_API_VERSION = "202510"

export interface PublishDeps {
  /** Only `agents.<id>.integrations` is read. */
  config: Pick<DaemonConfig, "agents"> | Record<string, unknown>
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
}

export function readyFileFor(draft: ContentDraft): string {
  const day = draft.date ?? draft.created_at.slice(0, 10)
  return resolve(draft.workspace, READY_DIR, `${day}-${draft.platform}-${draft.id}.txt`)
}

/** The post as a plain text file, nothing but the text, ready to paste. */
export function exportDraft(draft: ContentDraft): string {
  const file = readyFileFor(draft)
  mkdirSync(resolve(draft.workspace, READY_DIR), { recursive: true })
  writeFileSync(file, draft.text.endsWith("\n") ? draft.text : `${draft.text}\n`)
  return file
}

interface Connector {
  token: string
  metadata: Record<string, string | number | boolean>
}

/** The agent's enabled connector for the platform, when its token is set. */
export function connectorFor(deps: PublishDeps, agent: string, platform: string): Connector | null {
  const found = getIntegration(deps.config as DaemonConfig, agent, platform)
  if (!found) return null
  const env = deps.env ?? process.env
  const name = found.integration.credentials?.tokenEnv
  const token = name ? env[name] : undefined
  if (!token) return null
  return { token, metadata: found.integration.metadata ?? {} }
}

/** True when an approved draft of this agent would be posted, not saved to paste. */
export function hasConnector(deps: PublishDeps, agent: string, platform: string): boolean {
  return connectorFor(deps, agent, platform) !== null
}

async function postLinkedIn(text: string, c: Connector, doFetch: typeof fetch): Promise<{ url?: string }> {
  const author = String(c.metadata.author ?? "")
  if (!/^urn:li:(person|organization):/.test(author)) {
    throw new Error("the linkedin connector needs metadata.author, like urn:li:person:<id>")
  }
  const res = await doFetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.token}`,
      "Content-Type": "application/json",
      "LinkedIn-Version": String(c.metadata.apiVersion ?? LINKEDIN_API_VERSION),
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author,
      commentary: text,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`LinkedIn said ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
  const urn = res.headers.get("x-restli-id")
  return urn ? { url: `https://www.linkedin.com/feed/update/${urn}/` } : {}
}

async function postX(text: string, c: Connector, doFetch: typeof fetch): Promise<{ url?: string }> {
  const res = await doFetch("https://api.x.com/2/tweets", {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`X said ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
  const data = await res.json().catch(() => ({})) as { data?: { id?: string } }
  return data.data?.id ? { url: `https://x.com/i/web/status/${data.data.id}` } : {}
}

export async function publishDraft(draft: ContentDraft, deps: PublishDeps): Promise<PublishResult> {
  const connector = connectorFor(deps, draft.agent, draft.platform)
  if (!connector) return { ok: true, posted: false, file: exportDraft(draft) }
  const doFetch = deps.fetch ?? fetch
  try {
    const r = draft.platform === "linkedin"
      ? await postLinkedIn(draft.text, connector, doFetch)
      : await postX(draft.text, connector, doFetch)
    return { ok: true, posted: true, ...(r.url ? { url: r.url } : {}) }
  } catch (e: any) {
    const file = exportDraft(draft)
    return { ok: false, error: `not posted on ${PLATFORM_LABEL[draft.platform]}: ${e?.message ?? e}. Saved to paste by hand: ${file}`, file }
  }
}

export function publisher(deps: PublishDeps): PublishContent {
  return (draft) => publishDraft(draft, deps)
}
