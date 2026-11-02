import type { ProviderSpec } from "./types"
import { META } from "./meta"
import { YOUTUBE } from "./youtube"

// --- Registry of built-in provider specs ---
//
// One spec per outside API (#1696). Meta (Facebook Pages and Instagram)
// is `./meta.ts`; YouTube (Data API and Analytics) is `./youtube.ts`.

export type ProviderRegistry = Readonly<Record<string, ProviderSpec>>

export const BUILTIN_PROVIDERS: ProviderRegistry = { meta: META, youtube: YOUTUBE }

export function providerFor(kind: string, providers: ProviderRegistry = BUILTIN_PROVIDERS): ProviderSpec | null {
  return Object.prototype.hasOwnProperty.call(providers, kind) ? providers[kind] : null
}

export type { ProviderSpec, ReadSpec, ParamSpec, OAuthSpec, OAuthGrant, ProviderContext, ReadTokenRequest } from "./types"
