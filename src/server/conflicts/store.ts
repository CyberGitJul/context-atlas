import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConflictFinding } from '../../shared/conflicts.js';
import { appDirs } from '../paths.js';
import { sha256 } from '../scan/context.js';
import { hasQuote, normQuote, type CheckedFinding, type OwnText } from './quotes.js';

/** The last check of one plugin skill against the own instructions. */
export interface PairRecord {
  /** Hash of own texts, skill text and prompt the check ran on; '' when it never succeeded. */
  hash: string;
  checkedAt: string | null;
  /** Findings dropped because a quote did not stand in the text. */
  dropped: number;
  error: string | null;
}

/** The result of checking one plugin skill. */
export interface PairRun {
  skillId: string;
  skillName: string;
  hash: string;
  at: string;
  findings: CheckedFinding[];
  dropped: number;
  /** Every own instruction as sent (masked), by rule: own quotes are checked against their rule, precedence against all. */
  own: OwnText[];
  skillText: string;
}

export interface ConflictStore {
  load(): Promise<void>;
  pair(skillId: string): PairRecord | undefined;
  applyRun(run: PairRun): Promise<void>;
  /** Keeps the stored hash (or ''), so the pair stays due. */
  recordError(skillId: string, error: string): Promise<void>;
  findings(): ConflictFinding[];
}

/** Same own rule, same skill, same skill passage: the same finding across runs. */
export function findingKey(ownKey: string, skillId: string, quoteSkill: string): string {
  return sha256(JSON.stringify([ownKey, skillId, normQuote(quoteSkill)]));
}

export function defaultConflictsFile(): string {
  return path.join(appDirs().cache, 'conflicts.json');
}

const FORMAT = 1;

const ownText = (run: PairRun) => run.own.map((o) => o.text).join('\n\n');
/** The text a precedence sentence has to stand in: the own instructions or the skill. */
const settlingText = (run: PairRun, by: 'own' | 'skill') => (by === 'own' ? ownText(run) : run.skillText);
/** Whether the own quote still stands in the rule the finding belongs to (gone after a rename or a move). */
const inOwnRule = (run: PairRun, f: { ownKey: string; quoteOwn: string }) => run.own.some((o) => o.key === f.ownKey && hasQuote(o.text, f.quoteOwn));

/**
 * Findings as an inventory, not a snapshot: each run updates the findings of its pair, states carry over, and a
 * finding is resolved only when one of its quotes is gone. Persisted as one JSON file (written atomically).
 */
export function createConflictStore(file: string): ConflictStore {
  let pairs: Record<string, PairRecord> = {};
  let findings: Record<string, ConflictFinding> = {};

  async function persist(): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: FORMAT, pairs, findings }, null, 1));
    await rename(tmp, file);
  }

  return {
    async load() {
      try {
        const raw = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown; pairs?: Record<string, PairRecord>; findings?: Record<string, ConflictFinding> };
        if (raw.version !== FORMAT) throw new Error('other format');
        pairs = raw.pairs ?? {};
        findings = raw.findings ?? {};
      } catch {
        pairs = {};
        findings = {};
      }
    },
    pair: (skillId) => pairs[skillId],
    async applyRun(run) {
      const before = Object.values(findings).filter((x) => x.skillId === run.skillId);
      const seen = new Set<string>();
      for (const f of run.findings) {
        const key = findingKey(f.ownKey, run.skillId, f.quoteSkill);
        const old = findings[key];
        const nowBy = f.precedence === 'explicit-own' && hasQuote(ownText(run), f.precedenceQuote) ? 'own' : f.precedence === 'explicit-skill' && hasQuote(run.skillText, f.precedenceQuote) ? 'skill' : null;
        const keptBy = !nowBy && old?.state === 'deliberate' && old.settledBy && hasQuote(settlingText(run, old.settledBy), old.precedenceQuote) ? old.settledBy : null;
        const settledBy = nowBy ?? keptBy;
        const precedenceQuote = nowBy ? f.precedenceQuote : keptBy ? old!.precedenceQuote : null;
        // The quoted skill passage changed (plugin update) and the same own sentence still covers the new text.
        const moved =
          !old && settledBy
            ? before.find((g) => g.ownKey === f.ownKey && g.state === 'deliberate' && normQuote(g.precedenceQuote ?? '') === normQuote(precedenceQuote ?? '') && !hasQuote(run.skillText, g.quoteSkill))
            : undefined;
        const { precedence: _, precedenceQuote: __, ...fields } = f;
        findings[key] = {
          ...fields,
          key,
          skillId: run.skillId,
          skillName: run.skillName,
          state: settledBy ? 'deliberate' : 'new',
          settledBy,
          precedenceQuote,
          firstSeen: old?.firstSeen ?? moved?.firstSeen ?? run.at,
          lastConfirmed: run.at,
          unconfirmed: false,
          skillChangedAt: moved ? run.at : (old?.skillChangedAt ?? null),
        };
        seen.add(key);
      }
      for (const g of before) {
        if (seen.has(g.key)) continue;
        if (!inOwnRule(run, g) || !hasQuote(run.skillText, g.quoteSkill)) {
          delete findings[g.key];
          continue;
        }
        const stillSettled = g.state === 'deliberate' && g.settledBy && hasQuote(settlingText(run, g.settledBy), g.precedenceQuote);
        findings[g.key] = stillSettled ? { ...g, unconfirmed: true } : { ...g, unconfirmed: true, state: 'new', settledBy: null, precedenceQuote: null };
      }
      pairs[run.skillId] = { hash: run.hash, checkedAt: run.at, dropped: run.dropped, error: null };
      await persist();
    },
    async recordError(skillId, error) {
      const old = pairs[skillId];
      pairs[skillId] = { hash: old?.hash ?? '', checkedAt: old?.checkedAt ?? null, dropped: old?.dropped ?? 0, error };
      await persist();
    },
    findings: () => Object.values(findings),
  };
}
