import { useEffect, useId, useRef, useState } from 'react';
import type { ConflictsView, ConflictTheme, DecideProposal, Winner } from '../../src/shared/conflicts';
import { Finding } from './Conflicts';
import { DiffView } from './DiffView';
import { usePublishPage } from './PageContext';
import { t as texts } from './text';

type Choice = 'own' | 'skills' | 'depends';
const CHOICES: Choice[] = ['own', 'skills', 'depends'];

const skillsOf = (theme: ConflictTheme) => [...new Set(theme.findings.map((f) => f.skillName))];
const isSection = (ownKey: string) => ownKey.startsWith('CLAUDE.md#');
/** The file the sentence goes into: CLAUDE.md for a section, else rules/<file>. */
const targetOf = (ownKey: string) => (isSection(ownKey) ? 'CLAUDE.md' : ownKey);

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new HttpError(json.error ?? `HTTP ${res.status}`, res.status);
  return json;
}

/** Seconds since `running` became true, for the waiting line. */
function useElapsed(running: boolean) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!running) return;
    setS(0);
    const t = setInterval(() => setS((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  return s;
}

/**
 * "Decide precedence…" for one rule: pick who wins, Opus writes the sentence into the rule, the change is shown as
 * before/after and saved like every edit in the app; then the skills of the rule are checked again first.
 */
export function DecidePage({ ownKey }: { ownKey: string }) {
  const c = texts.conflicts;
  const t = c.decide;
  const id = useId();
  usePublishPage({ id: null, href: `#/conflicts/decide/${encodeURIComponent(ownKey)}`, name: t.question, editable: false, hasSecrets: false });
  const [theme, setTheme] = useState<ConflictTheme | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>('own');
  const [perSkill, setPerSkill] = useState<Record<string, Winner>>({});
  const [proposal, setProposal] = useState<DecideProposal | null>(null);
  const [busy, setBusy] = useState<'write' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ commit: string | null; warning: string | null; queued: number | null } | null>(null);
  const elapsed = useElapsed(busy === 'write');
  const step2 = useRef<HTMLHeadingElement>(null);
  const savedNotice = useRef<HTMLParagraphElement>(null);
  // Focus follows the result, so a screen reader reads what just appeared.
  useEffect(() => {
    if (proposal) step2.current?.focus();
  }, [proposal]);
  useEffect(() => {
    if (saved) savedNotice.current?.focus();
  }, [saved]);

  useEffect(() => {
    fetch('/api/conflicts?schedule=0')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(
        (v: ConflictsView) => {
          const found = v.themes.find((x) => x.ownKey === ownKey && x.ownId) ?? null;
          setTheme(found);
          if (found) setPerSkill(Object.fromEntries(skillsOf(found).map((s) => [s, 'own' as Winner])));
        },
        (e: Error) => setLoadError(e.message),
      );
  }, [ownKey]);

  const skills = theme ? skillsOf(theme) : [];
  const winners: Record<string, Winner> = Object.fromEntries(skills.map((s) => [s, choice === 'own' ? 'own' : choice === 'skills' ? 'skill' : (perSkill[s] ?? 'own')]));
  // A proposal belongs to the decision it was written for.
  const decide = (next: () => void) => {
    next();
    setProposal(null);
    setError(null);
  };

  const write = async () => {
    setBusy('write');
    setError(null);
    setProposal(null);
    try {
      setProposal(await post<DecideProposal>('/api/conflicts/propose', { ownKey, winners }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!proposal) return;
    setBusy('save');
    setError(null);
    try {
      const res = await post<{ commit: string | null; warning: string | null }>(`/api/component/save?id=${encodeURIComponent(proposal.ownId)}`, { before: proposal.before, after: proposal.after });
      // The save stands on its own; without the re-check the next visit to Conflicts queues every due pair anyway.
      const queued = await post<{ queued: string[] }>('/api/conflicts/recheck', { ownKey }).then(
        (r) => r.queued.length,
        () => null,
      );
      setSaved({ commit: res.commit, warning: res.warning, queued });
    } catch (e) {
      // The rule changed on disk since the sentence was written: that proposal can never be saved.
      if (e instanceof HttpError && e.status === 409) {
        setProposal(null);
        setError(t.ruleChanged);
      } else setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const choiceText: Record<Choice, [string, string]> = { own: [t.own, t.ownNote], skills: [t.skills, t.skillsNote], depends: [t.depends, t.dependsNote] };

  return (
    <main className="detail conflicts decide">
      <nav className="crumb" aria-label={c.title}>
        <a href="#/conflicts">{c.title}</a> / <span aria-current="page">{theme?.ownName ?? ownKey}</span>
      </nav>
      <header className="detail-head">
        <h1>{t.question}</h1>
        {theme && <p className="lede">{t.lede(theme.ownName, skills.length)}</p>}
      </header>

      {loadError && (
        <p className="notice error" role="status">
          {c.loadError(loadError)}
        </p>
      )}
      {theme === undefined && !loadError && <p className="status">{c.loading}</p>}
      {theme === null && (
        <p className="notice warn" role="status">
          {t.noTheme} <a href="#/conflicts">{t.backToConflicts}</a>
        </p>
      )}

      {theme && (
        <>
          <section className="decide-step" aria-labelledby={`${id}-c`}>
            <h2 id={`${id}-c`}>{t.collision}</h2>
            <p className="decide-note">{t.collisionNote}</p>
            <div className="conflict-findings">
              {theme.findings.map((f, i) => (
                <Finding key={f.key} finding={f} ownName={theme.ownName} noteUnconfirmed open={i === 0} />
              ))}
            </div>
          </section>

          <section className="decide-step" aria-labelledby={`${id}-s1`}>
            <h2 id={`${id}-s1`}>
              <span className="step-no" aria-hidden="true">
                1
              </span>
              {t.step1}
            </h2>
            <fieldset className="choices" aria-labelledby={`${id}-s1`} disabled={!!busy || !!saved}>
              {CHOICES.map((x) => (
                <label key={x} className="choice">
                  <input type="radio" name={`${id}-choice`} value={x} checked={choice === x} onChange={() => decide(() => setChoice(x))} />
                  <span className="choice-title">{choiceText[x][0]}</span>
                  <span className="choice-note">{choiceText[x][1]}</span>
                </label>
              ))}
            </fieldset>
            {choice === 'depends' && (
              <ul className="per-skill">
                {skills.map((s, i) => (
                  <li key={s}>
                    <span className="per-skill-name" id={`${id}-k${i}`}>
                      {s}
                    </span>
                    <span role="radiogroup" aria-labelledby={`${id}-k${i}`}>
                      {(['own', 'skill'] as Winner[]).map((w) => (
                        <label key={w}>
                          <input
                            type="radio"
                            name={`${id}-k${i}`}
                            checked={(perSkill[s] ?? 'own') === w}
                            disabled={!!busy || !!saved}
                            onChange={() => decide(() => setPerSkill((p) => ({ ...p, [s]: w })))}
                          />
                          {w === 'own' ? t.perSkillOwn : t.perSkillSkill}
                        </label>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="button-row">
              <button type="button" className={proposal ? undefined : 'primary'} onClick={write} disabled={!!busy || !!saved}>
                {t.write}
              </button>
              {busy === 'write' && (
                <span className="status" role="status">
                  {t.writing}
                  <span aria-hidden="true"> {t.seconds(elapsed)}</span>
                </span>
              )}
            </div>
            {error && !proposal && (
              <p className="notice error" role="status">
                {error}
              </p>
            )}
          </section>

          {proposal && (
            <>
              <section className="decide-step" aria-labelledby={`${id}-s2`}>
                <h2 id={`${id}-s2`} ref={step2} tabIndex={-1}>
                  <span className="step-no" aria-hidden="true">
                    2
                  </span>
                  {t.step2}
                </h2>
                <p className="decide-where">
                  <span>{t.where(proposal.file ?? targetOf(ownKey), isSection(ownKey) ? proposal.ownName : null)}</span>
                  <span className="decide-words">{t.words(proposal.wordsDelta, isSection(ownKey))}</span>
                </p>
                <DiffView before={proposal.before} after={proposal.after} />
                {proposal.changes.length > 0 && (
                  <ul className="decide-changes">
                    {proposal.changes.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
                {proposal.restored.length > 0 && <p className="notice warn">{t.restored(proposal.restored.join(', '))}</p>}
              </section>

              <section className="decide-step" aria-labelledby={`${id}-s3`}>
                <h2 id={`${id}-s3`}>
                  <span className="step-no" aria-hidden="true">
                    3
                  </span>
                  {t.step3}
                </h2>
                <ul className="after">
                  <li>
                    <b>{t.commitFact}</b>
                    {t.commitNote}
                  </li>
                  <li>
                    <b>{t.recheckFact}</b>
                    {t.recheckNote(skills.length)}
                  </li>
                  <li>
                    <b>{t.deliberateFact}</b>
                    {t.deliberateNote}
                  </li>
                </ul>
                {saved ? (
                  <p className="notice ok" role="status" ref={savedNotice} tabIndex={-1}>
                    {t.saved(saved.commit?.slice(0, 7) ?? null)} {saved.queued === null ? t.recheckFailed : t.rechecking(saved.queued)} <a href="#/conflicts">{t.backToConflicts}</a>
                  </p>
                ) : (
                  <div className="button-row decide-bar">
                    <a className="hint-action" href="#/conflicts">
                      {t.cancel}
                    </a>
                    <button type="button" className="primary" onClick={save} disabled={!!busy}>
                      {busy === 'save' ? t.saving : t.save(targetOf(ownKey))}
                    </button>
                  </div>
                )}
                {saved?.warning && <p className="notice warn">{saved.warning}</p>}
                {error && (
                  <p className="notice error" role="status">
                    {error}
                  </p>
                )}
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}
