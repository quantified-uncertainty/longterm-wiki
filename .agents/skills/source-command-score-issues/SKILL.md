---
name: "source-command-score-issues"
description: "Score open issues with LLM and apply priority/effort/model labels"
---

# source-command-score-issues

Use this skill when the user asks to run the migrated source command `score-issues`.

## Command Template

# Score Issues — LLM-Powered Issue Triage (Legacy GitHub)

**Note:** Linear is now the primary issue tracker and has its own priority system. This command applies to legacy GitHub issues that haven't been migrated to Linear yet.

Read open GitHub issues, use your judgment to assess priority/effort/model, and apply labels so `crux gh issues next` ranks them correctly.

## When to use

- After a batch of new issues are created (e.g., from discussion decomposition)
- Periodically to re-triage the backlog
- Before kicking off an autonomous execution loop

## Step 1: Fetch issues needing scoring

```bash
pnpm crux gh issues list --json 2>&1
```

Parse the JSON output. Focus on issues that are **under-labeled** — they lack priority, size, or model labels. Skip issues that already have `priority:*` AND `size:*` AND `model:*` labels.

If the user passed `--limit=N`, only process the top N under-labeled issues. Default: 20.

## Step 2: Score each issue

For each under-labeled issue, read the title and body and assess:

### Priority (pick one)
| Label | Criteria |
|-------|----------|
| `priority:high` | Data corruption, broken pages, pipeline failures, blocks other work |
| `priority:medium` | Missing features with clear user impact, coverage gaps, UI bugs |
| `priority:low` | Polish, nice-to-haves, speculative improvements, minor cleanup |

### Size (pick one)
| Label | Criteria |
|-------|----------|
| `size: S` | Single file, data fix, config change, <30 min agent session |
| `size: M` | 2-5 files, new component or command, 30-90 min session |
| `size: L` | Multiple systems, new pipeline, migration + code + UI, 2+ hours |

### Model (pick one)
| Label | Criteria |
|-------|----------|
| `model:haiku` | Data fixes, simple UI tweaks, label changes, config updates |
| `model:sonnet` | Standard features, new components, moderate refactors |
| `model:opus` | Architecture changes, complex multi-system work, design decisions |

### Additional labels (apply if relevant)
- `bug` — if it describes broken behavior (not just missing features)
- `Codex-ready` — if the issue is well-scoped with clear acceptance criteria and an agent could complete it without human clarification

## Step 3: Apply labels

For each issue, apply the labels via the GitHub API:

```bash
gh api repos/quantified-uncertainty/longterm-wiki/issues/NNNN/labels \
  -X POST --input - <<< '{"labels":["priority:medium","size: S","model:haiku"]}'
```

**Rules:**
- Never remove existing labels — only add missing ones
- If `--dry-run` was passed, just print the proposed labels without applying them
- Print a summary table as you go:

```
#3659  priority:high    size: S  model:haiku   Codex-ready  Fix investment URLs (data bug)
#3670  priority:low     size: S  model:sonnet               Surface abstract in resource cards
#3653  priority:medium  size: M  model:sonnet  Codex-ready  Benchmark scorecard visualization
```

## Step 4: Report

After labeling, show the new ranking:

```bash
pnpm crux gh issues next --scores
```

This confirms the scoring system now has useful signal to work with.

## Heuristics for good scoring

- **Data corruption/integrity issues are always priority:high** — wrong URLs, fabricated IDs, broken FKs
- **Pipeline improvements that save money or prevent bad data are priority:high** — dead link detection, verification gates
- **UI improvements are usually priority:low to medium** — unless they fix broken/misleading displays
- **Issues with clear acceptance criteria get `Codex-ready`** — look for checkboxes, specific file paths, concrete "before/after"
- **Issues that reference other issues as blockers should NOT get `Codex-ready`** — check dependencies first
- **Prefer `model:haiku` for anything that's mostly data manipulation or simple edits** — save Opus/Sonnet budget for complex work
