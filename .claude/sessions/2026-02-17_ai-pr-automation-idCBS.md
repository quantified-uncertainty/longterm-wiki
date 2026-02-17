## 2026-02-17 | claude/ai-pr-automation-idCBS | Add AI PR automation workflows

**What was done:** Added two new GitHub Actions workflows: `claude-assistant.yml` (interactive @claude bot for PRs/issues with CI log access) and `ci-autofix.yml` (automatic CI failure diagnosis and fix for claude/* branches, with infinite-loop protection).

**Issues encountered:**
- Pre-existing numericId conflict (E753 claimed by both "stub-style-guide" and "wiki-generation-architecture") blocks `validate gate` — unrelated to these changes.

**Learnings/notes:**
- `claude-code-action@v1` is the current stable version of Anthropic's GitHub Action. It auto-detects interactive vs automation mode based on whether `prompt` is provided.
- The `ci-autofix` workflow uses a commit-message-based loop detector (checks last 3 commits for `[ci-autofix]` prefix) to prevent infinite fix-fail cycles.
- Prerequisites for these workflows: `ANTHROPIC_API_KEY` GitHub secret and Claude GitHub App installed on the repo.
