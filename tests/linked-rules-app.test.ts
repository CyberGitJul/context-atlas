import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ConflictsView } from '../src/shared/conflicts.js';
import { joinSections } from '../src/shared/sections.js';
import { createApp } from '../src/server/app.js';
import { createExplanationCache } from '../src/server/ai/cache.js';
import type { BackgroundTask, ExplainQueue } from '../src/server/ai/queue.js';
import type { JsonRequest } from '../src/server/ai/router-client.js';
import { createConflictChecker } from '../src/server/conflicts/checker.js';
import type { RawFinding } from '../src/server/conflicts/quotes.js';
import { createConflictStore } from '../src/server/conflicts/store.js';
import { createEventHub } from '../src/server/events.js';
import { scanGlobal } from '../src/server/scan/index.js';
import { git, linkedRuleHome, RULE_TEXT } from './helpers/linked.js';

const RULE_ID = 'rule:user:arbeitsregeln.md';
const PROMPTS_DIR = path.join(process.cwd(), 'config', 'prompts');
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

type Repo = { display: string; file: string | null; branch: string | null; upstream: string | null; ahead: number; changes: { path: string; status: string }[] };

async function setup(opts: { answer?: (req: JsonRequest) => unknown; readOnly?: boolean } = {}) {
  const home = await linkedRuleHome();
  const cache = createExplanationCache(path.join(await mkdtemp(path.join(tmpdir(), 'atlas-app-')), 'e.json'));
  await cache.load();
  const prompts: JsonRequest[] = [];
  const client = { json: async <T,>(req: JsonRequest) => (prompts.push(req), { result: structuredClone(opts.answer?.(req) ?? {}) as T, model: req.model }) };
  const queue: ExplainQueue = { enqueue() {}, enqueueTask() {}, pause() {}, resume() {}, state: () => ({ pending: 0, running: false, failed: 0, failedHashes: [] }), runExclusive: (fn) => fn() };
  const app = createApp({
    ctx: home.ctx,
    ai: { cache, queue, events: createEventHub() },
    allowedHosts: ['localhost'],
    backupRoot: opts.readOnly ? undefined : await mkdtemp(path.join(tmpdir(), 'atlas-linked-backup-')),
    git: null,
    edit: { client, model: 'opus', promptsDir: PROMPTS_DIR },
  });
  return { ...home, app, prompts };
}

const edited = RULE_TEXT.replace('before fixing a bug', 'before any fix');

describe('a linked rule file in the app', () => {
  it('opens editable, at the target, with the state of its repo', async () => {
    const { app } = await setup();
    const res = await app.request(`/api/component?id=${encodeURIComponent(RULE_ID)}`);
    const body = (await res.json()) as { editable: boolean; file: string; repo: Repo | null };
    expect(body.editable).toBe(true);
    expect(body.file).toBe('~/projects/standards/regeln/arbeitsregeln.md');
    expect(body.repo).toMatchObject({ display: '~/projects/standards', file: 'regeln/arbeitsregeln.md', branch: 'main', changes: [] });
  });

  it('offers no commit on the page while the file is read-only (it holds a secret)', async () => {
    const { app, target } = await setup();
    await writeFile(target, `${RULE_TEXT}API_KEY=sk-abcdefghijklmnop123\n`);
    const body = (await (await app.request(`/api/component?id=${encodeURIComponent(RULE_ID)}`)).json()) as { editable: boolean; repo: Repo | null };
    expect(body.editable).toBe(false);
    expect(body.repo).toBeNull();
  });

  it('reports uncommitted changes in the repo after saving, and is clean after committing through the offer', async () => {
    const { app, repo, target, link } = await setup();
    const saved = await app.request(`/api/component/save?id=${encodeURIComponent(RULE_ID)}`, post({ before: RULE_TEXT, after: edited }));
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { repo: Repo };
    expect(body.repo.display).toBe('~/projects/standards');
    expect(body.repo.changes).toEqual([{ path: 'regeln/arbeitsregeln.md', status: '.M' }]);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(edited);

    const commit = await app.request('/api/repo/commit', post({ id: RULE_ID, files: ['regeln/arbeitsregeln.md'], message: 'Rules: root cause before any fix' }));
    expect(commit.status).toBe(200);
    const done = (await commit.json()) as { commit: string; repo: Repo };
    expect(done.commit).toBe(await git(repo, 'rev-parse', '--short', 'HEAD'));
    expect(done.repo.changes).toEqual([]);
    expect(done.repo.file).toBe('regeln/arbeitsregeln.md');
    expect(await git(repo, 'status', '--porcelain')).toBe('');
  });

  it('names the secret when a file to commit by path holds one, instead of refusing the path', async () => {
    const { app, target } = await setup();
    await writeFile(target, `${RULE_TEXT}API_KEY=sk-abcdefghijklmnop123\n`);
    const res = await app.request('/api/repo/commit', post({ path: '~/.claude/rules/arbeitsregeln.md', files: ['regeln/arbeitsregeln.md'], message: 'x' }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('regeln/arbeitsregeln.md contains secret-like values');
  });

  it('reports the repo after saving a chat proposal for the linked file too', async () => {
    const { app } = await setup();
    const res = await app.request('/api/file/save', post({ path: '~/.claude/rules/arbeitsregeln.md', before: RULE_TEXT, after: edited }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { repo: Repo }).repo.changes).toEqual([{ path: 'regeln/arbeitsregeln.md', status: '.M' }]);
    const commit = await app.request('/api/repo/commit', post({ path: '~/.claude/rules/arbeitsregeln.md', files: ['regeln/arbeitsregeln.md'], message: 'Edit rules' }));
    expect(commit.status).toBe(200);
  });

  it('names the repo on the file page of a chat proposal before saving', async () => {
    const { app } = await setup();
    const res = await app.request('/api/file/preview', post({ path: '~/.claude/rules/arbeitsregeln.md' }));
    expect(((await res.json()) as { repo: Repo | null }).repo).toMatchObject({ display: '~/projects/standards', changes: [] });
    const plain = await app.request('/api/file/preview', post({ path: '~/.claude/rules/style.md' }));
    expect(((await plain.json()) as { repo: Repo | null }).repo).toBeNull();
  });

  it('has no repo for files in ~/.claude, and the commit offer refuses them', async () => {
    const { app } = await setup();
    const style = (await (await app.request(`/api/component?id=${encodeURIComponent('rule:user:style.md')}`)).json()) as { repo: Repo | null };
    expect(style.repo).toBeNull();
    const res = await app.request('/api/repo/commit', post({ id: 'rule:user:style.md', files: ['style.md'], message: 'x' }));
    expect(res.status).toBe(400);
  });

  it('refuses the commit offer with a reason when nothing is left to commit, or in read-only mode', async () => {
    const { app } = await setup();
    const res = await app.request('/api/repo/commit', post({ id: RULE_ID, files: ['regeln/arbeitsregeln.md'], message: 'x' }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
    const ro = await setup({ readOnly: true });
    expect((await ro.app.request('/api/repo/commit', post({ id: RULE_ID, files: ['regeln/arbeitsregeln.md'], message: 'x' }))).status).toBe(403);
  });
});

describe('condensing a rule file', () => {
  const proposal = { summary: 'One sentence shorter.', sections: [{ index: 0, after: '## Errors first\nRoot cause before any fix.', changes: ['shortened'], outsource: '' }] };
  const answer = (req: JsonRequest) => (JSON.stringify(req.schema).includes('"outsource"') ? proposal : { sections: [] });

  it('proposes the sections of the linked rule file and saves the result into its target', async () => {
    const { app, prompts, target, link } = await setup({ answer });
    const res = await app.request('/api/condense/propose', post({ id: RULE_ID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { file: string; path: string; name: string; preamble: string; sections: { index: number; heading: string; before: string; after: string }[] };
    expect(body.file).toBe(RULE_TEXT);
    expect(body.path).toBe('~/.claude/rules/arbeitsregeln.md');
    expect(body.name).toBe('arbeitsregeln.md');
    expect(body.preamble).toBe('# Working rules\n\n');
    expect(body.sections.map((s) => s.heading)).toEqual(['## Errors first', '## Public repos']);
    expect(body.sections[0].after).toBe('## Errors first\nRoot cause before any fix.\n\n');
    expect(prompts[0].prompt).toContain('### Section 1');
    expect(prompts[0].prompt).not.toContain('# Working rules');

    const after = joinSections(body.preamble, body.sections.map((s) => s.after));
    const saved = await app.request('/api/file/save', post({ path: body.path, before: body.file, after }));
    expect(saved.status).toBe(200);
    expect(await readFile(target, 'utf8')).toBe('# Working rules\n\n## Errors first\nRoot cause before any fix.\n\n## Public repos\nEverything in a public repository is written in English.\n');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it('runs the rule test and the reviewer on the sections of the rule file', async () => {
    const test = { sections: [{ index: 0, rules: [{ rule: 'Root cause first', status: 'kept', before: 'Find the root cause before fixing a bug.', after: 'Root cause before any fix.', note: '' }] }] };
    const { app, prompts } = await setup({ answer: (req) => (JSON.stringify(req.schema).includes('"rules"') ? test : { sections: [{ index: 0, after: '## Errors first\nRoot cause first.', changes: ['kept'] }] }) });
    const tested = await app.request('/api/condense/test', post({ id: RULE_ID, file: RULE_TEXT, sections: [{ index: 0, after: '## Errors first\nRoot cause before any fix.\n\n' }] }));
    expect(tested.status).toBe(200);
    expect(((await tested.json()) as { sections: unknown }).sections).toEqual(test.sections);
    expect(prompts[0].prompt).toContain('Old:\n<<<\n## Errors first\nFind the root cause before fixing a bug.');
    const repaired = await app.request('/api/condense/repair', post({ id: RULE_ID, file: RULE_TEXT, sections: [{ index: 0, after: '## Errors first\nRoot cause.\n\n', findings: ['weakened: fixing'] }] }));
    expect(repaired.status).toBe(200);
    expect(((await repaired.json()) as { sections: { index: number; after: string }[] }).sections[0]).toMatchObject({ index: 0, after: '## Errors first\nRoot cause first.\n\n' });
    expect((await app.request('/api/condense/test', post({ id: RULE_ID, file: 'stale', sections: [] }))).status).toBe(409);
  });

  it('treats a rule file without sections as one section and keeps its frontmatter out of the AI', async () => {
    const { app, prompts } = await setup({ answer: (req) => (JSON.stringify(req.schema).includes('"outsource"') ? { summary: '', sections: [] } : { sections: [] }) });
    const scoped = (await (await app.request('/api/condense/propose', post({ id: 'rule:user:scoped.md' }))).json()) as { preamble: string; sections: { heading: string; before: string }[] };
    expect(scoped.preamble).toBe('---\npaths:\n  - "src/**/*.ts"\n---\n\n');
    expect(scoped.sections).toEqual([expect.objectContaining({ heading: '# Scoped rule', before: '# Scoped rule\n\n- Only for TypeScript.\n' })]);
    expect(prompts[0].prompt).not.toContain('paths:');
  });

  it('refuses components that are no rule file, and read-only rules', async () => {
    const { app, ctx } = await setup({ answer });
    expect((await app.request('/api/condense/propose', post({ id: 'instruction:user:CLAUDE.md#0' }))).status).toBe(400);
    expect((await app.request('/api/condense/propose', post({ id: 'rule:user:missing.md' }))).status).toBe(404);
    const ro = createApp({ ctx: { ...ctx, projectRoots: [] }, ai: { cache: createExplanationCache(path.join(await mkdtemp(path.join(tmpdir(), 'atlas-app-')), 'e.json')), queue: null, events: createEventHub() }, allowedHosts: ['localhost'], edit: { client: { json: vi.fn() }, model: 'opus', promptsDir: PROMPTS_DIR } });
    expect((await ro.request('/api/condense/propose', post({ id: RULE_ID }))).status).toBe(403);
  });
});

describe('conflict check with a linked rule file', () => {
  const FINDING: RawFinding = {
    type: 'contradiction',
    severity: 'high',
    title: 'Root cause versus quick fix',
    ownId: 'rules/arbeitsregeln.md',
    quoteOwn: 'Find the root cause before fixing a bug.',
    quoteSkill: 'Demo plugin skill.',
    situation: 's',
    whoWinsToday: 'The skill.',
    precedence: 'none',
    precedenceQuote: null,
  };

  it('checks the linked rule against the plugin skills and reports the conflict', async () => {
    const { ctx } = await linkedRuleHome();
    const store = createConflictStore(path.join(await mkdtemp(path.join(tmpdir(), 'atlas-conflicts-')), 'conflicts.json'));
    await store.load();
    const tasks: BackgroundTask[] = [];
    const prompts: string[] = [];
    const queue: ExplainQueue = { enqueue() {}, enqueueTask: (t) => void tasks.push(t), pause() {}, resume() {}, state: () => ({ pending: 0, running: false, failed: 0, failedHashes: [] }), runExclusive: (fn) => fn() };
    const client = { json: async <T,>(req: JsonRequest) => (prompts.push(req.prompt), { result: { summary: '', findings: [FINDING] } as T, model: 'opus' }) };
    const checker = createConflictChecker({ ctx, store, ai: { queue, client, model: 'opus', prompts: { generic: PROMPTS_DIR } }, onChange() {}, now: () => 'T1' });
    await checker.schedule((await scanGlobal(ctx)).components);
    while (tasks.length) await tasks.shift()!.run();
    expect(prompts[0]).toContain('[rules/arbeitsregeln.md]');
    expect(prompts[0]).toContain('Find the root cause before fixing a bug.');
    const view: ConflictsView = await checker.view((await scanGlobal(ctx)).components);
    expect(view.themes).toEqual([expect.objectContaining({ ownKey: 'rules/arbeitsregeln.md', ownId: RULE_ID })]);
  });

  it('lets "Decide precedence" write the sentence for the linked rule', async () => {
    const home = await linkedRuleHome();
    const finding = { ownKey: 'rules/arbeitsregeln.md', skillId: 'p:a', skillName: 'superpowers:a', title: 't', quoteOwn: 'Find the root cause before fixing a bug.', quoteSkill: 'x', situation: 's', unconfirmed: false };
    const view = { themes: [{ ownKey: 'rules/arbeitsregeln.md', ownName: 'rules/arbeitsregeln.md', ownId: RULE_ID, minor: false, findings: [finding] }], deliberate: [], progress: { total: 1, upToDate: 1, running: null, failed: [], lastCheck: null }, aiOff: false } as unknown as ConflictsView;
    const checker = { schedule: vi.fn(async () => {}), view: vi.fn(async () => view), decided: vi.fn() };
    const client = { json: async <T,>(req: JsonRequest) => ({ result: { after: `${RULE_TEXT}- Precedence: superpowers:a wins.\n`, changes: ['Added precedence.'] } as T, model: req.model }) };
    const app = createApp({
      ctx: home.ctx,
      ai: { cache: createExplanationCache(path.join(await mkdtemp(path.join(tmpdir(), 'atlas-app-')), 'e.json')), queue: null, events: createEventHub() },
      allowedHosts: ['localhost'],
      backupRoot: await mkdtemp(path.join(tmpdir(), 'atlas-linked-backup-')),
      git: null,
      conflicts: checker,
      edit: { client, model: 'opus', promptsDir: PROMPTS_DIR },
    });
    const res = await app.request('/api/conflicts/propose', post({ ownKey: 'rules/arbeitsregeln.md', winners: { 'superpowers:a': 'skill' } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { file: string }).file).toBe('~/projects/standards/regeln/arbeitsregeln.md');
  });
});
