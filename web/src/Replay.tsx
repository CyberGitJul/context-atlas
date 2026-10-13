import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReplayAction, ReplayOptions, ReplayResult, ReplaySection } from '../../src/shared/sessions';
import { t as texts } from './text';
import { useElapsed } from './useElapsed';

type Verdict = 'same' | 'similar' | 'different';

/** How the replay without the section compares to the replay as it was: same actions, same tools, or something else. */
export function compare(asIs: ReplayAction[], changed: ReplayAction[]): Verdict {
  const tools = (list: ReplayAction[]) => list.map((a) => (a.kind === 'tool' ? `tool:${a.tool}` : 'answer')).join('|');
  if (tools(asIs) !== tools(changed)) return 'different';
  return asIs.every((a, i) => a.text === changed[i].text) ? 'same' : 'similar';
}

function Actions({ list }: { list: ReplayAction[] }) {
  const t = texts.sessions.replay;
  const lanes = texts.sessions.timeline.lanes;
  if (!list.length) return <p className="replay-none">{t.nothing}</p>;
  return (
    <ul>
      {list.map((a, i) => (
        <li key={i}>
          <span className="step-lane">{lanes[a.kind]}</span> <span className="replay-title">{a.title}</span>
          {a.kind === 'tool' ? (
            <details>
              <summary>{t.input}</summary>
              <pre>{a.text}</pre>
            </details>
          ) : (
            a.text !== a.title && <p className="replay-answer">{a.text}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Groups the sections by file for the select, in the order the files were loaded. */
function byFile(sections: ReplaySection[]): [string, ReplaySection[]][] {
  const groups = new Map<string, ReplaySection[]>();
  for (const s of sections) groups.set(s.file, [...(groups.get(s.file) ?? []), s]);
  return [...groups];
}

/** Replay of one of Claude's steps: choose a section of the instructions to leave out, run twice, compare. */
export function ReplayPanel({ url }: { url: string }) {
  const t = texts.sessions.replay;
  const selectId = useId();
  const [options, setOptions] = useState<ReplayOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [section, setSection] = useState('');
  const [run, setRun] = useState<{ busy: boolean; result: ReplayResult | null; error: string | null }>({ busy: false, result: null, error: null });
  const elapsed = useElapsed(run.busy);
  const resultBox = useRef<HTMLDivElement>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch(url).then(
      async (r) => {
        const body = (await r.json().catch(() => ({}))) as ReplayOptions & { error?: string };
        if (r.ok) setOptions(body);
        else setLoadError(body.error ?? `HTTP ${r.status}`);
      },
      (e: Error) => setLoadError(e.message),
    );
    // Closing the panel stops a running replay on the server too.
    return () => pending.current?.abort();
  }, [url]);
  useEffect(() => {
    if (run.result) resultBox.current?.focus();
  }, [run.result]);

  const groups = useMemo(() => byFile(options?.sections ?? []), [options]);

  const start = async () => {
    const abort = new AbortController();
    pending.current = abort;
    setRun({ busy: true, result: null, error: null });
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ section }), signal: abort.signal });
      const body = (await res.json().catch(() => ({}))) as ReplayResult & { error?: string };
      setRun(res.ok ? { busy: false, result: body, error: null } : { busy: false, result: null, error: body.error ?? `HTTP ${res.status}` });
    } catch (e) {
      if (!abort.signal.aborted) setRun({ busy: false, result: null, error: (e as Error).message });
    }
  };

  if (loadError) return <p className="notice error replay-box">{t.loadError(loadError)}</p>;
  if (!options) return <p className="status replay-box">{t.loading}</p>;
  const r = run.result;
  const verdict = r ? compare(r.asIs, r.changed) : null;
  return (
    <div className="replay replay-box">
      <p className="replay-lede">
        {t.lede} {t.cost(options.tokens)}
      </p>
      {options.off ? (
        <p className="notice warn">{options.off}</p>
      ) : !options.sections.length ? (
        <p className="replay-none">{t.noSections}</p>
      ) : (
        <div className="replay-form">
          <label htmlFor={selectId}>{t.leaveOut}</label>
          <select id={selectId} value={section} onChange={(e) => setSection(e.target.value)} disabled={run.busy}>
            <option value="">{t.choose}</option>
            {groups.map(([file, list]) => (
              <optgroup key={file} label={file}>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.heading}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button type="button" className="primary" onClick={start} disabled={!section || run.busy}>
            {r ? t.again : t.run}
          </button>
        </div>
      )}
      {run.busy && (
        <p className="status" role="status">
          {t.running}
          <span aria-hidden="true"> {texts.sessions.timeline.seconds(elapsed)}</span>
        </p>
      )}
      {run.error && (
        <p className="notice error" role="status">
          {t.error(run.error)}
        </p>
      )}
      {r && verdict && (
        <div className="replay-result" ref={resultBox} tabIndex={-1}>
          <p className={`replay-verdict replay-${verdict}`}>{t[verdict](r.section.heading)}</p>
          <div className="replay-grid">
            <section aria-label={t.columns.original}>
              <h3>{t.columns.original}</h3>
              <Actions list={r.original} />
            </section>
            <section aria-label={t.columns.asIs}>
              <h3>{t.columns.asIs}</h3>
              <Actions list={r.asIs} />
            </section>
            <section className={verdict === 'different' ? 'replay-changed' : undefined} aria-label={t.columns.changed}>
              <h3>
                {t.columns.changed}
                {verdict === 'different' && <span className="replay-differs">{t.differs}</span>}
              </h3>
              <Actions list={r.changed} />
            </section>
          </div>
          <p className="replay-foot">{t.foot(r.model, Math.round(r.ms / 1000))}</p>
        </div>
      )}
    </div>
  );
}
