import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { EXPLAINABLE, INCOMING, type SessionSummary, type SessionTimeline, type StepDetail, type TimelineStep, type WhyItem, type WhyResult } from '../../src/shared/sessions';
import { usePublishPage } from './PageContext';
import { t as texts } from './text';
import { useElapsed } from './useElapsed';

type Filter = 'all' | 'incoming' | 'claude';
const FILTERS: Filter[] = ['all', 'incoming', 'claude'];

const sessionHref = (s: Pick<SessionSummary, 'project' | 'id'>) => `#/sessions/${encodeURIComponent(s.project)}/${encodeURIComponent(s.id)}`;

function getJson<T>(url: string): Promise<T> {
  return fetch(url).then(async (r) => {
    if (r.ok) return (await r.json()) as T;
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${r.status}`);
  });
}

/** #/sessions: the newest sessions of all projects, grouped by working folder. */
export function SessionsPage() {
  const t = texts.sessions;
  usePublishPage({ id: null, href: '#/sessions', name: t.title, editable: false, hasSecrets: false });
  const [list, setList] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getJson<{ sessions: SessionSummary[] }>('/api/sessions').then((r) => setList(r.sessions), (e: Error) => setError(e.message));
  }, []);

  // Folders in the order of their newest session.
  const groups = useMemo(() => {
    const byFolder = new Map<string, SessionSummary[]>();
    for (const s of list ?? []) {
      const key = s.cwd ?? s.project;
      byFolder.set(key, [...(byFolder.get(key) ?? []), s]);
    }
    return [...byFolder];
  }, [list]);

  return (
    <main className="detail sessions">
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
      {!list && !error && <p className="status">{t.loading}</p>}
      {list && list.length === 0 && <p className="status">{t.none}</p>}
      {list && list.length > 0 && <p className="sessions-note">{t.latest(list.length)}</p>}
      {groups.map(([folder, items]) => (
        <section key={folder} className="session-group" aria-label={folder}>
          <h2>{folder}</h2>
          <ul>
            {items.map((s) => (
              <li key={s.id}>
                <a href={sessionHref(s)}>{s.title}</a>
                <span className="session-meta">
                  {t.when(s.modified)}, {t.size(s.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

function WhyList({ title, items }: { title: string; items: WhyItem[] }) {
  const t = texts.sessions.timeline;
  if (!items.length) return null;
  return (
    <>
      <h2>{title}</h2>
      <ul>
        {items.map((x, i) => (
          <li key={i}>
            <span className="why-source">{x.source}</span>
            <blockquote>“{x.quote}”</blockquote>
            {!x.quoteFound && <span className="why-unverified">{t.quoteMissing}</span>}
            <p>{x.note}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

/** One row of the timeline; its full text is fetched the first time it is opened, "Why?" asks Opus on click. */
function Step({ step, project, id, ai }: { step: TimelineStep; project: string; id: string; ai: boolean }) {
  const t = texts.sessions.timeline;
  const region = useId();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<StepDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState<{ busy: boolean; result: WhyResult | null; error: string | null }>({ busy: false, result: null, error: null });
  const elapsed = useElapsed(why.busy);
  const whyBox = useRef<HTMLDivElement>(null);
  // Focus follows the answer, so a screen reader reads what just appeared.
  useEffect(() => {
    if (why.result) whyBox.current?.focus();
  }, [why.result]);
  const ask = async () => {
    setWhy({ busy: true, result: null, error: null });
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}/steps/${step.i}/why`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = (await res.json().catch(() => ({}))) as WhyResult & { error?: string };
      setWhy(res.ok ? { busy: false, result: body, error: null } : { busy: false, result: null, error: body.error ?? `HTTP ${res.status}` });
    } catch (e) {
      setWhy({ busy: false, result: null, error: (e as Error).message });
    }
  };
  const toggle = () => {
    setOpen((o) => !o);
    if (detail || error) return;
    getJson<StepDetail>(`/api/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}/steps/${step.i}`).then(setDetail, (e: Error) => setError(e.message));
  };
  const time = step.at ? new Date(step.at) : null;
  return (
    <li className={`step step-${step.kind} ${INCOMING.has(step.kind) ? 'step-in' : 'step-out'}`}>
      <time className="step-time" dateTime={step.at} title={time?.toLocaleString()}>
        {time?.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </time>
      <div className="step-body">
        <div className="step-row">
          <button type="button" className="step-head" aria-expanded={open} aria-controls={region} onClick={toggle}>
            <ChevronRight className="icon step-chevron" aria-hidden="true" />
            <span className="step-lane">{t.lanes[step.kind]}</span>
            <span className="step-title">{step.title}</span>
            {step.error && <span className="step-failed">{t.failed}</span>}
          </button>
          {ai && EXPLAINABLE.has(step.kind) && (
            <button type="button" className="step-why" onClick={ask} disabled={why.busy} aria-label={t.whyLabel(step.title)}>
              {t.why}
            </button>
          )}
        </div>
        {!open && step.preview && step.preview !== step.title && <p className="step-preview">{step.preview}</p>}
        <div id={region} className="step-detail" hidden={!open}>
          {open && !detail && !error && <p className="status">{t.loadingStep}</p>}
          {error && <p className="notice error">{t.stepError(error)}</p>}
          {detail && (
            <>
              <p className="step-chars">{t.chars(step.chars)}</p>
              <pre>{detail.text}</pre>
              {detail.cut && <p className="notice warn">{t.cut}</p>}
            </>
          )}
        </div>
        {why.busy && (
          <p className="status" role="status">
            {t.whyRunning}
            <span aria-hidden="true"> {t.seconds(elapsed)}</span>
          </p>
        )}
        {why.error && (
          <p className="notice error" role="status">
            {t.whyError(why.error)}
          </p>
        )}
        {why.result && (
          <div className="why" ref={whyBox} tabIndex={-1}>
            <p className="why-verdict">{why.result.verdict}</p>
            <WhyList title={t.steered} items={why.result.steered} />
            {!why.result.steered.length && <p className="why-none">{t.noneSteered}</p>}
            <WhyList title={t.ignored} items={why.result.ignored} />
            <p className="why-foot">{t.whyFoot(why.result.model, why.result.sources)}</p>
          </div>
        )}
      </div>
    </li>
  );
}

/** #/sessions/<project>/<id>: the steps of one session in file order, incoming text apart from Claude's actions. */
export function SessionPage({ project, id }: { project: string; id: string }) {
  const s = texts.sessions;
  const t = s.timeline;
  usePublishPage({ id: null, href: sessionHref({ project, id }), name: s.title, editable: false, hasSecrets: false });
  const [data, setData] = useState<SessionTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  useEffect(() => {
    getJson<SessionTimeline>(`/api/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}`).then(setData, (e: Error) => setError(e.message));
  }, [project, id]);

  const shown = useMemo(
    () => (data?.steps ?? []).filter((x) => filter === 'all' || (filter === 'incoming') === INCOMING.has(x.kind)),
    [data, filter],
  );

  return (
    <main className="detail sessions">
      <nav className="crumb" aria-label={s.title}>
        <a href="#/sessions">{s.title}</a> / <span aria-current="page">{data?.session.title ?? id}</span>
      </nav>
      {error && (
        <p className="notice error" role="status">
          {s.loadError(error)}
        </p>
      )}
      {!data && !error && <p className="status">{t.loading}</p>}
      {data && (
        <>
          <header className="detail-head">
            <h1>{data.session.title}</h1>
            <p className="lede">{t.about(data.session.cwd, s.when(data.session.modified), data.steps.length)}</p>
          </header>
          <div className="timeline-bar">
            <div className="segmented" role="group" aria-label={t.filter}>
              {FILTERS.map((f) => (
                <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {t.filters[f]}
                </button>
              ))}
            </div>
            <span className="status" role="status">
              {t.shown(shown.length, data.steps.length)}
            </span>
          </div>
          <ol className="timeline">
            {shown.map((x) => (
              <Step key={x.i} step={x} project={project} id={id} ai={data.ai} />
            ))}
          </ol>
        </>
      )}
    </main>
  );
}
