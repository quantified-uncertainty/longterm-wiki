# No Long Sleeps

## Scope
All agent sessions — applies to any `sleep()`, `setTimeout()`, or polling loop.

## Rationale
Sleeping for extended periods (>10 seconds) blocks the agent session and wastes wall-clock time. Long sleeps usually indicate a missing event-driven pattern — the agent should check output directly, use `--wait` flags, or poll with short intervals instead.

## Examples

**Bad**: `sleep(60000)` while waiting for CI to finish, or `sleep(30000)` between polling attempts.

**Good**:
- Use `pnpm crux gh ci status --wait` which has its own polling with short intervals
- Poll with 3-5 second intervals when waiting for a process
- Use `run_in_background` for long-running commands and get notified on completion
- Check command output immediately after running it — no sleep needed

## Rule
Never sleep over 10 seconds when checking command output or waiting for processes. If a wait is genuinely needed (e.g., API rate limiting), use the shortest effective interval and document why.
