import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSummary, SessionTimeline, StepDetail } from '../../src/shared/sessions.js';
import { createApp } from '../../src/server/app.js';
import { createExplanationCache } from '../../src/server/ai/cache.js';
import { createEventHub } from '../../src/server/events.js';
import { makeFixtureHome } from '../helpers/fixture.js';

const OLD = 'aaaaaaaa-0000-4000-8000-000000000001';
const NEW = 'bbbbbbbb-0000-4000-8000-000000000002';

async function setup() {
  const ctx = await makeFixtureHome();
  const cache = createExplanationCache(path.join(await mkdtemp(path.join(tmpdir(), 'atlas-sessions-')), 'e.json'));
  await cache.load();
  const dir = path.join(ctx.claudeDir, 'projects', '-home-ada-projects-atlas');
  await mkdir(dir, { recursive: true });
  const line = (o: object) => JSON.stringify({ sessionId: 's', cwd: `${ctx.homeDir}/projects/atlas`, timestamp: '2026-10-13T10:00:00.000Z', ...o });
  await writeFile(path.join(dir, `${OLD}.jsonl`), [line({ type: 'user', message: { content: 'first session' } })].join('\n'));
  await writeFile(
    path.join(dir, `${NEW}.jsonl`),
    [
      line({ type: 'user', message: { content: 'api_key=sk-123 please' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: `Done in ${ctx.homeDir}/x.\n${'long '.repeat(30_000)}` }] } }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Second session' }),
    ].join('\n'),
  );
  await utimes(path.join(dir, `${OLD}.jsonl`), new Date('2026-10-01'), new Date('2026-10-01'));
  await writeFile(path.join(dir, 'notes.txt'), 'not a session');
  const app = createApp({ ctx, ai: { cache, queue: null, events: createEventHub() }, allowedHosts: ['localhost'] });
  return { app, ctx };
}

describe('session timeline routes', () => {
  it('lists sessions newest first with title and working folder', async () => {
    const { app } = await setup();
    const { sessions } = (await (await app.request('/api/sessions')).json()) as { sessions: SessionSummary[] };
    expect(sessions.map((s) => s.id)).toEqual([NEW, OLD]);
    expect(sessions[0]).toMatchObject({ project: '-home-ada-projects-atlas', title: 'Second session', cwd: '~/projects/atlas' });
    expect(sessions[1].title).toBe('first session');
  });

  it('returns the steps without their full texts, masked', async () => {
    const { app } = await setup();
    const res = await app.request(`/api/sessions/-home-ada-projects-atlas/${NEW}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionTimeline;
    expect(body.session.title).toBe('Second session');
    expect(body.steps.map((s) => s.kind)).toEqual(['prompt', 'answer']);
    expect(body.steps[0].title).toBe('api_key=*** please');
    expect(JSON.stringify(body)).not.toContain('sk-123');
    expect('text' in body.steps[0]).toBe(false);
  });

  it('returns the full text of one step on demand, cut when it is very long', async () => {
    const { app, ctx } = await setup();
    const detail = (await (await app.request(`/api/sessions/-home-ada-projects-atlas/${NEW}/steps/1`)).json()) as StepDetail;
    expect(detail.text.startsWith('Done in ~/x.')).toBe(true);
    expect(detail.text).not.toContain(ctx.homeDir);
    expect(detail.cut).toBe(true);
    expect(detail.text.length).toBeLessThanOrEqual(100_000);
  });

  it('answers 404 for unknown sessions, steps and names that leave the projects folder', async () => {
    const { app } = await setup();
    for (const url of [
      `/api/sessions/-home-ada-projects-atlas/${OLD.replace('a', 'c')}`,
      `/api/sessions/-home-ada-projects-atlas/${NEW}/steps/9`,
      `/api/sessions/..%2F..%2Fetc/${NEW}`,
      `/api/sessions/-home-ada-projects-atlas/notes`,
      `/api/sessions/../${NEW}`,
    ]) {
      expect((await app.request(url)).status, url).toBe(404);
    }
  });

  it('lists nothing when there is no projects folder', async () => {
    const { app, ctx } = await setup();
    const empty = createApp({ ctx: { ...ctx, claudeDir: path.join(ctx.homeDir, 'missing') }, ai: { cache: createExplanationCache(path.join(ctx.homeDir, 'e2.json')), queue: null, events: createEventHub() }, allowedHosts: ['localhost'] });
    expect(await (await empty.request('/api/sessions')).json()).toEqual({ sessions: [] });
    void app;
  });
});
