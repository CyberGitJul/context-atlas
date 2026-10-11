import path from 'node:path';
import type { Component } from '../../shared/model.js';
import { msg } from '../messages/index.js';
import { parseFrontmatter, str } from '../scan/context.js';

/** errors block saving; warnings are shown next to the comparison. */
export interface FileCheck {
  errors: string[];
  warnings: string[];
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---/;

const where = (c: Component) => msg.edit.fileCheck.where(c.origin.type === 'plugin' ? c.origin.plugin.split('@')[0] : null, c.enabled);
/** Components of these kinds with this name, except the file being checked itself. */
const namesake = (components: Component[], kinds: Component['kind'][], name: string, abs: string) =>
  components.filter((c) => kinds.includes(c.kind) && c.name === name && c.sourcePath !== abs);

/**
 * Rules a SKILL.md must meet so Claude Code loads it as intended (Agent Skills spec: name = folder, lowercase
 * with hyphens, at most 64 characters; description present, at most 1024).
 */
function checkSkill(abs: string, folder: string, text: string, components: Component[]): FileCheck {
  const m = msg.edit.fileCheck;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!FRONTMATTER.test(text)) {
    errors.push(m.noFrontmatterSkill);
    return { errors, warnings };
  }
  const { data } = parseFrontmatter(text);
  const name = str(data.name);
  const description = str(data.description);
  if (!name) errors.push(m.nameMissing);
  else {
    if (name !== folder) errors.push(m.nameFolder(name, folder));
    if (!NAME_RE.test(name) || name.length > NAME_MAX) errors.push(m.nameFormat(name, NAME_MAX));
  }
  if (!description) errors.push(m.descriptionMissingSkill);
  else {
    if (description.length > DESCRIPTION_MAX) errors.push(m.descriptionLong(description.length, DESCRIPTION_MAX));
    if (!/^use when\b/i.test(description)) warnings.push(m.descriptionUseWhen);
  }
  const same = components.filter((c) => c.kind === 'skill' && c.name === (name ?? folder) && (!c.sourcePath || path.dirname(c.sourcePath) !== path.dirname(abs)));
  for (const c of same) warnings.push(m.skillExists(c.name, where(c)));
  return { errors, warnings };
}

/** A subagent needs name and description in its frontmatter; Claude picks it by the description. */
function checkAgent(abs: string, file: string, text: string, components: Component[]): FileCheck {
  const m = msg.edit.fileCheck;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!FRONTMATTER.test(text)) {
    errors.push(m.noFrontmatterAgent);
    return { errors, warnings };
  }
  const { data } = parseFrontmatter(text);
  const name = str(data.name);
  const description = str(data.description);
  if (!name) errors.push(m.nameMissing);
  else {
    if (!NAME_RE.test(name) || name.length > NAME_MAX) errors.push(m.nameFormat(name, NAME_MAX));
    if (name !== file) warnings.push(m.nameFile(name, file));
    for (const c of namesake(components, ['agent'], name, abs)) warnings.push(m.agentExists(c.name, where(c)));
  }
  if (!description) errors.push(m.descriptionMissingAgent);
  return { errors, warnings };
}

/** A command works without frontmatter; its file name is the /name, shared with skills. */
function checkCommand(abs: string, name: string, text: string, components: Component[]): FileCheck {
  const m = msg.edit.fileCheck;
  const warnings: string[] = [];
  const description = FRONTMATTER.test(text) ? str(parseFrontmatter(text).data.description) : null;
  if (!description) warnings.push(m.commandNoDescription(name));
  for (const c of namesake(components, ['command', 'skill'], name, abs)) {
    warnings.push(m.commandExists(name, c.kind === 'skill' ? 'skill' : 'command', where(c)));
  }
  return { errors: [], warnings };
}

/** Checks a file proposed in the chat by where it goes in ~/.claude; other files pass unchecked. */
export function checkProposedFile(abs: string, claudeDir: string, text: string, components: Component[]): FileCheck {
  const rel = path.relative(claudeDir, abs).split(path.sep).join('/');
  const skill = rel.match(/^skills\/([^/]+)\/SKILL\.md$/);
  if (skill) return checkSkill(abs, skill[1], text, components);
  const agent = rel.match(/^agents\/([^/]+)\.md$/);
  if (agent) return checkAgent(abs, agent[1], text, components);
  const command = rel.match(/^commands\/(?:[^/]+\/)*([^/]+)\.md$/);
  if (command) return checkCommand(abs, command[1], text, components);
  return { errors: [], warnings: [] };
}
