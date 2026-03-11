# Environment Setup

## Worktree setup (Claude Code worktrees only)

This applies to **Claude Code git worktrees** (`.claude/worktrees/xyz/`), not `lw/` agent slots. Agent slots (`lw/a1`, `lw/a2`, ...) are full clones managed by `crux agent-workspace` and don't need symlinks.

If running in a git worktree (check: `git worktree list`), symlink the env file and node_modules to avoid missing credentials and missing packages:

```bash
# From the worktree root (e.g., .claude/worktrees/xyz/):
ln -sf ../../../.env .env                                                 # env vars (GITHUB_TOKEN etc.)
ln -sf ../../../node_modules node_modules                                 # root packages (tsx, etc.)
ln -sf ../../../apps/web/node_modules apps/web/node_modules               # app packages (tsc, next, etc.)
ln -sf ../../../apps/wiki-server/node_modules apps/wiki-server/node_modules  # wiki-server packages (drizzle-orm, etc.)
```

Without these, `crux` won't have `GITHUB_TOKEN` and the gate check will fail with missing package errors. The root `node_modules` is needed for `tsx`. The wiki-server `node_modules` is needed because `apps/web/tsconfig.json` has `@wiki-server/*` path aliases that pull in wiki-server routes, and TypeScript resolves their dependencies (like `drizzle-orm`) from the wiki-server's `node_modules`.

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
