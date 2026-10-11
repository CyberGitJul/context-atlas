import { beforeAll, describe, expect, it } from 'vitest';
import type { Component } from '../src/shared/model.js';
import { FLOW_STEPS, hookCountsByEvent, stepOf } from '../src/shared/flow.js';
import { scanGlobal } from '../src/server/scan/index.js';
import { makeFixtureHome } from './helpers/fixture.js';

let components: Component[];
beforeAll(async () => {
  components = (await scanGlobal(await makeFixtureHome())).components;
});

describe('flow', () => {
  it('defines the six steps of a session with their hook events', () => {
    expect(FLOW_STEPS.map((s) => s.events)).toEqual([
      ['SessionStart'],
      ['UserPromptSubmit'],
      [],
      ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Notification'],
      ['Stop', 'SubagentStop'],
      ['PreCompact', 'SessionEnd'],
    ]);
  });

  it('counts hooks per event, split into own and plugin', () => {
    const counts = hookCountsByEvent(components);
    expect(counts.SessionStart).toEqual({ own: 1, plugin: 1 });
    expect(counts.Stop).toEqual({ own: 1, plugin: 0 });
  });

  it('places hooks by event and other components by phase; always-on ones in no step', () => {
    const byName = (n: string) => components.find((c) => c.name === n)!;
    const stop = components.find((c) => c.kind === 'hook' && c.detail.event === 'Stop')!;
    expect(stepOf(stop)?.id).toBe('answer');
    expect(stepOf(byName('good-skill'))?.id).toBe('think');
    expect(stepOf(byName('Rule A'))).toBeNull();
  });

  it('sends hooks with unknown events to the tool step', () => {
    const odd = { ...components.find((c) => c.kind === 'hook')!, phases: ['tool' as const], detail: { event: 'SomethingNew' } };
    expect(stepOf(odd)?.id).toBe('tool');
  });
});
