# Security

Context Atlas reads and edits your Claude Code configuration, and it can send parts of it to an AI provider. This page describes what the app does to keep that safe, where its limits are, and how to report a problem.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting instead: on [github.com/CyberGitJul/context-atlas](https://github.com/CyberGitJul/context-atlas), open *Security* → *Report a vulnerability*. Describe what an attacker can do, the steps to reproduce it, and the version (commit) you tested.

You can expect a first answer within a week. Fixes go to the `main` branch; there are no maintained release branches, so please always run the latest `main`.

## What the app protects

**Local only.** The server binds to `127.0.0.1`. It answers only requests whose `Host` header names this machine (`127.0.0.1` or `localhost` on the configured port), which blocks DNS rebinding. API requests from other websites are refused (`Sec-Fetch-Site`), and every write requires a JSON body, so a cross-site form cannot trigger one.

**Secrets stay out.** Of the `env` blocks in settings and the `env` and `headers` of MCP servers, the app keeps only the names; their values are never shown or sent to the AI. `.credentials.json` is never read. All other text passes a masking step (`redact`) before it is shown, goes to the AI provider or into the chat log. A text that contains secret-like values cannot be edited or sent to the AI, so a save can never write a mask over a real secret. Commits of files with secret-like content are refused.

**Nothing is written without you.** The AI never writes files. Every change is a proposal you review in a before/after comparison and save with a click. Each save checks that the file did not change meanwhile, writes a backup to `~/.cache/context-atlas/backups`, and commits the file to a separate git history (`~/.local/share/context-atlas/claude-config.git`) that lives outside `~/.claude` and tracks only hand-written configuration. Git runs with a fixed identity, no signing and no hooks.

**Limited write scope.** Only your own configuration files under `~/.claude`, skills inside the folders listed in `PROJECT_ROOTS`, and single files you list in `chat-files.json` can be written. Plugin files, skills synced from claude.ai and anything Claude Code manages itself (`~/.claude/projects`, `~/.claude/plugins`) stay read-only. Symlinks are resolved first, so a link cannot lead a write outside these places.

**The AI provider runs isolated.** With `AI_PROVIDER=agent-sdk`, the Agent SDK loads none of your settings, hooks, CLAUDE.md, MCP servers or plugins, and gets no tools except the app's read-only `read_component` tool.

## Known limits

- **Masking is pattern-based.** `redact` recognizes common key formats and `name: value` / `NAME=value` patterns. A secret in an unusual format can slip through. Keep secrets out of CLAUDE.md, rules, skills and hook commands; reference environment variables instead.
- **What goes to the AI provider.** When you use an AI feature, the masked text of the components involved goes to the provider you configured. Background explanations send the masked text of your hooks. Without an AI provider, nothing leaves your machine.
- **Chat logs.** Every chat turn is stored, masked, in `~/.local/state/context-atlas/chat-logs/` and deleted after 5 days.
- **Undocumented Claude Code files.** Some sources (installed plugins, MCP servers in `~/.claude.json`, the session transcripts in `~/.claude/projects` behind the Sessions view) are read from files whose format Claude Code does not document. The app reads them defensively, but a format change can hide components until the app is updated.
- **Not a sandbox.** Hook scripts and commands you save are run by Claude Code, not by this app. Review a proposed hook as carefully as any other script before you save it.
