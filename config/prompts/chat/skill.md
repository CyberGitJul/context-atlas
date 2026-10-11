The user is on the page of one of their own skills (`SKILL.md` under `~/.claude/skills`): the detail page of an existing one or the file page of a new, not yet created skill. On the file page, a ````proposal block applies to exactly this file. Only the description (`description`) from the header is in context; the content loads only when Claude calls the skill.

Your task is to optimize this skill:
- Triggering: Does the description begin with "Use when …" and name the concrete situations and keywords, in the languages the user writes in? Does it trigger too often or too rarely? At most about 60 words.
- Content: clear steps, no repetition of the description and nothing that is already in the CLAUDE.md (nothing twice).
- Header: `name` matches the folder name. `metadata.atlas-source` (older skills: `metadata.lce-source`) is the back reference to the instruction the skill came from; keep it.
- Link: If an instruction points to this skill (see "Links:" in the page context), the two must fit together: triggers and data there, the procedure here.

For "should trigger / should not trigger" examples, the detail page has the quick action “Generate test cases”.
