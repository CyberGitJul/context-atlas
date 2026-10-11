import { ArrowLeft, ExternalLink, Lightbulb } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { joinSections } from '../../src/shared/sections';
import { DiffView } from './DiffView';
import { t as texts } from './text';
import { usePublishPage } from './PageContext';

interface ProposedSection {
  index: number;
  heading: string;
  before: string;
  after: string;
  changes: string[];
  outsource: string;
  restored: string[];
  words: { before: number; after: number };
  check: { errors: string[]; warnings: string[] };
  /** What the reviewer fixed, when it repaired this section. */
  review?: string[];
}
type Repaired = Pick<ProposedSection, 'index' | 'after' | 'restored' | 'words' | 'check'> & { changes: string[] };
interface Proposal {
  file: string;
  preamble: string;
  summary: string;
  sections: ProposedSection[];
  model: string;
}
type Status = 'kept' | 'weakened' | 'lost' | 'ambiguous' | 'new';
interface Rule {
  rule: string;
  status: Status;
  before: string;
  after: string;
  note: string;
}

const heading = (h: string) => h.replace(/^##\s*/, '');
/** Detail page of a CLAUDE.md section: the scan numbers sections like the split here. */
const sectionHref = (index: number) => `#/c/${encodeURIComponent(`instruction:user:CLAUDE.md#${index}`)}`;

type Phase = 'idle' | 'proposing' | 'testing' | 'repairing' | 'retesting' | 'ready' | 'saving' | 'saved';
type StepPhase = 'proposing' | 'testing' | 'repairing' | 'retesting';
const isStep = (p: Phase): p is StepPhase => p === 'proposing' || p === 'testing' || p === 'repairing' || p === 'retesting';

/** A rule-test finding as one line for the reviewer: status, rule, what changed, the old wording. */
const finding = (r: Rule) => `${r.status}: ${r.rule}${r.note ? ` (${r.note})` : ''}${r.before ? ` Old wording: “${r.before}”` : ''}`;
const offRules = (rules: Rule[] | undefined) => (rules ?? []).filter((r) => r.status !== 'kept');

/** Ticked by default only when it saves words, the fixed checks found nothing and, once tested, every rule was kept. */
function preselect(p: Proposal, rules: Map<number, Rule[]> | null): Set<number> {
  const ok = (s: ProposedSection) =>
    s.words.after < s.words.before && !s.check.errors.length && !s.check.warnings.length && (rules === null || (rules.has(s.index) && !offRules(rules.get(s.index)).length));
  return new Set(p.sections.filter(ok).map((s) => s.index));
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const res = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(res.error ?? `HTTP ${r.status}`);
  return res;
}

/** Seconds since the current step started, for the waiting line. */
function useElapsed(step: Phase | undefined) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!step) return;
    setS(0);
    const t = setInterval(() => setS((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [step]);
  return s;
}

/**
 * "CLAUDE.md verdichten": Opus condenses every section boldly in plain short prose, fixed checks run without AI, a
 * second pass tests rule by rule what was kept, a reviewer puts back what got lost and the repaired sections are
 * tested again. Sections are taken over one by one; the file is saved once.
 */
export function CondensePage() {
  const t = texts.condense;
  usePublishPage({ id: null, href: '#/condense', name: t.title, editable: false, hasSecrets: false });
  const [phase, setPhase] = useState<Phase>('idle');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [rules, setRules] = useState<Map<number, Rule[]> | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const step = isStep(phase) ? phase : undefined;
  const elapsed = useElapsed(step);

  const changed = useMemo(() => proposal?.sections.filter((s) => s.after !== s.before) ?? [], [proposal]);
  const outsourceOnly = useMemo(() => proposal?.sections.filter((s) => s.after === s.before && s.outsource) ?? [], [proposal]);

  const start = async () => {
    setError(null);
    setNotice(null);
    setRules(null);
    setPhase('proposing');
    let p: Proposal;
    try {
      p = await post<Proposal>('/api/condense/propose', {});
    } catch (e) {
      setError((e as Error).message);
      return setPhase('idle');
    }
    setProposal(p);
    setChosen(preselect(p, null));
    const byIndex = new Map<number, Rule[]>();
    const test = async (sections: { index: number; after: string }[]) => {
      const res = await post<{ sections: { index: number; rules: Rule[] }[] }>('/api/condense/test', { file: p.file, sections });
      for (const s of res.sections) byIndex.set(s.index, s.rules);
      setRules(new Map(byIndex));
    };
    const changedNow = () => p.sections.filter((s) => s.after !== s.before);
    setPhase('testing');
    try {
      await test(changedNow().map((s) => ({ index: s.index, after: s.after })));
    } catch (e) {
      setError(t.ruleTestFailed((e as Error).message));
      return setPhase('ready');
    }
    // The reviewer gets every changed section with a finding, from the rule test or the fixed checks.
    const needs = changedNow().filter((s) => offRules(byIndex.get(s.index)).length || s.check.errors.length || s.check.warnings.length);
    if (needs.length) {
      setPhase('repairing');
      try {
        const r = await post<{ sections: Repaired[] }>('/api/condense/repair', {
          file: p.file,
          sections: needs.map((s) => ({ index: s.index, after: s.after, findings: offRules(byIndex.get(s.index)).map(finding) })),
        });
        const fixed = new Map(r.sections.map((x) => [x.index, x]));
        p = {
          ...p,
          sections: p.sections.map((s) => {
            const x = fixed.get(s.index);
            return x ? { ...s, after: x.after, restored: x.restored, words: x.words, check: x.check, review: x.changes } : s;
          }),
        };
        setProposal(p);
        // The old verdict belongs to the old text: until the new one is back, a repaired section counts as untested.
        for (const i of fixed.keys()) byIndex.delete(i);
        setRules(new Map(byIndex));
        if (fixed.size) {
          setPhase('retesting');
          await test(r.sections.map((x) => ({ index: x.index, after: x.after })));
        }
      } catch (e) {
        setError(t.reviewFailed((e as Error).message));
      }
    }
    setChosen(preselect(p, byIndex));
    setPhase('ready');
  };

  const total = (pick: (s: ProposedSection) => number) => proposal?.sections.reduce((n, s) => n + pick(s), 0) ?? 0;
  const before = total((s) => s.words.before);
  const after = total((s) => (chosen.has(s.index) ? s.words.after : s.words.before));

  const save = async () => {
    if (!proposal) return;
    setPhase('saving');
    setError(null);
    const text = joinSections(proposal.preamble, proposal.sections.map((s) => (chosen.has(s.index) ? s.after : s.before)));
    try {
      const r = await post<{ backup: string | null; commit: string | null; warning: string | null }>('/api/file/save', { path: '~/.claude/CLAUDE.md', before: proposal.file, after: text });
      setNotice({ tone: r.warning ? 'warn' : 'ok', text: [r.warning, t.saved(chosen.size, after), r.commit ? t.commit(r.commit) : '', r.backup ? t.backup(r.backup) : ''].filter(Boolean).join(' ') });
      setPhase('saved');
    } catch (e) {
      setError((e as Error).message);
      setPhase('ready');
    }
  };

  const toggle = (i: number) => setChosen((cur) => (cur.has(i) ? new Set([...cur].filter((x) => x !== i)) : new Set([...cur, i])));
  const busy = !!step || phase === 'saving';

  return (
    <main className="detail condense">
      <a className="back" href="#/">
        <ArrowLeft className="icon" aria-hidden="true" /> {t.back}
      </a>
      <header className="detail-head">
        <h1>{t.title}</h1>
        <p className="lede">{t.lede}</p>
      </header>

      {phase === 'idle' && (
        <div className="button-row">
          <button type="button" className="primary" onClick={start}>
            {t.start}
          </button>
          <span className="edit-state">{t.startNote}</span>
        </div>
      )}
      {step && (
        <p className="running" role="status">
          {t.waiting(t.steps[step], elapsed)}
        </p>
      )}
      {error && (
        <p className="notice error" role="status">
          {error}
        </p>
      )}
      {notice && (
        <p className={`notice ${notice.tone}`} role="status">
          {notice.text}
        </p>
      )}

      {proposal && (
        <>
          <section className="condense-summary" aria-label={t.summaryLabel}>
            <p>{proposal.summary}</p>
            <p className="condense-total">
              <strong>{t.words(before, after)}</strong> {t.totalRest(before - after > 0 ? `−${before - after}` : '±0', chosen.size, changed.length)}
            </p>
            {phase !== 'saved' && (
              <div className="button-row">
                <button type="button" className="primary" onClick={save} disabled={busy || !chosen.size}>
                  {phase === 'saving' ? t.saving : t.apply(chosen.size)}
                </button>
                <button type="button" onClick={start} disabled={busy}>
                  {t.newProposal}
                </button>
              </div>
            )}
          </section>

          {changed.map((s) => {
            const r = rules?.get(s.index);
            const off = r?.filter((x) => x.status !== 'kept') ?? [];
            return (
              <section key={s.index} className={`condense-section${chosen.has(s.index) ? ' chosen' : ''}`} aria-labelledby={`cs-${s.index}`}>
                <label className="condense-head">
                  <input type="checkbox" checked={chosen.has(s.index)} onChange={() => toggle(s.index)} disabled={busy || phase === 'saved'} />
                  <span id={`cs-${s.index}`} className="condense-title">
                    {heading(s.heading)}
                  </span>
                  <span className="condense-words">{t.words(s.words.before, s.words.after)}</span>
                </label>
                {s.check.errors.map((e) => (
                  <p key={e} className="notice error">
                    {e}
                  </p>
                ))}
                {s.check.warnings.map((w) => (
                  <p key={w} className="notice warn">
                    {w}
                  </p>
                ))}
                {r === undefined ? (
                  <p className="lede">{phase === 'testing' || phase === 'retesting' ? t.testRunning : t.noTest}</p>
                ) : (
                  <p className="lede">
                    {t.testResult(r.length - off.length, r.length, off.length)}
                  </p>
                )}
                {off.length > 0 && (
                  <ul className="condense-rules">
                    {off.map((x, i) => (
                      <li key={i} className={`rule-${x.status === 'weakened' ? 'weak' : x.status === 'new' ? 'new' : 'lost'}`}>
                        <strong>{t.status[x.status]}:</strong> {x.rule}
                        {x.note && <span className="muted"> {x.note}</span>}
                        {x.before && <q>{x.before}</q>}
                        {x.after && <q>{x.after}</q>}
                      </li>
                    ))}
                  </ul>
                )}
                {s.review && s.review.length > 0 && (
                  <>
                    <p className="condense-review">
                      <strong>{t.reviewed}</strong>
                    </p>
                    <ul className="condense-changes">
                      {s.review.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </>
                )}
                {s.outsource && (
                  <p className="condense-outsource">
                    <Lightbulb className="icon" aria-hidden="true" />
                    <span>
                      {s.outsource} <SkillifyLink index={s.index} />
                    </span>
                  </p>
                )}
                {s.changes.length > 0 && (
                  <ul className="condense-changes">
                    {s.changes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                )}
                <details>
                  <summary>{t.compare}</summary>
                  <DiffView before={s.before} after={s.after} />
                </details>
              </section>
            );
          })}

          {outsourceOnly.length > 0 && (
            <section className="condense-section" aria-label={t.outsourceLabel}>
              <h2>{t.outsourceTitle}</h2>
              <ul className="condense-changes">
                {outsourceOnly.map((s) => (
                  <li key={s.index}>
                    <strong>{heading(s.heading)}:</strong> {s.outsource} <SkillifyLink index={s.index} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}

/** Opens the section's detail page, where the skillify action runs; in a new tab, so this proposal stays. */
function SkillifyLink({ index }: { index: number }) {
  return (
    <a href={sectionHref(index)} target="_blank" rel="noopener">
      {texts.actions.skillify}
      <ExternalLink className="icon" aria-hidden="true" />
      <span className="sr-only"> {texts.condense.newTab}</span>
    </a>
  );
}
