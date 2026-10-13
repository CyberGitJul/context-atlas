import { ArrowLeft, ArrowLeftRight, Check, RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { ConflictFinding, ConflictsView, ConflictTheme, DeliberateGroup } from '../../src/shared/conflicts';
import { usePublishPage } from './PageContext';
import { t as texts } from './text';

type Tab = 'open' | 'deliberate';
const TABS: Tab[] = ['open', 'deliberate'];

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
const moment = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
};
/** The first sentence of a longer explanation, for the line under a theme. */
const firstSentence = (s: string) => s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s;
/** A rule's name from its key: the heading of a CLAUDE.md section, else rules/<file>. */
const ruleName = (ownKey: string) => (ownKey.startsWith('CLAUDE.md#') ? ownKey.slice('CLAUDE.md#'.length) : ownKey);
const skillsOf = (findings: ConflictFinding[]) => [...new Set(findings.map((f) => f.skillName))];
/** Findings the latest check confirmed; the others are folded away and not counted. */
const confirmedOf = (findings: ConflictFinding[]) => findings.filter((f) => !f.unconfirmed);

function progressText(view: ConflictsView): string {
  const t = texts.conflicts;
  const p = view.progress;
  if (view.aiOff) return t.aiOff;
  if (!p.total) return t.noSkills;
  if (p.running) return t.checking(p.upToDate, p.total, p.running);
  if (p.upToDate + p.failed.length < p.total) return t.waiting(p.upToDate, p.total);
  if (p.failed.length) return t.checked(p.upToDate, p.total);
  return t.allChecked(p.total, p.lastCheck ? moment(p.lastCheck) : '–');
}

/** Where own instructions collide with plugin skills: open findings by rule, deliberate ones by the sentence that settles them. */
export function ConflictsPage() {
  const t = texts.conflicts;
  usePublishPage({ id: null, href: '#/conflicts', name: t.title, editable: false, hasSecrets: false });
  const [view, setView] = useState<ConflictsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('open');
  const tabs = useRef<Record<Tab, HTMLButtonElement | null>>({ open: null, deliberate: null });

  /** The first load schedules due checks; refreshes on change events only read (else a failing check would loop). */
  const load = useCallback((schedule: boolean) => {
    fetch(schedule ? '/api/conflicts' : '/api/conflicts?schedule=0')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(
        (v: ConflictsView) => {
          setView(v);
          setError(null);
        },
        (e: Error) => setError(e.message),
      );
  }, []);

  // Each check that starts or ends sends a `conflicts` event; the page then reloads the view.
  useEffect(() => {
    load(true);
    const source = new EventSource('/api/events');
    source.addEventListener('conflicts', () => load(false));
    return () => source.close();
  }, [load]);

  // Tabs pattern: arrow keys, Home and End move between the tabs; only the selected one is in the tab order.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(tab);
    const next = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(i + TABS.length - 1) % TABS.length] : e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS[TABS.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabs.current[next]?.focus();
  };

  const themes = (view?.themes ?? []).filter((x) => confirmedOf(x.findings).length);
  const unconfirmedThemes = (view?.themes ?? []).filter((x) => !confirmedOf(x.findings).length);
  const major = themes.filter((x) => !x.minor);
  const minor = themes.filter((x) => x.minor);
  const openFindings = themes.reduce((n, x) => n + confirmedOf(x.findings).length, 0);
  const deliberateFindings = view?.deliberate.reduce((n, g) => n + g.findings.length, 0) ?? 0;
  const labels: Record<Tab, string> = { open: t.tabOpen(themes.length, openFindings), deliberate: t.tabDeliberate(deliberateFindings) };

  return (
    <main className="detail conflicts">
      <a className="back" href="#/">
        <ArrowLeft className="icon" aria-hidden="true" /> {t.back}
      </a>
      <header className="detail-head">
        <h1>{t.title}</h1>
        <p className="lede">{t.lede}</p>
      </header>

      {error && (
        <p className="notice error" role="status">
          {t.loadError(error)}
        </p>
      )}
      {!view && !error && <p className="status">{t.loading}</p>}
      {view && (
        <>
          <p className="conflicts-progress" role="status" aria-atomic="true">
            {progressText(view)}
          </p>
          {view.progress.failed.length > 0 && <p className="notice warn">{t.failed(view.progress.failed.join(', '))}</p>}

          <div className="conflicts-tabs" role="tablist" aria-label={t.title}>
            {TABS.map((id) => (
              <button
                key={id}
                ref={(el) => {
                  tabs.current[id] = el;
                }}
                type="button"
                role="tab"
                id={`conflicts-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`conflicts-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                onKeyDown={onTabKey}
              >
                {labels[id]}
              </button>
            ))}
          </div>

          <div id="conflicts-panel-open" role="tabpanel" aria-labelledby="conflicts-tab-open" hidden={tab !== 'open'}>
            {!themes.length && <p className="lede">{t.noneOpen}</p>}
            {major.map((x) => (
              <ThemeCard key={x.ownKey} theme={x} />
            ))}
            {minor.length > 0 && (
              <>
                <h2 className="conflicts-minor">{t.minor}</h2>
                {minor.map((x) => (
                  <ThemeCard key={x.ownKey} theme={x} />
                ))}
              </>
            )}
            {unconfirmedThemes.length > 0 && (
              <details className="conflict-unconfirmed-section">
                <summary>{t.unconfirmedSection(unconfirmedThemes.length)}</summary>
                {unconfirmedThemes.map((x) => (
                  <ThemeCard key={x.ownKey} theme={x} />
                ))}
              </details>
            )}
          </div>

          <div id="conflicts-panel-deliberate" role="tabpanel" aria-labelledby="conflicts-tab-deliberate" hidden={tab !== 'deliberate'}>
            {!view.deliberate.length && <p className="lede">{t.noneDeliberate}</p>}
            {view.deliberate.map((g) => (
              <DeliberateCard key={`${g.settledBy}:${g.quote}`} group={g} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}

/**
 * All open findings of one own rule. Findings the latest check did not confirm are folded away below the confirmed
 * ones; a rule with no confirmed finding shows them directly (it sits in the folded section at the end).
 */
function ThemeCard({ theme }: { theme: ConflictTheme }) {
  const t = texts.conflicts;
  const id = useId();
  const confirmed = confirmedOf(theme.findings);
  const shown = confirmed.length ? confirmed : theme.findings;
  const folded = confirmed.length ? theme.findings.filter((f) => f.unconfirmed) : [];
  const skills = skillsOf(shown);
  const high = shown.filter((f) => f.severity === 'high').length;
  return (
    <section className="theme" aria-labelledby={id}>
      <header className="theme-head">
        {theme.rechecking ? (
          <span className="state state-rechecking">
            <RefreshCw className="icon" aria-hidden="true" />
            {t.stateRechecking}
          </span>
        ) : (
          <span className="state state-new">
            <TriangleAlert className="icon" aria-hidden="true" />
            {t.stateNew}
          </span>
        )}
        <h2 id={id}>{theme.ownName}</h2>
        <span className="count">{t.count(shown.length, skills.length, high)}</span>
      </header>
      {theme.rechecking ? (
        <p className="today">{t.recheckingNote}</p>
      ) : (
        <p className="today">
          <strong>{t.noPrecedence}</strong> {firstSentence(shown[0]?.whoWinsToday ?? '')}
        </p>
      )}
      <ul className="chips">
        {skills.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      {theme.ownId && (
        <p className="theme-actions">
          {/* Deciding again before the re-check would add a second sentence. */}
          {!theme.rechecking && (
            <a className="hint-action primary" href={`#/conflicts/decide/${encodeURIComponent(theme.ownKey)}`}>
              {t.decide.button}
            </a>
          )}
          <a className="hint-action" href={`#/c/${encodeURIComponent(theme.ownId)}`}>
            {t.openRule}
          </a>
        </p>
      )}
      <div className="conflict-findings">
        {shown.map((f) => (
          <Finding key={f.key} finding={f} ownName={theme.ownName} />
        ))}
      </div>
      {folded.length > 0 && (
        <details className="conflict-unconfirmed">
          <summary>{t.unconfirmedGroup(folded.length)}</summary>
          {folded.map((f) => (
            <Finding key={f.key} finding={f} ownName={theme.ownName} />
          ))}
        </details>
      )}
    </section>
  );
}

/** Deliberate findings settled by the same sentence; they stay listed. */
function DeliberateCard({ group }: { group: DeliberateGroup }) {
  const t = texts.conflicts;
  const id = useId();
  const skills = skillsOf(group.findings);
  return (
    <section className="theme deliberate" aria-labelledby={id}>
      <header className="theme-head">
        <span className="state state-ok">
          <Check className="icon" aria-hidden="true" />
          {t.stateDeliberate}
        </span>
        <h2 id={id}>{group.settledBy === 'own' ? t.ownWins : t.skillDefers}</h2>
        <span className="count">{t.covers(group.findings.length, skills.length)}</span>
      </header>
      <blockquote className="rule-quote">{group.quote}</blockquote>
      <p className="since">{group.settledBy === 'own' ? t.inYourRules : t.inTheSkill}</p>
      <ul className="chips">
        {skills.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <div className="conflict-findings">
        {group.findings.map((f) => (
          <Finding key={f.key} finding={f} ownName={ruleName(f.ownKey)} noteUnconfirmed />
        ))}
      </div>
    </section>
  );
}

/** One finding: both quotes side by side, when it bites and what Claude does today. */
export function Finding({ finding: f, ownName, noteUnconfirmed = false, open = false }: { finding: ConflictFinding; ownName: string; noteUnconfirmed?: boolean; open?: boolean }) {
  const t = texts.conflicts;
  return (
    <details className="conflict-finding" open={open || undefined}>
      <summary>
        <span className={`sev sev-${f.severity}`}>{t.severity[f.severity]}</span>
        <span className="conflict-finding-skill">{f.skillName}</span>
        <span className="ftitle">{f.title}</span>
        <span className="ftype">{t.types[f.type]}</span>
      </summary>
      <div className="pair">
        <figure className="side own">
          <figcaption>{t.yourRule(ownName)}</figcaption>
          <blockquote>{f.quoteOwn}</blockquote>
        </figure>
        <div className="seam" aria-hidden="true">
          <ArrowLeftRight className="icon" />
        </div>
        <figure className="side theirs">
          <figcaption>{t.skillSide(f.skillName)}</figcaption>
          <blockquote>{f.quoteSkill}</blockquote>
        </figure>
      </div>
      <dl className="facts">
        <dt>{t.whenItBites}</dt>
        <dd>{f.situation}</dd>
        <dt>{t.today}</dt>
        <dd>{f.whoWinsToday}</dd>
      </dl>
      {noteUnconfirmed && f.unconfirmed && <p className="conflict-finding-note">{t.unconfirmed}</p>}
      {f.skillChangedAt && <p className="conflict-finding-note">{t.skillChanged(day(f.skillChangedAt))}</p>}
    </details>
  );
}
