import { beforeAll, describe, expect, it } from 'vitest';
import type { Component } from '../src/shared/model.js';
import { computeHints } from '../src/server/hints.js';
import { scanGlobal, type GlobalScan } from '../src/server/scan/index.js';
import { makeFixtureHome } from './helpers/fixture.js';

let scan: GlobalScan;
beforeAll(async () => {
  scan = await scanGlobal(await makeFixtureHome());
});

const hintsFor = (extra: Partial<{ projectScopedPlugins: string[]; latentFiles: string[] }> = {}) =>
  computeHints(scan.components, { projectScopedPlugins: scan.projectScopedPlugins, latentFiles: scan.latentFiles, ...extra });
const hint = (id: string, list = hintsFor()) => list.find((h) => h.id === id);
const namesOf = (ids: string[]) => ids.map((id) => scan.components.find((c) => c.id === id)!.name);

function section(i: number, words: number): Component {
  return {
    id: `instruction:user:CLAUDE.md#${i}`, kind: 'instruction', name: `S${i}`, origin: { type: 'user' }, phases: ['always'],
    sourcePath: '/h/.claude/CLAUDE.md', enabled: true, summary: null, contextWords: words, hash: String(i), detail: { file: 'CLAUDE.md', index: i },
  };
}

describe('computeHints', () => {
  it('warns when CLAUDE.md sections together exceed 2000 words', () => {
    const long = computeHints([section(0, 1500), section(1, 600)], { projectScopedPlugins: [], latentFiles: [] });
    expect(long.find((h) => h.id === 'claude-md-long')).toMatchObject({ severity: 'warn' });
    expect(long.find((h) => h.id === 'claude-md-long')!.text).toContain('2100');
    expect(hint('claude-md-long')).toBeUndefined();
  });

  it('names skills without description', () => {
    expect(namesOf(hint('skill-no-description')!.componentIds)).toEqual(['no-desc']);
  });

  it('names skills switched off but still installed', () => {
    expect(namesOf(hint('skill-off-installed')!.componentIds)).toEqual(['old-skill']);
  });

  it('names dangling skill symlinks', () => {
    expect(namesOf(hint('skill-dangling')!.componentIds)).toEqual(['linked']);
  });

  it('lists live-only sources as info', () => {
    const live = hint('live-only')!;
    expect(live.severity).toBe('info');
    expect(live.componentIds).toHaveLength(2);
  });

  it('mentions plugins installed only for projects', () => {
    expect(hint('plugins-project-only')!.text).toContain('proj@market');
  });

  it('lists latent files only when there are any', () => {
    expect(hint('latent-files', hintsFor({ latentFiles: ['HANDOFF.md'] }))).toMatchObject({ severity: 'info' });
    expect(hint('latent-files', hintsFor({ latentFiles: ['HANDOFF.md'] }))!.text).toContain('HANDOFF.md');
    expect(hint('latent-files', hintsFor({ latentFiles: [] }))).toBeUndefined();
  });
});

describe('skill pointer hints', () => {
  const withPointer = (s: Component, name: string): Component => ({ ...s, detail: { ...s.detail, skillPointers: [name] } });
  const skill = (name: string, enabled: boolean): Component => ({
    id: `skill:user:${name}:${name}`, kind: 'skill', name, origin: { type: 'user' }, phases: ['on-demand'], sourcePath: null, enabled, summary: 'Use when x', contextWords: 3, hash: name, detail: {},
  });
  it('names sections whose pointer goes nowhere or to a disabled skill', () => {
    const hints = computeHints([withPointer(section(0, 10), 'gone'), withPointer(section(1, 10), 'off'), withPointer(section(2, 10), 'present'), skill('off', false), skill('present', true)], { projectScopedPlugins: [], latentFiles: [] });
    const h = hints.find((x) => x.id === 'skill-pointer-broken')!;
    expect(h.componentIds).toEqual(['instruction:user:CLAUDE.md#0', 'instruction:user:CLAUDE.md#1']);
    expect(h.text).toContain('“S0” → skill `gone` (does not exist or its plugin is off)');
    expect(h.text).toContain('“S1” → skill `off` (switched off)');
  });
  it('names a skill made from a section that no longer points to it, or is gone', () => {
    const own = { ...skill('own', true), detail: { source: 'CLAUDE.md#S0' } };
    const orphan = { ...skill('orphan', true), detail: { source: 'CLAUDE.md#Gone' } };
    const linked = { ...skill('present', true), detail: { source: 'CLAUDE.md#S1' } };
    const hints = computeHints([section(0, 10), withPointer(section(1, 10), 'present'), own, orphan, linked], { projectScopedPlugins: [], latentFiles: [] });
    const h = hints.find((x) => x.id === 'skill-source-unlinked')!;
    expect(h.severity).toBe('info');
    expect(h.text).toContain('Skill `own` comes from “S0”, but the section does not point to it');
    expect(h.text).toContain('Skill `orphan` comes from “CLAUDE.md#Gone”, but that section no longer exists');
    expect(h.text).not.toContain('`present`');
  });
});
