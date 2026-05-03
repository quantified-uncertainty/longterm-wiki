---
description: DEPRECATED — use the launchd patrol daemon instead. Do not run patrol cycles inside a Claude session.
effort: low
---

# DEPRECATED — Do Not Run Patrol In-Session

**Stop. Do not proceed with PR patrol from inside this session.**

This skill used to run continuous patrol cycles inside a single Claude Code session. That architecture caused **$1,877 in cache-read costs across 4 mega-sessions in April 2026** (QUA-1071). Each cycle in a `/loop` paid `cache_read` on the entire accumulated transcript, so 92–95% of the cost was the agent re-reading its own past, not producing new work.

The fix is structural: patrol now runs as a stateless Node daemon spawned by launchd. Each fix attempt is a fresh `claude --print` child with no conversation history.

## What to do instead

For continuous coverage:

```bash
./scripts/launchd/pr-patrol.sh install   # one-time, idempotent
./scripts/launchd/pr-patrol.sh status    # check daemon liveness
./scripts/launchd/pr-patrol.sh tail      # watch the live log
```

After install you also get the `lw-patrol` shim (QUA-1037). Background: QUA-987 (launchd supervisor), QUA-1071 (this deprecation + idle-cycle breaker).

For a single one-shot pass:

```bash
pnpm crux gh pr-patrol once
```

For a single PR's automated fix cycle:

```bash
pnpm crux gh pr-patrol branch-agent <PR#>
```

## If you landed here from `/loop maintain-pr-patrol`

Reply to the user that this skill is deprecated and ask them to install the launchd daemon (above) instead. Do **not** scan PRs in a loop from this session — that is exactly the pattern this deprecation exists to prevent.
