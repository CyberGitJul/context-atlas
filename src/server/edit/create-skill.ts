import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import type { ScanContext } from '../scan/context.js';
import { SOURCE_KEY, type SkillifyBlock } from '../../shared/skill-links.js';
import { msg } from '../messages/index.js';
import type { ClaudeGit } from './claude-git.js';

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const RESERVED = new Set(['synced']);

/** The reason “Convert to skill” is blocked. */
export const skillifyBlockText = (block: SkillifyBlock): string => msg.edit.skillifyBlock[block.code](block.names);

export type CreateSkillResult =
  | { ok: true; file: string; commit: string | null; warning: string | null; repoCreated: boolean }
  | { ok: false; error: string; exists?: boolean };

/**
 * Creates ~/.claude/skills/<name>/SKILL.md; never overwrites anything, refuses unsafe names.
 * `source` (the section it came from) goes into `metadata`, which Claude Code ignores.
 */
export async function createSkill(ctx: ScanContext, name: string, description: string, body: string, deps: { git: ClaudeGit | null }, source?: string | null): Promise<CreateSkillResult> {
  const m = msg.edit.createSkill;
  if (!SKILL_NAME_RE.test(name)) return { ok: false, error: m.invalidName };
  if (RESERVED.has(name)) return { ok: false, error: m.reserved(name) };
  const skillsDir = path.join(ctx.claudeDir, 'skills');
  await mkdir(skillsDir, { recursive: true });
  const dir = path.join(skillsDir, name);
  try {
    // recursive:false fails if the folder exists — atomic "does not exist yet" check.
    await mkdir(dir, { recursive: false });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, exists: true, error: m.exists(name) };
    throw e;
  }
  const file = path.join(dir, 'SKILL.md');
  const frontmatter = source ? { name, description, metadata: { [SOURCE_KEY]: source } } : { name, description };
  const content = `---\n${stringify(frontmatter).trim()}\n---\n\n${body.trim()}\n`;
  await writeFile(file, content, { flag: 'wx' });

  let commit: string | null = null;
  let warning: string | null = null;
  let repoCreated = false;
  if (deps.git) {
    // The skill exists now; git problems must not turn that into an error.
    try {
      repoCreated = await deps.git.ensureRepo();
      const res = await deps.git.commitFile(file, `add: skill ${name} via Context Atlas`);
      if (res.status === 'committed') commit = res.hash;
      if (res.status === 'secret') warning = m.createdSecret;
    } catch (e) {
      warning = m.createdCommitFailed((e as Error).message.split('\n')[0].slice(0, 160));
    }
  }
  return { ok: true, file, commit, warning, repoCreated };
}
