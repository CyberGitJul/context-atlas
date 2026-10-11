import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Component } from '../../src/shared/model.js';
import { ACTION_DEFS, buildActionPrompt, estimateActions, runAction, validateResult } from '../../src/server/ai/actions.js';
import { withAddition } from '../../src/server/ai/prompts.js';
import type { JsonRequest } from '../../src/server/ai/router-client.js';
import { wordCount } from '../../src/server/scan/context.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'prompts');
const component: Component = {
  id: 'instruction:user:CLAUDE.md#0', kind: 'instruction', name: 'Rule A', origin: { type: 'user' }, phases: ['always'],
  sourcePath: '/h/.claude/CLAUDE.md', enabled: true, summary: null, contextWords: 5, hash: 'x', detail: { file: 'CLAUDE.md', index: 0 },
};

function fakeClient(result: unknown) {
  const calls: JsonRequest[] = [];
  return { calls, client: { json: async <T,>(req: JsonRequest) => (calls.push(req), { result: result as T, model: req.model }) } };
}

describe('AI actions', () => {
  it('defines the 10 quick actions of the spec, plus "align with skill" after "convert to skill"', () => {
    expect(ACTION_DEFS.map((a) => a.id)).toEqual(['classify', 'deterministic', 'enforce', 'contradictions', 'precedence', 'skillify', 'align', 'shorten', 'stale', 'testcases', 'rationale']);
  });

  it.each(['shorten', 'rationale'] as const)('%s proposes a new text from its own prompt file', async (id) => {
    const { client, calls } = fakeClient({ after: 'New', changes: ['shorter'] });
    await runAction(id, component, '## Rule A\nText\n', { client, model: 'opus', promptsDir: PROMPTS });
    expect(calls[0].system).toBe(withAddition(await readFile(path.join(PROMPTS, `${id}.md`), 'utf8'), ''));
    expect(calls[0].schema).toMatchObject({ required: ['after', 'changes'] });
  });

  it('rejects incomplete AI results with an understandable message', () => {
    const def = ACTION_DEFS.find((d) => d.id === 'shorten')!;
    expect(validateResult(def, { changes: [] })).toContain('incomplete');
    expect(validateResult(def, { after: 'x', changes: [] })).toBeNull();
  });

  it('sends the action prompt from config/prompts with the edit model and the redacted text', async () => {
    const { client, calls } = fakeClient({ after: '## Rule A\nNew.\n', changes: ['more precise'] });
    const res = await runAction('deterministic', component, '## Rule A\nIf needed token: 0123456789abcdef0123456789abcdef\n', { client, model: 'opus', promptsDir: PROMPTS });
    expect(calls[0].model).toBe('opus');
    expect(calls[0].system).toBe(withAddition(await readFile(path.join(PROMPTS, 'deterministic.md'), 'utf8'), ''));
    expect(calls[0].prompt).toContain('Rule A');
    expect(calls[0].prompt).toContain('If needed');
    expect(calls[0].prompt).not.toContain('0123456789abcdef0123456789abcdef');
    expect(calls[0].schema).toMatchObject({ required: ['after', 'changes'] });
    expect(res).toEqual({ after: '## Rule A\nNew.\n', changes: ['more precise'] });
  });

  it('classifies with its own schema', async () => {
    const { client, calls } = fakeClient({ kind: 'process', level: 'skill', reason: 'Long procedure.' });
    await runAction('classify', component, '## Rule A\nText\n', { client, model: 'opus', promptsDir: PROMPTS });
    expect(calls[0].schema).toMatchObject({ required: ['kind', 'level', 'reason'] });
  });

  it('estimates the words each action sends', async () => {
    const text = '## Rule A\nOne two three.\n';
    const [classify] = await estimateActions(component, text, { model: 'opus', promptsDir: PROMPTS });
    const system = withAddition(await readFile(path.join(PROMPTS, 'classify.md'), 'utf8'), '');
    expect(classify).toMatchObject({ id: 'classify', model: 'opus', inputWords: wordCount(system) + wordCount(buildActionPrompt(component, text)) });
  });

  it('testcases lists situations that should and should not trigger', async () => {
    const { client, calls } = fakeClient({ shouldTrigger: ['a'], shouldNotTrigger: ['b'], notes: 'n' });
    await runAction('testcases', component, 'Text', { client, model: 'opus', promptsDir: PROMPTS });
    expect(calls[0].schema).toMatchObject({ required: ['shouldTrigger', 'shouldNotTrigger', 'notes'] });
  });

  it('enforce returns drafts per rule with mechanism and limits', async () => {
    const { client, calls } = fakeClient({ summary: 's', items: [] });
    await runAction('enforce', component, 'Text', { client, model: 'opus', promptsDir: PROMPTS });
    expect(calls[0].schema).toMatchObject({ required: ['summary', 'items'] });
    expect(JSON.stringify(calls[0].schema)).toContain('not-enforceable');
  });

  it('skillify returns a new skill and the shortened instruction', async () => {
    const { client, calls } = fakeClient({ skillName: 'x-y', description: 'd', body: 'b', remainingText: 'r', changes: [] });
    await runAction('skillify', component, 'Text', { client, model: 'opus', promptsDir: PROMPTS });
    expect(calls[0].schema).toMatchObject({ required: ['skillName', 'description', 'body', 'remainingText', 'changes'] });
  });

  it('rejects result lists with broken entries', () => {
    const def = ACTION_DEFS.find((d) => d.id === 'contradictions')!;
    expect(validateResult(def, { summary: 's', findings: [null] })).toContain('incomplete');
    expect(validateResult(def, { summary: 's', findings: [{ type: 'duplicate', title: 't', otherId: 'i', otherName: 'n', quoteHere: 'a', quoteThere: 'b', suggestion: 's' }] })).toBeNull();
  });

  it('masks secrets in headings and paths it sends', () => {
    const c = { ...component, name: 'Rule token: 0123456789abcdef0123456789abcdef', sourcePath: '/h/x?key=secret-123' };
    const prompt = buildActionPrompt(c, 'Text');
    expect(prompt).not.toContain('0123456789abcdef0123456789abcdef');
    expect(prompt).not.toContain('secret-123');
  });

});
