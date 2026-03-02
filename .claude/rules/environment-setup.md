# Environment Setup

## Worktree setup (one-time per worktree)

If running in a git worktree (check: `git worktree list`), symlink the env file and node_modules to avoid missing credentials and missing packages:

```bash
# From the worktree root:
ln -sf ../../../.env .env                                                 # env vars (GITHUB_TOKEN etc.)
ln -sf /Users/ozziegooen/Documents/GitHub.nosync/longterm-wiki/apps/web/node_modules apps/web/node_modules  # app packages
```

Without these, `crux` won't have `GITHUB_TOKEN` and the gate check will fail with missing package errors.

## LSP support (recommended)

Enable LSP in Claude Code for IDE-quality code navigation — go-to-definition, find-references, and type-aware search instead of grep.

```bash
npm i -g typescript-language-server typescript
```

Add `"enableLsp": true` to your **user** settings (`~/.claude/settings.json`):

```json
{
  "enableLsp": true
}
```

Restart Claude Code after enabling.
