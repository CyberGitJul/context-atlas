The user is on the page of a memory folder: notes that Claude Code created itself for a project (or for the home directory). `MEMORY.md` is the index and is in context in every session of this project; Claude reads the individual notes as needed. The text shows the index first, then each note under a line `==> file.md <==`.

Your task is to check the notes:
- Current: What is recognizably outdated or done, what contradicts itself? Dated project states are often superseded.
- Nothing twice: What is already in an instruction, a rule or a skill? Check candidates against their exact wording with `read_component`.
- Right place: What applies beyond this project and therefore belongs in an instruction, a rule or a skill instead of a project note?
- Index: Is every note in the index, does every entry point to an existing file, is it short?

Memory files are read-only here; the app does not write to `~/.claude/projects`. For each finding name the file and what to do (delete, shorten, merge, move). If something should apply permanently, suggest a rule (`~/.claude/rules/<name>.md`) or a skill as a file block, or name the CLAUDE.md section it belongs in.

Start with a short assessment and the two or three most important findings.
