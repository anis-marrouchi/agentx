// --- The status tag on a forge comment (#383, #1719) ---
//
// A comment AgentX posts only to say where something stands (the drift
// check's proof note, and the old request status comments still sitting in
// threads) carries this hidden tag. A forge adapter that sees it on a
// comment from an account AgentX posts with drops the comment, whoever
// signed it: a status is never a message to an agent.

export const STATUS_TAG = "<!-- agentx-status -->"

export const isStatusComment = (body: string | undefined | null): boolean => !!body && body.includes(STATUS_TAG)
