/** Hint bar texts. */
export const hints = {
  sourceUnreadable: (list: string) => `Could not be read, so its content is missing from the overview: ${list}`,
  claudeMdLong: (words: number, limit: number) => `The global CLAUDE.md has ${words} words (limit ${limit}) and is sent in full with every message.`,
  brokenItem: (section: string, skill: string, missing: boolean) => `“${section}” → skill \`${skill}\` (${missing ? 'does not exist or its plugin is off' : 'switched off'})`,
  broken: (list: string) => `Pointer to nowhere: ${list}`,
  unlinkedGone: (skill: string, source: string) => `Skill \`${skill}\` comes from “${source}”, but that section no longer exists (renamed?)`,
  unlinkedNoPointer: (skill: string, section: string) => `Skill \`${skill}\` comes from “${section}”, but the section does not point to it`,
  unlinked: (list: string) => `Loose link: ${list}. Either add the line “Procedure: skill …” or merge the content into one place.`,
  dangling: (names: string) => `Orphaned skill link (target missing): ${names}`,
  noDescription: (names: string) => `Skill without a description, never triggers reliably: ${names}`,
  offInstalled: (n: number, names: string) => `${n} ${n === 1 ? 'skill' : 'skills'} switched off but still installed: ${names}`,
  liveOnly: (n: number, names: string) => `${n} ${n === 1 ? 'source acts' : 'sources act'} only at runtime and ${n === 1 ? 'is' : 'are'} in no config file: ${names}`,
  pluginsProjectOnly: (names: string) => `Installed only in single projects: ${names}`,
  latentFiles: (names: string) => `Present in ~/.claude but loaded nowhere: ${names}`,
};
