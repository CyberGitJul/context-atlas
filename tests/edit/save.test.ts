import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Component } from '../../src/shared/model.js';
import { createClaudeGit } from '../../src/server/edit/claude-git.js';
import { resolveEditable, type EditTarget } from '../../src/server/edit/resolve.js';
import { saveComponentPair, saveComponentText } from '../../src/server/edit/save.js';
import type { ScanContext } from '../../src/server/scan/context.js';
import { scanGlobal } from '../../src/server/scan/index.js';
import { makeFixtureHome } from '../helpers/fixture.js';

const run = promisify(execFile);
let ctx: ScanContext;
let backupRoot: string;
let gitDir: string;

beforeEach(async () => {
  ctx = await makeFixtureHome();
  backupRoot = await mkdtemp(path.join(tmpdir(), 'atlas-backup-'));
  gitDir = path.join(await mkdtemp(path.join(tmpdir(), 'atlas-gitdir-')), 'claude-config.git');
});

async function target(pred: (c: Component) => boolean): Promise<EditTarget> {
  const c = (await scanGlobal(ctx)).components.find(pred)!;
  const t = await resolveEditable(c, ctx);
  if ('readOnly' in t) throw new Error(t.readOnly);
  return t;
}
const deps = () => ({ backupRoot, git: createClaudeGit(ctx.claudeDir, gitDir) });
const claudeMd = () => readFile(path.join(ctx.claudeDir, 'CLAUDE.md'), 'utf8');
const git = async (...args: string[]) => (await run('git', [`--git-dir=${gitDir}`, `--work-tree=${ctx.claudeDir}`, ...args])).stdout.trim();

describe('saveComponentText', () => {
  it('replaces only its CLAUDE.md section, byte for byte around it', async () => {
    const t = await target((c) => c.name === 'Rule A');
    const res = await saveComponentText(t, '## Rule A\nText one two three.\n\n', '## Rule A new\nChanged.\n\n', deps());
    expect(res.ok).toBe(true);
    expect(await claudeMd()).toBe('# Global\n\nPreamble text.\n\n## Rule A new\nChanged.\n\n## Rule B\nFour five.\n');
  });

  it('keeps the next heading on its own line when the new text lacks a final newline', async () => {
    const t = await target((c) => c.name === 'Rule A');
    await saveComponentText(t, '## Rule A\nText one two three.\n\n', '## Rule A\nShort', deps());
    expect(await claudeMd()).toContain('Short\n\n## Rule B\n');
  });

  it('refuses to overwrite a file that changed since it was loaded', async () => {
    const t = await target((c) => c.name === 'Rule A');
    const file = path.join(ctx.claudeDir, 'CLAUDE.md');
    await writeFile(file, (await claudeMd()).replace('Text one', 'Changed elsewhere'));
    const res = await saveComponentText(t, '## Rule A\nText one two three.\n\n', '## Rule A\nMine.\n\n', deps());
    expect(res).toEqual({ ok: false, conflict: true });
    expect(await claudeMd()).toContain('Changed elsewhere');
  });

  it('backs up the old content before writing', async () => {
    const t = await target((c) => c.name === 'style.md');
    const res = await saveComponentText(t, '# Style\n\n- Be concise.\n', '# Style\n\n- Be brief.\n', deps());
    expect(res.ok && (await readFile(res.backup, 'utf8'))).toBe('# Style\n\n- Be concise.\n');
  });

  it('versions ~/.claude with git data kept outside it, committing only the saved file', async () => {
    const t = await target((c) => c.name === 'Rule A');
    const res = await saveComponentText(t, '## Rule A\nText one two three.\n\n', '## Rule A\nNew.\n\n', deps());
    expect(res.ok && res.repoCreated).toBe(true);
    expect(res.ok && res.commit).toMatch(/^[0-9a-f]{7,}$/);
    await expect(stat(path.join(ctx.claudeDir, '.git'))).rejects.toThrow();
    await expect(stat(path.join(ctx.claudeDir, '.gitignore'))).rejects.toThrow();
    await expect(run('git', ['-C', ctx.claudeDir, 'rev-parse', '--git-dir'])).rejects.toThrow();
    expect(await git('ls-files')).toBe('CLAUDE.md');
    await expect(git('check-ignore', 'settings.json')).resolves.toBe('settings.json');
    await expect(git('check-ignore', 'skills/synced/bucket-1/abc/SKILL.md')).resolves.toBe('skills/synced/bucket-1/abc/SKILL.md');
    await expect(git('check-ignore', 'hooks/claude-notifier-config.json')).resolves.toBe('hooks/claude-notifier-config.json');
    expect(await git('log', '-1', '--format=%s')).toContain('CLAUDE.md');
  });

  it('commits the state before the edit first, so the edit commit holds only the edit', async () => {
    const t = await target((c) => c.name === 'Rule A');
    await saveComponentText(t, '## Rule A\nText one two three.\n\n', '## Rule A\nFirst.\n\n', deps());
    const file = path.join(ctx.claudeDir, 'CLAUDE.md');
    await writeFile(file, (await claudeMd()).replace('Four five.', 'Changed outside.'));
    const t2 = await target((c) => c.name === 'Rule A');
    await saveComponentText(t2, '## Rule A\nFirst.\n\n', '## Rule A\nSecond.\n\n', deps());
    const subjects = (await git('log', '--format=%s')).split('\n');
    expect(subjects[0]).toContain('edit: CLAUDE.md (Rule A)');
    expect(subjects[1]).toContain('outside change');
    const editDiff = await git('show', '--format=', 'HEAD');
    expect(editDiff).toContain('+Second.');
    expect(editDiff).not.toMatch(/^[+-].*Changed outside/m);
    expect(await git('show', `${(await git('rev-list', '--max-parents=0', 'HEAD'))}:CLAUDE.md`)).toContain('Text one two three.');
  });

  it('reports a git failure as a warning after a successful write', async () => {
    const t = await target((c) => c.name === 'style.md');
    const broken = { ensureRepo: async () => Promise.reject(new Error('git broken')), commitFile: async () => ({ status: 'unchanged' as const }) };
    const res = await saveComponentText(t, '# Style\n\n- Be concise.\n', '# Style\n\n- Be brief.\n', { backupRoot, git: broken });
    expect(res.ok && res.warning).toContain('Git');
    expect(await readFile(path.join(ctx.claudeDir, 'rules', 'style.md'), 'utf8')).toContain('brief');
  });

  it('serializes concurrent saves of one file so no edit is lost', async () => {
    const a = await target((c) => c.name === 'Rule A');
    const b = await target((c) => c.name === 'Rule B');
    const [ra, rb] = await Promise.all([
      saveComponentText(a, '## Rule A\nText one two three.\n\n', '## Rule A\nA new.\n\n', deps()),
      saveComponentText(b, '## Rule B\nFour five.\n', '## Rule B\nB new.\n', deps()),
    ]);
    expect(ra.ok && rb.ok).toBe(true);
    const text = await claudeMd();
    expect(text).toContain('A new.');
    expect(text).toContain('B new.');
  });

  it.each([
    ['without a heading', 'No heading any more.\n'],
    ['with a second heading', '## Rule A\nx\n\n## New\ny\n'],
  ])('refuses a section text %s', async (_l, after) => {
    const t = await target((c) => c.name === 'Rule A');
    const res = await saveComponentText(t, '## Rule A\nText one two three.\n\n', after, deps());
    expect(res.ok).toBe(false);
    expect(!res.ok && 'invalid' in res && res.invalid).toContain('##');
  });

  it('refuses files that are not valid UTF-8 instead of damaging them', async () => {
    const file = path.join(ctx.claudeDir, 'rules', 'style.md');
    await writeFile(file, Buffer.concat([Buffer.from('# Style\n\n- Be concise.\n'), Buffer.from([0xff, 0xfe, 0x0a])]));
    const t = await target((c) => c.name === 'style.md');
    const before = (await readFile(file)).toString('utf8');
    const res = await saveComponentText(t, before, '# Style\n', deps());
    expect(!res.ok && 'invalid' in res && res.invalid).toContain('UTF-8');
    expect((await readFile(file)).includes(Buffer.from([0xff, 0xfe]))).toBe(true);
  });

  it('writes but does not commit a file that now contains a secret', async () => {
    const t = await target((c) => c.kind === 'hook' && c.name === 'start.sh' && c.origin.type === 'user');
    const res = await saveComponentText(t, "#!/bin/bash\necho 'PROGRESS'\n", '#!/bin/bash\nAPI_KEY=sk-abcdefghijklmnop123 curl x\n', deps());
    expect(res.ok && res.commit).toBeNull();
    expect(res.ok && res.warning).toContain('secret-like');
    expect(await readFile(path.join(ctx.claudeDir, 'hooks', 'start.sh'), 'utf8')).toContain('curl x');
  });

  it('keeps the executable bit of hook scripts', async () => {
    const file = path.join(ctx.claudeDir, 'hooks', 'start.sh');
    await chmod(file, 0o755);
    const t = await target((c) => c.kind === 'hook' && c.name === 'start.sh' && c.origin.type === 'user');
    await saveComponentText(t, "#!/bin/bash\necho 'PROGRESS'\n", "#!/bin/bash\necho 'DONE'\n", deps());
    expect((await stat(file)).mode & 0o777).toBe(0o755);
  });

  it('writes a skill linked into a project at its target, without committing', async () => {
    ctx = { ...ctx, projectRoots: [path.join(ctx.homeDir, 'projects')] };
    const dir = path.join(ctx.homeDir, 'projects', 'ai-skills', 'poll');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: poll\ndescription: Polls.\n---\nOld\n');
    await symlink(dir, path.join(ctx.claudeDir, 'skills', 'poll'));
    const t = await target((c) => c.name === 'poll');
    const res = await saveComponentText(t, '---\nname: poll\ndescription: Polls.\n---\nOld\n', '---\nname: poll\ndescription: Polls.\n---\nNew\n', deps());
    expect(res.ok && res.commit).toBeNull();
    expect(await readFile(path.join(dir, 'SKILL.md'), 'utf8')).toContain('New');
  });

  it('never puts a secret from another section into git, not even in the outside-change commit', async () => {
    const file = path.join(ctx.claudeDir, 'CLAUDE.md');
    await writeFile(file, (await claudeMd()).replace('Four five.', 'ROUTER_API_KEY=sk-abcdefghijklmnop123 Four five.'));
    const t = await target((c) => c.name === 'Rule A');
    const res = await saveComponentText(t, '## Rule A\nText one two three.\n\n', '## Rule A\nNew.\n\n', deps());
    expect(res.ok && res.warning).toContain('secret-like');
    const history = await git('log', '--all', '-p').catch(() => '');
    expect(history).not.toContain('sk-abcdefghijklmnop123');
  });

  it('commits saves of different files in parallel without git lock errors', async () => {
    for (let i = 0; i < 6; i++) await writeFile(path.join(ctx.claudeDir, 'rules', `r${i}.md`), `# R${i}\n\nold\n`);
    const comps = (await scanGlobal(ctx)).components.filter((c) => /^r\d\.md$/.test(c.name));
    const targets = await Promise.all(comps.map(async (c) => { const t = await resolveEditable(c, ctx); if ('readOnly' in t) throw new Error(t.readOnly); return t; }));
    const results = await Promise.all(targets.map((t, i) => saveComponentText(t, `# R${i}\n\nold\n`.replace(`R${i}`, path.basename(t.realFile, '.md').toUpperCase()), `# new ${i}\n`, deps())));
    for (const r of results) expect(r.ok && r.warning).toBeNull();
    const hashes = results.map((r) => (r.ok ? r.commit : null));
    expect(new Set(hashes).size).toBe(6);
  });

  it('says when a changed file is outside the whitelist instead of "no commit needed"', async () => {
    await mkdir(path.join(ctx.claudeDir, 'agents', 'sub'), { recursive: true });
    await writeFile(path.join(ctx.claudeDir, 'agents', 'sub', 'x.md'), '---\nname: x\n---\nold\n');
    const t: EditTarget = { file: path.join(ctx.claudeDir, 'agents', 'sub', 'x.md'), realFile: path.join(ctx.claudeDir, 'agents', 'sub', 'x.md'), inRepo: true };
    const res = await saveComponentText(t, '---\nname: x\n---\nold\n', '---\nname: x\n---\nnew\n', deps());
    expect(res.ok && res.commitStatus).toBe('ignored');
  });

});

describe('saveComponentPair', () => {
  const skillFile = () => path.join(ctx.claudeDir, 'skills', 'good-skill', 'SKILL.md');
  const sectionB = '## Rule B\nFour five.\n';

  it('saves a section and its skill together, each with backup and commit', async () => {
    const section = await target((c) => c.name === 'Rule B');
    const skill = await target((c) => c.kind === 'skill' && c.name === 'good-skill');
    const skillBefore = await readFile(skillFile(), 'utf8');
    const skillAfter = '---\nname: good-skill\ndescription: Use when testing things.\n---\n\n# Good\n1. Step\n';
    const res = await saveComponentPair({ target: section, before: sectionB, after: '## Rule B\nShorter.\n' }, { target: skill, before: skillBefore, after: skillAfter }, deps());
    expect(res.ok).toBe(true);
    expect(await claudeMd()).toContain('## Rule B\nShorter.\n');
    expect(await readFile(skillFile(), 'utf8')).toBe(skillAfter);
    expect(res.ok && [res.first.commit, res.second.commit].every(Boolean)).toBe(true);
  });

  it('writes nothing when either file changed since it was loaded', async () => {
    const section = await target((c) => c.name === 'Rule A');
    const skill = await target((c) => c.kind === 'skill' && c.name === 'good-skill');
    const original = await claudeMd();
    const res = await saveComponentPair({ target: section, before: '## Rule A\nText one two three.\n\n', after: '## Rule A\nNew.\n\n' }, { target: skill, before: 'outdated', after: 'whatever' }, deps());
    expect(res).toEqual({ ok: false, conflict: true });
    expect(await claudeMd()).toBe(original);
  });

  it('puts the first file back when the second cannot be written, so it is both or neither', async () => {
    const a = await target((c) => c.name === 'Rule A');
    const b = await target((c) => c.name === 'Rule B');
    const original = await claudeMd();
    const res = await saveComponentPair({ target: a, before: '## Rule A\nText one two three.\n\n', after: '## Rule A\nNew.\n\n' }, { target: b, before: sectionB, after: 'no section' }, deps());
    expect(res.ok).toBe(false);
    expect(await claudeMd()).toBe(original);
  });
});
