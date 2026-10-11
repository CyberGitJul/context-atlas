import { mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createChatLog, type ChatTurn } from '../../src/server/ai/chat-log.js';

const turn = (messages: ChatTurn['messages'], extra: Partial<ChatTurn> = {}): ChatTurn => ({
  page: { id: 'instruction:user:CLAUDE.md#3', file: null, area: 'instruction' },
  model: 'opus',
  system: 'System',
  messages,
  reply: 'Answer',
  outcome: 'ok',
  ms: 12,
  ...extra,
});
const entries = async (dir: string) =>
  (await Promise.all((await readdir(dir)).map((f) => readFile(path.join(dir, f), 'utf8')))).join('').trim().split('\n').map((l) => JSON.parse(l));

describe('chat log', () => {
  it('writes one line per turn into a file per day, earlier messages only the first time', async () => {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), 'atlas-chatlog-')), 'chat-logs');
    const log = createChatLog({ dir, now: () => new Date(2026, 9, 10, 22, 0) });
    const first = [{ role: 'user' as const, content: 'Question 1' }, { role: 'assistant' as const, content: 'A1' }, { role: 'user' as const, content: 'Question 2' }];
    await log.record(turn(first));
    await log.record(turn([...first, { role: 'assistant', content: 'A2' }, { role: 'user', content: 'Question 3' }]));
    expect(await readdir(dir)).toEqual(['2026-10-10.jsonl']);
    expect(((await stat(dir)).mode & 0o777).toString(8)).toBe('700');
    const [a, b] = await entries(dir);
    expect(a).toMatchObject({ turn: 2, user: 'Question 2', reply: 'Answer', outcome: 'ok', history: [{ content: 'Question 1' }, { content: 'A1' }] });
    expect(b).toMatchObject({ conversation: a.conversation, turn: 3, user: 'Question 3' });
    expect(b.history).toBeUndefined();
  });

  it('masks secrets in everything it writes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'atlas-chatlog-'));
    const log = createChatLog({ dir });
    // Assembled at runtime: a literal in GitHub's PAT format would trip push protection and secret scanners.
    const fakePat = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
    await log.record(turn([{ role: 'user', content: 'What does api_key=abcdef1234567890abcdef?' }], { reply: 'token=sk-ant-abcdefghijklmnopqrstuvwxyz0123', system: fakePat }));
    const text = (await readFile(path.join(dir, (await readdir(dir))[0]), 'utf8'));
    expect(text).not.toMatch(/abcdef1234567890|sk-ant-abc|ghp_abc/);
    expect(text).toContain('***');
  });

  it('deletes day files older than five days and nothing else', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'atlas-chatlog-'));
    const now = new Date(2026, 9, 10, 12, 0);
    const age = async (name: string, days: number) => {
      await writeFile(path.join(dir, name), '{}\n');
      const t = new Date(now.getTime() - days * 86_400_000);
      await utimes(path.join(dir, name), t, t);
    };
    await age('2026-10-04.jsonl', 6);
    await age('2026-10-06.jsonl', 4);
    await age('notes.txt', 30);
    const log = createChatLog({ dir, now: () => now });
    expect(await log.prune()).toEqual(['2026-10-04.jsonl']);
    expect((await readdir(dir)).sort()).toEqual(['2026-10-06.jsonl', 'notes.txt']);
  });
});
