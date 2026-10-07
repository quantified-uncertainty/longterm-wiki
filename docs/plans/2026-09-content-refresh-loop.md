# Keeping the wiki current without the owner: the content refresh loop

**Status:** proposed, 2026-09-26. Stage 1 (below) needs no decision; stages
2–3 each need one yes from the owner.

## Decision in one paragraph

Run `/refresh-content` (this PR) as a **scheduled Claude Code cloud
session** twice a week. Each run picks the most overdue pages, makes small
cited edits, has a **separate agent verify every edit against its fetched
source**, and opens one PR. Start with a human merging those PRs. Once a few
runs look right, let the run enable auto-merge on its own PR, and then let
content-only releases to `production` merge themselves. The fact that would
flip this: if a spot check of the first ~20 merged changes finds even one
fabricated or misattributed claim, stay at stage 1 and fix the verifier
first.

## What the evidence says

Measured 2026-09-26 (git history, workflow runs, live site):

| Fact | Number |
|---|---|
| Content pages edited in the last 90 days | **0** of 667 |
| Pages overdue by their own `update_frequency` | 526 of 537 (98%) |
| "Current value" FactBase series older than 6 months | 292 of 321 (91%) |
| AI-models directory: newest OpenAI / Google / xAI model listed | Apr 2025 / May 2025 / Feb 2025 |
| Pages with past-dated future-tense claims ("expected in Q2 2026") | ~50–70 |
| Content/data merges driven by the owner's own sessions | ~94% |
| Last production release | 2026-06-21 |

What happened to earlier automation:

- **News-driven auto-update (CI, API-billed):** 29 runs, 9 PRs, all merged.
  It cost \$13–28.50 per run. 19 of 29 runs failed or were cancelled. #378
  merged 35+ invented arXiv IDs (reverted in #413). Its citation verifier
  checked **0** citations per PR in March. Cron disabled 2026-03-17 (#2592);
  the decision about re-enabling it (QUA-31) was never closed.
- **Subscription-mode replacements** (`/auto-update` skill, launchd,
  `/loop` enrichment): these cost \$0 per page, but they needed the owner's
  laptop or a live session. They produced 2 page PRs and 26 data PRs, then
  stopped when the sessions stopped.
- **Job queue:** groundskeeper enqueues `auto-update` jobs that no worker
  handles ("Unknown job type"), and the health check excludes that type.
- **Every change needed two human clicks:** merging the PR, then merging a
  `main → production` release PR. Merge latency went from hours in March to
  weeks in May, and then nothing was merged at all.

**Diagnosis.** Generating edits was never the hard part. The binding
constraints were:

1. The runtime required the owner to be present.
2. Review was nominal, so human merge was the only real gate.
3. Deploying needed a second human click.

A design that needs less oversight has to remove all three. It must also add
a gate that actually tests claims, because constraint 2 is removed.

## Design

| Piece | Choice | Why |
|---|---|---|
| Runtime | Claude Code scheduled routine: a fresh cloud session per run, in the environment this repo already has | No laptop, no API key, no billing surprise; web search and GitHub tools are built in |
| Cadence | Tue and Fri; 5 pages per run to start, raise to 8–10 | 6-month freshness for the ~570 non-evergreen pages needs ~26 page-updates a week |
| Selection | Existing `crux w updates list --overdue` (staleness × importance), minus pages edited within 45 days or in an open PR | Already works offline; its top picks are the fast-moving pages (labs, legislation) |
| Editing | One editor subagent per page. Surgical in-place edits, named URL footnotes, change log with a verbatim supporting quote per change | Named footnotes pass the gate without the database (50 pages already use them) |
| Verification | A **separate** verifier subagent sees only the diff and the change log, fetches every URL, and checks the quote and the claim. Anything not verified is reverted; a page with more than 1/3 of its changes rejected is dropped | This is the gate the old pipeline lacked |
| Mechanical gates | `fix escaping`, `fix markdown`, content gate. Only `content/docs/knowledge-base/**` may change; ≤200 changed lines per page | Bounds the blast radius of any one run |
| Output | One PR per run, labelled `auto-content`. The body lists every change with its source, plus the rejected claims | A 2-minute skim is enough to trust or veto a run |

## Pilot (2026-09-26)

The procedure was run once by hand on three pages from the top of the
overdue list: `openai`, `eu-ai-act` and `california-sb53`. Its output is the
`content: refresh 3 stale pages` PR.

| Page | Changes logged | Verified | Rejected → fixed or reverted | Narrowings applied |
|---|---|---|---|---|
| openai | 15 | 12 | 3 | 5 |
| eu-ai-act | 25 (15 claims) | 25 | 0 | 5 |
| california-sb53 | 12 | 12 | 0 | 2 |

Examples of what the verifier caught:
- a false "latest model in late 2025 = GPT-5" (GPT-5.1 and 5.2 had shipped);
- an incident described as "faking task completion" when the source says
  the model solved the task and faked *how* it found the answer;
- "consisted of" where the source said "included".

None of these would have been caught by the old pipeline, which had no
claim-level check. Before the fixes, 3 of 52 logged changes were wrong
(about 6%). The owner's spot check of the merged PR is the real test.

Cost: about 20 minutes wall-clock (three editors in parallel, then three
verifiers) and ~1.1M subagent tokens for the three
pages. At that rate a 5-page run fits comfortably in one scheduled session.

## Rollout

| Stage | What runs | Owner effort | Gate to the next stage |
|---|---|---|---|
| 1 (this PR) | The skill exists. Run it by hand or from a routine with `landing=pr-only` | Merge 2 PRs a week and release weekly (~5 min/week) | 3–4 runs whose PRs you skimmed and found accurate |
| 2 | The routine passes `landing=auto-merge`: the run enables auto-merge only if verification and the gate are clean | Weekly release click only | A spot check of ~20 merged changes finds no fabrication |
| 3 | A content-only release lane: if `main` is ahead of `production` only in `content/**` and `data/**`, open and auto-merge the release PR | None; the PR list is the audit log | — |

Stage 3 changes a human checkpoint (`create-release-pr.yml` says "Does NOT
auto-merge") and needs the owner's explicit yes. It only applies to diffs with
no migrations and no server code, so those still get a human.

**Kill switch:** pause or delete the routine. Revert any bad run with one
`git revert` of its merge commit.

## What this deliberately does not do

- **No new entities** (e.g. adding GPT-6 to `ai-models.yaml`). IDs come from
  the wiki-server, and this environment's `LONGTERMWIKI_SERVER_API_KEY` is
  currently rejected (HTTP 401). Once the owner updates it, a second lane for
  structured data can run the same way: FactBase current values, then new
  models.
- **No revival of `crux/auto-update` or `crux/authoring`** (≈28k LOC). This
  loop doesn't use them. Delete them after the loop has run cleanly for a
  month.
- **No LLM API spend.** The loop runs on the session's own model.

## Open questions (one line each)

- Should the routine run in this cloud environment? Its runs count against
  the owner's Claude plan usage.
- Should `update_frequency` be re-tiered to realistic values (90 / 180 / 365
  days)? Today 3–7 day values put an "Overdue" banner on almost every page.
