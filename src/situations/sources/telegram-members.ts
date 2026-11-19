import { situationKey } from "../key"
import { unknownSignal, type Signal, type SignalSource } from "./types"

// --- "Who left" on Telegram groups (#1892 phase 3) ---
//
// Two ways Telegram says someone left:
//   - a `chat_member` update. Telegram sends these only to bots that are
//     admins of the group, and only when `allowed_updates` asks for them;
//   - the `left_chat_member` service message, which bots receive in groups.
// Neither is a list of who is present. Without a leave reported there is
// no answer: a read is `unknown`, which the core treats as absent.
//
// The adapter (channels/telegram.ts) asks `wantsSignal` first, then counts
// the members once (getChatMemberCount, minus our own bots in the group).
// A count it cannot get is null: unknown, nothing moves.

export const TELEGRAM_MEMBERS_SOURCE: SignalSource = {
  id: "telegram-members", kind: "left", sensitivity: "open", platforms: ["any"], mode: "push",
  read: (scope) => [unknownSignal("telegram-members", "present", "", "Telegram reports leaves only (chat_member updates need the bot to be a group admin); it lists no one present", Date.now(), scope.key)],
}

export function telegramLeftSignal(accountId: string, chatId: string, userId: string, remaining: number | null, now: number): Signal {
  return {
    source: TELEGRAM_MEMBERS_SOURCE.id, kind: "left", subject: userId, value: true, checkedAt: now, expiresAt: null,
    reason: "left the group", scope: situationKey("telegram", accountId, chatId), remaining,
  }
}
