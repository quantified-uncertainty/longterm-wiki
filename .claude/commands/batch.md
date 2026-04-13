---
description: Not a real command — redirects to validator-first sweeps or agent slots.
effort: low
---

# /batch — not a real command in this project

`/batch` has no implementation here. If you landed on it via a harness default prompt, ignore that prompt.

- **Bulk codebase changes** (rename, move, enforce a rule across >5 files): follow the validator-first sweep pattern in `.claude/rules/implementation-quality.md` § "Codebase-Wide Sweeps — Validator-First". Write a `crux/validate/validate-<rule>.ts` first, use its output as the work queue, then wire it into `validate-gate.ts`.
- **Isolated branch work**: use an agent slot (`lw/a1`–`lw/a20`) via `./ws open <N> --claude`, or a `/tmp` worktree off the `lw/main` clone. See `.claude/rules/slot-isolation.md` and `.claude/rules/worktree-isolation-bug.md` (never use `Agent(isolation:"worktree")`).
