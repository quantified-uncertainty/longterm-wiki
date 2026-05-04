# Longterm Wiki — Agent Instructions

This file exists because Codex (and a few other agent runtimes) look for `AGENTS.md` by convention. The canonical instructions live in `CLAUDE.md` and are agent-neutral despite the filename.

**Read `CLAUDE.md` and follow it as written.** It is the single source of truth for repo conventions, the MANDATORY first action (`pnpm crux sys agent-checklist init`), the wiki architecture, the issue-tracking workflow, and the tier-1/tier-2 rule split. Do not duplicate or paraphrase its content here.

## Agent runtime — what's specific to Codex (vs Claude Code)

| Runtime | Instructions file | Hooks config | Commands / skills | Canonical workflows | Project-dir env var |
|---------|-------------------|--------------|-------------------|---------------------|---------------------|
| Claude Code | `CLAUDE.md` | `.claude/settings.json` | `.claude/commands/` | `docs/agent-workflows/` when extracted; otherwise `.claude/commands/` | `CLAUDE_PROJECT_DIR` |
| Codex | `AGENTS.md` (this file → reads `CLAUDE.md`) | `.codex/hooks.json` | `.agents/skills/` | `docs/agent-workflows/` when extracted; otherwise `.claude/commands/` | `CODEX_PROJECT_DIR` |

The hook scripts themselves live in `.claude/hooks/*.sh` (single source of truth — Codex's `.codex/hooks.json` references the same files). Each script reads `${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-...}}` so it works in both runtimes.

The `.agents/skills/source-command-*` directories are thin pointers to
canonical command bodies. The canonical body lives in
`docs/agent-workflows/<name>.md` for runtime-neutral workflows, or
`.claude/commands/<name>.md` otherwise. When a workflow has been extracted to
`docs/agent-workflows/`, the matching `.claude/commands/<name>.md` becomes a
Claude-only adapter (it covers Claude built-ins like `/clear` and `/rename`)
and defers to the canonical doc for the rest.

## Branch convention

Use `claude/<description>` or `codex/<description>` interchangeably for feature branches. For Linear-tracked work, use `claude/qua-NNN-description` or `codex/qua-NNN-description` — Linear's GitHub integration auto-closes on either form (the `qua-NNN` token is what matters).

## When to edit which file

- Repo-wide conventions, workflow rules, architecture notes → `CLAUDE.md`
- Codex-specific bits only (entries in this table, things that genuinely differ between runtimes) → here
- Hook scripts → `.claude/hooks/` (canonical)
- Runtime-neutral workflow bodies → `docs/agent-workflows/`
- Claude-only slash command adapters → `.claude/commands/`
- Codex skill shims → `.agents/skills/source-command-*/SKILL.md`
