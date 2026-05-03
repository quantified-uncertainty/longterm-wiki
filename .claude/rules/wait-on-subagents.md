# Waiting on Subagents — Use Monitor, Not `cat`

When you dispatch a subagent (`Agent` / `TaskCreate` / `./ws dispatch`) or
launch a background process (`Bash` with `run_in_background`), **wait on
it with `Monitor`, not by repeated `cat` of its task-output file**.

## The rule

- ✅ Use `Monitor({ target: ..., until: ..., timeout_seconds: ... })` to
  stream the subagent's output until your exit predicate matches.
- ❌ Do NOT repeatedly run `cat /tmp/claude-*/.../tasks/<id>.output`,
  `tail -f` it, `stat -f %z` it for size deltas, or chain it with
  `ps -p N && echo RUN || echo DONE` poll loops.
- ❌ Do NOT pair the above with `echo wait` or `sleep` shims to
  approximate streaming — `Monitor` already does this correctly.

A `PreToolUse` hook (`.claude/hooks/block-cat-polling.sh`) detects the
anti-pattern and **blocks Bash at the 3rd occurrence per session** with
exit 2. There is no env-var bypass — the threshold exists because manual
soft rules didn't change the behavior (Monitor was available the whole
time the W18 spike happened, and agents reached for `cat` reflexively
anyway).

## The schema-not-loaded escape hatch

`Monitor` is a deferred tool. Its full schema isn't in your prompt by
default — you have to fetch it once per session before the first call:

```
ToolSearch({ query: "select:Monitor", max_results: 1 })
```

After that, `Monitor` is callable like any other tool for the rest of
the session. If you find yourself reaching for `cat /tmp/.../tasks/*`
because you don't remember Monitor's parameters, **load the schema
first** — that one-time `ToolSearch` is much cheaper than the polling
budget it replaces.

## Why this matters

Polling burns context and bash budget without making progress. Full
33-day, 744-session analysis (QUA-1069):

- Baseline polling rate: ~1.3-1.8% of bash calls.
- W18 worst week: 5.9% of bash calls (3.3× baseline).
- W18 worst session: 143 cat-polls + 133 `echo wait` calls in 325
  minutes, slot a9.

The hook's simulated impact: prevent ~62% of all observed polling
calls (1,495 of 2,400+ in the 33-day window) by tripping at the 3rd
match in the 193 sessions that exceeded the threshold.

## Legitimate one-shot reads

A single `cat` of a finished task file for forensics (e.g., recovering
the last lines of a crashed run, debugging a hook the subagent
triggered) is fine — the counter only fires on the third occurrence in
a session. If you genuinely need to read the file once, do it and move
on. The hook is targeted at busy-wait, not at one-shot reads.

## See also

- `.claude/hooks/block-cat-polling.sh` — the enforcing hook
- QUA-1069 — the simulation data and rationale behind the threshold
- [12-Factor Agents](https://github.com/humanlayer/12-factor-agents) —
  exit between cycles, don't poll inside them
