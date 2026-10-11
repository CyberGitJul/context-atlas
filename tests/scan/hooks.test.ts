import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { eventToPhase, scanUserHooks } from '../../src/server/scan/hooks.js';
import type { ScanContext } from '../../src/server/scan/context.js';
import { makeFixtureHome } from '../helpers/fixture.js';

let ctx: ScanContext;
beforeEach(async () => {
  ctx = await makeFixtureHome();
});

describe('scanUserHooks', () => {
  it('finds one component per hook entry, mapped to phases', async () => {
    const hooks = await scanUserHooks(ctx);
    expect(hooks).toHaveLength(4);
    expect(hooks.map((h) => h.phases[0]).sort()).toEqual(['end', 'prompt', 'session-start', 'tool']);
  });

  it('resolves the script behind a command and reads it for the explanation', async () => {
    const start = (await scanUserHooks(ctx)).find((h) => h.detail.event === 'SessionStart')!;
    expect(start.sourcePath).toMatch(/\.claude\/hooks\/start\.sh$/);
    expect(start.explainInput).toContain('PROGRESS');
  });

  it('keeps the matcher and never exposes secrets from the command', async () => {
    const hooks = await scanUserHooks(ctx);
    expect(hooks.find((h) => h.detail.event === 'PreToolUse')!.detail.matcher).toBe('Bash');
    expect(JSON.stringify(hooks)).not.toContain('sk-abcdefghijklmnop123');
  });

  it('returns an empty list for a broken settings.json instead of throwing', async () => {
    await writeFile(path.join(ctx.claudeDir, 'settings.json'), '{nope');
    await expect(scanUserHooks(ctx)).resolves.toEqual([]);
  });
});

describe('eventToPhase', () => {
  it('maps every known hook event, unknown ones to tool', () => {
    const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SubagentStop', 'PreCompact', 'SessionEnd', 'Unbekannt'];
    expect(events.map(eventToPhase)).toEqual(['session-start', 'prompt', 'tool', 'tool', 'tool', 'tool', 'end', 'end', 'end', 'end', 'tool']);
  });
});

describe('script resolution', () => {
  it('skips env and other launchers', async () => {
    await writeFile(path.join(ctx.claudeDir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/bin/env bash "$HOME/.claude/hooks/start.sh"' }] }] } }));
    const [hook] = await scanUserHooks(ctx);
    expect(hook.name).toBe('start.sh');
  });

  it('ignores binary files', async () => {
    await writeFile(path.join(ctx.claudeDir, 'hooks', 'tool.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
    await writeFile(path.join(ctx.claudeDir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '"$HOME/.claude/hooks/tool.bin" --x' }] }] } }));
    const [hook] = await scanUserHooks(ctx);
    expect(hook.explainInput).not.toContain('\u0000');
    expect(hook.sourcePath).toMatch(/settings\.json$/);
  });

  it('follows a wrapper to the script named by its argument and hashes both', async () => {
    const dir = path.join(ctx.claudeDir, 'hooks');
    await writeFile(path.join(dir, 'run-hook.cmd'), '#!/bin/bash\nexec "$(dirname "$0")/$1"\n');
    await writeFile(path.join(dir, 'session-start'), '#!/bin/bash\necho "INJECTED SKILL TEXT"\n');
    await writeFile(path.join(ctx.claudeDir, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '"$HOME/.claude/hooks/run-hook.cmd" session-start' }] }] } }));
    const [before] = await scanUserHooks(ctx);
    expect(before.explainInput).toContain('INJECTED SKILL TEXT');
    await writeFile(path.join(dir, 'session-start'), '#!/bin/bash\necho "CHANGED"\n');
    const [after] = await scanUserHooks(ctx);
    expect(after.hash).not.toBe(before.hash);
  });

  it('survives malformed but parseable hook entries', async () => {
    await writeFile(path.join(ctx.claudeDir, 'settings.json'), JSON.stringify({ hooks: { Stop: [null, { hooks: [null, { type: 'command', command: 5 }, { type: 'command', command: 'echo ok' }] }], Bad: 'x' } }));
    const hooks = await scanUserHooks(ctx);
    expect(hooks.map((h) => h.summary)).toEqual(['echo ok']);
  });
});
