---
name: source-command-agent-end
description: End a Longterm Wiki agent session when no PR is being shipped. Use for research-only, abandoned, maintenance, or already-pushed quick-fix sessions; follows the shared agent-end workflow, updates Linear/GitHub if needed, closes the agent session, and resets the slot safely.
---

# source-command-agent-end

Use this skill when the user asks an agent to end, close out, wrap up, or
reset a Longterm Wiki agent session and no PR needs to be shipped.

Follow the canonical workflow in `docs/agent-workflows/agent-end.md`.

Important:

- Do not skip the problem-disposition summary required by `AGENTS.md`.
- Complete or mark N/A every checklist item before ending.
- Ask the user before discarding uncommitted changes or unpushed commits.
- Never kill processes outside this slot; use the slot's `DEV_PORT` only.
- If a PR exists, use the ship workflow instead of this skill.
