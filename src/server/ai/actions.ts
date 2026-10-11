import type { ActionId, Component, Kind } from '../../shared/model.js';
import { redact } from '../redact.js';
import { msg } from '../messages/index.js';
import { wordCount } from '../scan/context.js';
import { personalAddition, readPrompt, withAddition } from './prompts.js';
import type { RouterJsonClient } from './router-client.js';

export type { ActionId };
export type ResultKind = 'classification' | 'proposal' | 'report' | 'testcases' | 'enforce' | 'skillify' | 'align' | 'stale';

export interface ActionDef {
  id: ActionId;
  label: string;
  result: ResultKind;
  /** Uses the router (best model, manual, estimate first); false = local check without AI. */
  ai: boolean;
  /** Sends the other active sources along (contradictions, precedence). */
  context: boolean;
  /** Produces a new text and therefore needs an editable component. */
  editableOnly: boolean;
  /** Offered only for these kinds (all when absent). */
  kinds?: Kind[];
}

/** The quick actions: the 10 of spec §6, plus the align-with-skill action next to convert-to-skill. */
export const ACTION_DEFS: ActionDef[] = [
  { id: 'classify', label: 'Classify', result: 'classification', ai: true, context: false, editableOnly: false },
  { id: 'deterministic', label: 'Make it deterministic', result: 'proposal', ai: true, context: false, editableOnly: true },
  { id: 'enforce', label: 'Enforce instead of ask', result: 'enforce', ai: true, context: false, editableOnly: false },
  { id: 'contradictions', label: 'Contradictions & duplicates', result: 'report', ai: true, context: true, editableOnly: false },
  { id: 'precedence', label: 'Clarify precedence', result: 'proposal', ai: true, context: true, editableOnly: true },
  { id: 'skillify', label: 'Convert to skill', result: 'skillify', ai: true, context: false, editableOnly: true },
  { id: 'align', label: 'Align with skill', result: 'align', ai: true, context: false, editableOnly: true, kinds: ['instruction', 'rule'] },
  { id: 'shorten', label: 'Shorten', result: 'proposal', ai: true, context: false, editableOnly: true },
  { id: 'stale', label: 'Find outdated parts', result: 'stale', ai: false, context: false, editableOnly: false },
  { id: 'testcases', label: 'Generate test cases', result: 'testcases', ai: true, context: false, editableOnly: false },
  { id: 'rationale', label: 'Add reason & example', result: 'proposal', ai: true, context: false, editableOnly: true },
];

export interface ClassifyResult {
  kind: string;
  level: 'global' | 'project' | 'skill' | 'hook';
  reason: string;
}

export interface ProposalResult {
  after: string;
  changes: string[];
}

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: { after: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } } },
  required: ['after', 'changes'],
  additionalProperties: false,
};

/** JSON schemas of the AI actions that are implemented. */
export const SCHEMAS: Partial<Record<ActionId, object>> = {
  classify: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['process', 'style', 'tool-routing', 'security', 'project-knowledge', 'other'] },
      level: { type: 'string', enum: ['global', 'project', 'skill', 'hook'] },
      reason: { type: 'string' },
    },
    required: ['kind', 'level', 'reason'],
    additionalProperties: false,
  },
  deterministic: PROPOSAL_SCHEMA,
  precedence: PROPOSAL_SCHEMA,
  contradictions: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['contradiction', 'duplicate'] },
            title: { type: 'string' },
            otherId: { type: 'string' },
            otherName: { type: 'string' },
            quoteHere: { type: 'string' },
            quoteThere: { type: 'string' },
            suggestion: { type: 'string' },
          },
          required: ['type', 'title', 'otherId', 'otherName', 'quoteHere', 'quoteThere', 'suggestion'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'findings'],
    additionalProperties: false,
  },
  shorten: PROPOSAL_SCHEMA,
  rationale: PROPOSAL_SCHEMA,
  skillify: {
    type: 'object',
    properties: {
      skillName: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' },
      description: { type: 'string' },
      body: { type: 'string' },
      remainingText: { type: 'string' },
      changes: { type: 'array', items: { type: 'string' } },
    },
    required: ['skillName', 'description', 'body', 'remainingText', 'changes'],
    additionalProperties: false,
  },
  align: {
    type: 'object',
    properties: {
      assessment: { type: 'string' },
      trigger: { type: 'string' },
      instruction: { type: 'string' },
      skill: { type: 'string' },
      changes: { type: 'array', items: { type: 'string' } },
    },
    required: ['assessment', 'trigger', 'instruction', 'skill', 'changes'],
    additionalProperties: false,
  },
  testcases: {
    type: 'object',
    properties: {
      shouldTrigger: { type: 'array', items: { type: 'string' } },
      shouldNotTrigger: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
    },
    required: ['shouldTrigger', 'shouldNotTrigger', 'notes'],
    additionalProperties: false,
  },
  enforce: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            rule: { type: 'string' },
            mechanism: { type: 'string', enum: ['hook', 'permission', 'not-enforceable'] },
            how: { type: 'string' },
            draft: { type: 'string' },
            limits: { type: 'string' },
          },
          required: ['rule', 'mechanism', 'how', 'draft', 'limits'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'items'],
    additionalProperties: false,
  },
};

/** Required fields per result kind; arrays must be arrays, the rest strings. */
const REQUIRED: Record<ResultKind, Record<string, 'string' | 'array'>> = {
  classification: { kind: 'string', level: 'string', reason: 'string' },
  proposal: { after: 'string', changes: 'array' },
  report: { summary: 'string', findings: 'array' },
  testcases: { shouldTrigger: 'array', shouldNotTrigger: 'array', notes: 'string' },
  enforce: { summary: 'string', items: 'array' },
  skillify: { skillName: 'string', description: 'string', body: 'string', remainingText: 'string', changes: 'array' },
  align: { assessment: 'string', trigger: 'string', instruction: 'string', skill: 'string', changes: 'array' },
  stale: { findings: 'array' },
};

/** Required string fields of list entries; other lists must hold strings. */
const ITEM_FIELDS: Partial<Record<ResultKind, Record<string, string[]>>> = {
  report: { findings: ['type', 'title', 'otherId', 'otherName', 'quoteHere', 'quoteThere', 'suggestion'] },
  enforce: { items: ['rule', 'mechanism', 'how', 'draft', 'limits'] },
};

export function validateResult(def: ActionDef, value: unknown): string | null {
  const v = (value ?? {}) as Record<string, unknown>;
  const missing = Object.entries(REQUIRED[def.result])
    .filter(([key, type]) => (type === 'array' ? !Array.isArray(v[key]) : typeof v[key] !== 'string'))
    .map(([key]) => key);
  for (const [key, type] of Object.entries(REQUIRED[def.result])) {
    if (type !== 'array' || !Array.isArray(v[key])) continue;
    const fields = ITEM_FIELDS[def.result]?.[key];
    const broken = (v[key] as unknown[]).some((item) =>
      fields ? typeof item !== 'object' || item === null || fields.some((f) => typeof (item as Record<string, unknown>)[f] !== 'string') : typeof item !== 'string' && def.result !== 'stale',
    );
    if (broken) missing.push(msg.app.action.items(key));
  }
  return missing.length ? msg.app.action.incompleteFields(missing.join(', ')) : null;
}

export interface ActionConfig {
  model: string;
  /** Folder with one generic prompt file per action (config/prompts/<id>.md). */
  promptsDir: string;
  /** Personal config root whose prompts/ override the generic ones (see prompts.ts); absent: generic only. */
  personalDir?: string | null;
}

export function actionDef(id: string): ActionDef | undefined {
  return ACTION_DEFS.find((a) => a.id === id);
}

/** AI actions are available when their schema exists; local checks are listed in LOCAL_ACTIONS. */
export const LOCAL_ACTIONS = new Set<ActionId>(['stale']);
export function isAvailable(def: ActionDef): boolean {
  return def.ai ? def.id in SCHEMAS : LOCAL_ACTIONS.has(def.id);
}

/** The action's prompt (own version or generic), with the personal addition after it. */
export async function loadActionPrompt(cfg: Pick<ActionConfig, 'promptsDir' | 'personalDir'>, id: ActionId): Promise<string> {
  const dirs = { generic: cfg.promptsDir, personal: cfg.personalDir };
  const [prompt, addition] = await Promise.all([readPrompt(dirs, `${id}.md`), personalAddition(dirs)]);
  return withAddition(prompt.text, addition.text);
}

/** The second text of a two-file action: the skill a section points to. */
export interface PairedText {
  component: Component;
  text: string;
}

/** User prompt: what the component is, then its text (secrets masked), then the paired skill or other sources. */
export function buildActionPrompt(c: Component, text: string, context?: string, paired?: PairedText): string {
  const origin = c.origin.type === 'plugin' ? `Plugin ${c.origin.plugin}` : c.origin.type === 'live' ? 'live only' : 'own';
  const parts = [`Component: ${c.kind} “${redact(c.name)}” (${origin}, file ${redact(c.sourcePath ?? '–')})`, '', 'Text:', redact(text)];
  if (paired) parts.push('', `Linked skill “${redact(paired.component.name)}” (file ${redact(paired.component.sourcePath ?? '–')}):`, redact(paired.text));
  if (context) parts.push('', 'Other active sources (for comparison):', context);
  return parts.join('\n');
}

const offeredFor = (d: ActionDef, c: Component) => !d.kinds || d.kinds.includes(c.kind);

export interface ActionEstimate {
  id: ActionId;
  label: string;
  model: string;
  inputWords: number;
  ai: boolean;
  available: boolean;
  editableOnly: boolean;
  result: ResultKind;
}

/** Without router key only local actions are available. */
export function localOnlyEstimates(c: Component): ActionEstimate[] {
  return ACTION_DEFS.filter((d) => offeredFor(d, c)).map((d) => ({ id: d.id, label: d.label, model: '', inputWords: 0, ai: d.ai, available: !d.ai && isAvailable(d), editableOnly: d.editableOnly, result: d.result }));
}

export async function estimateActions(c: Component, text: string, cfg: ActionConfig, context?: string, paired?: PairedText): Promise<ActionEstimate[]> {
  return Promise.all(
    ACTION_DEFS.filter((d) => offeredFor(d, c)).map(async (d) => {
      const available = isAvailable(d);
      const words =
        available && d.ai ? wordCount(await loadActionPrompt(cfg, d.id)) + wordCount(buildActionPrompt(c, text, d.context ? context : undefined, d.id === 'align' ? paired : undefined)) : 0;
      return { id: d.id, label: d.label, model: cfg.model, inputWords: words, ai: d.ai, available, editableOnly: d.editableOnly, result: d.result };
    }),
  );
}

export async function runAction(id: ActionId, c: Component, text: string, deps: ActionConfig & { client: RouterJsonClient; context?: string; paired?: PairedText }): Promise<unknown> {
  const def = actionDef(id)!;
  const schema = SCHEMAS[id];
  if (!schema) throw new Error(msg.app.action.notAvailable(id));
  const system = await loadActionPrompt(deps, id);
  const { result } = await deps.client.json<unknown>({ prompt: buildActionPrompt(c, text, def.context ? deps.context : undefined, deps.paired), system, schema, model: deps.model });
  return result;
}
