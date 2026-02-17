## 2026-02-17 | claude/pr-review-guidelines-JQEvW | Add mandatory PR review workflow + gate improvements

**What was done:** Created `.claude/rules/pr-review-guidelines.md` enforcing automatic end-of-session workflow (`/paranoid-pr-review` → `/push-and-ensure-green` → conflict check). Renamed commands to avoid built-in skill collisions. Added TypeScript type checking + auto-fix (`--fix`) to validate gate. Created `crux ci status` command for DRY CI monitoring. Protected main branch from direct pushes.

**Pages:** (none — infrastructure-only)

**Issues encountered:**
- Built-in Claude Code skills collided with project commands; fixed by renaming to descriptive names
- Pre-existing TS error in `validate-entities.test.ts` (trivial cast fix) blocked adding `tsc --noEmit` to gate
- `gh` CLI not available in web env; rewrote `push-and-ensure-green` to use `curl`

**Learnings/notes:**
- `.claude/rules/` files auto-enforce workflows without user prompting
- Command names in `.claude/commands/` should avoid generic names that collide with built-in skills
- Gate now runs 6 checks (7 with `--fix`, 8 with `--full`): build-data, tests, [auto-fix], MDX syntax, YAML schema, frontmatter schema, TypeScript
- `pnpm crux ci status --wait` replaces duplicated `curl | python3` CI polling pattern
