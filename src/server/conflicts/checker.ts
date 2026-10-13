import type { ConflictFinding, ConflictsView, ConflictTheme, DeliberateGroup } from '../../shared/conflicts.js';
import type { Component } from '../../shared/model.js';
import { sourceKeyOf } from '../../shared/skill-links.js';
import { personalAddition, readPrompt, withAddition, type PromptDirs } from '../ai/prompts.js';
import type { ExplainQueue } from '../ai/queue.js';
import type { RouterJsonClient } from '../ai/router-client.js';
import { loadComponentText } from '../edit/resolve.js';
import { redact } from '../redact.js';
import { sha256, type ScanContext } from '../scan/context.js';
import { scanGlobal } from '../scan/index.js';
import { blockOf, normQuote, verifyFindings, type OwnText, type RawFinding } from './quotes.js';
import type { ConflictStore } from './store.js';

export interface ConflictChecker {
  /** Queues a check for every active plugin skill whose pair hash changed; due skills in `first` go ahead, in that order. */
  schedule(components: Component[], first?: string[]): Promise<void>;
  view(components: Component[]): Promise<ConflictsView>;
  /** A precedence sentence was saved into this rule: its theme shows as re-checking until its skills are checked again. */
  decided(ownKey: string): void;
}

export interface CheckerDeps {
  ctx: ScanContext;
  store: ConflictStore;
  /** null when AI is off: stored results are shown, nothing is checked. */
  ai: { queue: ExplainQueue; client: RouterJsonClient; model: string; prompts: PromptDirs } | null;
  /** Called when a check starts, ends or fails. */
  onChange: () => void;
  now?: () => string;
}

/** The user's own instructions: CLAUDE.md sections and rule files. */
export function ownSources(components: Component[]): Component[] {
  return components.filter((c) => (c.kind === 'instruction' && c.detail.file === 'CLAUDE.md') || (c.kind === 'rule' && c.origin.type === 'user'));
}

/** Skills of plugins Claude loads, in a fixed order. */
export function pluginSkills(components: Component[]): Component[] {
  return components.filter((c) => c.kind === 'skill' && c.origin.type === 'plugin' && c.enabled).sort((a, b) => a.id.localeCompare(b.id));
}

/** "superpowers:brainstorming": plugin id without @marketplace, then the skill name. */
export function skillNameOf(skill: Component): string {
  return skill.origin.type === 'plugin' ? `${skill.origin.plugin.split('@')[0]}:${skill.name}` : skill.name;
}

export const CONFLICTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['contradiction', 'tension', 'duplicate'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string' },
          ownId: { type: 'string' },
          quoteOwn: { type: 'string' },
          quoteSkill: { type: 'string' },
          situation: { type: 'string' },
          whoWinsToday: { type: 'string' },
          precedence: { type: 'string', enum: ['explicit-own', 'explicit-skill', 'none'] },
          precedenceQuote: { type: ['string', 'null'] },
        },
        required: ['type', 'severity', 'title', 'ownId', 'quoteOwn', 'quoteSkill', 'situation', 'whoWinsToday', 'precedence', 'precedenceQuote'],
      },
    },
  },
  required: ['summary', 'findings'],
};

const RANK = { high: 0, medium: 1, low: 2 } as const;
/** Confirmed findings with severity medium or high; unconfirmed ones are folded away and do not rank a theme. */
const serious = (findings: ConflictFinding[]) => findings.filter((f) => !f.unconfirmed && f.severity !== 'low').length;
const confirmed = (findings: ConflictFinding[]) => findings.filter((f) => !f.unconfirmed).length;

/** Every own instruction under its key in square brackets, then the skill; all masked. */
function pairPrompt(own: OwnText[], skill: Component, skillText: string): string {
  const plugin = skill.origin.type === 'plugin' ? skill.origin.plugin : '';
  return [
    '# OWN INSTRUCTIONS (editable)',
    '',
    ...own.flatMap((o) => [`[${o.key}]`, redact(o.text), '']),
    `# THIRD-PARTY SKILL "${skillNameOf(skill)}" (plugin ${plugin}, not editable)`,
    '',
    redact(skillText),
  ].join('\n');
}

/**
 * Checks each active plugin skill against the own instructions in the background (one AI request per skill, only
 * when own texts, skill text or prompt changed) and builds the Conflicts view from the stored inventory.
 */
export function createConflictChecker(deps: CheckerDeps): ConflictChecker {
  const now = deps.now ?? (() => new Date().toISOString());
  let running: string | null = null;
  /** Rules a sentence was saved into, until their skills are checked on the new text (in memory only). */
  const decidedKeys = new Set<string>();

  async function systemPrompt(prompts: PromptDirs): Promise<string> {
    const [prompt, addition] = await Promise.all([readPrompt(prompts, 'conflicts.md'), personalAddition(prompts)]);
    return withAddition(prompt.text, addition.text);
  }

  /** The hash a pair was checked on: own texts, skill text, prompt and model. */
  function pairHashes(components: Component[], system: string, model: string): Map<string, string> {
    const promptHash = sha256(`${system}\n${model}`);
    const ownHash = sha256(ownSources(components).map((c) => `${sourceKeyOf(c)}:${c.hash}`).join('\n'));
    return new Map(pluginSkills(components).map((s) => [s.id, sha256([ownHash, s.hash, promptHash].join(':'))]));
  }

  async function check(skillId: string): Promise<void> {
    const ai = deps.ai!;
    const components = (await scanGlobal(deps.ctx)).components;
    const skill = pluginSkills(components).find((s) => s.id === skillId);
    if (!skill) return;
    const system = await systemPrompt(ai.prompts);
    const hash = pairHashes(components, system, ai.model).get(skill.id)!;
    // Queued again while it was running (a page load during the check): it is up to date now, no second paid call.
    const done = deps.store.pair(skill.id);
    if (done && !done.error && done.hash === hash) return;
    const skillName = skillNameOf(skill);
    running = skillName;
    deps.onChange();
    try {
      const own: OwnText[] = await Promise.all(ownSources(components).map(async (c) => ({ key: sourceKeyOf(c)!, text: (await loadComponentText(c, deps.ctx)).text })));
      const skillText = (await loadComponentText(skill, deps.ctx)).text;
      const { result } = await ai.client.json<{ summary?: string; findings?: RawFinding[] }>({ prompt: pairPrompt(own, skill, skillText), system, schema: CONFLICTS_SCHEMA, model: ai.model, effort: 'high' });
      if (!Array.isArray(result.findings)) throw new Error('result without findings');
      const { findings, dropped } = verifyFindings(result.findings, own, skillText);
      await deps.store.applyRun({ skillId, skillName, hash, at: now(), findings, dropped, own, skillText });
    } finally {
      running = null;
      deps.onChange();
    }
  }

  return {
    async schedule(components, first = []) {
      const ai = deps.ai;
      if (!ai) return;
      const hashes = pairHashes(components, await systemPrompt(ai.prompts), ai.model);
      const due = pluginSkills(components).filter((skill) => deps.store.pair(skill.id)?.hash !== hashes.get(skill.id));
      const enqueue = (skill: Component, front: boolean) =>
        ai.queue.enqueueTask(
          {
            id: `conflicts:${skill.id}`,
            run: () => check(skill.id),
            // The stored hash stays, so the pair is due again on the next page load.
            fail: (e) => void deps.store.recordError(skill.id, e.message).then(deps.onChange, deps.onChange),
          },
          { front },
        );
      for (const skill of due.filter((s) => !first.includes(s.id))) enqueue(skill, false);
      // Backwards to the front, so they run in the order given.
      for (const id of [...first].reverse()) {
        const skill = due.find((s) => s.id === id);
        if (skill) enqueue(skill, true);
      }
    },

    async view(components) {
      const active = pluginSkills(components);
      const activeIds = new Set(active.map((s) => s.id));
      const hashes = deps.ai ? pairHashes(components, await systemPrompt(deps.ai.prompts), deps.ai.model) : null;
      const findings = deps.store.findings().filter((f) => activeIds.has(f.skillId));
      const own = new Map(ownSources(components).map((c) => [sourceKeyOf(c)!, c]));

      const byOwn = new Map<string, ConflictFinding[]>();
      for (const f of findings.filter((x) => x.state === 'new')) byOwn.set(f.ownKey, [...(byOwn.get(f.ownKey) ?? []), f]);
      const due = (skillId: string) => {
        const p = deps.store.pair(skillId);
        return !p || !!p.error || p.hash !== hashes?.get(skillId);
      };
      for (const key of decidedKeys) {
        const skills = findings.filter((f) => f.ownKey === key).map((f) => f.skillId);
        if (!hashes || !skills.some(due)) decidedKeys.delete(key);
      }
      const themes: ConflictTheme[] = [...byOwn]
        .map(([ownKey, list]) => {
          const c = own.get(ownKey);
          const ownName = c && c.kind === 'instruction' ? c.name : ownKey;
          return { ownKey, ownName, ownId: c?.id ?? null, minor: serious(list) === 0, rechecking: decidedKeys.has(ownKey), findings: list.sort((a, b) => RANK[a.severity] - RANK[b.severity]) };
        })
        .sort((a, b) => serious(b.findings) - serious(a.findings) || confirmed(b.findings) - confirmed(a.findings) || a.ownName.localeCompare(b.ownName));

      // One decision is one card: own sentences are grouped by the paragraph or list item they stand in.
      const ownTexts = await Promise.all(ownSources(components).map(async (c) => (await loadComponentText(c, deps.ctx)).text));
      const blockFor = (quote: string) => ownTexts.map((t) => blockOf(t, quote)).find((b) => b !== null) ?? quote;
      const groups = new Map<string, DeliberateGroup>();
      for (const f of findings) {
        if (f.state !== 'deliberate' || !f.settledBy) continue;
        const quote = f.settledBy === 'own' ? blockFor(f.precedenceQuote ?? '') : (f.precedenceQuote ?? '');
        const key = `${f.settledBy}:${normQuote(quote)}`;
        const group = groups.get(key) ?? { settledBy: f.settledBy, quote, findings: [] };
        group.findings.push(f);
        groups.set(key, group);
      }
      const deliberate = [...groups.values()].sort((a, b) => b.findings.length - a.findings.length);

      const records = active.map((s) => ({ s, p: deps.store.pair(s.id) }));
      const checked = records.map((r) => r.p?.checkedAt).filter((x): x is string => !!x).sort();
      return {
        themes,
        deliberate,
        progress: {
          total: active.length,
          upToDate: records.filter(({ s, p }) => p && !p.error && p.hash !== '' && (!hashes || p.hash === hashes.get(s.id))).length,
          running,
          failed: records.filter((r) => r.p?.error).map((r) => skillNameOf(r.s)),
          lastCheck: checked.at(-1) ?? null,
        },
        aiOff: !deps.ai,
      };
    },

    decided(ownKey) {
      decidedKeys.add(ownKey);
    },
  };
}
