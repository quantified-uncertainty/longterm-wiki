## 2026-02-13 | claude/session-logging-tracking-d4d6K | Add session logging system

**What was done:** Created a session logging and common-issues tracking system. Added `.claude/rules/session-logging.md` (instructs each session to log a summary), `.claude/session-log.md` (the log itself), and `.claude/common-issues.md` (recurring issues and solutions seeded from CLAUDE.md knowledge).

**Issues encountered:**
- None

**Learnings/notes:**
- Hook-based logging (SessionStart/SessionEnd) captures metadata but not what actually happened. Rule-based self-logging is more useful for understanding session outcomes.
- The `.claude/rules/` directory is read automatically by Claude Code — no settings.json needed for rules.
