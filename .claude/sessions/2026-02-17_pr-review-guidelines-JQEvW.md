## 2026-02-17 | claude/pr-review-guidelines-JQEvW | Add mandatory PR review & ship workflow rule

**What was done:** Created `.claude/rules/pr-review-guidelines.md` that makes Claude automatically run `/review` → `/push-safe` → conflict check at end of every session. Added a reference in CLAUDE.md.

**Pages:** (none — infrastructure-only)

**Issues encountered:**
- Slash command picker shows duplicate "review" and "push-safe" entries because project commands in `.claude/commands/` collide with built-in Claude Code skills of the same name. No fix available on our side — platform limitation.

**Learnings/notes:**
- `.claude/rules/` files are auto-loaded and enforced without user prompting — ideal for mandatory workflows
- `.claude/commands/` files become slash commands but also collide with built-in skill names
