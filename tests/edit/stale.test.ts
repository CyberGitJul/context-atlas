import { beforeEach, describe, expect, it } from 'vitest';
import { findStale, knownNamesFrom } from '../../src/server/edit/stale.js';
import type { ScanContext } from '../../src/server/scan/context.js';
import { scanGlobal } from '../../src/server/scan/index.js';
import { makeFixtureHome } from '../helpers/fixture.js';

let ctx: ScanContext;
let known: Set<string>;
beforeEach(async () => {
  ctx = await makeFixtureHome();
  known = knownNamesFrom((await scanGlobal(ctx)).components);
});

describe('findStale', () => {
  it('accepts paths that exist', async () => {
    const r = await findStale('See ~/.claude/CLAUDE.md and $HOME/.claude/hooks/start.sh.', known, ctx);
    expect(r.findings).toEqual([]);
    expect(r.checked).toBe(2);
  });

  it('reports missing paths as errors', async () => {
    const r = await findStale('Located at ~/projects/does-not-exist/x.', known, ctx);
    expect(r.findings).toEqual([{ kind: 'path', ref: '~/projects/does-not-exist/x', problem: expect.stringContaining('does not exist'), level: 'error' }]);
  });

  it('knows skills, plugin skills, agents and MCP servers', async () => {
    const r = await findStale('Skill `good-skill`, Plugin skill `demo:demo-skill`, Subagent `helper`, MCP `fc` and Tool `fc_search`.', known, ctx);
    expect(r.findings).toEqual([]);
  });

  it('flags unknown names next to a keyword as a hint only', async () => {
    const r = await findStale('Use the skill `gone-skill` for everything.', known, ctx);
    expect(r.findings).toEqual([{ kind: 'name', ref: 'gone-skill', problem: expect.any(String), level: 'note' }]);
  });

  it('ignores backticked words without a keyword nearby', async () => {
    expect((await findStale('Write `foo` into the file.', known, ctx)).findings).toEqual([]);
  });

  it.each([
    ['typographic quotes', 'See „~/.claude/CLAUDE.md“ here.'],
    ['trailing ellipsis', 'See ~/.claude/CLAUDE.md…'],
    ['anchor', 'See ~/.claude/CLAUDE.md#rule-a'],
    ['URL path', 'Docs at https://example.org/home/foo/bar'],
  ])('does not raise false errors for %s', async (_l, text) => {
    expect((await findStale(text, known, ctx)).findings).toEqual([]);
  });

  it('treats paths outside the own home (e.g. on a Pi) as hints, not errors', async () => {
    const r = await findStale('On the Pi: /home/pi/wiki/docker-compose.yml', known, ctx);
    expect(r.findings.map((f) => f.level)).toEqual(['note']);
  });

});
