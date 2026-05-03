// Pure helper extracted from MessageRouter so it's testable without
// instantiating a registry/router (heavy filesystem deps). The router calls
// this with its live config + an adapter callback for group membership.

interface AccountLike {
  agentBinding: string
}

/**
 * Pick the Telegram account that should canonically handle traffic for an
 * agent. When multiple accounts share the same agentBinding (e.g. pm-ksi has
 * both @noqta_ksi_bot and @noqta_pm_ksi_bot), prefer one whose bot is a
 * member of the target group — without that, multi-account-dedup picks the
 * first config-order match and silently drops messages received via the
 * other bot when the "canonical" one isn't in the chat.
 *
 * - groupId omitted → first config-order match (DM path).
 * - groupId set, getGroupBotAccounts returns members → first matching member,
 *   else fall back to first candidate.
 */
export function pickAccountForAgent(
  accounts: Record<string, AccountLike>,
  agentId: string,
  groupId?: string,
  getGroupBotAccounts?: (groupId: string) => string[],
): string | undefined {
  const candidates: string[] = []
  for (const [accountId, account] of Object.entries(accounts)) {
    if (account.agentBinding === agentId) candidates.push(accountId)
  }
  if (candidates.length === 0) return undefined
  if (candidates.length === 1 || !groupId) return candidates[0]

  const inGroup = getGroupBotAccounts?.(groupId) ?? []
  const memberCandidates = candidates.filter((id) => inGroup.includes(id))
  return memberCandidates[0] || candidates[0]
}
