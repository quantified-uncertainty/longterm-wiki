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

## Dev server ports — NEVER use localhost:3001 from agent slots

Port 3001 belongs to the user's main dev server (`lw/main`). Agents must use their own port.

| Location | Port | Notes |
|----------|------|-------|
| `lw/main` | 3001 | User's main dev server — **do not touch** |
| `lw/a1` – `lw/a15` | 3011–3025 | `3010 + slot number` |
| Worktrees | Pick unused | Use `npx next dev -p <port>` with a free port |

**Rules:**
- **Never `pkill -f "next dev"`** — that kills ALL dev servers including the user's
- **Never `kill $(lsof -ti:PORT)` without `-sTCP:LISTEN`** — bare `lsof -ti` matches browser connections too, which crashes the user's browser. Always use: `kill $(lsof -ti:PORT -sTCP:LISTEN) 2>/dev/null`
- **Never start a dev server on port 3001** from a slot or worktree
- **Never browse to localhost:3001** from a slot agent — you'll see the wrong branch
- Worktree agents generally don't need dev servers (they're for quick fixes like rebases)
- If you need to verify UI changes, start on your slot's port: `npx next dev -p 3011`

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
