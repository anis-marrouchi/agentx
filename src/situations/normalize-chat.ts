/** Normalize a chat identifier for comparison. Channel-aware: WhatsApp
 *  ids drift between formats (raw digits "10000000000", JID
 *  "10000000000@s.whatsapp.net", group JID "...-...@g.us", and human-formatted
 *  "+216 00 000 000") depending on whether they came from the adapter's
 *  payload, a copy-paste from the WA UI, or an editor field. We collapse all
 *  of these to the canonical bare-id form before equality so authors can write
 *  filters in whichever form is convenient. Other channels (Telegram, GitLab,
 *  ...) use stable id formats from their APIs and don't need normalization.
 *
 *  `source` is the trigger source form ("whatsapp-message"), not the channel
 *  name: called with "whatsapp" it changes nothing. Shared by the workflow
 *  dispatcher and the situation key (#1892). */
export function normalizeChat(source: string | undefined, value: string | undefined): string {
  if (value == null) return ""
  if (source === "whatsapp-message") {
    return value.replace(/@s\.whatsapp\.net$|@g\.us$/i, "").replace(/[\s+()]/g, "")
  }
  return value
}
