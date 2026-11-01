import type { ProviderSpec } from "./types"

// --- Registry of built-in provider specs ---
//
// Empty in the first phase of #1696: the layer (connect, refresh, read
// tool, doctor) lands and is tested with a fake provider first. Meta and
// YouTube specs are added here as `./meta.ts` and `./youtube.ts`.

export type ProviderRegistry = Readonly<Record<string, ProviderSpec>>

export const BUILTIN_PROVIDERS: ProviderRegistry = {}

export function providerFor(kind: string, providers: ProviderRegistry = BUILTIN_PROVIDERS): ProviderSpec | null {
  return Object.prototype.hasOwnProperty.call(providers, kind) ? providers[kind] : null
}

export type { ProviderSpec, ReadSpec, ParamSpec, OAuthSpec, OAuthGrant, ProviderContext } from "./types"
