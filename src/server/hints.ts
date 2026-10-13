import type { ConflictsView } from '../shared/conflicts.js';
import type { Component, Hint } from '../shared/model.js';
import { pointersOf, resolveLinks, sourceKeyOf } from '../shared/skill-links.js';
import type { ScanProblem } from './scan/context.js';
import { msg } from './messages/index.js';

export const CLAUDE_MD_WORD_LIMIT = 2000;

export interface HintExtras {
  projectScopedPlugins: string[];
  latentFiles: string[];
  problems?: ScanProblem[];
  /** Own rules that collide with plugin skills without saying who wins (from the Conflicts view). */
  conflicts?: { rules: number; findings: number; plugins: string[]; componentIds: string[] };
}

/** What the hint needs from the Conflicts view: open rules, their findings, the plugins and the rules' ids. */
export function conflictSummary(view: ConflictsView): NonNullable<HintExtras['conflicts']> {
  const findings = view.themes.flatMap((t) => t.findings);
  return {
    rules: view.themes.length,
    findings: findings.length,
    plugins: [...new Set(findings.map((f) => f.skillName.split(':')[0]))],
    componentIds: view.themes.flatMap((t) => (t.ownId ? [t.ownId] : [])),
  };
}

const ids = (list: Component[]) => list.map((c) => c.id);
const names = (list: Component[]) => list.map((c) => c.name).join(', ');

/** Simple, rule-based findings for the hint bar (no AI). */
export function computeHints(components: Component[], extra: HintExtras): Hint[] {
  const hints: Hint[] = [];
  const m = msg.hints;
  const skills = components.filter((c) => c.kind === 'skill');

  if (extra.problems?.length) {
    hints.push({
      id: 'source-unreadable',
      severity: 'warn',
      text: m.sourceUnreadable(extra.problems.map((p) => `${p.file} – ${p.error}`).join('; ')),
      componentIds: [],
    });
  }

  const sections = components.filter((c) => c.kind === 'instruction' && c.detail.file === 'CLAUDE.md');
  const words = sections.reduce((sum, c) => sum + c.contextWords, 0);
  if (words > CLAUDE_MD_WORD_LIMIT) {
    hints.push({
      id: 'claude-md-long',
      severity: 'warn',
      text: m.claudeMdLong(words, CLAUDE_MD_WORD_LIMIT),
      componentIds: ids(sections),
    });
  }

  if (extra.conflicts?.rules) {
    const { rules, findings, plugins, componentIds } = extra.conflicts;
    hints.push({ id: 'conflicts-open', severity: 'warn', text: m.conflictsOpen(rules, findings, plugins.join(', ')), componentIds });
  }

  // A pointer Claude cannot follow: the skill is gone (renamed, deleted) or switched off.
  const broken = components.flatMap((c) =>
    resolveLinks(pointersOf(c), components)
      .filter((l) => l.state !== 'ok')
      .map((l) => ({ c, text: m.brokenItem(c.name, l.name, l.state === 'missing') })),
  );
  if (broken.length) {
    hints.push({
      id: 'skill-pointer-broken',
      severity: 'warn',
      text: m.broken(broken.map((b) => b.text).join('; ')),
      componentIds: [...new Set(broken.map((b) => b.c.id))],
    });
  }

  // The other direction: a skill made from a section (atlas-source) the section no longer points to, or that is gone.
  const unlinked = components.flatMap((s) => {
    if (s.kind !== 'skill' || !s.enabled || typeof s.detail.source !== 'string') return [];
    const section = components.find((c) => sourceKeyOf(c) === s.detail.source);
    if (!section) return [{ s, ids: [s.id], text: m.unlinkedGone(s.name, s.detail.source) }];
    if (resolveLinks(pointersOf(section), components).some((l) => l.skillId === s.id)) return [];
    return [{ s, ids: [s.id, section.id], text: m.unlinkedNoPointer(s.name, section.name) }];
  });
  if (unlinked.length) {
    hints.push({
      id: 'skill-source-unlinked',
      severity: 'info',
      text: m.unlinked(unlinked.map((u) => u.text).join('; ')),
      componentIds: [...new Set(unlinked.flatMap((u) => u.ids))],
    });
  }

  const dangling = skills.filter((c) => c.detail.dangling === true);
  if (dangling.length) {
    hints.push({ id: 'skill-dangling', severity: 'warn', text: m.dangling(names(dangling)), componentIds: ids(dangling) });
  }

  const noDesc = skills.filter((c) => c.summary === null && c.detail.dangling !== true);
  if (noDesc.length) {
    hints.push({ id: 'skill-no-description', severity: 'warn', text: m.noDescription(names(noDesc)), componentIds: ids(noDesc) });
  }

  const off = skills.filter((c) => !c.enabled && c.detail.dangling !== true);
  if (off.length) {
    hints.push({ id: 'skill-off-installed', severity: 'info', text: m.offInstalled(off.length, names(off)), componentIds: ids(off) });
  }

  const live = components.filter((c) => c.origin.type === 'live');
  if (live.length) {
    hints.push({ id: 'live-only', severity: 'info', text: m.liveOnly(live.length, names(live)), componentIds: ids(live) });
  }

  if (extra.projectScopedPlugins.length) {
    hints.push({ id: 'plugins-project-only', severity: 'info', text: m.pluginsProjectOnly(extra.projectScopedPlugins.join(', ')), componentIds: [] });
  }

  if (extra.latentFiles.length) {
    hints.push({ id: 'latent-files', severity: 'info', text: m.latentFiles(extra.latentFiles.join(', ')), componentIds: [] });
  }

  return hints;
}
