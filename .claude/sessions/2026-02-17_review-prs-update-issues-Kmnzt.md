## 2026-02-17 | claude/review-prs-update-issues-Kmnzt | Add maintenance sweep system

**What was done:** Added a comprehensive maintenance sweep system with both a `/maintain` Claude Code command and a `crux maintain` CLI domain. The system gathers signals from merged PRs, session logs, GitHub issues, and codebase analysis, then prioritizes work into P0-P5 categories. Includes `review-prs`, `triage-issues`, `detect-cruft`, `status`, and `mark-run` subcommands.

**Pages:** (none — infrastructure-only)

**Issues encountered:**
- `execSync` ENOBUFS error when fetching GitHub API responses — needed `maxBuffer: 10MB` for curl output
- `gh` CLI not available in this environment — used `curl` with `$GITHUB_TOKEN` instead
- `pnpm install` fails on puppeteer postinstall — used `--ignore-scripts` workaround

**Learnings/notes:**
- GitHub API responses for PRs can be very large (50+ PRs × detailed JSON), always set maxBuffer
- The `crux maintain triage-issues` cross-references PR titles and session log text against open issues to detect potentially resolved issues — useful pattern for automated issue cleanup
- Session log parser needed careful regex for the `Issues encountered` and `Learnings/notes` sections since they can contain varied markdown formatting
