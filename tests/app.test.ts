import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Overview } from '../src/shared/model.js';
import type { ComponentLinks } from '../src/shared/skill-links.js';
import { createApp } from '../src/server/app.js';
import { createExplanationCache } from '../src/server/ai/cache.js';
import { createChatLog } from '../src/server/ai/chat-log.js';
import type { ExplainQueue } from '../src/server/ai/queue.js';
import type { ChatRequest, ExplainJob, ToolCall } from '../src/server/ai/router-client.js';
import { createEventHub } from '../src/server/events.js';
import { makeFixtureHome } from './helpers/fixture.js';

async function setup(withQueue: boolean) {
  const ctx = await makeFixtureHome();
  const cache = createExplanationCache(path.join(await mkdtemp(path.join(tmpdir(), 'atlas-app-')), 'e.json'));
  await cache.load();
  const enqueued: ExplainJob[] = [];
  const queue: ExplainQueue = { enqueue: (jobs) => void enqueued.push(...jobs), enqueueTask() {}, pause() {}, resume() {}, state: () => ({ pending: 0, running: false, failed: 0, failedHashes: [] }), runExclusive: (fn) => fn() };
  const backupRoot = await mkdtemp(path.join(tmpdir(), 'atlas-app-backup-'));
  const app = createApp({ ctx, ai: { cache, queue: withQueue ? queue : null, events: createEventHub() }, allowedHosts: ['localhost'], backupRoot, git: null });
  return { app, cache, enqueued };
}

describe('GET /api/overview', () => {
  it('queues every hook for explanation and keeps the AI input server-side', async () => {
    const { app, enqueued } = await setup(true);
    const overview = (await (await app.request('/api/overview')).json()) as Overview;
    expect(enqueued).toHaveLength(overview.components.filter((c) => c.kind === 'hook').length);
    expect(enqueued.find((j) => j.name === 'start.sh')!.input).toContain('PROGRESS');
    expect(JSON.stringify(overview)).not.toContain('explainInput');
    expect(overview.ai.enabled).toBe(true);
  });

  it('serves cached explanations for current components', async () => {
    const { app, cache } = await setup(true);
    const first = (await (await app.request('/api/overview')).json()) as Overview;
    const hook = first.components.find((c) => c.kind === 'hook')!;
    await cache.set({ hash: hook.hash, title: 'T', summary: 'explained', injects: null, at: 'now' });
    const second = (await (await app.request('/api/overview')).json()) as Overview;
    expect(second.explanations[hook.hash].summary).toBe('explained');
  });

  it('reports AI as disabled without a queue', async () => {
    const { app } = await setup(false);
    const overview = (await (await app.request('/api/overview')).json()) as Overview;
    expect(overview.ai.enabled).toBe(false);
  });

  it('words hints and the AI status in English', async () => {
    const { app } = await setup(false);
    const overview = (await (await app.request('/api/overview')).json()) as Overview;
    expect(overview.ai.off).toContain('AI off');
    expect(overview.hints.find((h) => h.id === 'skill-dangling')!.text).toContain('Orphaned skill link');
  });
});

describe('request guard', () => {
  it('rejects requests with a foreign Host header (DNS rebinding)', async () => {
    const { app } = await setup(true);
    expect((await app.request('/api/overview', { headers: { Host: 'evil.example' } })).status).toBe(403);
  });

  it('rejects cross-site browser requests', async () => {
    const { app, enqueued } = await setup(true);
    const res = await app.request('/api/overview', { headers: { Host: 'localhost', 'Sec-Fetch-Site': 'cross-site' } });
    expect(res.status).toBe(403);
    expect(enqueued).toHaveLength(0);
  });

  it('still serves the page itself when opened from another site (link, extension)', async () => {
    const { app } = await setup(true);
    const res = await app.request('/', { headers: { Host: 'localhost', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } });
    expect(res.status).not.toBe(403);
  });

  it('accepts same-origin requests from the allowed host', async () => {
    const { app } = await setup(true);
    expect((await app.request('/api/overview', { headers: { Host: 'localhost', 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
  });
});

describe('GET /api/component', () => {
  it('returns the text of a known component and 404 for unknown ids', async () => {
    const { app } = await setup(true);
    const overview = (await (await app.request('/api/overview')).json()) as Overview;
    const rule = overview.components.find((c) => c.name === 'style.md')!;
    const res = await app.request(`/api/component?id=${encodeURIComponent(rule.id)}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toContain('Be concise');
    expect((await app.request('/api/component?id=nope')).status).toBe(404);
  });
});

describe('POST /api/component/save', () => {
  it('refuses read-only components', async () => {
    const { app } = await setup(true);
    const overview = (await (await app.request('/api/overview')).json()) as Overview;
    const plugin = overview.components.find((c) => c.name === 'demo-skill')!;
    const res = await app.request(`/api/component/save?id=${encodeURIComponent(plugin.id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ before: 'x', after: 'y' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/component/action', () => {
  async function setupWithEdit(result: unknown) {
    const ctx = await makeFixtureHome();
    const cache = createExplanationCache(path.join(await mkdtemp(path.join(tmpdir(), 'atlas-app-')), 'e.json'));
    await cache.load();
    let exclusiveRuns = 0;
    const queue: ExplainQueue = {
      enqueue() {}, enqueueTask() {}, pause() {}, resume() {},
      state: () => ({ pending: 0, running: false, failed: 0, failedHashes: [] }),
      runExclusive: async (fn) => (exclusiveRuns++, fn()),
    };
    const calls: unknown[] = [];
    const client = { json: async <T,>(req: { model: string }) => (calls.push(req), { result: result as T, model: req.model }) };
    const app = createApp({
      ctx, ai: { cache, queue, events: createEventHub() }, allowedHosts: ['localhost'],
      edit: { client, model: 'opus', promptsDir: path.join(process.cwd(), 'config', 'prompts') },
    });
    const overview = (await (await app.request('/api/overview')).json()) as Overview;
    return { app, overview, calls, exclusive: () => exclusiveRuns };
  }
  const post = async (app: { request: (u: string, i: RequestInit) => Response | Promise<Response> }, id: string, action: string, text: string) =>
    app.request(`/api/component/action?id=${encodeURIComponent(id)}&action=${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });

  it('runs the action exclusively and returns the result', async () => {
    const { app, overview, exclusive } = await setupWithEdit({ kind: 'Stil', level: 'global', reason: 'r' });
    const rule = overview.components.find((c) => c.name === 'style.md')!;
    const res = await post(app, rule.id, 'classify', '# Style\n');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { kind: string } }).result.kind).toBe('Stil');
    expect(exclusive()).toBe(1);
  });

  it('refuses texts with secret-like values without calling the router', async () => {
    const { app, overview, calls } = await setupWithEdit({});
    const rule = overview.components.find((c) => c.name === 'style.md')!;
    expect((await post(app, rule.id, 'deterministic', 'API_KEY=sk-abcdefghijklmnop123')).status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('reports an incomplete AI answer instead of showing an empty result', async () => {
    const { app, overview } = await setupWithEdit({ changes: ['x'] });
    const rule = overview.components.find((c) => c.name === 'style.md')!;
    const res = await post(app, rule.id, 'shorten', '# Style\n');
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('incomplete');
  });

  it('answers 503 when no edit model is configured', async () => {
    const { app } = await setup(true);
    expect((await post(app, 'x', 'classify', 'y')).status).toBe(503);
  });
});

describe('local actions', () => {
  it('runs "Veraltetes finden" without router key and without AI', async () => {
    const { app } = await setup(true);
    const overview = (await (await app.request('/api/overview')).json()) as Overview;
    const rule = overview.components.find((c) => c.name === 'style.md')!;
    const res = await app.request(`/api/component/action?id=${encodeURIComponent(rule.id)}&action=stale`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'See ~/projects/does-not-exist/x' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { findings: { kind: string }[] } };
    expect(body.result.findings[0].kind).toBe('path');
  });

  it('lists the local action as available even without router key', async () => {
    const { app } = await setup(true);
    const overview = (await (await app.request('/api/overview')).json()) as Overview;
    const rule = overview.components.find((c) => c.name === 'style.md')!;
    const t = (await (await app.request(`/api/component?id=${encodeURIComponent(rule.id)}`)).json()) as { actions: { id: string; available: boolean }[] };
    expect(t.actions.find((a) => a.id === 'stale')!.available).toBe(true);
    expect(t.actions.find((a) => a.id === 'classify')!.available).toBe(false);
  });
});

describe('POST /api/skill/create', () => {
  const create = async (app: { request: (u: string, i: RequestInit) => Response | Promise<Response> }, name: string) =>
    app.request('/api/skill/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, description: 'Use when testing.', body: '# B' }) });

  it('creates a new skill, refuses existing ones and invalid names', async () => {
    const { app } = await setup(true);
    expect((await create(app, 'brand-new')).status).toBe(201);
    expect((await create(app, 'brand-new')).status).toBe(409);
    expect((await create(app, '../evil')).status).toBe(400);
  });
});

describe('POST /api/component/save validation', () => {
  it('answers 400 with the reason when a section would lose its heading', async () => {
    const { app } = await setup(true);
    const overview = (await (await app.request('/api/overview')).json()) as Overview;
    const rule = overview.components.find((c) => c.name === 'Rule A')!;
    const res = await app.request(`/api/component/save?id=${encodeURIComponent(rule.id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ before: '## Rule A\nText one two three.\n\n', after: 'no heading\n' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('##');
  });
});

describe('POST routes', () => {
  it('only accept JSON bodies (a cross-site form cannot send them)', async () => {
    const { app } = await setup(true);
    const res = await app.request('/api/skill/create', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ name: 'x-y', description: 'd', body: 'b' }) });
    expect(res.status).toBe(415);
  });
});

describe('caching', () => {
  it('makes the browser revalidate the page so a rebuild is always picked up', async () => {
    const { app } = await setup(true);
    expect((await app.request('/')).headers.get('cache-control')).toBe('no-cache');
  });

  it('lets hashed bundles be cached for good', async () => {
    const { app } = await setup(true);
    expect((await app.request('/assets/index-abc123.js')).headers.get('cache-control')).toContain('immutable');
  });
});

describe('skill links', () => {
  async function linkedSetup(pointer: string) {
    const { app, overview } = await (async () => {
      const ctx = await makeFixtureHome();
      const file = path.join(ctx.claudeDir, 'CLAUDE.md');
      await writeFile(file, (await readFile(file, 'utf8')).replace('Four five.', `Four five. Ablauf: Skill \`${pointer}\`.`));
      const cache = createExplanationCache(path.join(await mkdtemp(path.join(tmpdir(), 'atlas-app-')), 'e.json'));
      await cache.load();
      const queue: ExplainQueue = { enqueue() {}, enqueueTask() {}, pause() {}, resume() {}, state: () => ({ pending: 0, running: false, failed: 0, failedHashes: [] }), runExclusive: (fn) => fn() };
      const client = { json: async <T,>(req: { model: string }) => ({ result: {} as T, model: req.model }) };
      const backupRoot = await mkdtemp(path.join(tmpdir(), 'atlas-app-backup-'));
      const app = createApp({ ctx, ai: { cache, queue, events: createEventHub() }, allowedHosts: ['localhost'], backupRoot, git: null, edit: { client, model: 'opus', promptsDir: path.join(process.cwd(), 'config', 'prompts') } });
      return { app, overview: (await (await app.request('/api/overview')).json()) as Overview };
    })();
    return { app, overview, section: overview.components.find((c) => c.name === 'Rule B')! };
  }
  const component = async (app: { request: (u: string) => Response | Promise<Response> }, id: string) =>
    (await (await app.request(`/api/component?id=${encodeURIComponent(id)}`)).json()) as { links: ComponentLinks };

  it('shows the link on both sides and offers no correction while it holds', async () => {
    const { app, overview, section } = await linkedSetup('good-skill');
    const skill = overview.components.find((c) => c.kind === 'skill' && c.name === 'good-skill')!;
    expect((await component(app, section.id)).links).toEqual({ pointers: [{ name: 'good-skill', state: 'ok', skillId: skill.id }], referencedBy: [], sourcedBy: [], choices: [] });
    expect((await component(app, skill.id)).links.referencedBy).toEqual([{ id: section.id, name: 'Rule B' }]);
    expect(overview.hints.find((h) => h.id === 'skill-pointer-broken')).toBeUndefined();
  });

  it('warns about a pointer into nothing and offers the existing skills', async () => {
    const { app, overview, section } = await linkedSetup('renamed-away');
    expect(overview.hints.find((h) => h.id === 'skill-pointer-broken')).toMatchObject({ severity: 'warn', componentIds: [section.id] });
    const links = (await component(app, section.id)).links;
    expect(links.pointers[0].state).toBe('missing');
    expect(links.choices).toContain('good-skill');
  });

  it('stores the source section in a new skill when the request names it', async () => {
    const { app, section } = await linkedSetup('good-skill');
    const res = await app.request('/api/skill/create', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'from-rule-b', description: 'Use when x.', body: '# A', sourceId: section.id }),
    });
    expect(res.status).toBe(201);
    expect(await readFile(((await res.json()) as { file: string }).file, 'utf8')).toContain('atlas-source: CLAUDE.md#Rule B');
  });

  it('refuses "In Skill umwandeln" for a text that already points to a skill, without calling the router', async () => {
    const { app, section } = await linkedSetup('good-skill');
    const res = await app.request(`/api/component/action?id=${encodeURIComponent(section.id)}&action=skillify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '## Rule B\nFour five. Ablauf: Skill `good-skill`.' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('good-skill');
  });

  it('refuses it also when the skill exists but the shortened section was never saved (atlas-source)', async () => {
    // The saved pointer goes nowhere, so only the back-reference of the new skill can block.
    const { app, section } = await linkedSetup('does-not-exist');
    const created = await app.request('/api/skill/create', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'from-rule-b', description: 'Use when x.', body: '# A', sourceId: section.id }),
    });
    expect(created.status).toBe(201);
    const res = await app.request(`/api/component/action?id=${encodeURIComponent(section.id)}&action=skillify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '## Rule B\nFour five, no pointer.' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('from-rule-b');
  });
});

describe('Align with skill', () => {
  const pairResult = {
    assessment: 'Almost fits.',
    trigger: 'Triggers.',
    instruction: '## Rule B\nFour five, shorter.\n',
    skill: '---\nname: good-skill\ndescription: Use when testing things.\n---\n\n# Good\n1. Step\n',
    changes: ['Instruction: shortened.'],
  };
  async function alignSetup(pointer = 'good-skill', result: unknown = pairResult) {
    const ctx = await makeFixtureHome();
    const file = path.join(ctx.claudeDir, 'CLAUDE.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace('Four five.', `Four five.\n\nProcedure: skill \`${pointer}\`.`));
    const cache = createExplanationCache(path.join(await mkdtemp(path.join(tmpdir(), 'atlas-app-')), 'e.json'));
    await cache.load();
    const queue: ExplainQueue = { enqueue() {}, enqueueTask() {}, pause() {}, resume() {}, state: () => ({ pending: 0, running: false, failed: 0, failedHashes: [] }), runExclusive: (fn) => fn() };
    const prompts: string[] = [];
    const client = { json: async <T,>(req: { model: string; prompt: string }) => (prompts.push(req.prompt), { result: structuredClone(result) as T, model: req.model }) };
    const backupRoot = await mkdtemp(path.join(tmpdir(), 'atlas-app-backup-'));
    const app = createApp({ ctx, ai: { cache, queue, events: createEventHub() }, allowedHosts: ['localhost'], backupRoot, git: null, edit: { client, model: 'opus', promptsDir: path.join(process.cwd(), 'config', 'prompts') } });
    const overview = (await (await app.request('/api/overview')).json()) as Overview;
    const section = overview.components.find((c) => c.name === 'Rule B')!;
    const skill = overview.components.find((c) => c.kind === 'skill' && c.name === 'good-skill')!;
    const loaded = (await (await app.request(`/api/component?id=${encodeURIComponent(section.id)}`)).json()) as { text: string; actions: { id: string }[] };
    return { app, ctx, prompts, section, skill, saved: loaded.text, actions: loaded.actions.map((a) => a.id), skillFile: path.join(ctx.claudeDir, 'skills', 'good-skill', 'SKILL.md') };
  }
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('is offered on instructions and rules only', async () => {
    const { app, skill, actions } = await alignSetup();
    expect(actions).toContain('align');
    const skillPage = (await (await app.request(`/api/component?id=${encodeURIComponent(skill.id)}`)).json()) as { actions: { id: string }[] };
    expect(skillPage.actions.map((a) => a.id)).not.toContain('align');
  });

  it('sends both texts and returns the pair with the pointer kept and the SKILL.md checked', async () => {
    const { app, prompts, section, skill, saved } = await alignSetup();
    const res = await app.request(`/api/component/action?id=${encodeURIComponent(section.id)}&action=align`, json({ text: saved }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { instruction: string }; pair: { skillId: string; skillBefore: string; restored: string[]; check: { errors: string[] } } };
    expect(prompts[0]).toContain('Four five.');
    expect(prompts[0]).toContain('# Good');
    expect(body.result.instruction).toContain('Procedure: skill `good-skill`');
    expect(body.pair).toMatchObject({ skillId: skill.id, restored: ['good-skill'], check: { errors: [] } });
    expect(body.pair.skillBefore).toContain('# Good');
  });

  it('refuses without a pointer to an existing skill, without calling the router', async () => {
    const { app, prompts, section, saved } = await alignSetup('does-not-exist');
    const res = await app.request(`/api/component/action?id=${encodeURIComponent(section.id)}&action=align`, json({ text: saved }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('Procedure: skill');
    expect(prompts).toHaveLength(0);
  });

  it('saves section and skill together', async () => {
    const { app, ctx, section, skill, saved, skillFile } = await alignSetup();
    const after = '## Rule B\nShorter.\n\nAblauf: Skill `good-skill`.\n';
    const res = await app.request('/api/pair/save', json({ id: section.id, before: saved, after, skillId: skill.id, skillBefore: await readFile(skillFile, 'utf8'), skillAfter: pairResult.skill }));
    expect(res.status).toBe(200);
    expect(await readFile(path.join(ctx.claudeDir, 'CLAUDE.md'), 'utf8')).toContain(after);
    expect(await readFile(skillFile, 'utf8')).toBe(pairResult.skill);
  });

  it('writes neither when the skill changed in between', async () => {
    const { app, ctx, section, skill, saved, skillFile } = await alignSetup();
    const skillBefore = await readFile(skillFile, 'utf8');
    await writeFile(skillFile, `${skillBefore}\nfrom outside\n`);
    const claudeMd = await readFile(path.join(ctx.claudeDir, 'CLAUDE.md'), 'utf8');
    const res = await app.request('/api/pair/save', json({ id: section.id, before: saved, after: '## Rule B\nShorter.\n\nAblauf: Skill `good-skill`.\n', skillId: skill.id, skillBefore, skillAfter: pairResult.skill }));
    expect(res.status).toBe(409);
    expect(await readFile(path.join(ctx.claudeDir, 'CLAUDE.md'), 'utf8')).toBe(claudeMd);
  });

  it('refuses a pair that cuts the link, renames the section or breaks the SKILL.md rules', async () => {
    const { app, section, skill, saved, skillFile } = await alignSetup();
    const skillBefore = await readFile(skillFile, 'utf8');
    const save = (after: string, skillAfter = pairResult.skill) => app.request('/api/pair/save', json({ id: section.id, before: saved, after, skillId: skill.id, skillBefore, skillAfter }));
    expect((await save('## Rule B\nNo pointer.\n')).status).toBe(400);
    expect((await save('## Rule C\nAblauf: Skill `good-skill`.\n')).status).toBe(400);
    const broken = await save('## Rule B\nAblauf: Skill `good-skill`.\n', '---\nname: other\ndescription: Use when x.\n---\n\n# X\n');
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { error: string }).error).toContain('must equal the folder name');
  });
});

describe('CLAUDE.md verdichten', () => {
  async function condenseSetup(proposal: unknown, test: unknown = { sections: [] }, repair: unknown = { sections: [] }) {
    const ctx = await makeFixtureHome();
    const cache = createExplanationCache(path.join(await mkdtemp(path.join(tmpdir(), 'atlas-app-')), 'e.json'));
    await cache.load();
    const queue: ExplainQueue = { enqueue() {}, enqueueTask() {}, pause() {}, resume() {}, state: () => ({ pending: 0, running: false, failed: 0, failedHashes: [] }), runExclusive: (fn) => fn() };
    const prompts: { prompt: string; system: string }[] = [];
    const client = {
      json: async <T,>(req: { model: string; prompt: string; system: string; schema: object }) => {
        prompts.push(req);
        const schema = JSON.stringify(req.schema);
        return { result: structuredClone(schema.includes('"rules"') ? test : schema.includes('"outsource"') ? proposal : repair) as T, model: req.model };
      },
    };
    const app = createApp({ ctx, ai: { cache, queue, events: createEventHub() }, allowedHosts: ['localhost'], backupRoot: await mkdtemp(path.join(tmpdir(), 'atlas-b-')), git: null, edit: { client, model: 'opus', promptsDir: path.join(process.cwd(), 'config', 'prompts') } });
    return { app, ctx, prompts };
  }
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('proposes every section, keeps unchanged ones byte for byte and checks the changed ones without AI', async () => {
    const { app, prompts } = await condenseSetup({
      summary: 'Little to gain.',
      sections: [{ index: 1, after: '## Rule B\nFour.', changes: ['shortened'], outsource: '' }],
    });
    const res = await app.request('/api/condense/propose', json({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { file: string; summary: string; sections: { heading: string; before: string; after: string; words: { before: number; after: number }; check: { errors: string[]; warnings: string[] } }[] };
    expect(prompts[0].prompt).toContain('### Section 0');
    expect(prompts[0].system).toContain('concise prose');
    expect(body.summary).toBe('Little to gain.');
    expect(body.sections.map((s) => s.heading)).toEqual(['## Rule A', '## Rule B']);
    expect(body.sections[0].after).toBe(body.sections[0].before);
    expect(body.sections[1]).toMatchObject({ after: '## Rule B\nFour.\n', words: { before: 5, after: 4 }, check: { errors: [], warnings: [] } });
  });

  it('runs the rule test only for changed sections and refuses when the file changed meanwhile', async () => {
    const test = { sections: [{ index: 1, rules: [{ rule: 'Four five', status: 'weakened', before: 'Four five.', after: 'Four.', note: 'five missing' }] }] };
    const { app, ctx, prompts } = await condenseSetup({ summary: '', sections: [] }, test);
    const file = await readFile(path.join(ctx.claudeDir, 'CLAUDE.md'), 'utf8');
    const res = await app.request('/api/condense/test', json({ file, sections: [{ index: 0, after: '## Rule A\nText one two three.\n\n' }, { index: 1, after: '## Rule B\nFour.\n' }] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sections: unknown }).sections).toEqual(test.sections);
    expect(prompts[0].prompt).not.toContain('Section 0');
    expect(prompts[0].prompt).toContain('New:\n<<<\n## Rule B\nFour.');
    expect((await app.request('/api/condense/test', json({ file: 'stale', sections: [] }))).status).toBe(409);
  });

  it('lets the reviewer repair only sections with findings, adds the fixed-check findings and checks the result again', async () => {
    const repair = { sections: [{ index: 1, after: '## Rule B\nFour five.', changes: ['"five" restored'] }] };
    const { app, ctx, prompts } = await condenseSetup({ summary: '', sections: [] }, { sections: [] }, repair);
    const file = await readFile(path.join(ctx.claudeDir, 'CLAUDE.md'), 'utf8');
    const res = await app.request(
      '/api/condense/repair',
      json({
        file,
        sections: [
          { index: 0, after: '## Rule A\nText one two three.\n\n', findings: [] },
          { index: 1, after: '## Rule B\nFour.\n', findings: ['lost: five belongs here'] },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sections: { index: number; after: string; changes: string[]; words: { after: number }; check: { errors: string[]; warnings: string[] } }[] };
    expect(prompts[0].system).toContain('reviewer');
    expect(prompts[0].prompt).not.toContain('Section 0');
    expect(prompts[0].prompt).toContain('New:\n<<<\n## Rule B\nFour.');
    expect(prompts[0].prompt).toContain('- lost: five belongs here');
    // The repaired text keeps the trailing whitespace of the section and is checked again without AI.
    expect(body.sections).toEqual([{ index: 1, after: '## Rule B\nFour five.\n', changes: ['"five" restored'], restored: [], words: { before: 5, after: 5 }, check: { errors: [], warnings: [] } }]);
    expect((await app.request('/api/condense/repair', json({ file: 'stale', sections: [] }))).status).toBe(409);
  });

  it('hands the reviewer the fixed-check findings too, even without a rule finding', async () => {
    const { app, ctx, prompts } = await condenseSetup({ summary: '', sections: [] });
    const file = await readFile(path.join(ctx.claudeDir, 'CLAUDE.md'), 'utf8');
    const res = await app.request('/api/condense/repair', json({ file, sections: [{ index: 1, after: '## Other\nFour.\n', findings: [] }] }));
    expect(res.status).toBe(200);
    expect(prompts[0].prompt).toContain('- The heading has changed.');
  });
});

describe('chat', () => {
  type Script = string[] | Error | ((req: ChatRequest, n: number) => (string | ToolCall)[]);
  async function chatSetup(deltas: Script = ['Hal', 'lo'], prepare?: (claudeDir: string) => Promise<void>, withPersonal = false) {
    const ctx = await makeFixtureHome();
    await prepare?.(ctx.claudeDir);
    const configDir = await mkdtemp(path.join(tmpdir(), 'atlas-config-'));
    const promptsDir = path.join(configDir, 'prompts');
    await cp(path.join(process.cwd(), 'config', 'prompts'), promptsDir, { recursive: true });
    // The shipped list is empty; tests allow one single file outside ~/.claude, as a user would.
    await writeFile(path.join(configDir, 'chat-files.json'), JSON.stringify({ extraFiles: ['~/projects/INDEX.md'] }));
    const cache = createExplanationCache(path.join(await mkdtemp(path.join(tmpdir(), 'atlas-app-')), 'e.json'));
    await cache.load();
    let exclusive = 0;
    const queue: ExplainQueue = { enqueue() {}, enqueueTask() {}, pause() {}, resume() {}, state: () => ({ pending: 0, running: false, failed: 0, failedHashes: [] }), runExclusive: async (fn) => (exclusive++, fn()) };
    const requests: ChatRequest[] = [];
    const client = {
      json: async <T,>(req: { model: string }) => ({ result: {} as T, model: req.model }),
      async *chat(req: ChatRequest) {
        requests.push({ ...req, messages: [...req.messages] });
        if (deltas instanceof Error) throw deltas;
        yield* typeof deltas === 'function' ? deltas(req, requests.length) : deltas;
      },
    };
    const backupRoot = await mkdtemp(path.join(tmpdir(), 'atlas-app-backup-'));
    const logDir = await mkdtemp(path.join(tmpdir(), 'atlas-app-chatlog-'));
    const chatLog = createChatLog({ dir: logDir });
    const personalDir = withPersonal ? await mkdtemp(path.join(tmpdir(), 'atlas-personal-')) : null;
    const app = createApp({ ctx, ai: { cache, queue, events: createEventHub() }, allowedHosts: ['localhost'], backupRoot, git: null, edit: { client, model: 'opus', promptsDir, personalDir }, chatLog });
    const overview = (await (await app.request('/api/overview')).json()) as Overview;
    const logged = async () => {
      const files = await readdir(logDir);
      return files.length ? (await readFile(path.join(logDir, files[0]), 'utf8')).trim().split('\n').map((l) => JSON.parse(l)) : [];
    };
    return { app, overview, requests, promptsDir, personalDir, ctx, exclusive: () => exclusive, logged };
  }
  const post = (app: { request: (u: string, i: RequestInit) => Response | Promise<Response> }, url: string, body: unknown) =>
    app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const lines = async (res: Response) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));

  it('shows the assembled system prompt of the current page, area by page', async () => {
    const { app, overview } = await chatSetup();
    const home = (await (await post(app, '/api/chat/prompt', { page: {} })).json()) as { area: string; system: string; prompts: { base: string; area: string } };
    expect(home.area).toBe('overview');
    expect(home.system).toContain('Page: overview');
    const section = overview.components.find((c) => c.name === 'Rule B')!;
    const detail = (await (await post(app, '/api/chat/prompt', { page: { id: section.id, draft: '## Rule B\nFour five six.' } })).json()) as { area: string; system: string };
    expect(detail.area).toBe('instruction');
    expect(detail.system).toContain('Four five six.');
    expect(detail.system).toContain('Unsaved changes in the editor: yes.');
  });

  it('gives the chat the linked skill in full on the section page, and the section on the skill page', async () => {
    const pointToSkill = async (dir: string) => {
      const file = path.join(dir, 'CLAUDE.md');
      await writeFile(file, (await readFile(file, 'utf8')).replace('Four five.', 'Four five. Ablauf: Skill `good-skill`.'));
    };
    const { app, overview } = await chatSetup(['x'], pointToSkill);
    const skill = overview.components.find((c) => c.kind === 'skill' && c.name === 'good-skill')!;
    const section = overview.components.find((c) => c.name === 'Rule B')!;
    const skillText = ((await (await app.request(`/api/component?id=${encodeURIComponent(skill.id)}`)).json()) as { text: string }).text.trim();
    const onSection = ((await (await post(app, '/api/chat/prompt', { page: { id: section.id } })).json()) as { system: string }).system;
    expect(onSection).toContain('Linked components (in full):');
    expect(onSection).toContain(skillText.split('\n').at(-1));
    const onSkill = ((await (await post(app, '/api/chat/prompt', { page: { id: skill.id } })).json()) as { system: string }).system;
    expect(onSkill).toContain('Four five. Ablauf: Skill `good-skill`.');
  });

  it('follows a pointer typed into the editor before it is saved', async () => {
    const { app, overview } = await chatSetup();
    const section = overview.components.find((c) => c.name === 'Rule B')!;
    const draft = '## Rule B\nFour five. Ablauf: Skill `good-skill`.';
    const system = ((await (await post(app, '/api/chat/prompt', { page: { id: section.id, draft } })).json()) as { system: string }).system;
    expect(system).toContain('Belongs to skill “good-skill”');
    expect(system).toContain('Linked components (in full):');
  });

  it('streams the answer as NDJSON with the page context as system prompt, exclusively', async () => {
    const { app, requests, exclusive } = await chatSetup();
    const res = await post(app, '/api/chat', { page: {}, messages: [{ role: 'user', content: 'Wo anfangen?' }] });
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(await lines(res)).toEqual([{ editable: false }, { t: 'Hal' }, { t: 'lo' }, { done: true, model: 'opus' }]);
    expect(requests[0].system).toContain('# Area: Overview');
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'Wo anfangen?' }]);
    expect(exclusive()).toBe(1);
  });

  it('lets Opus read a component in full: the read shows in the stream, the text goes back to the router', async () => {
    const read: ToolCall = { id: 'c1', name: 'read_component', arguments: JSON.stringify({ name: 'Rule B', kind: 'instruction' }) };
    const { app, requests, logged } = await chatSetup((_req, n) => (n === 1 ? [read] : ['Stated in Rule B.']));
    const out = await lines(await post(app, '/api/chat', { page: {}, messages: [{ role: 'user', content: 'What does Rule B say?' }] }));
    expect(out).toEqual([{ editable: false }, { read: 'Instruction (CLAUDE.md) “Rule B”' }, { t: 'Stated in Rule B.' }, { done: true, model: 'opus' }]);
    expect(requests[0].tools?.[0].function.name).toBe('read_component');
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: expect.stringContaining('Four five.') });
    expect((await logged())[0]).toMatchObject({ reads: ['Instruction (CLAUDE.md) “Rule B”'], reply: 'Stated in Rule B.' });
  });

  it('masks secrets in chat messages before they go to the router', async () => {
    const { app, requests } = await chatSetup();
    await (await post(app, '/api/chat', { page: {}, messages: [{ role: 'user', content: 'What does api_key=abcdef1234567890abcdef do?' }] })).text();
    expect(JSON.stringify(requests[0].messages)).not.toContain('abcdef1234567890');
    expect(JSON.stringify(requests[0].messages)).toContain('***');
  });

  it('tells the client a page with a secret in the draft is not editable, before the first token', async () => {
    const { app, overview } = await chatSetup();
    const section = overview.components.find((c) => c.name === 'Rule B')!;
    const out = await lines(await post(app, '/api/chat', { page: { id: section.id, draft: '## Rule B\napi_key=abcdef1234567890abcdef' }, messages: [{ role: 'user', content: 'Make it shorter' }] }));
    expect(out[0]).toEqual({ editable: false });
    const clean = await lines(await post(app, '/api/chat', { page: { id: section.id, draft: '## Rule B\nFour.' }, messages: [{ role: 'user', content: 'Make it shorter' }] }));
    expect(clean[0]).toEqual({ editable: true });
  });

  it('refuses a too long conversation with a hint to start anew', async () => {
    const { app } = await chatSetup();
    const big = 'x'.repeat(99_000);
    const messages = Array.from({ length: 5 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: big }));
    const res = await post(app, '/api/chat', { page: {}, messages });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('New');
  });

  it('labels the chat area in English', async () => {
    const { app } = await chatSetup();
    const area = (await (await post(app, '/api/chat/prompt', { page: { new: 'skill' } })).json()) as { areaLabel: string };
    expect(area.areaLabel).toBe('Create new skill');
  });

  it('treats prototype names as unknown prompt files', async () => {
    const { app } = await chatSetup();
    for (const file of ['constructor', 'toString', '__proto__']) expect((await post(app, '/api/chat/prompt/save', { file, before: 'a', after: 'b' })).status).toBe(400);
  });

  it('logs every turn with page, question, answer and system prompt', async () => {
    const { app, logged } = await chatSetup();
    await (await post(app, '/api/chat', { page: {}, messages: [{ role: 'user', content: 'Wo anfangen?' }] })).text();
    expect(await logged()).toEqual([expect.objectContaining({ page: { id: null, file: null, area: 'overview' }, user: 'Wo anfangen?', reply: 'Hallo', outcome: 'ok', system: expect.stringContaining('# Area: Overview') })]);
  });

  it('ends the stream with the error when the router fails, and logs it', async () => {
    const { app, logged } = await chatSetup(new Error('router answered 500'));
    expect((await lines(await post(app, '/api/chat', { page: {}, messages: [{ role: 'user', content: 'x' }] }))).at(-1).error).toContain('500');
    expect((await logged())[0]).toMatchObject({ outcome: 'error', error: expect.stringContaining('500') });
  });

  it('logs a request for a page that does not exist as refused', async () => {
    const { app, logged } = await chatSetup();
    expect((await post(app, '/api/chat', { page: { id: 'does-not-exist' }, messages: [{ role: 'user', content: 'x' }] })).status).toBe(404);
    expect((await logged())[0]).toMatchObject({ outcome: 'refused', page: { id: 'does-not-exist' } });
  });

  it('refuses malformed conversations', async () => {
    const { app } = await chatSetup();
    expect((await post(app, '/api/chat', { page: {}, messages: [] })).status).toBe(400);
    expect((await post(app, '/api/chat', { page: {}, messages: [{ role: 'system', content: 'x' }] })).status).toBe(400);
    expect((await post(app, '/api/chat', { page: {}, messages: [{ role: 'assistant', content: 'x' }] })).status).toBe(400);
  });

  it('saves an edited prompt as an own version, keeps the generic one and can go back to it', async () => {
    const { app, promptsDir, personalDir } = await chatSetup(undefined, undefined, true);
    const generic = path.join(promptsDir, 'chat', 'skill.md');
    const before = await readFile(generic, 'utf8');
    const res = await post(app, '/api/chat/prompt/save', { file: 'skill', before, after: 'My skill prompt.\n' });
    expect(res.status).toBe(200);
    expect(await readFile(path.join(personalDir!, 'prompts', 'chat', 'skill.md'), 'utf8')).toBe('My skill prompt.\n');
    expect(await readFile(generic, 'utf8')).toBe(before);
    const page = { id: (await (await app.request('/api/overview')).json() as Overview).components.find((c) => c.kind === 'skill' && c.name === 'good-skill')!.id };
    const preview = async () => (await (await post(app, '/api/chat/prompt', { page })).json()) as { prompts: { area: string; sources: { area: string } }; system: string };
    expect((await preview()).prompts).toMatchObject({ area: 'My skill prompt.\n', sources: { area: 'personal' } });
    expect((await post(app, '/api/chat/prompt/reset', { file: 'skill' })).status).toBe(200);
    expect((await preview()).prompts).toMatchObject({ area: before, sources: { area: 'generic' } });
  });

  it('puts the personal addition into every system prompt; it may be emptied again', async () => {
    const { app } = await chatSetup(undefined, undefined, true);
    expect((await post(app, '/api/chat/prompt/save', { file: '_personal', before: '', after: 'The user is called Alex.' })).status).toBe(200);
    const system = ((await (await post(app, '/api/chat/prompt', { page: {} })).json()) as { system: string }).system;
    expect(system).toContain('# Personal\n\nThe user is called Alex.');
    expect((await post(app, '/api/chat/prompt/save', { file: '_personal', before: 'The user is called Alex.', after: '' })).status).toBe(200);
    expect(((await (await post(app, '/api/chat/prompt', { page: {} })).json()) as { system: string }).system).not.toContain('# Personal');
  });

  it('takes the single files the chat may propose from the personal config first', async () => {
    const { app, personalDir } = await chatSetup(undefined, undefined, true);
    await writeFile(path.join(personalDir!, 'chat-files.json'), JSON.stringify({ extraFiles: ['~/notes/plan.md'] }));
    const system = ((await (await post(app, '/api/chat/prompt', { page: {} })).json()) as { system: string }).system;
    expect(system).toContain('~/notes/plan.md');
  });

  it('saves an edited prompt only when nobody changed it in between', async () => {
    const { app, promptsDir } = await chatSetup();
    const file = path.join(promptsDir, 'chat', 'skill.md');
    const before = await readFile(file, 'utf8');
    expect((await post(app, '/api/chat/prompt/save', { file: 'skill', before: 'stale', after: 'new' })).status).toBe(409);
    expect((await post(app, '/api/chat/prompt/save', { file: '../../evil', before, after: 'x' })).status).toBe(400);
    expect((await post(app, '/api/chat/prompt/save', { file: 'skill', before, after: 'New skill prompt.\n' })).status).toBe(200);
    expect(await readFile(file, 'utf8')).toBe('New skill prompt.\n');
  });

  it('is off without router key', async () => {
    const { app } = await setup(true);
    expect((await post(app, '/api/chat', { page: {}, messages: [{ role: 'user', content: 'x' }] })).status).toBe(503);
  });

  it('names the single files outside ~/.claude a proposal may target', async () => {
    const { app } = await chatSetup();
    expect(((await (await post(app, '/api/chat/prompt', { page: {} })).json()) as { system: string }).system).toContain('~/projects/INDEX.md');
  });

  it('previews, creates and changes an allowed file; refuses the rest', async () => {
    const { app, ctx } = await chatSetup();
    await mkdir(path.join(ctx.homeDir, 'projects'), { recursive: true });
    expect((await post(app, '/api/file/preview', { path: '~/.netrc' })).status).toBe(403);
    expect(await (await post(app, '/api/file/preview', { path: '~/projects/INDEX.md' })).json()).toMatchObject({ path: '~/projects/INDEX.md', exists: false, text: '', warning: null });
    expect((await post(app, '/api/file/save', { path: '~/projects/INDEX.md', before: null, after: '# Index\n' })).status).toBe(200);
    expect((await post(app, '/api/file/save', { path: '~/projects/INDEX.md', before: null, after: '# Zweiter\n' })).status).toBe(409);
    expect((await post(app, '/api/file/save', { path: '~/projects/INDEX.md', before: '# Index\n', after: '# Index 2\n' })).status).toBe(200);
    expect(await readFile(path.join(ctx.homeDir, 'projects', 'INDEX.md'), 'utf8')).toBe('# Index 2\n');
    expect((await post(app, '/api/file/save', { path: '~/.bashrc', before: null, after: 'evil' })).status).toBe(403);
  });

  it('gives the new-skill page its own area with all skills, nothing to edit', async () => {
    const { app } = await chatSetup();
    const res = (await (await post(app, '/api/chat/prompt', { page: { new: 'skill' } })).json()) as { area: string; areaLabel: string; system: string; editable: boolean };
    expect(res).toMatchObject({ area: 'new-skill', areaLabel: 'Create new skill', editable: false });
    expect(res.system).toContain('Existing skills');
    expect(res.system).toContain('Use when');
  });

  it.each([
    ['rule', 'new-rule', 'Create new rule', 'Instructions and rules'],
    ['agent', 'new-agent', 'Create new subagent', 'Existing subagents'],
    ['command', 'new-command', 'Create new slash command', 'Existing slash commands'],
  ])('gives the new-%s page its own area and prompt', async (kind, area, areaLabel, list) => {
    const { app } = await chatSetup();
    const res = (await (await post(app, '/api/chat/prompt', { page: { new: kind } })).json()) as { area: string; areaLabel: string; system: string; editable: boolean };
    expect(res).toMatchObject({ area, areaLabel, editable: false });
    expect(res.system).toContain(list);
  });

  it('checks a proposed SKILL.md and refuses to create one that breaks the rules', async () => {
    const { app, ctx } = await chatSetup();
    const bad = '---\nname: other\n---\n\n# X\n';
    const check = (await (await post(app, '/api/file/check', { path: '~/.claude/skills/new-test/SKILL.md', text: bad })).json()) as { errors: string[] };
    expect(check.errors.join(' ')).toContain('must equal the folder name');
    expect(((await (await post(app, '/api/chat/prompt', { page: { file: '~/.claude/skills/new-test/SKILL.md', draft: bad } })).json()) as { area: string }).area).toBe('skill');
    const res = await post(app, '/api/file/save', { path: '~/.claude/skills/new-test/SKILL.md', before: null, after: bad });
    expect(res.status).toBe(400);
    await expect(readFile(path.join(ctx.claudeDir, 'skills', 'new-test', 'SKILL.md'), 'utf8')).rejects.toThrow();
    const good = '---\nname: new-test\ndescription: Use when testing.\n---\n\n# X\n';
    expect((await post(app, '/api/file/save', { path: '~/.claude/skills/new-test/SKILL.md', before: null, after: good })).status).toBe(200);
  });

  it('gives the chat the file page with the text from the editor', async () => {
    const { app, ctx } = await chatSetup();
    await mkdir(path.join(ctx.homeDir, 'projects'), { recursive: true });
    const res = (await (await post(app, '/api/chat/prompt', { page: { file: '~/projects/INDEX.md', draft: '# Entwurf' } })).json()) as { area: string; system: string };
    expect(res.system).toContain('file ~/projects/INDEX.md (will be created)');
    expect(res.system).toContain('# Entwurf');
  });
});
