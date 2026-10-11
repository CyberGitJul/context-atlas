import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Component } from '../../src/shared/model.js';
import { loadComponentText } from '../../src/server/edit/resolve.js';
import type { ScanContext } from '../../src/server/scan/context.js';
import { scanGlobal } from '../../src/server/scan/index.js';
import { makeFixtureHome } from '../helpers/fixture.js';

let ctx: ScanContext;
let components: Component[];
beforeEach(async () => {
  ctx = await makeFixtureHome();
  components = (await scanGlobal(ctx)).components;
});
const named = (n: string) => components.find((c) => c.name === n)!;

describe('loadComponentText', () => {
  it('returns exactly one CLAUDE.md section, editable', async () => {
    const t = await loadComponentText(named('Rule A'), ctx);
    expect(t.text).toBe('## Rule A\nText one two three.\n\n');
    expect(t.editable).toBe(true);
    expect(t.inRepo).toBe(true);
  });

  it('returns a whole rule file', async () => {
    const t = await loadComponentText(named('style.md'), ctx);
    expect(t.text).toBe('# Style\n\n- Be concise.\n');
    expect(t.editable).toBe(true);
  });

  it('keeps plugin files read-only', async () => {
    const t = await loadComponentText(named('demo-skill'), ctx);
    expect(t.editable).toBe(false);
    expect(t.readOnlyReason).toContain('Plugin');
    expect(t.text).toContain('Demo plugin skill.');
  });

  it('keeps skills synced from claude.ai read-only', async () => {
    const t = await loadComponentText(named('synced-one'), ctx);
    expect(t.editable).toBe(false);
    expect(t.readOnlyReason).toContain('claude.ai');
  });

  it('edits hook scripts but not settings', async () => {
    const hook = components.find((c) => c.kind === 'hook' && c.name === 'start.sh' && c.origin.type === 'user')!;
    expect((await loadComponentText(hook, ctx)).editable).toBe(true);
    expect((await loadComponentText(components.find((c) => c.kind === 'setting')!, ctx)).editable).toBe(false);
  });

  it('flags texts that contain secret-like values', async () => {
    await writeFile(path.join(ctx.claudeDir, 'hooks', 'start.sh'), '#!/bin/bash\nAPI_KEY=sk-abcdefghijklmnop123 curl x\n');
    components = (await scanGlobal(ctx)).components;
    const hook = components.find((c) => c.kind === 'hook' && c.name === 'start.sh' && c.origin.type === 'user')!;
    const t = await loadComponentText(hook, ctx);
    expect(t.hasSecrets).toBe(true);
    expect(t.editable).toBe(false);
    expect(t.readOnlyReason).toContain('secret-like');
    expect(t.text).not.toContain('sk-abcdefghijklmnop123');
    expect((await loadComponentText(named('style.md'), ctx)).hasSecrets).toBe(false);
  });

  it('shows a memory folder as its index followed by every note, read-only', async () => {
    await writeFile(path.join(ctx.claudeDir, 'projects', '-home-x', 'memory', 'a-first.md'), 'first\n\n');
    components = (await scanGlobal(ctx)).components;
    const t = await loadComponentText(components.find((c) => c.kind === 'memory')!, ctx);
    expect(t.editable).toBe(false);
    expect(t.readOnlyReason).toContain('Claude Code');
    expect(t.text).toBe('==> MEMORY.md <==\n- [Note](note.md) — a note\n\n==> a-first.md <==\nfirst\n\n==> note.md <==\nnote body\n');
  });

  it('never shows secret values in read-only views either', async () => {
    const t = await loadComponentText(components.find((c) => c.kind === 'setting')!, ctx);
    expect(t.text).not.toContain('do-not-leak-123');
  });
});
