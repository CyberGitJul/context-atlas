import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ActionId } from '../../src/shared/model';
import { skillifyBlock, type ComponentLinks } from '../../src/shared/skill-links';
import { t } from './text';
import type { AlignPair } from './PairReview';
import { ResultView } from './ResultView';

export interface ActionInfo {
  id: ActionId;
  /** The server's label; the page shows the translated label by id instead. */
  label: string;
  model: string;
  inputWords: number;
  /** Uses the router; false = local check, no confirmation needed. */
  ai: boolean;
  available: boolean;
  editableOnly: boolean;
  result: 'classification' | 'proposal' | 'report' | 'testcases' | 'enforce' | 'skillify' | 'align' | 'stale';
}

export interface ClassifyResult {
  kind: string;
  level: 'global' | 'project' | 'skill' | 'hook';
  reason: string;
}

export interface DeterministicResult {
  after: string;
  changes: string[];
}

/** Rough token estimate for the confirmation: about 1.6 tokens per word. */
const tokens = (words: number) => Math.round(words * 1.6);

interface Props {
  componentId: string;
  actions: ActionInfo[];
  /** Current editor text; the action works on it. */
  text: string;
  editable: boolean;
  hasSecrets: boolean;
  /** Saved links of this component; part of the guard against converting twice. */
  links: ComponentLinks;
  onProposal: (p: DeterministicResult, action: ActionInfo) => void;
  /** The align action: two files, reviewed and saved together on the page. */
  onPair: (p: AlignPair) => void;
  /** The editor is locked while an action runs, so a proposal never overwrites typing. */
  onRunningChange?: (running: boolean) => void;
}

/** Manually triggered AI actions with the best model: estimate first, confirm in place, then run. */
export function ActionsPanel({ componentId, actions, text, editable, hasSecrets, links, onProposal, onPair, onRunningChange }: Props) {
  const d = t.detail.panel;
  const [confirming, setConfirming] = useState<ActionInfo | null>(null);
  const [running, setRunning] = useState<ActionInfo | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [outcome, setOutcome] = useState<{ action: ActionInfo; data: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onRunningChange?.(!!running);
  }, [running, onRunningChange]);

  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const start = async (a: ActionInfo) => {
    setConfirming(null);
    setRunning(a);
    setError(null);
    try {
      const r = await fetch(`/api/component/action?id=${encodeURIComponent(componentId)}&action=${a.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string; result?: unknown; pair?: AlignPair['pair'] };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      if (a.result === 'proposal') onProposal(body.result as DeterministicResult, a);
      else if (a.result === 'align') onPair({ ...(body.result as Omit<AlignPair, 'pair'>), pair: body.pair! });
      else setOutcome({ action: a, data: body.result });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(null);
    }
  };

  const disabledReason = (a: ActionInfo): string | null => {
    if (!a.available) return a.ai && !actions.some((x) => x.ai && x.available) ? d.reasonAiOff : d.reasonSoon;
    if (hasSecrets && a.ai) return d.reasonSecrets;
    if (a.editableOnly && !editable) return d.reasonReadOnly;
    // Deterministic guard, also enforced by the server: a second skill next to the first would not know it.
    if (a.id === 'skillify') {
      const block = skillifyBlock(text, links);
      return block ? d.skillifyBlock[block.code](block.names) : null;
    }
    if (a.id === 'align' && links.pointers.filter((p) => p.state === 'ok').length !== 1) return d.reasonAlign;
    return null;
  };

  return (
    <aside className="actions-panel" aria-label={d.title}>
      <h2>{d.title}</h2>
      {!actions.some((a) => a.ai && a.available) && <p className="lede">{d.off}</p>}
      {actions.some((a) => a.ai && a.available) && <p className="lede">{d.on(actions.find((a) => a.ai)?.model ?? '')}</p>}
      <div className="action-list">
        {actions.map((a) => {
          const reason = disabledReason(a);
          return (
            <button
              key={a.id}
              type="button"
              className="action"
              disabled={!!reason || !!running}
              onClick={() => (a.ai ? setConfirming(a) : start(a))}
              title={reason ?? undefined}
            >
              <Sparkles className="icon" aria-hidden="true" />
              <span>{t.actions[a.id]}</span>
              {(reason || !a.ai) && <small>{reason ?? d.noAi}</small>}
            </button>
          );
        })}
      </div>

      {confirming && (
        <div className="confirm" role="alertdialog" aria-labelledby="confirm-text">
          <p id="confirm-text">
            {d.confirm(t.actions[confirming.id], confirming.model, confirming.inputWords, tokens(confirming.inputWords))}
          </p>
          <div className="button-row">
            <button type="button" className="primary" onClick={() => start(confirming)}>
              {d.start}
            </button>
            <button type="button" onClick={() => setConfirming(null)}>
              {d.cancel}
            </button>
          </div>
        </div>
      )}

      {running && (
        <p className="running" role="status">
          {d.running(running.model, t.actions[running.id], elapsed)}
        </p>
      )}
      {error && (
        <p className="notice error" role="status">
          {error}
        </p>
      )}
      {outcome && <ResultView action={outcome.action} data={outcome.data} sourceId={componentId} onProposal={(p) => onProposal(p, outcome.action)} />}

    </aside>
  );
}
