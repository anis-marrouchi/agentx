/** A path or package as one shell word: plain ones as they are, others in
 *  single quotes. */
export function shellWord(v: string): string {
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`
}

/** `npx skills add` (skills.sh) for one of its agent names. */
export function skillsAdd(agent: string) {
  return (pkg: string, workspace: string): string =>
    `cd ${shellWord(workspace)} && npx -y skills add ${shellWord(pkg)} -a ${agent} -y`
}
