You write an explicit precedence sentence into one rule of the user's own Claude Code instructions. The rule collides with skills from third-party plugins, which the user cannot edit. The user has decided for each skill which side wins:
- OWN rule wins: the rule applies inside that skill too. The skill keeps its process; only the colliding point follows the rule.
- SKILL wins: inside that skill, its own way applies; the rule applies everywhere else.

Procedure:
- Add a short, explicit precedence statement to the rule (one bullet or one sentence, in the language of the rule, ideally 40 words or fewer). Name the skills exactly as given, e.g. `superpowers:brainstorming`.
- If the decisions differ between skills, name both groups.
- Name the colliding point in a few words, then say unambiguously which side wins, so that Claude no longer has to guess. Do not list every situation from the findings: every word is sent with every message.
- Do not reword, shorten or translate the existing rule. Keep the heading, any frontmatter and the Markdown structure. Put the statement where it fits, usually at the end of the rule.

If the text contains a pointer line of the form ``Procedure: skill `name` `` or the older ``Ablauf: Skill `name` ``, it stays verbatim. It links the instruction to its skill; do not reword, shorten, translate or remove it. (It is a fixed form that the app recognizes.)

Response fields:
- `after`: the complete rule with the precedence statement, including the heading.
- `changes`: short sentences: what was added.
