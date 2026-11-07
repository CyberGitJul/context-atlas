import { GitBranch } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RepoChange, RepoState } from '../../src/shared/model';
import { pushCommand } from '../../src/shared/push-command';
import { t as texts } from './text';

/** How the server finds the repo again: the component, or the file path the page saved. Never a free path. */
export type RepoTarget = { id: string } | { path: string };

const SHOWN = 8;
const isConflict = (c: RepoChange) => c.status.includes('U') || c.status === 'AA' || c.status === 'DD';
/** Only the file this page is about is ticked at first: other changes in the repo may be someone else's work. */
const preselect = (repo: RepoState) => new Set(repo.file && repo.changes.some((c) => c.path === repo.file && !isConflict(c)) ? [repo.file] : []);

function CopyCommand({ command }: { command: string }) {
  const t = texts.repo;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <code>{command}</code>
      <button type="button" aria-label={t.copyLabel} onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => undefined)}>
        {copied ? t.copied : t.copy}
      </button>
    </>
  );
}

/**
 * A saved file lies in a git repo under PROJECT_ROOTS (a linked rule or skill): what is not committed there yet, with
 * an offer to commit the ticked files, and what is not pushed yet. Nothing shows while the repo is clean and pushed.
 */
export function RepoPanel({ repo: initial, target }: { repo: RepoState; target: RepoTarget }) {
  const t = texts.repo;
  const [repo, setRepo] = useState(initial);
  const [chosen, setChosen] = useState(() => preselect(initial));
  const [hash, setHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState(() => t.defaultMessage([...preselect(initial)]));
  const [typed, setTyped] = useState(false);

  // A newer state from the page (saved again, reloaded) replaces the one shown here.
  useEffect(() => {
    setRepo(initial);
    setChosen(preselect(initial));
    setHash(null);
    setError(null);
  }, [initial]);
  const chosenKey = [...chosen].sort().join('\n');
  useEffect(() => {
    if (!typed) setMessage(t.defaultMessage(chosenKey ? chosenKey.split('\n') : []));
  }, [chosenKey, typed, t]);

  const toggle = (p: string) => setChosen((cur) => (cur.has(p) ? new Set([...cur].filter((x) => x !== p)) : new Set([...cur, p])));

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/repo/commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...target, files: [...chosen], message }) });
      const body = (await r.json().catch(() => ({}))) as { commit?: string; repo?: RepoState | null; error?: string };
      if (body.repo) {
        const left = new Set(body.repo.changes.map((c) => c.path));
        setRepo(body.repo);
        setChosen((cur) => new Set([...cur].filter((p) => left.has(p))));
      }
      if (!r.ok) setError(body.error ?? `HTTP ${r.status}`);
      else {
        setHash(body.commit ?? null);
        setTyped(false);
      }
    } catch {
      setError(t.serverDown);
    }
    setBusy(false);
  };

  const pending = repo.changes.length > 0;
  if (!pending && !repo.ahead && !hash && !error) return null;
  const branch = repo.branch ?? t.detached;
  const item = (c: RepoChange, i: number) => (
    <li key={`${c.path}:${c.status}:${i}`}>
      <label>
        <input type="checkbox" checked={chosen.has(c.path)} onChange={() => toggle(c.path)} disabled={busy || isConflict(c)} />
        <code>{c.path}</code> <span className="muted">{t.status(c.status, c.from)}</span>
      </label>
    </li>
  );
  return (
    <section className="repo" aria-label={t.label(repo.display)}>
      <GitBranch className="icon" aria-hidden="true" />
      <div className="repo-body">
        {/* Present from the start, so the outcome is announced when it appears. */}
        <p role="status" className={hash ? undefined : 'sr-only'}>
          {hash && t.committed(hash)}
        </p>
        {pending && (
          <>
            <p>
              {t.uncommitted(repo.changes.length)} <code>{repo.display}</code> <span className="muted">{repo.branch ? t.onBranch(branch) : branch}</span>
            </p>
            <ul className="repo-files">{repo.changes.slice(0, SHOWN).map(item)}</ul>
            {repo.changes.length > SHOWN && (
              <details>
                <summary>{t.moreFiles(repo.changes.length - SHOWN)}</summary>
                <ul className="repo-files">{repo.changes.slice(SHOWN).map((c, i) => item(c, i + SHOWN))}</ul>
              </details>
            )}
            <label className="field">
              {t.message}
              <input value={message} onChange={(e) => (setMessage(e.target.value), setTyped(true))} disabled={busy} />
            </label>
            <div className="button-row">
              <button type="button" className="primary" onClick={() => void commit()} disabled={busy || !chosen.size || !message.trim()}>
                {busy ? t.committing : t.commit(chosen.size)}
              </button>
              <span className="edit-state">{t.commitNote}</span>
            </div>
          </>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {repo.ahead > 0 && repo.upstream && (
          <p className="repo-push">
            {t.notPushed(repo.ahead, repo.upstream)} <CopyCommand command={pushCommand(repo.display)} />
          </p>
        )}
        {hash && !repo.upstream && repo.branch && <p className="muted">{t.noUpstream(repo.branch)}</p>}
        {repo.behind > 0 && <p className="muted">{t.behind(repo.behind)}</p>}
      </div>
    </section>
  );
}
