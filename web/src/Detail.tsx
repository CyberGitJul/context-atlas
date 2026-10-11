import { ArrowLeft, Link2, Lock, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { stepOf } from '../../src/shared/flow';
import type { ComponentText } from '../../src/shared/model';
import { maskedCount } from '../../src/shared/chat-proposals';
import { keepPointers, retargetPointer, skillPointers, type ComponentLinks, type SkillLink } from '../../src/shared/skill-links';
import { t, type Messages } from './text';
import { ActionsPanel, type ActionInfo, type DeterministicResult } from './ActionsPanel';
import { DiffView } from './DiffView';
import { PairReview, type AlignPair } from './PairReview';
import { hrefOf, usePendingProposal, usePublishPage } from './PageContext';
import { Editor } from './Editor';

type DetailData = ComponentText & { actions: ActionInfo[]; links: ComponentLinks };
type SaveResponse = { ok: true; backup: string; commit: string | null; commitStatus: 'committed' | 'unchanged' | 'ignored' | 'secret' | 'failed' | 'none'; warning: string | null; repoCreated: boolean };
type Notice = { tone: 'ok' | 'warn' | 'error'; text: string; reload?: boolean };

function whenLabel(text: ComponentText, t: Messages): string {
  const step = stepOf(text.component);
  if (step) return t.flow.steps[step.id].label;
  return text.component.phases.includes('always') ? t.band.title : t.detail.page.whenNone;
}

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

async function errorText(r: Response): Promise<string> {
  return ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`;
}

/** A broken pointer: why Claude cannot follow it, and a deterministic correction (shown in the comparison, saved as usual). */
function BrokenPointer({ link, choices, editable, onFix }: { link: SkillLink; choices: string[]; editable: boolean; onFix: (to: string) => void }) {
  const d = t.detail.broken;
  const [to, setTo] = useState(link.suggestion ?? choices[0] ?? '');
  const why = link.state === 'missing' ? d.missing : d.disabled;
  return (
    <div className="links warn" role="note">
      <TriangleAlert className="icon" aria-hidden="true" />
      <div>
        <p>
          {d.before} <code>{link.name}</code> {d.after(why)}
        </p>
        {link.suggestion && (
          <p className="lede">
            {d.suggestion} <code>{link.suggestion}</code>
            {d.suggestionAfter}
          </p>
        )}
        {editable && choices.length > 0 && (
          <div className="button-row">
            <label className="inline-field">
              {d.newTarget}
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                {choices.map((n) => (
                  <option key={n} value={n}>
                    {n}
                    {n === link.suggestion ? d.suggestionOption : ''}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => onFix(to)} disabled={!to}>
              {d.change}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Detail page of one component: editor, review of changes as before/after, save with backup and commit. */
export function Detail({ id }: { id: string }) {
  const kinds = t.kinds;
  const d = t.detail.page;
  const [data, setData] = useState<DetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [version, setVersion] = useState(0);
  const [proposal, setProposal] = useState<(DeterministicResult & { label: string; savedWords: number | null }) | null>(null);

  const [actionRunning, setActionRunning] = useState(false);
  const [pair, setPair] = useState<AlignPair | null>(null);

  /** A chat proposal goes into the same before/after review as the quick actions. */
  const applyChat = useCallback(
    (text: string) => {
      // In the chat the user may cut a link on purpose, so a dropped pointer line is only pointed out, not restored.
      const dropped = keepPointers(draft, text).restored;
      const changes = [d.chatApplied];
      if (dropped.length) changes.push(d.chatDropped(dropped.join(', ')));
      setProposal({ after: text, changes, label: d.chatLabel, savedWords: null });
      setDraft(text);
      setReviewing(true);
    },
    [draft, d],
  );
  // A proposal written on this page, opened in the chat while on another page: into the review once the text is loaded.
  const { pending, setPending } = usePendingProposal();
  useEffect(() => {
    if (!data || pending?.target !== hrefOf({ id })) return;
    setPending(null);
    if (data.editable && !data.hasSecrets && maskedCount(pending.text) > maskedCount(draft))
      setNotice({ tone: 'error', text: d.chatMasked });
    else if (data.editable && !data.hasSecrets) applyChat(pending.text);
    else setNotice({ tone: 'error', text: d.chatBlocked(data.hasSecrets ? d.reasonSecrets : d.reasonReadOnly) });
  }, [data, pending, id, applyChat, setPending, draft, d]);
  usePublishPage(
    data
      ? { id, name: data.component.name, draft, editable: data.editable && !actionRunning, hasSecrets: data.hasSecrets, apply: data.editable ? applyChat : undefined }
      : { id, name: d.loading, editable: false, hasSecrets: false },
  );

  /** keepDraft: after a conflict, take the current file as new "before" and show the own change again in the comparison. */
  const load = useCallback(
    (keepDraft = false) => {
      setError(null);
      fetch(`/api/component?id=${encodeURIComponent(id)}`)
        .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(await errorText(r)))))
        .then(
          (t: DetailData) => {
            setData(t);
            if (keepDraft) {
              setReviewing(true);
              return;
            }
            setDraft(t.text);
            setReviewing(false);
            setProposal(null);
            setPair(null);
            setVersion((v) => v + 1);
          },
          (e: Error) => setError(e.message),
        );
    },
    [id],
  );

  useEffect(() => {
    setData(null);
    setNotice(null);
    load();
  }, [load]);

  const save = async () => {
    if (!data) return;
    setSaving(true);
    let r: Response;
    try {
      r = await fetch(`/api/component/save?id=${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ before: data.text, after: draft }),
      });
    } catch {
      setSaving(false);
      return setNotice({ tone: 'error', text: d.serverDown });
    }
    setSaving(false);
    if (r.status === 409) return setNotice({ tone: 'error', text: await errorText(r), reload: true });
    if (!r.ok) return setNotice({ tone: 'error', text: await errorText(r) });
    const res = (await r.json()) as SaveResponse;
    const parts = [d.saved];
    if (res.repoCreated) parts.push(d.repoCreated);
    if (res.commit) parts.push(d.commit(res.commit));
    else if (res.commitStatus === 'unchanged') parts.push(d.commitUnchanged);
    else if (res.commitStatus === 'ignored') parts.push(d.commitIgnored);
    else if (!data.inRepo) parts.push(d.outsideClaude);
    parts.push(d.backup(res.backup));
    setNotice({ tone: res.warning ? 'warn' : 'ok', text: [res.warning, parts.join(' ')].filter(Boolean).join(' ') });
    load();
  };

  const back = (
    <a className="back" href="#/">
      <ArrowLeft className="icon" aria-hidden="true" /> {d.back}
    </a>
  );
  if (error) return <main>{back}<p className="status">{error}</p></main>;
  if (!data) return <main>{back}<p className="status">{d.loading}</p></main>;

  const c = data.component;
  const changed = draft !== data.text;
  return (
    <main className="detail">
      {back}
      <header className="detail-head">
        <h1>{c.name}</h1>
        <p className="lede">
          {d.lede(kinds[c.kind], c.origin.type === 'plugin' ? d.originPlugin(c.origin.plugin) : c.origin.type === 'live' ? d.originLive : d.originOwn, whenLabel(data, t))}
        </p>
        {data.file && <p className="path">{data.file}</p>}
      </header>
      {data.links.pointers.map((l) =>
        l.state === 'ok' ? (
          <p key={l.name} className="links" role="note">
            <Link2 className="icon" aria-hidden="true" />
            <span>
              {d.belongsTo} <a href={`#/c/${encodeURIComponent(l.skillId!)}`}>{l.name}</a>
              {d.belongsToAfter(t.actions.skillify)}
            </span>
          </p>
        ) : (
          <BrokenPointer
            key={l.name}
            link={l}
            choices={data.links.choices}
            // The fix works on the editor text; once the line is gone there, there is nothing to retarget.
            editable={data.editable && !reviewing && skillPointers(draft).includes(l.name)}
            onFix={(to) => {
              const after = retargetPointer(draft, l.name, to);
              setProposal({ after, changes: [d.pointerChanged(l.name, to)], label: t.detail.broken.change, savedWords: null });
              setDraft(after);
              setReviewing(true);
            }}
          />
        ),
      )}
      {data.links.referencedBy.length > 0 && (
        <p className="links" role="note">
          <Link2 className="icon" aria-hidden="true" />
          <span>
            {d.pointedBy}{' '}
            {data.links.referencedBy.map((r, i) => (
              <span key={r.id}>
                {i > 0 && ', '}
                <a href={`#/c/${encodeURIComponent(r.id)}`}>{r.name}</a>
              </span>
            ))}
            {d.pointedByAfter}
          </span>
        </p>
      )}
      {!data.editable && data.readOnlyReason && (
        <p className="readonly" role="note">
          <Lock className="icon" aria-hidden="true" /> {data.readOnlyReason}
        </p>
      )}
      {notice && (
        <p className={`notice ${notice.tone}`} role="status">
          {notice.text}
          {notice.reload && (
            <button type="button" onClick={() => (setNotice(null), load(true))}>
              {d.reload}
            </button>
          )}
        </p>
      )}
      <div className="detail-grid">
        <section aria-label={d.textSection}>
          {pair ? (
            <PairReview
              sectionId={id}
              sectionName={c.name}
              sectionBefore={data.text}
              data={pair}
              onCancel={() => setPair(null)}
              onSaved={(n) => {
                setPair(null);
                setNotice(n);
                load();
              }}
            />
          ) : reviewing ? (
            <>
              {proposal && (
                <div className="proposal" role="status">
                  <h3>{d.proposalTitle(proposal.label)}</h3>
                  {proposal.savedWords !== null && (
                    <p>
                      {d.saves(proposal.savedWords, c.phases.includes('always'))}
                    </p>
                  )}
                  <ul>
                    {proposal.changes.map((ch) => (
                      <li key={ch}>{ch}</li>
                    ))}
                  </ul>
                  <p className="lede">{d.reviewHint}</p>
                </div>
              )}
              <DiffView before={data.text} after={draft} />
              <div className="button-row">
                <button type="button" className="primary" onClick={save} disabled={saving}>
                  {saving ? d.saving : d.save}
                </button>
                <button type="button" onClick={() => setReviewing(false)} disabled={saving}>
                  {d.keepEditing}
                </button>
              </div>
            </>
          ) : (
            <>
              <Editor value={draft} version={version} readOnly={!data.editable || actionRunning} onChange={setDraft} label={d.editorLabel(c.name)} />
              {actionRunning && <p className="edit-state">{d.locked}</p>}
              {data.editable && (
                <div className="button-row">
                  <button type="button" className="primary" disabled={!changed} onClick={() => setReviewing(true)}>
                    {d.reviewChanges}
                  </button>
                  <button type="button" disabled={!changed} onClick={() => (setDraft(data.text), setProposal(null), setVersion((v) => v + 1))}>
                    {d.discard}
                  </button>
                  <span className="edit-state">{changed ? d.unsaved : d.unchanged}</span>
                </div>
              )}
            </>
          )}
        </section>
        <ActionsPanel
          componentId={id}
          actions={data.actions}
          text={draft}
          editable={data.editable}
          hasSecrets={data.hasSecrets}
          links={data.links}
          onRunningChange={setActionRunning}
          onPair={setPair}
          onProposal={(p, action) => {
            // An action never cuts the link to a skill on the side: a dropped pointer line comes back.
            const kept = keepPointers(draft, p.after);
            const changes = kept.restored.length ? [...p.changes, d.pointerRestored(kept.restored.join(', '))] : p.changes;
            setProposal({ after: kept.text, changes, label: t.actions[action.id], savedWords: action.id === 'shorten' ? words(data.text) - words(kept.text) : null });
            setDraft(kept.text);
            setReviewing(true);
          }}
        />
      </div>
    </main>
  );
}
