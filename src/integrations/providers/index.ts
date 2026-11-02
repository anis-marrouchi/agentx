import type { ProviderSpec } from "./types"
import { META } from "./meta"

// --- Registry of built-in provider specs ---
//
// One spec per outside API (#1696). Meta (Facebook Pages and Instagram)
// is `./meta.ts`; YouTube is added as `./youtube.ts`.

export type ProviderRegistry = Readonly<Record<string, ProviderSpec>>

export const BUILTIN_PROVIDERS: ProviderRegistry = { meta: META }

export function providerFor(kind: string, providers: ProviderRegistry = BUILTIN_PROVIDERS): ProviderSpec | null {
  return Object.prototype.hasOwnProperty.call(providers, kind) ? providers[kind] : null
}

export type { ProviderSpec, ReadSpec, ParamSpec, OAuthSpec, OAuthGrant, ProviderContext, ReadTokenRequest } from "./types"
