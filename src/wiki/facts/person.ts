/** Refuse when running as an agent: the runtime sets AGENTX_AGENT_ID for
 *  every agent process, so confirming a fact, approving a proposal or
 *  settling a fact disagreement stays with a person. */
export function assertPerson(action: string): void {
  const agent = process.env.AGENTX_AGENT_ID?.trim()
  if (agent) throw new Error(`only a person can ${action}; this is running as agent "${agent}". Ask the owner instead.`)
}
