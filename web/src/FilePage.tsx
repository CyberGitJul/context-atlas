import { ArrowLeft, FilePlus2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { DiffView } from './DiffView';
import { Editor } from './Editor';
import { riskyLines } from '../../src/shared/risky-lines';
import { t } from './text';
import { hrefOf, usePendingProposal, usePublishPage } from './PageContext';

interface FileInfo {
  path: string;
  exists: boolean;
  text: string;
  warning: string | null;
  inRepo: boolean;
}
type Notice = { tone: 'ok' | 'warn' | 'error'; text: string; reload?: boolean };

async function post<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as T & { error?: string } };
}

/** A file proposed in the chat (new or another one): before/after review, then save with backup (and commit inside ~/.claude). */
export function FilePage({ path }: { path: string }) {
  const c = t.create.file;
  const { pending, setPending } = usePendingProposal();
  /** The page the proposal came from (e.g. the CLAUDE.md section); without it, back goes to the overview. */
  const [from, setFrom] = useState<{ href: string; name: string } | null>(null);
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(true);
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** Server rules for this file (SKILL.md: name = folder, description); errors block saving. */
  const [check, setCheck] = useState<{ errors: string[]; warnings: string[] }>({ errors: [], warnings: [] });

  /** keepDraft: after a conflict, show the current file as "before" and keep the proposal. Returns the error, if any. */
  const load = useCallback(
    async (keepDraft = false, quiet = false): Promise<string | null> => {
      const r = await post<FileInfo>('/api/file/preview', { path });
      if (!r.ok) {
        const message = r.body.error ?? `HTTP ${r.status}`;
        if (!quiet) setError(message);
        return message;
      }
      setInfo(r.body);
      if (!keepDraft) setDraft((d) => d ?? r.body.text);
      setVersion((v) => v + 1);
      return null;
    },
    [path],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (draft === null) return;
    const stale = new AbortController();
    const t = setTimeout(() => {
      fetch('/api/file/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, text: draft }), signal: stale.signal })
        .then((r) => (r.ok ? (r.json() as Promise<{ errors: string[]; warnings: string[] }>) : null))
        .then((c) => c && setCheck(c))
        .catch(() => {});
    }, 300);
    return () => (clearTimeout(t), stale.abort());
  }, [path, draft]);

  // A proposal travels from the chat to this page on every click, also when the page is already open.
  useEffect(() => {
    if (pending?.target !== hrefOf({ id: null, file: path })) return;
    setDraft(pending.text);
    setReviewing(true);
    setVersion((v) => v + 1);
    if (pending.from) setFrom(pending.from);
    setNotice(null);
    setPending(null);
  }, [pending, path, setPending]);

  const apply = useCallback((text: string) => {
    setDraft(text);
    setReviewing(true);
    setVersion((v) => v + 1);
  }, []);
  usePublishPage({ id: `file:${path}`, file: path, name: c.pageName(info?.path ?? path), draft: draft ?? undefined, editable: !!info, hasSecrets: false, apply: info ? apply : undefined });

  const save = async () => {
    if (!info || draft === null) return;
    setSaving(true);
    const r = await post<{ backup: string | null; commit: string | null; warning: string | null }>('/api/file/save', { path, before: info.exists ? info.text : null, after: draft }).catch(() => null);
    setSaving(false);
    if (!r) return setNotice({ tone: 'error', text: c.serverDown });
    if (r.status === 409) return setNotice({ tone: 'error', text: r.body.error ?? c.conflict, reload: true });
    if (!r.ok) return setNotice({ tone: 'error', text: r.body.error ?? `HTTP ${r.status}` });
    const parts = [info.exists ? c.saved : c.created];
    if (r.body.commit) parts.push(c.commit(r.body.commit));
    else if (!info.inRepo) parts.push(c.noCommit);
    if (r.body.backup) parts.push(c.backup(r.body.backup));
    setDraft(null);
    // Saved is saved: if the file can no longer be shown here (e.g. it now holds a secret), say so next to the success.
    const after = await load(false, true);
    if (after) {
      setInfo({ ...info, exists: true, text: draft });
      setDraft(draft);
    }
    setNotice({ tone: r.body.warning || after ? 'warn' : 'ok', text: [r.body.warning, parts.join(' '), after && c.reloadFailed(after)].filter(Boolean).join(' ') });
  };

  const back = (
    <a className="back" href={from?.href ?? '#/'}>
      <ArrowLeft className="icon" aria-hidden="true" /> {from ? c.backTo(from.name) : c.backOverview}
    </a>
  );
  if (error) return <main>{back}<p className="notice error">{error}</p></main>;
  if (!info || draft === null) return <main>{back}<p className="status">{c.loading}</p></main>;

  const changed = draft !== info.text || !info.exists;
  // Only what the proposal adds: lines already in the file were reviewed before.
  const risky = riskyLines(draft).filter((r) => !info.text.split('\n').some((l) => l.trim().slice(0, 120) === r.text));
  return (
    <main className="detail">
      {back}
      <header className="detail-head">
        <h1>{info.path}</h1>
        <p className="lede">
          {info.exists ? c.existingProposed : c.newProposed} {info.inRepo ? c.inRepo : c.outsideRepo}
        </p>
      </header>
      {(info.warning || risky.length > 0) && (
        <div className="links warn" role="note">
          <TriangleAlert className="icon" aria-hidden="true" />
          <div>
            {info.warning && <p>{info.warning}</p>}
            {risky.length > 0 && (
              <>
                <p>{c.riskyIntro}</p>
                <ul>
                  {risky.map((r) => (
                    <li key={r.line}>
                      {c.riskyLine(r.line, c.riskyWhy[r.why])}<code>{r.text}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
      {(check.errors.length > 0 || check.warnings.length > 0) && (
        <div className={`links ${check.errors.length ? 'warn' : ''}`} role="note">
          <TriangleAlert className="icon" aria-hidden="true" />
          <div>
            {check.errors.length > 0 && <p>{info.exists ? c.fixBeforeSave : c.fixBeforeCreate}</p>}
            <ul>
              {[...check.errors, ...check.warnings].map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {notice && (
        <p className={`notice ${notice.tone}`} role="status">
          {notice.text}
          {notice.reload && (
            <button type="button" onClick={() => (setNotice(null), void load(true))}>
              {c.reload}
            </button>
          )}
        </p>
      )}
      <section aria-label={c.textLabel} className="file-review">
        {reviewing ? (
          <>
            <DiffView before={info.text} after={draft} />
            <div className="button-row">
              <button type="button" className="primary" onClick={save} disabled={saving || !changed || !draft.trim() || check.errors.length > 0} title={check.errors.length ? c.fixFirst : undefined}>
                {saving ? c.saving : info.exists ? c.save : (
                  <>
                    <FilePlus2 className="icon" aria-hidden="true" /> {c.create}
                  </>
                )}
              </button>
              <button type="button" onClick={() => setReviewing(false)} disabled={saving}>
                {c.keepEditing}
              </button>
              <span className="edit-state">{changed ? (info.exists ? c.unsaved : c.notCreated) : c.unchanged}</span>
            </div>
          </>
        ) : (
          <>
            <Editor value={draft} version={version} readOnly={false} onChange={setDraft} label={c.editorLabel(info.path)} />
            <div className="button-row">
              <button type="button" className="primary" onClick={() => setReviewing(true)}>
                {c.reviewChanges}
              </button>
              <button type="button" onClick={() => (setDraft(info.text), setVersion((v) => v + 1))} disabled={draft === info.text}>
                {c.discard}
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
