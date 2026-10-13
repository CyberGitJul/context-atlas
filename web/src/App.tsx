import { useEffect, useMemo, useState } from 'react';
import { FLOW_STEPS, hookCountsByEvent, stepOf } from '../../src/shared/flow';
import { isNewKind, NEW_KINDS, type AiState, type Component, type Explanation, type Hint, type NewKind, type Overview } from '../../src/shared/model';
import { AlwaysBand } from './AlwaysBand';
import type { CardContext } from './Column';
import { FlowTrack } from './FlowTrack';
import { HintBar } from './HintBar';
import { SequenceView } from './SequenceView';
import { Detail } from './Detail';
import { FilePage } from './FilePage';
import { NewPage } from './NewPage';
import { CondensePage } from './CondensePage';
import { ConflictsPage } from './Conflicts';
import { Plus } from 'lucide-react';
import { ChatPanel, ChatToggle } from './ChatPanel';
import { PageProvider, usePublishPage } from './PageContext';
import { t, type Messages } from './text';

type View = 'overview' | 'sequence';
interface Selection {
  key: string;
  label: string;
  ids: Set<string>;
}

/** Words sent with every message: always-on components (except per-project memory) plus skill and agent descriptions. */
function wordsPerMessage(components: Component[]): number {
  return components
    .filter((c) => c.enabled && c.kind !== 'memory' && (c.phases.includes('always') || c.kind === 'skill' || c.kind === 'agent'))
    .reduce((sum, c) => sum + c.contextWords, 0);
}

function aiStatus(ai: AiState | null, t: Messages): string {
  if (!ai) return '';
  if (!ai.enabled) return ai.off ?? t.ai.off;
  const parts = [`${ai.running ? t.ai.explaining : t.ai.ready}${ai.provider ? ` (${ai.provider})` : ''}`, t.ai.pending(ai.pending)];
  if (ai.failed) parts.push(t.ai.failed(ai.failed));
  return parts.join(', ');
}

function Overview() {
  usePublishPage();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [explanations, setExplanations] = useState<Record<string, Explanation>>({});
  const [ai, setAi] = useState<AiState | null>(null);
  const [view, setView] = useState<View>('overview');
  const [selection, setSelection] = useState<Selection | null>(null);

  useEffect(() => {
    fetch('/api/overview')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(
        (o: Overview) => {
          setOverview(o);
          setExplanations(o.explanations);
          setAi(o.ai);
        },
        (e: Error) => setError(e.message),
      );
  }, []);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('explanation', (ev) => {
      const { explanation } = JSON.parse((ev as MessageEvent).data) as { explanation: Explanation };
      setExplanations((prev) => ({ ...prev, [explanation.hash]: explanation }));
    });
    source.addEventListener('queue', (ev) => {
      const { state } = JSON.parse((ev as MessageEvent).data) as { state: Omit<AiState, 'enabled'> };
      setAi((prev) => ({ ...prev, enabled: prev?.enabled ?? true, ...state }));
    });
    return () => source.close();
  }, []);

  const derived = useMemo(() => {
    if (!overview) return null;
    const always: Component[] = [];
    const byStep = new Map<string, Component[]>(FLOW_STEPS.map((s) => [s.id, []]));
    for (const c of overview.components) {
      if (c.kind === 'plugin') continue;
      const step = stepOf(c);
      if (step) byStep.get(step.id)!.push(c);
      else if (c.phases.includes('always')) always.push(c);
    }
    return { always, byStep, counts: hookCountsByEvent(overview.components) };
  }, [overview]);

  if (error) return <p className="status">{t.overview.loadError(error)}</p>;
  if (!overview || !derived) return <p className="status">{t.overview.loading}</p>;

  const toggle = (next: Selection) => setSelection((cur) => (cur?.key === next.key ? null : next));
  const selectHint = (h: Hint | null) => (h ? toggle({ key: `hint:${h.id}`, label: h.text, ids: new Set(h.componentIds) }) : setSelection(null));
  const selectEvent = (event: string) => {
    const ids = overview.components.filter((c) => c.kind === 'hook' && c.detail.event === event).map((c) => c.id);
    toggle({ key: `event:${event}`, label: t.overview.hooksAt(event), ids: new Set(ids) });
    setView('overview');
  };

  const ctx: CardContext = {
    explanations,
    explaining: !!ai?.enabled,
    failedHashes: new Set(ai?.failedHashes ?? []),
    hints: overview.hints,
    highlight: selection?.ids ?? null,
  };
  const plugins = overview.components.filter((c) => c.kind === 'plugin');
  const skills = overview.components.filter((c) => c.kind === 'skill');

  return (
    <main>
      <header className="top">
        <div>
          <h1>{t.overview.title}</h1>
          <p className="lede">{t.overview.lede(overview.components.length, wordsPerMessage(overview.components))}</p>
          <p className="lede">
            {t.overview.plugins(
              plugins
                .filter((p) => p.enabled)
                .map((p) => p.name.split('@')[0])
                .join(', '),
            )}
          </p>
        </div>
        <div className="top-side">
          <nav className="top-new" aria-label={t.overview.create}>
            <span className="top-new-label">
              <Plus className="icon" aria-hidden="true" /> {t.overview.create}
            </span>
            {NEW_KINDS.map((k) => (
              <a key={k} href={`#/new/${k}`}>
                {t.overview.newKinds[k]}
              </a>
            ))}
          </nav>
          <div className="segmented" role="group" aria-label={t.overview.view}>
            <button type="button" aria-pressed={view === 'overview'} onClick={() => setView('overview')}>
              {t.overview.viewOverview}
            </button>
            <button type="button" aria-pressed={view === 'sequence'} onClick={() => setView('sequence')}>
              {t.overview.viewSequence}
            </button>
            <a href="#/conflicts">{t.overview.viewConflicts}</a>
          </div>
          <p className="ai-status" role="status">
            {aiStatus(ai, t)}
          </p>
        </div>
      </header>

      <HintBar hints={overview.hints} selected={selection?.key.startsWith('hint:') ? selection.key.slice(5) : null} onSelect={selectHint} />
      {selection && (
        <div className="selection" role="status">
          <span>{t.overview.highlighted(selection.label)}</span>
          <button type="button" onClick={() => setSelection(null)}>
            {t.overview.clearHighlight}
          </button>
        </div>
      )}

      {view === 'sequence' ? (
        <SequenceView counts={derived.counts} onEvent={selectEvent} />
      ) : (
        <>
          <AlwaysBand components={derived.always} skills={skills} ctx={ctx} />
          <FlowTrack
            byStep={derived.byStep}
            counts={derived.counts}
            selectedEvent={selection?.key.startsWith('event:') ? selection.key.slice(6) : null}
            onEvent={selectEvent}
            ctx={ctx}
          />
        </>
      )}
    </main>
  );
}

function currentRoute(): { detail: string | null; file: string | null; create: NewKind | null; condense: boolean; conflicts: boolean } {
  const c = location.hash.match(/^#\/c\/(.+)$/);
  const f = location.hash.match(/^#\/f\/(.+)$/);
  // A hand-typed or broken link must not blank the whole app.
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return null;
    }
  };
  const n = location.hash.match(/^#\/new\/([a-z]+)$/)?.[1];
  return { detail: c ? decode(c[1]) : null, file: f ? decode(f[1]) : null, create: isNewKind(n) ? n : null, condense: location.hash === '#/condense', conflicts: location.hash === '#/conflicts' };
}

const CHAT_OPEN_KEY = 'atlas.chat-open';
const LEGACY_CHAT_OPEN_KEY = 'lce.chat-open';

function readChatOpen(): boolean {
  try {
    return (localStorage.getItem(CHAT_OPEN_KEY) ?? localStorage.getItem(LEGACY_CHAT_OPEN_KEY)) === '1';
  } catch {
    return false;
  }
}

/** Hash routes: #/ overview, #/c/<id> detail page, #/f/<path> file proposed in the chat, #/new/<kind> create a skill, rule, agent or command, #/condense, #/conflicts. The chat stays mounted across pages. */
export function App() {
  const [route, setRoute] = useState(currentRoute);
  const [chatOpen, setChatOpen] = useState(readChatOpen);
  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    document.body.classList.toggle('chat-open', chatOpen);
    try {
      localStorage.setItem(CHAT_OPEN_KEY, chatOpen ? '1' : '0');
    } catch {
      // Remembering the panel is a convenience only.
    }
  }, [chatOpen]);
  return (
    <PageProvider>
      {route.detail ? (
        <Detail key={route.detail} id={route.detail} />
      ) : route.file ? (
        <FilePage key={route.file} path={route.file} />
      ) : route.condense ? (
        <CondensePage />
      ) : route.conflicts ? (
        <ConflictsPage />
      ) : route.create ? (
        <NewPage key={route.create} kind={route.create} onOpenChat={() => setChatOpen(true)} />
      ) : (
        <Overview />
      )}
      {/* Stays mounted while closed, so closing the panel keeps the conversation. */}
      <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />
      {!chatOpen && <ChatToggle onOpen={() => setChatOpen(true)} />}
    </PageProvider>
  );
}
