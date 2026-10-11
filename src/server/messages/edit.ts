/** Server texts of the edit area shown in the interface. */
export const edit = {
  /** Why a component cannot be edited (read-only reasons). */
  resolve: {
    plugin: (plugin: string) => `Comes from the plugin ${plugin}. Plugin files are not edited, an update would overwrite them.`,
    live: 'Acts only at runtime and is in no file.',
    dangling: 'Orphaned link: the target does not exist.',
    claudeAi: 'Synced from claude.ai. Please make changes there, otherwise the next sync overwrites them.',
    installer: 'Managed by an installer (~/.agents). Changes would be overwritten by the next update.',
    external: 'Link to a place outside ~/.claude and the project folders (PROJECT_ROOTS in .env).',
    hookCommand: 'The command is written directly in settings.json. Editing settings follows in a later slice.',
    memory: 'Memory notes are maintained by Claude Code itself (~/.claude/projects). Change them in a session in that project or by hand.',
    laterSlice: 'Editing this kind follows in a later slice.',
    noFile: 'No file known.',
    fileGone: 'The file no longer exists. Please reload.',
    managedArea: 'It is in an area managed by Claude Code.',
    outside: 'It is outside the places you can edit.',
    hookOutside: 'The script is outside ~/.claude/hooks.',
    changedSinceLoad: 'The file changed since it was loaded. Please reload the overview.',
    secrets: 'Contains secret-like values. They are shown masked; editing is locked here so that saving does not destroy anything.',
  },
  save: {
    sectionStart: 'A CLAUDE.md section must start with its “## ” heading.',
    sectionTwoHeadings: 'A section may contain only one “## ” heading. Please create new sections separately.',
    partialSave: (backup: string) => `Only the first file was saved, putting it back failed. Previous version: ${backup}`,
    notUtf8: 'The file is not valid UTF-8. It is not edited here so that nothing gets damaged.',
    gitProblem: (error: string) => `Git: ${error}`,
    secretNotVersioned: 'The previous version was not versioned: the file contains secret-like values.',
    savedCommitFailed: (error: string | null) => `Saved, but the Git commit failed: ${error ?? 'unknown'}`,
    savedNotCommittedSecret: 'Saved, but not committed: the file contains secret-like values that do not belong in the Git repo.',
  },
  /** Files proposed in the chat. */
  files: {
    runsCode: 'This file runs code or controls permissions: a change takes effect in every session. Please check every line.',
    mayRunCode:
      'Commands, skills and agents can run commands (!`…`) and grant rights (allowed-tools, hooks, permissionMode). A change takes effect as soon as Claude loads it. Please check every line.',
    noPath: 'No path given.',
    fullPath: 'Please give a full path (~/… or /…).',
    notAllowed: (path: string) => `Not allowed: ${path}. Allowed are your own configuration files under ~/.claude and the single files from config/chat-files.json.`,
    symlinkOut: 'The path leads out of the allowed area through a symlink. Please edit the file at its target.',
    notRegular: 'That is not a regular file.',
    symlinkNoTarget: 'The path is a symlink without a target. Please repair or delete the link by hand.',
    notUtf8: 'The file is not valid UTF-8 and is not edited here.',
    hasSecrets: 'The file contains secret-like values. A proposal made from masked text would destroy them; please edit it by hand.',
    createdSecret: 'Created, but not committed: the file contains secret-like values.',
    createdCommitFailed: (error: string) => `Created, but the Git commit failed: ${error}`,
    jsonInvalid: (line: number, column: number) => `Not valid JSON (line ${line}, column ${column}). Nothing saved; otherwise Claude Code would ignore the whole file.`,
    settingsNotObject: 'settings.json must be a JSON object. Nothing saved.',
  },
  /** Rules for a proposed SKILL.md, agent or command. */
  fileCheck: {
    /** Where a same-named component comes from, shown in parentheses. */
    where: (plugin: string | null, enabled: boolean) => `${plugin ? `from plugin ${plugin}` : 'your own'}${enabled ? '' : ', switched off'}`,
    noFrontmatterSkill: 'The frontmatter block is missing at the top (--- with name and description ---). Without it Claude cannot find the skill.',
    noFrontmatterAgent: 'The frontmatter block is missing at the top (--- with name and description ---). Without it Claude Code does not load the subagent.',
    nameMissing: 'name is missing in the frontmatter.',
    nameFolder: (name: string, folder: string) => `name “${name}” must equal the folder name “${folder}”.`,
    nameFormat: (name: string, max: number) => `name “${name}”: only lowercase letters, digits and single hyphens, at most ${max} characters.`,
    nameFile: (name: string, file: string) => `name “${name}” differs from the file name “${file}”. That works, but makes it harder to find.`,
    descriptionMissingSkill: 'description is missing. Claude uses it to decide when to load the skill.',
    descriptionMissingAgent: 'description is missing. Claude uses it to decide when to start the subagent.',
    descriptionLong: (length: number, max: number) => `description has ${length} characters, ${max} are allowed.`,
    descriptionUseWhen: 'description does not start with “Use when …”. It should say when the skill applies, not how it works.',
    skillExists: (name: string, where: string) => `A skill “${name}” already exists (${where}). Two with the same name make it unclear which one loads.`,
    agentExists: (name: string, where: string) => `A subagent “${name}” already exists (${where}). Two with the same name make it unclear which one starts.`,
    commandNoDescription: (name: string) => `No description in the frontmatter. Without it the command list does not show what /${name} is for.`,
    commandExists: (name: string, kind: 'skill' | 'command', where: string) =>
      `/${name} already exists as a ${kind === 'skill' ? 'skill' : 'command'} (${where}). The same name makes it unclear what the call starts.`,
  },
  createSkill: {
    invalidName: 'Invalid skill name: only lowercase letters, digits and hyphens, 2–64 characters.',
    reserved: (name: string) => `“${name}” is a reserved folder (managed by claude.ai).`,
    exists: (name: string) => `The skill “${name}” already exists. Please choose another name.`,
    createdSecret: 'Created, but not committed: the content contains secret-like values.',
    createdCommitFailed: (error: string) => `Created, but the Git commit failed: ${error}`,
  },
  /** Why “Convert to skill” is blocked for a section; see `skillifyBlock` in shared/skill-links. */
  skillifyBlock: {
    moved: (names: string[]) => `already moved out to skill “${names.join('”, “')}”`,
    saved: (names: string[]) => `once saved, the section points to skill “${names.join('”, “')}”`,
    sourced: (names: string[]) => `skill “${names.join('”, “')}” already comes from this section (atlas-source)`,
  },
  stale: {
    pathMissing: 'The path does not exist (any more).',
    pathOtherHost: 'Not on this machine, cannot be checked (for example a path on another host).',
    nameUnknown: 'No known skill, subagent, MCP server, command or hook with this name.',
  },
  /** Fixed checks of a condensed CLAUDE.md section. */
  condense: {
    headingChanged: 'The heading has changed.',
    extraHeading: 'The section contains another “## ” heading.',
    pointerMissing: (lines: string[]) => `Pointer line missing: ${lines.join(', ')}.`,
    missingVerbatim: (shown: string[], more: number) => `Missing word for word: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`,
    fewerStrict: (changes: { word: string; before: number; after: number }[]) =>
      `Fewer negations or obligation words: ${changes.map((c) => `“${c.word}” ${c.before} → ${c.after}`).join(', ')}.`,
    secretLike: 'To the secret detection the new text looks like a secret (such as “Token: …”). Saved like that, editing, AI actions and commits of CLAUDE.md would be locked.',
  },
  /** Sources that could not be read, listed in the scan problems. */
  scan: {
    invalidJson: (line: number, column: number) => `invalid JSON (line ${line}, column ${column})`,
    mcpNotObject: (name: string) => `MCP entry “${name}” is not an object`,
    aborted: (error: string) => `Scan aborted (${error})`,
    parts: { instructions: 'Instructions', misc: 'Settings, agents, memory', mcp: 'MCP servers', latent: 'Unloaded files' },
  },
};
