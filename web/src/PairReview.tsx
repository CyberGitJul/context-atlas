import { useState } from 'react';
import { DiffView } from './DiffView';
import { t } from './text';

/** Result of the align action: the new section and SKILL.md, plus what the server knows about the skill. */
export interface AlignPair {
  assessment: string;
  trigger: string;
  instruction: string;
  skill: string;
  changes: string[];
  pair: {
    skillId: string;
    skillName: string;
    skillFile: string | null;
    skillBefore: string;
    /** Pointer lines the proposal dropped and the server put back. */
    restored: string[];
    check: { errors: string[]; warnings: string[] };
  };
}

type PairSaved = { section: { backup: string; commit: string | null; warning: string | null }; skill: { backup: string; commit: string | null; warning: string | null } };

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** Both files of a section and its skill side by side as before/after, saved together or not at all. */
export function PairReview({ sectionId, sectionName, sectionBefore, data, onSaved, onCancel }: {
  sectionId: string;
  sectionName: string;
  /** Saved text of the section (the comparison starts there, unsaved edits included in the proposal). */
  sectionBefore: string;
  data: AlignPair;
  onSaved: (notice: { tone: 'ok' | 'warn'; text: string }) => void;
  onCancel: () => void;
}) {
  const d = t.detail.pair;
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const { pair } = data;
  const blocked = pair.check.errors.length > 0;
  const saved = words(sectionBefore) - words(data.instruction);

  const save = async () => {
    setState({ busy: true, error: null });
    const r = await fetch('/api/pair/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: sectionId, before: sectionBefore, after: data.instruction, skillId: pair.skillId, skillBefore: pair.skillBefore, skillAfter: data.skill }),
    }).catch(() => null);
    if (!r) return setState({ busy: false, error: d.serverDown });
    const body = (await r.json().catch(() => ({}))) as Partial<PairSaved> & { error?: string };
    if (!r.ok || !body.section || !body.skill) return setState({ busy: false, error: body.error ?? `HTTP ${r.status}` });
    const commits = [body.section.commit, body.skill.commit].filter(Boolean);
    const warning = [body.section.warning, body.skill.warning].filter(Boolean).join(' ');
    onSaved({
      tone: warning ? 'warn' : 'ok',
      text: [warning, d.saved(pair.skillName), commits.length ? d.commits(commits.join(', ')) : '', d.backups(body.section.backup, body.skill.backup)].filter(Boolean).join(' '),
    });
  };

  return (
    <div className="pair-review">
      <div className="proposal" role="status">
        <h3>{t.detail.page.proposalTitle(t.actions.align)}</h3>
        <p>{data.assessment}</p>
        <p>
          <strong>{d.trigger}</strong> {data.trigger}
        </p>
        <ul>
          {data.changes.map((ch) => (
            <li key={ch}>{ch}</li>
          ))}
          {pair.restored.length > 0 && <li>{d.restored}</li>}
        </ul>
        <p className="lede">{d.both}</p>
      </div>

      <h3 className="pair-head">
        {d.instruction(sectionName)}
        <small>{saved > 0 ? d.saves(saved) : saved < 0 ? d.longer(-saved) : d.sameLength}</small>
      </h3>
      <DiffView before={sectionBefore} after={data.instruction} />

      <h3 className="pair-head">
        {d.skill} <a href={`#/c/${encodeURIComponent(pair.skillId)}`}>{pair.skillName}</a>
        {pair.skillFile && <small>{pair.skillFile}</small>}
      </h3>
      {blocked && (
        <div className="notice error" role="alert">
          <p>{d.mustFix}</p>
          <ul>
            {pair.check.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {pair.check.warnings.length > 0 && (
        <div className="notice warn" role="note">
          <ul>
            {pair.check.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <DiffView before={pair.skillBefore} after={data.skill} />

      <div className="button-row">
        <button type="button" className="primary" onClick={save} disabled={state.busy || blocked}>
          {state.busy ? d.saving : d.saveBoth}
        </button>
        <button type="button" onClick={onCancel} disabled={state.busy}>
          {d.discard}
        </button>
      </div>
      {state.error && (
        <p className="notice error" role="status">
          {state.error}
        </p>
      )}
    </div>
  );
}
