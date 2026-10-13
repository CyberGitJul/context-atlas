import { Component as ReactComponent, useState, type ReactElement, type ReactNode } from 'react';
import { pointOnlyTo } from '../../src/shared/skill-links';
import { t } from './text';
import type { ActionInfo, ClassifyResult } from './ActionsPanel';

interface Finding {
  type: 'contradiction' | 'duplicate';
  title: string;
  otherId: string;
  otherName: string;
  quoteHere: string;
  quoteThere: string;
  suggestion: string;
}

function Classification({ r }: { r: ClassifyResult }) {
  const d = t.detail.result;
  return (
    <>
      <p>
        <strong>{d.kinds[r.kind] ?? r.kind}</strong>, {d.location}: {d.levels[r.level] ?? r.level}
      </p>
      <p>{r.reason}</p>
    </>
  );
}

function Report({ r }: { r: { summary: string; findings: Finding[] } }) {
  const d = t.detail.result;
  return (
    <>
      <p>{r.summary}</p>
      {r.findings.length > 0 && (
        <ul className="findings">
          {r.findings.map((f, i) => (
            <li key={i} className={`finding ${f.type === 'contradiction' ? 'warn' : f.type}`}>
              <p className="finding-head">
                <span className="tag">{f.type === 'contradiction' ? d.contradiction : d.duplicate}</span> {f.title}
              </p>
              <blockquote>{d.here(f.quoteHere)}</blockquote>
              <blockquote>
                <a href={`#/c/${encodeURIComponent(f.otherId)}`}>{f.otherName}</a>: „{f.quoteThere}“
              </blockquote>
              <p>
                <strong>{d.proposal}</strong> {f.suggestion}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export interface EnforceItem {
  rule: string;
  mechanism: 'hook' | 'permission' | 'not-enforceable';
  how: string;
  draft: string;
  limits: string;
}

interface StaleFinding {
  kind: 'path' | 'name';
  ref: string;
  problem: string;
  level: 'error' | 'note';
}

function Testcases({ r }: { r: { shouldTrigger: string[]; shouldNotTrigger: string[]; notes: string } }) {
  const d = t.detail.result;
  return (
    <>
      <h4>{d.shouldTrigger}</h4>
      <ul>
        {r.shouldTrigger.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <h4>{d.shouldNotTrigger}</h4>
      <ul>
        {r.shouldNotTrigger.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      {r.notes && <p className="lede">{r.notes}</p>}
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const d = t.detail.result;
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      onClick={() => navigator.clipboard.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))}
    >
      {done ? d.copied : d.copy}
    </button>
  );
}

export function Enforce({ r }: { r: { summary: string; items: EnforceItem[] } }) {
  const d = t.detail.result;
  return (
    <>
      <p>{r.summary}</p>
      <ul className="findings">
        {r.items.map((it, i) => (
          <li key={i} className={`finding ${it.mechanism === 'not-enforceable' ? '' : 'enforceable'}`}>
            <p className="finding-head">
              <span className="tag">{d.mechanisms[it.mechanism] ?? it.mechanism}</span> {it.rule}
            </p>
            <p>{it.how}</p>
            {it.draft && (
              <div className="draft">
                <CopyButton text={it.draft} />
                <pre>{it.draft}</pre>
              </div>
            )}
            <p className="lede">{d.limits}: {it.limits}</p>
          </li>
        ))}
      </ul>
      <p className="lede">{d.draftsOnly}</p>
    </>
  );
}

function Stale({ r }: { r: { checked: number; findings: StaleFinding[] } }) {
  const d = t.detail.result;
  if (!r.findings.length) return <p>{d.staleNone(r.checked)}</p>;
  return (
    <>
      <p>
        {d.staleSome(r.findings.length, r.checked)}
      </p>
      <ul className="findings">
        {r.findings.map((f) => (
          <li key={f.ref} className={`finding ${f.level === 'error' ? 'warn' : ''}`}>
            <p className="finding-head">
              <span className="tag">{f.level === 'error' ? d.staleError : d.staleNote}</span> <code>{f.ref}</code>
            </p>
            <p>{f.problem}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

interface SkillifyResult {
  skillName: string;
  description: string;
  body: string;
  remainingText: string;
  changes: string[];
}

function Skillify({ r, sourceId, onProposal }: { r: SkillifyResult; sourceId?: string; onProposal?: (p: { after: string; changes: string[] }) => void }) {
  const d = t.detail.result;
  const [name, setName] = useState(r.skillName);
  const [state, setState] = useState<{ busy: boolean; error: string | null; created: string | null }>({ busy: false, error: null, created: null });
  const create = async () => {
    setState({ busy: true, error: null, created: null });
    const res = await fetch('/api/skill/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, description: r.description, body: r.body, sourceId }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; commit?: string | null; warning?: string | null };
    if (!res.ok) return setState({ busy: false, error: body.error ?? `HTTP ${res.status}`, created: null });
    setState({ busy: false, error: body.warning ?? null, created: body.commit ? d.createdWith(body.commit) : d.createdWithout });
    // The pointer line in the fixed form is what later locks this section against a second conversion.
    onProposal?.({ after: pointOnlyTo(r.remainingText, name), changes: [d.moved(name), ...r.changes] });
  };
  return (
    <>
      <label className="field">
        {d.skillName}
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={!!state.created} />
      </label>
      <h4>{d.skillDescription}</h4>
      <p>{r.description}</p>
      <h4>{d.skillBody}</h4>
      <pre className="raw">{r.body}</pre>
      <h4>{d.skillRemaining}</h4>
      <pre className="raw">{name.trim() ? pointOnlyTo(r.remainingText, name.trim()) : r.remainingText}</pre>
      {state.created ? (
        <p className="notice ok">{d.created(state.created)}</p>
      ) : (
        <div className="button-row">
          <button type="button" className="primary" onClick={create} disabled={state.busy}>
            {state.busy ? d.creating : d.create}
          </button>
        </div>
      )}
      {state.error && <p className="notice warn">{state.error}</p>}
    </>
  );
}

/** Keeps the page usable if an AI result has an unexpected shape. */
class ResultBoundary extends ReactComponent<{ children: ReactNode; message: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <p className="notice error">{this.props.message}</p> : this.props.children;
  }
}

/** Renders an action result by its kind (proposals go to the before/after review instead). */
export function ResultView({ action, data, sourceId, onProposal }: { action: ActionInfo; data: unknown; sourceId?: string; onProposal?: (p: { after: string; changes: string[] }) => void }) {
  let body: ReactElement;
  switch (action.result) {
    case 'classification':
      body = <Classification r={data as ClassifyResult} />;
      break;
    case 'report':
      body = <Report r={data as { summary: string; findings: Finding[] }} />;
      break;
    case 'testcases':
      body = <Testcases r={data as { shouldTrigger: string[]; shouldNotTrigger: string[]; notes: string }} />;
      break;
    case 'enforce':
      body = <Enforce r={data as { summary: string; items: EnforceItem[] }} />;
      break;
    case 'skillify':
      body = <Skillify r={data as SkillifyResult} sourceId={sourceId} onProposal={onProposal} />;
      break;
    case 'stale':
      body = <Stale r={data as { checked: number; findings: StaleFinding[] }} />;
      break;
    default:
      body = <pre className="raw">{JSON.stringify(data, null, 2)}</pre>;
  }
  return (
    <div className="result" role="status">
      <h3>{t.actions[action.id]}</h3>
      <ResultBoundary message={t.detail.result.badShape}>{body}</ResultBoundary>
    </div>
  );
}
