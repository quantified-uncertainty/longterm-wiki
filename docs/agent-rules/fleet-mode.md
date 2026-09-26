# Fleet mode (many parallel agent slots)

Read this only when running several agents at once in the `lw/a1`…`lw/a20`
slot clones. A single session (local or cloud) does not need any of it.

## What is on by default

`.claude/settings.json` (and `.codex/hooks.json`) register only hooks that
prevent damage in any session:

| Hook | Guards against |
|---|---|
| `warn-main-branch.sh` | Edit/Write while on `main` |
| `block-no-verify.sh` | `git commit/push --no-verify` bypassing the pre-push gate |
| `recover-cwd.sh` | Parent CWD deleted by the subagent-worktree bug |
| `approve-claude-configs.sh` | (convenience) auto-approves writes to `.claude/` session paths |

## Turning fleet mode on in a slot

```bash
cp .claude/settings.fleet.json .claude/settings.local.json   # gitignored, per slot
```

Claude Code merges hooks from `settings.local.json` with `settings.json`, so
this adds the fleet hooks on top of the defaults. If the slot already has a
`settings.local.json`, merge the `hooks` entries by hand. For Codex, merge
`.codex/hooks.fleet.json` into the slot's `.codex/hooks.json`. To turn it off,
delete the local file.

The fleet hooks, all still in `.claude/hooks/`:

| Hook | Event | What it does |
|---|---|---|
| `session-start.sh` | SessionStart | PID lock, clears stale checklist, wiki-server health, registers the session with prod `/api/active-agents` |
| `require-checklist.sh` | Edit/Write | Blocks edits until `pnpm crux sys agent-checklist init` has run |
| `block-git-stash.sh`, `block-branch-switch.sh` | Bash | Stop cross-session branch confusion within one slot |
| `block-tmux-kill.sh`, `block-other-slots.sh` | Bash | Protect other slots' tmux windows, directories and processes |
| `block-raw-gh-pr.sh` | Bash | Forces `pnpm crux gh pr create` (injects `Fixes QUA-NNN`) |
| `block-cat-polling.sh` | Bash | Blocks busy-wait polling of subagent output |
| `require-stage-approved.sh` | Bash | Blocks `gh pr merge` without the `stage:approved` label (spawns `npx tsx` on every Bash call, ~0.8 s) |
| `heartbeat.sh` | PostToolUse | Heartbeat to prod wiki-server |
| `inject-wip-checklist.sh` / `verify-checklist-on-stop.sh` | Prompt / Stop | Surface and enforce the checklist |
| `cleanup-worktrees.sh`, `session-finalize.sh` | SessionEnd | Remove merged worktrees; write session log to prod |

`require-checklist.sh` needs prod wiki-server credentials for `agent-checklist
init`, or `--allow-offline`.

## Fleet workflow docs

`agent-session-workflow.md`, `session-logging.md`, `slot-isolation.md`,
`environment-setup.md` (slot ports, auto-prod wiki-server),
`wait-on-subagents.md`, `dispatched-agent-review.md`, `patrol-health-gate.md`,
`linear-integration.md`.
